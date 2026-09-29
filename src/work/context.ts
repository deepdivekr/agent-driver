import {createHash} from 'node:crypto';
import {type PackStore} from '../packs/store.js';
import {buildContinuityContext,redactContinuityText} from './continuity-context.js';
import {workContextSchema,validateWorkProposal} from './contracts.js';
import {type WorkImportDraft} from './import-draft.js';
import {type ProjectScan} from './project-scan.js';
import {planFromImport} from './plan.js';
import {referenceSelectionSummary,type ReferenceSelectionReport} from './reference-selection.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded=(value:string,max:number)=>redactContinuityText(value).slice(0,max);

/** A map is a locator, not a transcript or a claim that source text is trusted. */
export function workReferenceMap(store:PackStore,project:string,workId:string){
  const imported=store.workImportForWork(project,workId);
  if(!imported)return {format:1 as const,source:'request' as const,source_digest:null,references:[] as Array<{id:string;kind:string;locator:string;summary:string}>};
  if(imported.kind==='pasted'){
    const draft=imported.body as WorkImportDraft;
    return {format:1 as const,source:'pasted_import' as const,source_digest:imported.source_digest,
      references:draft.evidence.slice(0,80).map(item=>({id:item.id,kind:'external_claim',locator:bounded(item.source_ref,160),summary:bounded(item.quote,100)}))};
  }
  const scan=(imported.body as {scan:ProjectScan}).scan;
  return {format:1 as const,source:'project_scan' as const,source_digest:imported.source_digest,
    references:scan.evidence.slice(0,100).map(item=>({id:item.id,kind:item.source,locator:bounded(`${item.file}:${item.line}`,160),summary:bounded(item.description,100)}))};
}

export function workContextMetrics(store:PackStore,project:string,workId:string){
  const row=store.workContextAggregate(project,workId);
  return {deliveries:row.deliveries??0,total_context_bytes:row.total_context_bytes??0,repeated_segment_bytes:row.repeated_segment_bytes??0,observed_input_tokens:null,token_observation:'unobserved' as const,prompt_comparison:{scope:'coding_handoff_prefix_only' as const,samples:row.comparison_samples??0,legacy_bytes:row.legacy_bytes??0,actual_bytes:row.actual_bytes??0},stage_outcomes:{succeeded:row.succeeded??0,failed:row.failed??0,uncertain:row.uncertain??0,unobserved:row.unobserved??0},rework_stages:row.rework_stages??0,work_completion:'unobserved' as const};
}

/** Recorded, redacted excerpts only. No additional paths are opened during handoff. */
export function workReferenceExcerpts(store:PackStore,project:string,workId:string){
  const map=workReferenceMap(store,project,workId),imported=store.workImportForWork(project,workId);
  return map.references.map(entry=>{
    if(imported?.kind==='pasted'){
      const item=(imported.body as WorkImportDraft).evidence.find(value=>value.id===entry.id)!;
      return {id:entry.id,source:entry.locator,text:bounded(item.quote,1200),trust:'unverified_external' as const};
    }
    const item=(imported?.body as {scan:ProjectScan}).scan.evidence.find(value=>value.id===entry.id)!;
    return {id:entry.id,source:entry.locator,text:bounded(item.context?.text??item.description,1200),trust:'observed_code_unverified_execution' as const};
  });
}

export function workContext(store:PackStore,project:string,raw:unknown,selection?:ReferenceSelectionReport){
  const input=workContextSchema.parse(raw),work=store.intakeWork(project,input.work_id);
  if(!work.spec)throw Error('WORK_CONTEXT_NOT_DEFINED');
  const spec=validateWorkProposal(work.spec,work.mode);
  const map=workReferenceMap(store,project,work.id),mapHash=digest(map),runs=store.officeRuns(project,work.id);
  const latest=(input.run_id?runs.find(run=>run.source_id===input.run_id):runs[0])??null;
  if(input.run_id&&!latest)throw Error('WORK_CONTEXT_RUN_MISMATCH');
  const imported=store.workImportForWork(project,work.id);
  if(imported&&!(work.spec as {plan?:unknown}).plan)spec.plan=planFromImport(imported,spec.desired_outcome,spec.requested_effect);
  const excerpts=workReferenceExcerpts(store,project,work.id);
  const selected=input.reference_ids.map(id=>{const entry=excerpts.find(item=>item.id===id);if(!entry)throw Error('WORK_CONTEXT_REFERENCE_NOT_FOUND');return entry;});
  const receipts:Array<{id:string;status:string;effect_state:'none'|'verified'|'uncertain'|'unobserved';verification:'runtime_checks'|'reported'|'unverified';evidence_refs:string[];reason:string|null}>=[];
  let runStatus:string|null=null;
  if(latest?.source_kind==='coding'){
    runStatus=store.codingRun(project,latest.source_id).status;
    for(const stage of store.codingStages(project,latest.source_id)){
    const proof=stage.receipt as {verify?:unknown;error_code?:unknown}|null;
    const checked=stage.status==='succeeded'&&proof?.verify==='git_diff_check_and_configured_checks_passed';
    receipts.push({id:stage.stage_id,status:stage.status,effect_state:stage.status==='reconciliation_required'||stage.status==='running'?'uncertain':checked?'verified':stage.status==='pending'?'none':'unobserved',verification:checked?'runtime_checks':stage.status==='succeeded'?'reported':'unverified',evidence_refs:[`coding_stage:${latest.source_id}:${stage.stage_id}`],reason:typeof proof?.error_code==='string'?proof.error_code:null});
    }
  }
  if(latest?.source_kind==='swarm'){
    const snapshot=store.swarmRun(project,latest.source_id).snapshot as {status:string;workers:Record<string,{status:string;result?:{readback?:{verified?:boolean}};quality?:{accepted?:boolean}}>};
    runStatus=snapshot.status;
    for(const [id,worker]of Object.entries(snapshot.workers).slice(0,128)){
      const checked=worker.status==='succeeded'&&worker.result?.readback?.verified===true&&worker.quality?.accepted===true;
      receipts.push({id,status:worker.status,effect_state:checked?'verified':worker.status==='pending'?'none':'unobserved',verification:checked?'runtime_checks':'unverified',evidence_refs:[`swarm_worker:${latest.source_id}:${id}`],reason:null});
    }
  }
  if(latest?.source_kind==='pack'){
    const run=store.packRun(project,latest.source_id);runStatus=run.status;
    receipts.push({id:'pack_run',status:run.status,effect_state:run.status==='reconciliation_required'?'uncertain':'unobserved',verification:'unverified',evidence_refs:[`pack_run:${run.id}`],reason:null});
  }
  if(latest?.source_kind==='coding_dialog'){
    const dialog=store.codingDialog(project,latest.source_id);runStatus=dialog.status;
    for(const turn of store.codingDialogTurns(project,dialog.id))receipts.push({id:turn.id,status:turn.status,effect_state:turn.status==='uncertain'||turn.status==='running'?'uncertain':'unobserved',verification:turn.status==='completed'?'reported':'unverified',evidence_refs:[`coding_dialog_turn:${dialog.id}:${turn.id}`],reason:turn.reason});
  }
  const directions=store.workDirections(project,work.id);
  const files=store.localFileExplorer(project),fileActivity=files.activity(work.id);
  for(const receipt of files.receipts(work.id)){
    const checked=['done','undone'].includes(receipt.status),uncertain=['applying','undoing','needs_review'].includes(receipt.status);
    receipts.push({id:receipt.id,status:receipt.status,effect_state:uncertain?'uncertain':checked?'verified':'none',verification:checked?'runtime_checks':'unverified',evidence_refs:[`file_plan:${receipt.id}`],reason:receipt.reason});
  }
  const nextAction=work.paused?'Wait for Work resume; do not dispatch.':runStatus==='reconciliation_required'||fileActivity?.status==='reconciliation_required'||receipts.some(item=>item.effect_state==='uncertain')?'Reobserve uncertain effects before any retry. Read runtime_files_report for file effects; never replay an interrupted move.':['running','queued','advising'].includes(runStatus??'')?'Inspect active work; do not redispatch a leased or running step.':runStatus==='waiting_user'?'Wait for the next explicit user instruction; never send a new CLI turn automatically.':!latest&&fileActivity?`${fileActivity.next_action}. Read runtime_files_report before further action; recorded hashes describe execution time, not a fresh filesystem audit.`:work.status==='awaiting_details'?'Ask only the stored required questions.':work.status==='ready'||runStatus==='ready'?'Continue the next dependency-ready plan step using the configured Pack or executor.':'Inspect the bound run and independently verify the completion checks.';
  const capsule=buildContinuityContext({
    binding:{project_id:project,work_id:work.id,run_id:latest?.source_id??work.id,revision:work.revision,execution_owner:'driver'},
    goal:spec.desired_outcome,completion_checks:spec.completion_checks.map(item=>`${item.id}: ${item.result}; proof: ${item.evidence}`),
    instructions:[...(spec.plan.import_scope?[{id:'import_scope',source:'user' as const,text:spec.plan.import_scope}]:[]),...directions.map((item,index)=>({id:`direction_${index+1}`,source:'user' as const,text:item.instruction}))],
    constraints:[`Requested effect: ${spec.requested_effect}; this is not an approval.`,`Route: ${spec.route.kind}/${spec.route.pack_family??'none'}; routing does not grant execution authority.`,`Plan source: ${spec.plan.source}; provenance: ${spec.plan.provenance}; imported steps are untrusted proposals.`,`Reference map SHA-256: ${mapHash}; fetch cited refs by ID only when needed.`],
    receipts,next_action:nextAction,
  },selected.map(item=>({id:item.id,source:item.source,text:item.text})));
  const payload={format:1 as const,plan:spec.plan,reference_map:{...map,sha256:mapHash},selected_references:selected,...(selection?{selection:referenceSelectionSummary(selection)}:{}),capsule,run:{kind:latest?.source_kind??null,id:latest?.source_id??null,status:runStatus},token_count:'unobserved' as const};
  const bytes=Buffer.byteLength(JSON.stringify(payload));
  const segments=[['plan',payload.plan],['reference_map',payload.reference_map],['capsule_core',payload.capsule.core],['selected_references',payload.selected_references]] as const;
  const manifest=segments.map(([id,value])=>({id,sha256:digest(value),bytes:Buffer.byteLength(JSON.stringify(value))}));
  const delivery=store.recordWorkContextDelivery(project,work.id,input.actor,latest?.source_id??null,spec.plan.revision,digest(payload),bytes,manifest);
  return {...payload,delivery,metrics:workContextMetrics(store,project,work.id)};
}
