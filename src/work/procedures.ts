import {type PackStore} from '../packs/store.js';
import {hashJson} from '../taskpack/adaptive-spec.js';
import {safeControlText} from '../observability/safe-text.js';
import {type WorkClientCheckpoint} from './client-executor.js';

/** Plan B2–B4, first slice: a Work whose completion was verified leaves its procedure behind, and a later
 * similar request gets it as guidance. This is not a Pack and not evidence: it carries no authority, the new run
 * needs its own receipts and its own verification, and a procedure that keeps failing stops being offered. */
export interface SavedProcedure {id:string;request:string;steps:Array<{tool:string;arguments:Record<string,unknown>}>;successes:number;failures:number;}
type Observation=WorkClientCheckpoint['observations'][number];
const trace='office_controlled_run_trace';
/** Arguments that only made sense in the run that produced them. */
const runScoped=new Set(['request_id','work_id','run_id','result_sha256','snapshot_id','offset','max_bytes','text','content']);
const table=`CREATE TABLE IF NOT EXISTS office_procedure(project_id TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,terms TEXT NOT NULL,steps TEXT NOT NULL,source_work_id TEXT NOT NULL,successes INTEGER NOT NULL DEFAULT 1,failures INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,id))`;
const init=(store:PackStore)=>store.hermesState.exec(table);

/** Words that carry the task: letters and digits, two characters or more, without the most common fillers. */
export function requestTerms(request:string):string[]{
  const stop=new Set(['the','and','for','from','with','that','this','into','해줘','해주세요','저장해줘','확인해','에서','으로','하고','그리고','한번','한']);
  return [...new Set((request.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.]{1,}/gu)??[]).map(term=>term.replace(/\.+$/u,'')).filter(term=>term.length>=2&&!stop.has(term)))].slice(0,60);
}
const overlap=(a:readonly string[],b:readonly string[])=>{if(!a.length||!b.length)return 0;const other=new Set(b),shared=a.filter(term=>other.has(term)).length;return shared/(a.length+b.length-shared);};
function cleanArguments(value:unknown,depth=0):unknown{
  if(typeof value==='string')return value.length>300?`${value.slice(0,300)}…`:value;
  if(value===null||typeof value!=='object'||depth>4)return typeof value==='object'&&value!==null?null:value;
  if(Array.isArray(value))return value.slice(0,12).map(item=>cleanArguments(item,depth+1));
  return Object.fromEntries(Object.entries(value).filter(([key])=>!runScoped.has(key)).slice(0,20).map(([key,item])=>[key,cleanArguments(item,depth+1)]));
}
/** The dispatched calls that succeeded, in order, without the readbacks that only confirm a saved file. */
export function procedureSteps(observations:readonly Observation[]):SavedProcedure['steps']{
  return observations.filter(item=>item.invocation.dispatched&&item.receipt.status==='succeeded'&&item.invocation.tool_name!==trace&&item.invocation.tool_name!=='office_result_read')
    .slice(0,16).map(item=>({tool:item.invocation.tool_name,arguments:cleanArguments(item.invocation.arguments) as Record<string,unknown>}));
}
/** Called once for a Work whose completion the host verified. Idempotent per request text. */
export function recordVerifiedProcedure(store:PackStore,project:string,workId:string,request:string,observations:readonly Observation[]):SavedProcedure|null{
  const steps=procedureSteps(observations),terms=requestTerms(request);if(!steps.length||terms.length<2)return null;
  init(store);const id=hashJson({request:request.trim()}).slice(0,32),at=new Date().toISOString(),db=store.hermesState;
  const existing=db.prepare('SELECT successes,failures FROM office_procedure WHERE project_id=? AND id=?').get(project,id) as {successes:number;failures:number}|undefined;
  if(existing)db.prepare('UPDATE office_procedure SET steps=?,source_work_id=?,successes=successes+1,updated_at=? WHERE project_id=? AND id=?').run(JSON.stringify(steps),workId,at,project,id);
  else db.prepare('INSERT INTO office_procedure(project_id,id,request,terms,steps,source_work_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(project,id,safeControlText(request,2000),JSON.stringify(terms),JSON.stringify(steps),workId,at,at);
  return {id,request,steps,successes:(existing?.successes??0)+1,failures:existing?.failures??0};
}
/** A run that was offered this procedure and still did not complete counts against it. */
export function recordProcedureFailure(store:PackStore,project:string,id:string){
  init(store);store.hermesState.prepare('UPDATE office_procedure SET failures=failures+1,updated_at=? WHERE project_id=? AND id=?').run(new Date().toISOString(),project,id);
}
/** The best verified procedure for a similar request, or null. A procedure with more failures than successes
 * is no longer offered; half of the task words must be shared. */
export function similarProcedure(store:PackStore,project:string,request:string,threshold=0.5):(SavedProcedure&{similarity:number})|null{
  init(store);const terms=requestTerms(request);if(terms.length<2)return null;
  let best:(SavedProcedure&{similarity:number})|null=null;
  for(const row of store.hermesState.prepare('SELECT id,request,terms,steps,successes,failures FROM office_procedure WHERE project_id=? AND successes>failures ORDER BY updated_at DESC LIMIT 200').all(project) as Array<{id:string;request:string;terms:string;steps:string;successes:number;failures:number}>){
    const similarity=overlap(terms,JSON.parse(row.terms) as string[]);
    if(similarity>=threshold&&(!best||similarity>best.similarity))best={id:row.id,request:row.request,steps:JSON.parse(row.steps) as SavedProcedure['steps'],successes:row.successes,failures:row.failures,similarity};
  }
  return best;
}
export const procedureGuidance=(procedure:SavedProcedure)=>({from_request:procedure.request,verified_runs:procedure.successes,steps:procedure.steps,
  meaning:'A procedure that completed a similar request and passed verification. Reuse its sources and order when they fit this request; adapt arguments to the current request. It is guidance, not evidence or permission: this run needs its own receipts and is verified on its own.'});
