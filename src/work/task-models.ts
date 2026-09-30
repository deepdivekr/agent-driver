import {z} from 'zod';
import {ConfiguredStructuredModel} from '../onboarding/configured-model.js';
import {TASK_MODEL_ALLOCATION_INSTRUCTIONS,taskModelAllocationSchema,taskModelCandidateSchema,taskModelRoles,validateTaskModelAllocation,type TaskModelSelection} from '../onboarding/task-models.js';
import {hashJson,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {type PackStore} from '../packs/store.js';
import {safeControlText} from '../observability/safe-text.js';
import {isInvalidClientOutput,isNonRetryableClientFailure} from '../integrations/client-handoff.js';
import {workActivity} from './activity.js';

const digest=z.string().regex(/^[a-f0-9]{64}$/u);
const receiptSchema=z.object({
  format:z.literal(1),work_id:z.string().uuid(),run_id:z.string().min(1).max(100),settings_binding:digest,task_binding:digest,
  created_at:z.string().datetime(),status:z.enum(['assigned','fallback']),
  reason:z.enum(['allocated','no_candidates','invalid_allocation','allocation_unavailable']),
  candidates:z.array(taskModelCandidateSchema).max(450),allocation:taskModelAllocationSchema.nullable(),
  allocator:z.object({provider:z.string().max(80),model:z.string().max(200),elapsed_ms:z.number().nonnegative(),total_tokens:z.union([z.number().nonnegative(),z.literal('unobserved')])}).strict().nullable(),
}).strict();
export type TaskModelReceipt=z.infer<typeof receiptSchema>;

export function readTaskModelReceipt(store:PackStore,project:string,workId:string):TaskModelReceipt|null{
  if(!store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_task_models'").get())return null;
  const row=store.hermesState.prepare('SELECT body FROM office_task_models WHERE project_id=? AND work_id=?').get(project,workId);
  try{
    const value=receiptSchema.parse(JSON.parse(String(row?.body)));
    if(value.work_id!==workId)return null;
    if(value.status==='assigned')validateTaskModelAllocation(value.allocation,value.candidates);
    return value;
  }catch{return null;}
}
function assignments(receipt:TaskModelReceipt):TaskModelSelection[]{return receipt.status==='assigned'?validateTaskModelAllocation(receipt.allocation,receipt.candidates):taskModelRoles.map(role=>({role,client:null,model:null,reason:''}));}
export function taskModelReceiptView(store:PackStore,project:string,workId:string){
  const receipt=readTaskModelReceipt(store,project,workId);if(!receipt)return null;
  return {status:receipt.status,reason:receipt.reason,created_at:receipt.created_at,allocator:receipt.allocator,assignments:assignments(receipt).map(item=>({...item,reason:safeControlText(item.reason,400)})),basis:'saved_task_allocation',execution_proven:false};
}

/** An optional planning preference, not task authority. The existing supervisor
 * lease serializes admission. A resume reads this receipt; model turns never
 * recalculate the distribution or mutate global/coding settings. */
export async function allocateWorkModels(store:PackStore,project:string,workId:string,model:StructuredModel,task:unknown,guard:()=>void|Promise<void>):Promise<StructuredModel>{
  if(!(model instanceof ConfiguredStructuredModel))return model;
  const context=model.taskModelContext();if(!context)return model;
  await guard();
  const taskBinding=hashJson(task),saved=readTaskModelReceipt(store,project,workId);
  const bind=(receipt:TaskModelReceipt)=>model.withTaskModels({work_id:workId,settings_binding:receipt.settings_binding,assignments:assignments(receipt)});
  if(saved?.settings_binding===context.settings_binding&&saved.task_binding===taskBinding&&(saved.status==='assigned'||saved.run_id===model.provenance?.run_id)){
    workActivity(store,project,workId,'models.reused','Reusing the saved task model allocation.',{stage_id:'model-allocation',status:saved.status});
    return bind(saved);
  }
  workActivity(store,project,workId,'models.allocating','Checking connected subscription models and allocating task roles.',{stage_id:'model-allocation',status:'running'});
  let candidates:z.infer<typeof taskModelCandidateSchema>[]=[];
  try{candidates=z.array(taskModelCandidateSchema).max(450).parse(await model.taskModelCandidates());}catch{/* Optional allocation falls back, never invents candidates. */}
  await guard();
  let allocation:TaskModelReceipt['allocation']=null,reason:TaskModelReceipt['reason']='no_candidates',allocator:TaskModelReceipt['allocator']=null;
  if(candidates.length){
    const planner=model.forRole('planner'),callStart=planner.calls.length;
    try{
      // One bounded call across all four roles. This proposal cannot set effort,
      // credentials, client executable, API endpoint, session or tool permissions.
      const schema=z.toJSONSchema(taskModelAllocationSchema),candidateIds=['INHERIT',...candidates.map(item=>item.id)];
      const item=(schema.properties!.assignments as {items:{properties:Record<string,unknown>}}).items;
      item.properties.candidate_id={type:'string',enum:candidateIds};
      const defaults={client_order:context.environment.AGENT_DRIVER_LLM_CLIENT??'auto',models:{codex:context.environment.AGENT_DRIVER_CODEX_MODEL??null,claude:context.environment.AGENT_DRIVER_CLAUDE_MODEL??null,opencode:context.environment.AGENT_DRIVER_OPENCODE_MODEL??null},codex_reasoning_effort:context.environment.AGENT_DRIVER_CODEX_REASONING_EFFORT??null};
      const value=await planner.call('design',TASK_MODEL_ALLOCATION_INSTRUCTIONS,{task,candidates,defaults,default_policy:'Keep the saved client and model when choosing INHERIT.'},schema);
      const last=planner.calls.slice(callStart).findLast(call=>call.status==='accepted');
      if(!last)throw Error('TASK_MODEL_ALLOCATION_UNOBSERVED');
      allocator={provider:safeControlText(last.provider??'unobserved',80),model:safeControlText(last.model,200),elapsed_ms:last.elapsed_ms,total_tokens:last.total_tokens};
      try{
        validateTaskModelAllocation(value,candidates);allocation=taskModelAllocationSchema.parse(value);
        for(const entry of allocation.assignments)entry.reason=safeControlText(entry.reason,400);
        reason='allocated';
      }catch{reason='invalid_allocation';}
    }catch(error){
      // Optional preferences may fall back after an unavailable or malformed
      // answer, but must never erase a session/receipt/connection safety fence.
      if(isNonRetryableClientFailure(error)&&!isInvalidClientOutput(error))throw error;
      reason='allocation_unavailable';
    }
    finally{model.calls.push(...planner.calls.slice(callStart));}
  }
  await guard();
  if(model.taskModelContext()?.settings_binding!==context.settings_binding)throw Error('MODEL_SETTINGS_CHANGED');
  const receipt=receiptSchema.parse({format:1,work_id:workId,run_id:model.provenance?.run_id,settings_binding:context.settings_binding,task_binding:taskBinding,created_at:new Date().toISOString(),status:allocation?'assigned':'fallback',reason,candidates,allocation,allocator});
  store.hermesState.exec('CREATE TABLE IF NOT EXISTS office_task_models(project_id TEXT NOT NULL,work_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,work_id))');
  store.hermesState.prepare('INSERT INTO office_task_models(project_id,work_id,body) VALUES(?,?,?) ON CONFLICT(project_id,work_id) DO UPDATE SET body=excluded.body').run(project,workId,JSON.stringify(receipt));
  workActivity(store,project,workId,allocation?'models.assigned':'models.fallback',allocation?'Task models assigned; unused roles do not create additional workers.':'Using the saved default model because task allocation was unavailable.',{stage_id:'model-allocation',status:receipt.status,reason});
  return bind(receipt);
}
