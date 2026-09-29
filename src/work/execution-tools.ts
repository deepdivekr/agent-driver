import {z} from 'zod';
import {type RuntimeApi} from '../interface/api.js';
import {tools} from '../interface/catalog.js';
import {type HostConfig} from '../interface/config.js';
import {RoutedBrowser,browserCatalog,assertBrowserUrl,type BrowserRouteOptions} from '../browser/executor-routing.js';
import {browserObservationSchema} from '../browser/executor-contracts.js';
import {type PackStore} from '../packs/store.js';
import {workActivity} from './activity.js';
import {type WorkProposal} from './contracts.js';
import {requireCondition} from '../core/contracts.js';
import {hashJson,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {WorkClientToolInputError,type WorkClientTool,type WorkClientToolReceipt} from './client-executor.js';
import {readScopedFile,sha} from '../packs/data.js';
import {dirname,join,resolve} from 'node:path';
import {mkdir,open,realpath,stat} from 'node:fs/promises';
import {nativeProcessRunner} from '../integrations/subscription-auth.js';
import {readLocalGitCheckpoint} from '../coding/local-checkpoint.js';

/** Potential effect, not a claim that a particular call performed a write.
 * Drafts also have durable state and must not be replayed after a lost reply.
 * Approval/grant, shell, raw UI actions and cross-Work coding resume are absent.
 */
const effects={
  runtime_pack_catalog:'read_only',runtime_pack_plan:'read_only',runtime_pack_run:'local_write',runtime_pack_status:'read_only',runtime_pack_execute_approved:'external_write',
  runtime_files_roots:'read_only',runtime_files_request:'draft_only',runtime_files_scan:'draft_only',runtime_files_inspect:'read_only',runtime_files_classify:'draft_only',runtime_files_propose:'draft_only',runtime_files_report:'read_only',
  runtime_windows_catalog:'read_only',runtime_windows_design:'draft_only',runtime_windows_start:'draft_only',runtime_windows_step:'external_write',runtime_windows_status:'read_only',
  runtime_work_context:'read_only',runtime_coding_projects:'read_only',runtime_coding_start:'local_write',runtime_coding_step:'local_write',runtime_coding_status:'read_only',runtime_coding_pause:'draft_only',runtime_coding_reconcile:'read_only',office_browser_read:'read_only',office_browser_links:'read_only',office_result_draft:'local_write',office_result_read:'read_only',
} as const satisfies Record<string,WorkClientTool['effect']>;
type ExecutionToolName=keyof typeof effects;
const injectWork=new Set(['runtime_pack_plan','runtime_pack_run','runtime_files_request','runtime_files_scan','runtime_files_propose','runtime_files_report','runtime_windows_design','runtime_windows_start','runtime_work_context','runtime_coding_start']);
const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const browserInput=z.object({url:z.string().url().max(4096)}).strict();
const resultInput=z.object({text:z.string().trim().min(1).max(16000),label:z.string().trim().min(1).max(120).optional()}).strict();
const resultReadInput=z.object({request_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u)}).strict();
const sourceIntegritySchema=z.array(z.object({
  source_id:z.string().min(1).max(80),before_sha256:z.string().regex(/^[a-f0-9]{64}$/u).nullable(),after_sha256:z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  before_observed_at:z.string().datetime().nullable(),after_observed_at:z.string().datetime().nullable(),unchanged:z.union([z.boolean(),z.literal('unknown')]),
}).strict()).max(24);
type SourceIntegrity=z.infer<typeof sourceIntegritySchema>;
type FileSnapshot={source_id:string;sha256:string|null;observed_at:string|null};

/** Host executes typed capabilities. Project/source text never becomes shell code. */
export class WorkExecutionTools {
  private browsers=new Map<string,RoutedBrowser>();
  private allowedUrls=new Set<string>();
  private resultReceipts=new Map<string,{tool_name:'office_result_draft'|'runtime_pack_run';value:Record<string,unknown>}>();
  private packIntegrity=new Map<string,{run_id:string;result_sha256:string;sources:SourceIntegrity}>();
  private dispatched=new Map<string,{name:string;input:Record<string,unknown>;coding_stage?:{id:string;attempts:number};reused_coding_run?:string}>();
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly api:RuntimeApi,readonly workId:string,readonly runId:string,readonly spec:WorkProposal,readonly prompt:string,readonly guard:()=>void,readonly model:StructuredModel,readonly options:{browserFactory?:BrowserRouteOptions['factory']}={}){
    for(const raw of prompt.match(/https?:\/\/[^\s<>"'`]+/gu)??[]){try{this.allowedUrls.add(new URL(raw.replace(/[),.;]+$/u,'')).href);}catch{}}
  }
  catalog():WorkClientTool[]{
    const coding=this.spec.route.kind==='pack'&&this.spec.route.pack_family==='coding.orchestrate';
    const names=Object.keys(effects).filter(name=>!name.startsWith('office_')&&(!name.startsWith('runtime_coding_')||name==='runtime_coding_projects'||coding)) as ExecutionToolName[];
    const descriptors=names.flatMap(name=>{const tool=(tools as Record<string,{schema:z.ZodType;implemented:boolean;readOnly:boolean}>)[name];if(!tool?.implemented)return [];
      return [{name,description:`Agent Office ${name}. Scope: this Work only. ${name==='runtime_files_roots'?'Only folders explicitly granted to this Work are returned. ':''}${name==='runtime_files_request'?'Creates a permission request, never grants access. ':''}${name==='runtime_files_propose'?'Creates a move preview, never moves files. ':''}${name==='runtime_pack_execute_approved'?'Requires an existing human-approved, unconsumed proposal; cannot approve it. ':''}${name==='runtime_windows_step'?'May change an application or send externally; native host approval and postcondition receipts are mandatory. ':''}${name==='runtime_coding_start'?'Choose one registered project_ref. Creates a bounded Codex/Claude CLI stage plan and local Git handoff for this Work. The host supplies Work/request identity. Reuses this Work existing coding run; never resumes an unrelated session. Model-data consent and registered project policy remain mandatory. ':''}${name==='runtime_coding_step'?'Send only the next prepared stage instruction to the configured Codex/Claude CLI, read its actual response, and verify its Git/check receipts. Only same-run saved CLI session IDs may resume; no --last. Repository writes require this Work write delegation and registered policy. Imported plans/stages retain human approval. ':''}${name==='runtime_coding_status'?'Read actual stage progress, exact CLI replies and verification receipts of this Work coding run; completed stages are not proof of whole Work completion. ':''}${name==='runtime_coding_reconcile'?'Inspect uncertain coding effects without replay or automatic acceptance; report required user review. ':''}Only configured executors and approved connections can run. Unknown effects are fenced, not replayed.`,input_schema:z.toJSONSchema(tool.schema),effect:effects[name]}];});
    descriptors.push({name:'office_browser_read',description:'Open and read a URL explicitly supplied by the user, or a link in an already observed page. Returns live text, links, timestamp and executor. Read-only; never submits or signs in. Independent same-environment executor fallback is automatic.',input_schema:z.toJSONSchema(z.object({url:z.string().url().max(4096)}).strict()),effect:'read_only'});
    descriptors.push({name:'office_browser_links',description:'List available user-supplied and observed URLs plus configured browser environments.',input_schema:z.toJSONSchema(z.object({}).strict()),effect:'read_only'});
    descriptors.push({name:'office_result_draft',description:'Save the Work result/report for the user in this Office. Write the requested final text using observed source evidence and requested language/format, without invented facts. The host independently rereads the file and verifies exact bytes and SHA-256 before issuing a verified receipt. Returns text, artifact metadata and request_id. Use office_result_read with that request_id if additional readback is required; runtime_files_report is for user folders, not Office results. Creates only an Office-owned file, never sends a message or changes an external service.',input_schema:z.toJSONSchema(resultInput),effect:'local_write'});
    descriptors.push({name:'office_result_read',description:'Read the actual text of an Office-created output using the exact host invocation request_id from a successful verified office_result_draft or runtime_pack_run receipt, not an ID proposed in tool arguments. Supports local TXT/JSON/CSV artifacts up to 16KB. Rechecks bytes and SHA-256; Pack outputs also require a task-free successful run bound to this Work. Only current Work/run receipts may be read, including persisted receipts after resume. A known failed source-quality output is not readable: correct its grounded recipe and obtain a successful verified receipt first. Arbitrary paths, binary files and other Work files are unavailable. Use this tool to inspect saved Pack rows before computing or summarizing them.',input_schema:z.toJSONSchema(resultReadInput),effect:'read_only'});
    return descriptors;
  }
  private table(name:string){return Boolean(this.store.desktopState.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));}
  private fileRecord(kind:string,id:string){
    requireCondition(this.table('file_explorer_record'),'WORK_TOOL_FILE_SCOPE_MISMATCH');
    const row=this.store.desktopState.prepare('SELECT body FROM file_explorer_record WHERE project=? AND kind=? AND id=?').get(this.config.project.id,kind,id);
    requireCondition(row,'WORK_TOOL_FILE_SCOPE_MISMATCH');return object(JSON.parse(String(row.body)))!;
  }
  private folderGranted(rootId:string){
    return this.table('file_explorer_record')&&Boolean(this.store.desktopState.prepare("SELECT 1 FROM file_explorer_record a JOIN file_explorer_record r ON r.project=a.project AND r.kind='root' AND r.id=json_extract(a.body,'$.root_id') WHERE a.project=? AND a.kind='access' AND json_extract(a.body,'$.work_id')=? AND r.id=? LIMIT 1").get(this.config.project.id,this.workId,rootId));
  }
  private ownScan(scanId:string){
    const scan=this.fileRecord('scan',scanId),rootId=String(scan.root_id);
    requireCondition(this.folderGranted(rootId)&&Boolean(this.store.desktopState.prepare("SELECT 1 FROM file_explorer_record WHERE project=? AND kind='observation' AND json_extract(body,'$.work_id')=? AND json_extract(body,'$.scan_id')=? LIMIT 1").get(this.config.project.id,this.workId,scanId)),'WORK_TOOL_FILE_SCOPE_MISMATCH');return scan;
  }
  private ownWindows(runId:string){
    requireCondition(this.table('windows_workflow_run'),'WORK_TOOL_RUN_SCOPE_MISMATCH');
    const row=this.store.desktopState.prepare('SELECT body FROM windows_workflow_run WHERE project_id=? AND work_id=? AND id=?').get(this.config.project.id,this.workId,runId);
    requireCondition(row,'WORK_TOOL_RUN_SCOPE_MISMATCH');return object(JSON.parse(String(row.body)))!;
  }
  private ownPack(runId:string){
    requireCondition(this.store.officeRuns(this.config.project.id,this.workId).some(r=>r.source_kind==='pack'&&r.source_id===runId),'WORK_TOOL_RUN_SCOPE_MISMATCH');return this.store.packRun(this.config.project.id,runId);
  }
  private ownCoding(runId:string){
    requireCondition(this.store.officeRuns(this.config.project.id,this.workId).some(r=>r.source_kind==='coding'&&r.source_id===runId),'WORK_TOOL_RUN_SCOPE_MISMATCH');
    const run=this.store.codingRun(this.config.project.id,runId);requireCondition(run.work_id===this.workId,'WORK_TOOL_RUN_SCOPE_MISMATCH');return run;
  }
  private codingApproval(runId?:string,projectRef?:string){
    if(this.store.workImportForWork(this.config.project.id,this.workId)?.kind!=='project')return true;
    const row=this.store.desktopState.prepare('SELECT * FROM office_import_coding_approval WHERE project_id=? AND work_id=?').get(this.config.project.id,this.workId);
    if(!runId)return Boolean(row&&row.project_ref===projectRef&&row.plan_approved_at);
    const run=this.ownCoding(runId),stage=this.store.codingStages(this.config.project.id,runId).find(item=>item.status==='pending');
    return Boolean(row&&stage&&row.project_ref===run.project_ref&&row.stage_run_id===runId&&row.stage_id===stage.stage_id&&row.stage_revision===run.revision&&row.stage_approved_at);
  }
  private async codingGitVerified(runId:string){
    const run=this.ownCoding(runId),project=this.config.coding?.projects.find(item=>item.id===run.project_ref),expected=this.store.codingCheckpoint(this.config.project.id,runId);
    requireCondition(project&&expected&&run.project_root===project.root&&run.config_fingerprint===this.config.fingerprint&&await realpath(project.root)===project.root,'WORK_CODING_CHECKPOINT_SCOPE_MISMATCH');
    const observed=await readLocalGitCheckpoint(project.root,async(root,args,timeout_ms)=>{const result=await nativeProcessRunner.run({executable:process.platform==='win32'?'git.exe':'/usr/bin/git',args:['-C',root,...args],cwd:root,timeout_ms:timeout_ms??10_000});requireCondition(result.code===0,'WORK_CODING_GIT_CHECK_FAILED');return result.stdout;});
    return expected.head===observed.head&&expected.state_sha256===observed.state_sha256;
  }
  private resultPath(requestId:string){
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(this.workId)&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(this.runId)&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(requestId),'WORK_RESULT_ID_INVALID');
    return join(dirname(this.config.dbPath),'work-artifacts',this.workId,this.runId,`report-${hashJson(requestId).slice(0,32)}.txt`);
  }
  /** A Work already has a family and the typed tool catalog in its context.
   * Preserve authoritative plan/connection fields; reference only duplicated
   * descriptions rather than embedding every family/schema/example again.
   * The public MCP Pack planning response is unchanged.
   */
  private packPlanView(value:unknown):unknown{
    const data=object(value);if(!data||this.spec.route.kind!=='pack'||!this.spec.route.pack_family)return value;
    const family=this.spec.route.pack_family;
    if(data.requested_family!==undefined)requireCondition(data.requested_family===family,'WORK_TOOL_PACK_FAMILY_MISMATCH');
    const view:Record<string,unknown>={...data,plan_view:{kind:'work_family',family,work_id:this.workId,run_id:this.runId,unscoped_sha256:hashJson(data),unscoped_bytes:Buffer.byteLength(JSON.stringify(data))}};
    const supplied=object(data.recipe_schema);
    if(supplied){
      const advertised=object(object(this.catalog().find(tool=>tool.name==='runtime_pack_run')?.input_schema.properties)?.recipe);
      const equivalent={...supplied};delete equivalent.$schema;
      requireCondition(advertised&&hashJson(equivalent)===hashJson(advertised),'WORK_TOOL_PLAN_SCHEMA_MISMATCH');
      view.recipe_schema={catalog_tool:'runtime_pack_run',input_schema_pointer:'/properties/recipe',sha256:hashJson(advertised),bytes:Buffer.byteLength(JSON.stringify(advertised)),response_sha256:hashJson(supplied),response_bytes:Buffer.byteLength(JSON.stringify(supplied)),reuse:'Use this exact recipe schema from the supplied tool catalog; no schema or permission was relaxed.'};
    }
    if(Array.isArray(data.families)){
      view.families=data.families.filter(item=>object(item)?.id===family);
      view.families_catalog_ref={catalog_tool:'runtime_pack_catalog',pointer:'/families',ids:data.families.flatMap(item=>typeof object(item)?.id==='string'?[object(item)!.id]:[]),sha256:hashJson(data.families),bytes:Buffer.byteLength(JSON.stringify(data.families))};
    }
    if(Array.isArray(data.windows_profiles))view.windows_profiles={catalog_tool:'runtime_windows_catalog',pointer:'/profiles',projection:['id','title','family','example'],ids:data.windows_profiles.flatMap(item=>typeof object(item)?.id==='string'?[object(item)!.id]:[]),sha256:hashJson(data.windows_profiles),bytes:Buffer.byteLength(JSON.stringify(data.windows_profiles)),reuse:'Optional examples are available from the catalog; they are not an allowlist or execution authority.'};
    return view;
  }
  private resultObservations():unknown[]{
    if(!this.table('office_supervisor'))return [];
    const row=this.store.desktopState.prepare('SELECT checkpoint FROM office_supervisor WHERE project_id=? AND work_id=? AND run_id=?').get(this.config.project.id,this.workId,this.runId);
    const checkpoint=row?.checkpoint?object(JSON.parse(String(row.checkpoint))):null;
    return Array.isArray(checkpoint?.observations)?checkpoint.observations:[];
  }
  private async fileSnapshots(recipe:Record<string,unknown>):Promise<FileSnapshot[]>{
    const requested=Array.isArray(recipe.sources)?recipe.sources:[],ids=[...new Set(requested.flatMap(item=>typeof object(item)?.id==='string'?[String(object(item)!.id)]:[]))];
    const snapshots:FileSnapshot[]=[];
    for(const id of ids){
      const source=this.config.packs?.sources.find(item=>item.id===id);if(source?.kind!=='file')continue;
      // Registered source policy and the same no-follow, size and concurrent-
      // change checks as the Pack reader apply. Never return source contents.
      try{const bytes=await readScopedFile(source.path);snapshots.push({source_id:id,sha256:sha(bytes),observed_at:new Date().toISOString()});}
      catch{snapshots.push({source_id:id,sha256:null,observed_at:null});}
    }
    return snapshots;
  }
  private trustedSourceIntegrity(data:Record<string,unknown>,requestId:string|undefined):SourceIntegrity|null{
    if(!requestId||typeof data.run_id!=='string')return null;
    try{
      const run=this.ownPack(data.run_id);
      if(run.request_id!==requestId||run.status!==data.status||hashJson(run.result)!==hashJson(data.result))return null;
      const memory=this.packIntegrity.get(requestId);let raw:unknown=null;
      if(memory?.run_id===run.id&&memory.result_sha256===hashJson(run.result))raw=memory.sources;
      else{
        const saved=this.resultObservations().find(item=>{const record=object(item),invocation=object(record?.invocation),receipt=object(record?.receipt),value=object(receipt?.value);return invocation?.tool_name==='runtime_pack_run'&&invocation.request_id===requestId&&receipt?.effect_state==='verified'&&['succeeded','retryable_failure'].includes(String(receipt.status))&&value?.run_id===run.id&&hashJson(value.result)===hashJson(run.result);});
        raw=object(object(object(saved)?.receipt)?.value)?.source_integrity??null;
      }
      const parsed=sourceIntegritySchema.safeParse(raw);if(!parsed.success||!parsed.data.length)return null;
      const requested=object(run.recipe)?.sources,ids=Array.isArray(requested)?requested.flatMap(item=>typeof object(item)?.id==='string'?[String(object(item)!.id)]:[]):[];
      const fileIds=[...new Set(ids.filter(id=>this.config.packs?.sources.some(source=>source.id===id&&source.kind==='file')))];
      if(parsed.data.length!==fileIds.length||new Set(parsed.data.map(item=>item.source_id)).size!==fileIds.length||parsed.data.some(item=>!fileIds.includes(item.source_id)||item.unchanged!==(item.before_sha256&&item.after_sha256?item.before_sha256===item.after_sha256:'unknown')||Boolean(item.before_sha256)!==Boolean(item.before_observed_at)||Boolean(item.after_sha256)!==Boolean(item.after_observed_at)))return null;
      return structuredClone(parsed.data);
    }catch{return null;}
  }
  /** A rejected quality read may be corrected, but never grants result access.
   * Only a known invocation of this exact Work/run can supply this feedback.
   * Recheck its durable Pack ownership, canonical request ID, result and bytes.
   */
  private async validateResultRead(args:Record<string,unknown>){
    const input=resultReadInput.parse(args),observations=this.resultObservations();
    if(this.resultReceipts.has(input.request_id)||observations.some(item=>{const record=object(item),invocation=object(record?.invocation),receipt=object(record?.receipt);return invocation?.request_id===input.request_id&&receipt?.status==='succeeded'&&receipt.effect_state==='verified';}))return input;
    const candidates=observations.filter(item=>{
      const record=object(item),invocation=object(record?.invocation),receipt=object(record?.receipt),correction=object(object(receipt?.value)?.correction);
      // A persisted model alias only selects feedback, never a file or a grant.
      return invocation?.tool_name==='runtime_pack_run'&&invocation.dispatched===true&&(invocation.request_id===input.request_id||object(invocation.arguments)?.request_id===input.request_id)&&receipt?.status==='retryable_failure'&&receipt.effect_state!=='uncertain'&&correction?.kind==='data_quality';
    });
    if(candidates.length!==1)return input;
    const record=object(candidates[0])!,invocation=object(record.invocation)!,receipt=object(record.receipt)!,value=object(receipt.value),canonical=invocation.request_id;
    if(!value||typeof value.run_id!=='string'||typeof canonical!=='string')return input;
    const run=this.ownPack(value.run_id);
    requireCondition(run.request_id===canonical,'WORK_TOOL_RUN_SCOPE_MISMATCH');
    const current=await this.receipt('runtime_pack_run',value,canonical),correction=object(object(current.value)?.correction);
    if(current.status==='retryable_failure'&&current.effect_state!=='uncertain'&&correction?.kind==='data_quality'){
      throw new WorkClientToolInputError('WORK_RESULT_QUALITY_NOT_VERIFIED',`No result was read. This Pack output failed source-quality checks; its host request_id is ${canonical}. Correct only grounded recipe fields using the preserved verification receipts, then obtain a successful verified Pack receipt before office_result_read. Do not weaken checks or treat rejected data as completed.`);
    }
    return input;
  }
  private normalizedInput(name:string,args:Record<string,unknown>,requestId:string){
    const input={...args};
    if('work_id' in input)requireCondition(input.work_id===this.workId,'WORK_TOOL_SCOPE_MISMATCH');
    if(injectWork.has(name))input.work_id=this.workId;
    if(name==='runtime_pack_run'||name==='runtime_windows_start'||name==='runtime_coding_start')input.request_id=requestId;
    if(name==='runtime_work_context'&&typeof input.run_id==='string'){
      requireCondition(input.run_id===this.runId||this.store.officeRuns(this.config.project.id,this.workId).some(r=>r.source_id===input.run_id),'WORK_TOOL_RUN_SCOPE_MISMATCH');
      if(input.run_id===this.runId)delete input.run_id;
    }
    return input;
  }
  /** Pre-dispatch schema checking: no API, grants, model calls or filesystem effects. */
  validate(name:string,args:Record<string,unknown>,requestId:string){
    requireCondition(this.catalog().some(t=>t.name===name),'WORK_TOOL_NOT_AVAILABLE');
    if(name==='office_browser_read')return browserInput.parse(args);
    if(name==='office_browser_links')return z.object({}).strict().parse(args);
    if(name==='office_result_draft')return resultInput.parse(args);
    if(name==='office_result_read')return this.validateResultRead(args);
    return (tools as Record<string,{schema:z.ZodType}>)[name]!.schema.parse(this.normalizedInput(name,args,requestId));
  }
  async execute(name:string,args:Record<string,unknown>,requestId:string){
    this.guard();this.store.intakeWork(this.config.project.id,this.workId);
    if(name==='office_browser_links'){z.object({}).strict().parse(args);return {urls:[...this.allowedUrls].slice(0,160),executors:browserCatalog(this.config)};}
    if(name==='office_result_read'){
      const {request_id}=resultReadInput.parse(args);let source=this.resultReceipts.get(request_id);
      if(!source){
        const item=this.resultObservations().find(value=>{const record=object(value),invocation=object(record?.invocation),receipt=object(record?.receipt);return (invocation?.tool_name==='office_result_draft'||invocation?.tool_name==='runtime_pack_run')&&invocation.request_id===request_id&&receipt?.status==='succeeded'&&receipt.effect_state==='verified';});
        const found=object(item),invocation=object(found?.invocation),value=object(object(found?.receipt)?.value);
        if(value&&invocation)source={tool_name:invocation.tool_name as 'office_result_draft'|'runtime_pack_run',value};
      }
      requireCondition(source,'WORK_RESULT_RECEIPT_NOT_FOUND');const value=source.value;
      let artifact:Record<string,unknown>|null,path:string,sourceRunId:string|null=null;
      if(source.tool_name==='office_result_draft'){
        artifact=object(value.artifact);path=this.resultPath(request_id);
        requireCondition(value.work_id===this.workId&&value.run_id===this.runId&&artifact?.path===path,'WORK_RESULT_RECEIPT_NOT_FOUND');
      }else{
        requireCondition(value.status==='succeeded'&&value.task_id===null&&typeof value.run_id==='string','WORK_RESULT_RECEIPT_NOT_FOUND');
        const run=this.ownPack(value.run_id);requireCondition(run.status==='succeeded'&&run.task_id===null&&hashJson(run.result)===hashJson(value.result),'WORK_RESULT_RECEIPT_NOT_FOUND');
        artifact=object(object(run.result)?.artifact);requireCondition(typeof artifact?.path==='string'&&resolve(dirname(artifact.path))===resolve(join(dirname(this.config.dbPath),'pack-artifacts')),'WORK_ARTIFACT_SCOPE_MISMATCH');
        path=artifact.path;sourceRunId=run.id;
      }
      requireCondition(artifact&&['txt','json','csv'].includes(String(artifact.format)),'WORK_RESULT_UNSUPPORTED_FORMAT');
      requireCondition(Number.isInteger(artifact.bytes)&&Number(artifact.bytes)<=16000&&Number(artifact.bytes)>=0&&(await stat(path)).size<=16000,'WORK_RESULT_READBACK_TOO_LARGE');
      const bytes=await readScopedFile(path);requireCondition(sha(bytes)===artifact.sha256&&bytes.length===artifact.bytes,'WORK_RESULT_READBACK_MISMATCH');
      requireCondition(!bytes.includes(0),'WORK_RESULT_UNSUPPORTED_FORMAT');let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw Error('WORK_RESULT_UNSUPPORTED_FORMAT');}
      return {status:'succeeded',work_id:this.workId,run_id:this.runId,request_id,source_tool:source.tool_name,source_run_id:sourceRunId,title:value.title??this.spec.title,text:source.tool_name==='office_result_draft'?text.replace(/\n$/u,''):text,artifact,verified_by:'independent_sha256_and_bytes_readback',external_delivery:false};
    }
    if(name==='office_result_draft'){
      const input=resultInput.parse(args),path=this.resultPath(requestId),root=join(dirname(this.config.dbPath),'work-artifacts'),directory=dirname(path),bytes=Buffer.from(input.text+'\n','utf8');
      for(const part of [root,join(root,this.workId),directory]){await mkdir(part,{recursive:true,mode:0o700});requireCondition(await realpath(part)===resolve(part),'WORK_ARTIFACT_SCOPE_MISMATCH');}
      let deduplicated=false;
      try{const handle=await open(path,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;deduplicated=true;}
      const saved=await readScopedFile(path);requireCondition(saved.equals(bytes),'WORK_RESULT_REQUEST_ID_CONFLICT');
      workActivity(this.store,this.config.project.id,this.workId,'result.saved',`Result saved: ${input.label??this.spec.title} · ${saved.length} bytes`);
      return {status:'succeeded',work_id:this.workId,run_id:this.runId,request_id:requestId,title:input.label??this.spec.title,text:input.text,artifact:{path,sha256:sha(saved),bytes:saved.length,format:'txt'},deduplicated,external_delivery:false};
    }
    if(name==='office_browser_read'){
      const {url}=browserInput.parse(args),parsed=new URL(url);
      requireCondition(this.allowedUrls.has(parsed.href),'BROWSER_URL_NOT_OBSERVED');
      assertBrowserUrl(url,[parsed.origin],this.config.environment==='fixture');
      const key=parsed.origin,journal=this.store.browserExecutors(),checkpointKey=`work:${this.runId}:${key}`;
      let browser=this.browsers.get(key);
      if(!browser){browser=new RoutedBrowser(this.config,{profile_key:`work-${this.workId}`,context_id:this.runId,request:this.prompt,preference:this.spec.browser??{environment:'owned_headless'},ephemeral:true,guard:this.guard,providers:{llm:this.model},...(this.options.browserFactory?{factory:this.options.browserFactory}:{}),checkpoint:{load:()=>journal.checkpoint(this.config.project.id,checkpointKey),save:cp=>journal.saveCheckpoint(this.config.project.id,checkpointKey,cp)},event:event=>{journal.append(this.config.project.id,this.runId,event);workActivity(this.store,this.config.project.id,this.workId,`browser.${event.kind}`,`${event.engine} / ${event.environment}${event.from?' ← '+event.from:''}${event.reason?' · '+event.reason:''}`);}},[key]);this.browsers.set(key,browser);await browser.open(url);}else await browser.navigate(url);
      const observed=browserObservationSchema.parse(await browser.observe());this.guard();assertBrowserUrl(observed.url,[key],this.config.environment==='fixture');
      this.allowedUrls.add(new URL(observed.url).href);
      const links=observed.links.filter(link=>{try{const next=new URL(link.url);return !next.username&&!next.password&&!Array.from(next.searchParams.keys()).some(k=>/token|password|secret|api.?key/iu.test(k));}catch{return false;}});
      for(const link of links){try{const next=assertBrowserUrl(link.url,[new URL(link.url).origin],this.config.environment==='fixture');if(this.allowedUrls.has(next.href)||next.origin===key||next.protocol==='https:'&&!/^(?:localhost$|.*\.localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)/iu.test(next.hostname))this.allowedUrls.add(next.href);}catch{}}
      workActivity(this.store,this.config.project.id,this.workId,'source.observed',`${observed.title} · ${observed.url}`);
      // Never rewrite observed hrefs or fill absent links with model guesses.
      return {...observed,links,omitted_sensitive_links:observed.links.length-links.length,requested_url:url,provenance:'live_browser_dom',executor:browser.target?.id,effect:'read_only'};
    }
    requireCondition(this.catalog().some(t=>t.name===name),'WORK_TOOL_NOT_AVAILABLE');
    const input=this.normalizedInput(name,args,requestId);
    const schema=(tools as Record<string,{schema:z.ZodType}>)[name]!.schema;schema.parse(input);
    if(name.startsWith('runtime_pack_')&&typeof input.run_id==='string')this.ownPack(input.run_id);
    if(name.startsWith('runtime_windows_')&&typeof input.run_id==='string')this.ownWindows(input.run_id);
    if(name.startsWith('runtime_coding_')&&typeof input.run_id==='string')this.ownCoding(input.run_id);
    if(name==='runtime_files_roots'){
      const roots=await this.api.call(name,input);requireCondition(Array.isArray(roots),'WORK_TOOL_FILE_SCOPE_MISMATCH');return roots.filter(root=>typeof object(root)?.id==='string'&&this.folderGranted(String(object(root)!.id)));
    }
    if(name==='runtime_files_scan')requireCondition(this.folderGranted(String(input.root_id)),'WORK_TOOL_FILE_SCOPE_MISMATCH');
    if(name.startsWith('runtime_files_')&&typeof input.scan_id==='string')this.ownScan(input.scan_id);
    if(name==='runtime_pack_run'){
      const recipe=object(input.recipe)!;requireCondition(this.spec.route.kind==='pack'&&recipe.family===this.spec.route.pack_family,'WORK_TOOL_PACK_FAMILY_MISMATCH');
      if(recipe.browser&&this.spec.browser)requireCondition(object(recipe.browser)?.environment===this.spec.browser.environment,'BROWSER_WORK_ENVIRONMENT_CONFLICT');
    }
    if(name==='runtime_pack_execute_approved'){
      const run=this.ownPack(String(input.run_id));requireCondition(run.task_id,'PACK_WRITE_NOT_PREPARED');
      const task=this.store.task(run.task_id),proposal=this.store.proposal(run.task_id);
      if(task.status==='succeeded')return {run_id:run.id,status:'succeeded',result:run.result,task_id:run.task_id,reconciled_from_durable_task:true};
      if(proposal.state==='consumed'||task.effect_state==='unknown'||task.status==='reconciliation_required')return {run_id:run.id,status:'reconciliation_required',reason:'PACK_PRIOR_EFFECT_UNCERTAIN',write_replayed:false};
      if(proposal.state!=='approved')return {run_id:run.id,status:'waiting_approval',reason:'HUMAN_APPROVAL_REQUIRED',next_action:'review_exact_proposal_in_control_center',approval_created:false};
    }
    let codingStage:{id:string;attempts:number}|undefined;
    if(name==='runtime_coding_start'){
      if(!this.config.coding?.model_data_approved)return {status:'waiting_approval',reason:'CODING_MODEL_DATA_APPROVAL_REQUIRED',next_action:'configure_coding_connection_in_control_center',approval_created:false};
      requireCondition(this.config.coding.projects.some(item=>item.id===input.project_ref),'CODING_PROJECT_NOT_REGISTERED');
      const prior=this.store.officeRuns(this.config.project.id,this.workId).find(item=>item.source_kind==='coding'||item.source_kind==='coding_dialog');
      if(prior?.source_kind==='coding_dialog')return {status:'waiting_approval',reason:'CODING_DIALOG_USE_USER_CONTROL',next_action:'choose_next_instruction_in_work_detail',approval_created:false};
      if(prior){const run=this.ownCoding(prior.source_id);requireCondition(run.project_ref===input.project_ref,'WORK_CODING_PROJECT_ALREADY_BOUND');this.dispatched.set(requestId,{name,input,reused_coding_run:run.id});return {...object(await this.api.call('runtime_coding_status',{run_id:run.id})),deduplicated:true,reused_existing:true};}
      if(!this.codingApproval(undefined,String(input.project_ref)))return {status:'waiting_approval',reason:'WORK_IMPORT_CODING_PLAN_APPROVAL_REQUIRED',next_action:'approve_imported_coding_plan_in_work_detail',approval_created:false};
    }
    if(name==='runtime_coding_step'){
      const run=this.ownCoding(String(input.run_id)),stage=this.store.codingStages(this.config.project.id,run.id).find(item=>item.status==='pending'),operation=stage?run.plan.stages[stage.ordinal]?.operation:null;
      if(operation&&['implement','document','commit_readme'].includes(operation)&&!['local_file_write','external_effect_requested'].includes(this.spec.requested_effect))return {run_id:run.id,status:'waiting_approval',reason:'WORK_CODING_WRITE_NOT_DELEGATED',next_action:'revise_work_write_scope_in_work_detail',approval_created:false};
      if(!this.codingApproval(run.id))return {run_id:run.id,status:'waiting_approval',reason:'WORK_IMPORT_CODING_STAGE_APPROVAL_REQUIRED',next_action:'approve_exact_imported_coding_stage_in_work_detail',approval_created:false};
      if(stage)codingStage={id:stage.stage_id,attempts:stage.attempts};
    }
    const before=name==='runtime_pack_run'?await this.fileSnapshots(object(input.recipe)!):[];
    if(name==='runtime_pack_run')this.guard();
    this.dispatched.set(requestId,{name,input,...(codingStage?{coding_stage:codingStage}:{})});
    // Once dispatched, return the authoritative receipt even if pause/revision
    // changes during the effect. The bounded executor checkpoints it first and
    // applies the live guard before admitting its next operation.
    const value=await this.api.call(name,input);
    if(name==='runtime_pack_plan')return this.packPlanView(value);
    if(name==='runtime_pack_run'&&typeof object(value)?.run_id==='string'){
      const data=object(value)!,run=this.ownPack(String(data.run_id));
      if(data.deduplicated!==true&&before.length){
        const after=await this.fileSnapshots(object(input.recipe)!),sources=before.map(item=>{const last=after.find(observed=>observed.source_id===item.source_id);return {source_id:item.source_id,before_sha256:item.sha256,after_sha256:last?.sha256??null,before_observed_at:item.observed_at,after_observed_at:last?.observed_at??null,unchanged:item.sha256&&last?.sha256?item.sha256===last.sha256:'unknown' as const};});
        this.packIntegrity.set(requestId,{run_id:run.id,result_sha256:hashJson(run.result),sources});
      }
      // A deduplicated old run cannot gain new before/after execution evidence.
      return {...data,source_integrity:this.trustedSourceIntegrity(data,requestId)};
    }
    if(name==='runtime_windows_start'&&typeof object(value)?.run_id==='string')this.ownWindows(String(object(value)!.run_id));
    if(name==='runtime_coding_start'&&typeof object(value)?.run_id==='string')this.ownCoding(String(object(value)!.run_id));
    return value;
  }
  /** Host-owned receipt normalization. A model/API status alone never verifies a write. */
  async receipt(name:string,value:unknown,requestId?:string):Promise<WorkClientToolReceipt>{
    const effect=effects[name as ExecutionToolName];requireCondition(effect,'WORK_TOOL_NOT_AVAILABLE');
    const data=object(value),readOnly=effect==='read_only';
    let state=String(data?.status??data?.run_status??'succeeded'),status:WorkClientToolReceipt['status']='succeeded';
    if(!readOnly){
      if(name==='runtime_files_request'&&!data?.root_id)state='waiting_approval';
      if(name==='runtime_files_propose'&&data?.state==='preview')state='waiting_approval';
      if(['waiting_auth','waiting_approval','retryable_failure','failed','reconciliation_required'].includes(state))status=state as WorkClientToolReceipt['status'];
      else if(['needs_human','approval_required','needs_approval','needs_review','needs_replan','paused_work','paused_config','cancelled'].includes(state))status='waiting_approval';
      else if(['waiting_connection','waiting_observation','running'].includes(state))status='retryable_failure';
    }
    let effectState:WorkClientToolReceipt['effect_state']=status==='reconciliation_required'?'uncertain':'none',correctableQuality=false;
    if((name==='runtime_pack_run'||name==='runtime_pack_execute_approved')&&typeof data?.run_id==='string'){
      try{const run=this.ownPack(data.run_id);if(run.task_id&&(this.store.task(run.task_id).effect_state==='unknown'||this.store.proposal(run.task_id).state==='consumed'&&this.store.task(run.task_id).status!=='succeeded')){status='reconciliation_required';effectState='uncertain';}}catch{status='reconciliation_required';effectState='uncertain';}
    }
    // A source/field verification error is not a permission request. Only the
    // durable, task-free collection families can expose this correction path;
    // unknown effects, approval tasks and other review states still stop.
    if(name==='runtime_pack_run'&&state==='needs_review'&&data?.task_id===null&&status!=='reconciliation_required'&&typeof data.run_id==='string'){
      try{
        const run=this.ownPack(data.run_id),report=object(object(run.result)?.verification);
        correctableQuality=run.task_id===null&&run.status==='needs_review'&&['research.search','portal.collect','file.pipeline'].includes(run.recipe.family)&&hashJson(run.result)===hashJson(data.result)&&report?.scope==='supplied_source_snapshot'&&report.all_checks_passed===false&&report.originals_modified===false&&Array.isArray(report.receipts);
        if(correctableQuality)status='retryable_failure';
      }catch{/* Missing provenance is never grounds to bypass user review. */}
    }
    if((status==='succeeded'||correctableQuality)&&(effect==='local_write'||effect==='external_write')){
      let verified=false;
      try{
        if(name==='office_result_draft'&&requestId){
          const artifact=object(data?.artifact);requireCondition(data?.work_id===this.workId&&data?.run_id===this.runId&&typeof data?.text==='string'&&artifact?.path===this.resultPath(requestId),'WORK_ARTIFACT_SCOPE_MISMATCH');
          const bytes=await readScopedFile(String(artifact.path));verified=sha(bytes)===artifact.sha256&&bytes.length===artifact.bytes&&bytes.equals(Buffer.from(data.text+'\n','utf8'));
          if(verified)this.resultReceipts.set(requestId,{tool_name:'office_result_draft',value:data});
        }else if(name==='runtime_pack_run'&&typeof data?.run_id==='string'){
          const run=this.ownPack(data.run_id);verified=run.status===data.status&&hashJson(run.result)===hashJson(data.result);
          if(run.task_id)verified=verified&&this.store.task(run.task_id).effect_state==='none'&&this.store.proposal(run.task_id).state!=='consumed';
          const artifact=object(object(run.result)?.artifact);
          if(artifact){
            requireCondition(typeof artifact.path==='string'&&resolve(dirname(artifact.path))===resolve(join(dirname(this.config.dbPath),'pack-artifacts')),'WORK_ARTIFACT_SCOPE_MISMATCH');
            const bytes=await readScopedFile(artifact.path);verified=verified&&sha(bytes)===artifact.sha256&&bytes.length===artifact.bytes;
          }
          if(verified&&status==='succeeded'&&run.task_id===null&&artifact&&requestId)this.resultReceipts.set(requestId,{tool_name:'runtime_pack_run',value:data});
        }else if(name==='runtime_pack_execute_approved'&&typeof data?.run_id==='string'){
          const run=this.ownPack(data.run_id);if(run.task_id){const task=this.store.task(run.task_id);verified=task.project_id===this.config.project.id&&task.status==='succeeded'&&task.effect_state==='observed';}
        }else if(name==='runtime_windows_step'&&typeof data?.run_id==='string'){
          const run=this.ownWindows(data.run_id),receipt=object(Array.isArray(run.receipts)?run.receipts.at(-1):null),input=requestId?this.dispatched.get(requestId)?.input:null;
          verified=Boolean(input&&input.run_id===data.run_id&&typeof input.expected_revision==='number'&&typeof run.revision==='number'&&run.revision>input.expected_revision&&data.revision===run.revision&&run.reason==='POSTCONDITION_VERIFIED'&&receipt?.capture_id&&Array.isArray(receipt.evidence_refs)&&receipt.evidence_refs.length>0&&hashJson(data.receipts)===hashJson(run.receipts));
        }else if((name==='runtime_coding_start'||name==='runtime_coding_step')&&typeof data?.run_id==='string'&&requestId){
          const run=this.ownCoding(data.run_id),invocation=this.dispatched.get(requestId),stages=this.store.codingStages(this.config.project.id,run.id),stage=stages.find(item=>item.stage_id===invocation?.coding_stage?.id);
          const common=invocation?.name===name&&data.work_id===this.workId&&data.project_ref===run.project_ref&&data.revision===run.revision&&data.status===run.status&&hashJson(data.plan)===hashJson(run.plan)&&hashJson(data.stages)===hashJson(stages);
          if(name==='runtime_coding_start')verified=Boolean(common&&invocation.input.project_ref===run.project_ref&&(run.request_id===requestId||invocation.reused_coding_run===run.id)&&await this.codingGitVerified(run.id));
          else verified=Boolean(common&&invocation.input.run_id===run.id&&typeof invocation.input.expected_revision==='number'&&run.revision>invocation.input.expected_revision&&stage?.status==='succeeded'&&stage.attempts===(invocation.coding_stage?.attempts??-1)+1&&stage.receipt&&await this.codingGitVerified(run.id));
        }
      }catch{/* Keep unverified effects visible; do not replay on an exception. */}
      effectState=verified?(correctableQuality&&!object(object(data?.result)?.artifact)?'none':'verified'):'uncertain';if(!verified)status='reconciliation_required';
    }
    const id=requestId&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(requestId)?requestId:null;
    const scopedValue=name==='runtime_pack_run'&&data?{...data,source_integrity:effectState==='verified'?this.trustedSourceIntegrity(data,requestId):null}:value;
    const receiptValue=correctableQuality&&status==='retryable_failure'?{...object(scopedValue),correction:{kind:'data_quality',reason:'PACK_SOURCE_EVIDENCE_VERIFICATION_FAILED',automatic_correction_allowed:true,user_confirmation_required:false,quality_checks_passed:false,next_action:'Inspect preserved source records and verification receipts; correct only grounded recipe fields or collect missing evidence, then retry a validated recipe. Do not invent evidence, weaken requested checks or mark unverified data complete.'}}:scopedValue;
    return {status,value:receiptValue,evidence_ids:status==='succeeded'&&id?[id]:[],effect_state:effectState,retry_safe:effectState==='none'&&(readOnly||status!=='succeeded')};
  }
  async close(){await Promise.allSettled([...this.browsers.values()].map(b=>b.close()));this.browsers.clear();}
}
