import {type PackStore} from '../packs/store.js';
import {hashJson} from '../taskpack/adaptive-spec.js';
import {safeControlText} from '../observability/safe-text.js';
import {type WorkClientCheckpoint} from './client-executor.js';
import {buildProcedureTemplate,type ProcedureTemplate} from './procedure-template.js';

/** Plan B2–B4, first slice: a Work whose completion was verified leaves its procedure behind, and a later
 * similar request gets it as guidance. This is not a Pack and not evidence: it carries no authority, the new run
 * needs its own receipts and its own verification, and a procedure that keeps failing stops being offered. */
export interface SavedProcedure {id:string;request:string;steps:Array<{tool:string;arguments:Record<string,unknown>}>;successes:number;failures:number;template?:ProcedureTemplate|null;template_runs?:number;}
type Observation=WorkClientCheckpoint['observations'][number];
const trace='office_controlled_run_trace';
/** Arguments that only made sense in the run that produced them. */
const runScoped=new Set(['request_id','work_id','run_id','result_sha256','snapshot_id','offset','max_bytes','text','content']);
const table=`CREATE TABLE IF NOT EXISTS office_procedure(project_id TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,terms TEXT NOT NULL,steps TEXT NOT NULL,source_work_id TEXT NOT NULL,successes INTEGER NOT NULL DEFAULT 1,failures INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,id))`;
const init=(store:PackStore)=>{
  const db=store.hermesState;db.exec(table);const columns=new Set(db.prepare('PRAGMA table_info(office_procedure)').all().map(column=>String(column.name)));
  if(!columns.has('consecutive_failures'))db.exec('ALTER TABLE office_procedure ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0');
  if(!columns.has('disabled'))db.exec('ALTER TABLE office_procedure ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  if(!columns.has('template'))db.exec('ALTER TABLE office_procedure ADD COLUMN template TEXT');
  if(!columns.has('spec'))db.exec('ALTER TABLE office_procedure ADD COLUMN spec TEXT');
  if(!columns.has('template_runs'))db.exec('ALTER TABLE office_procedure ADD COLUMN template_runs INTEGER NOT NULL DEFAULT 0');
};
/** Plan B2 life cycle. A procedure starts as a candidate, becomes regular at its second verified run, is demoted
 * (no longer offered) after two failures in a row, and returns with its next verified run. Only the owner switches it off. */
export type ProcedureGrade='candidate'|'regular'|'demoted'|'off';
const grade=(row:{successes:number;consecutive_failures:number;disabled:number}):ProcedureGrade=>row.disabled?'off':row.consecutive_failures>=2?'demoted':row.successes>=2?'regular':'candidate';

/** Words that carry the task: letters and digits, two characters or more, without the most common fillers. */
export function requestTerms(request:string):string[]{
  const stop=new Set(['the','and','for','from','with','that','this','into','해줘','해주세요','저장해줘','확인해','에서','으로','하고','그리고','한번','한']);
  // A Korean particle at the end of a word is not part of the task word ("json으로" and "json" are the same term).
  const stem=(term:string)=>{const cut=term.replace(/(?:에서|으로|[의을를은는이가과와로에도])$/u,'');return cut.length>=2?cut:term;};
  return [...new Set((request.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.]{1,}/gu)??[]).map(term=>term.replace(/\.+$/u,'')).filter(term=>term.length>=2&&!stop.has(term)).map(stem))].slice(0,60);
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
/** Called once for a Work whose completion the host verified. One procedure per request text or offered procedure. */
export function recordVerifiedProcedure(store:PackStore,project:string,workId:string,request:string,observations:readonly Observation[],offeredId?:string,options:{keepTemplate?:boolean;spec?:unknown;templateRun?:boolean}={}):SavedProcedure|null{
  const steps=procedureSteps(observations),terms=requestTerms(request);if(!steps.length||terms.length<2)return null;
  // A run that was guided by a saved procedure and passed verification is that procedure's next success.
  init(store);const id=offeredId??hashJson({request:request.trim()}).slice(0,32),at=new Date().toISOString(),db=store.hermesState;
  const existing=db.prepare('SELECT successes,failures FROM office_procedure WHERE project_id=? AND id=?').get(project,id) as {successes:number;failures:number}|undefined;
  // The template comes from a run the model set up itself. A run the host produced from a template keeps the one it used.
  const template=options.keepTemplate?undefined:buildProcedureTemplate(request,observations),templateJson=template?JSON.stringify(template):null;
  if(existing)db.prepare(`UPDATE office_procedure SET steps=?,source_work_id=?,successes=successes+1,consecutive_failures=0,updated_at=?${options.keepTemplate?'':',template=?'} WHERE project_id=? AND id=?`).run(...[JSON.stringify(steps),workId,at,...(options.keepTemplate?[]:[templateJson]),project,id]);
  else db.prepare('INSERT INTO office_procedure(project_id,id,request,terms,steps,source_work_id,template,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(project,id,safeControlText(request,2000),JSON.stringify(terms),JSON.stringify(steps),workId,templateJson,at,at);
  // The verified plan of this request, for an identical later request; and how often the template itself held up.
  if(options.spec!==undefined)db.prepare('UPDATE office_procedure SET spec=? WHERE project_id=? AND id=?').run(JSON.stringify(options.spec),project,id);
  if(options.templateRun)db.prepare('UPDATE office_procedure SET template_runs=template_runs+1 WHERE project_id=? AND id=?').run(project,id);
  else if(!options.keepTemplate)db.prepare('UPDATE office_procedure SET template_runs=0 WHERE project_id=? AND id=?').run(project,id);
  return {id,request,steps,successes:(existing?.successes??0)+1,failures:existing?.failures??0};
}
/** A run that was offered this procedure and still did not complete counts against it. */
export function recordProcedureFailure(store:PackStore,project:string,id:string){
  init(store);store.hermesState.prepare('UPDATE office_procedure SET failures=failures+1,consecutive_failures=consecutive_failures+1,updated_at=? WHERE project_id=? AND id=?').run(new Date().toISOString(),project,id);
}
/** The best verified procedure for a similar request, or null. A demoted or switched-off procedure is not
 * offered; half of the task words must be shared. */
export function similarProcedure(store:PackStore,project:string,request:string,threshold=0.5):(SavedProcedure&{similarity:number})|null{
  init(store);const terms=requestTerms(request);if(terms.length<2)return null;
  let best:(SavedProcedure&{similarity:number})|null=null;
  for(const row of store.hermesState.prepare('SELECT id,request,terms,steps,successes,failures,template,template_runs FROM office_procedure WHERE project_id=? AND disabled=0 AND consecutive_failures<2 ORDER BY updated_at DESC LIMIT 200').all(project) as Array<{id:string;request:string;terms:string;steps:string;successes:number;failures:number;template:string|null;template_runs:number}>){
    const similarity=overlap(terms,JSON.parse(row.terms) as string[]);
    if(similarity>=threshold&&(!best||similarity>best.similarity))best={id:row.id,request:row.request,steps:JSON.parse(row.steps) as SavedProcedure['steps'],successes:row.successes,failures:row.failures,similarity,template:row.template?JSON.parse(row.template) as ProcedureTemplate:null,template_runs:row.template_runs};
  }
  return best;
}
/** Above this similarity the request is the same task reworded or repeated, and its read steps are replayed. */
export const REPLAY_SIMILARITY=0.75;
export const procedureGuidance=(procedure:SavedProcedure)=>({from_request:procedure.request,verified_runs:procedure.successes,steps:procedure.steps,
  meaning:'A procedure that completed a similar request and passed verification. Reuse its sources and order when they fit this request; adapt arguments to the current request. It is guidance, not evidence or permission: this run needs its own receipts and is verified on its own.'});
type ProcedureRow={id:string;request:string;terms:string;steps:string;successes:number;failures:number;consecutive_failures:number;disabled:number;template?:string|null;template_runs?:number;spec?:string|null};
const offerable='disabled=0 AND consecutive_failures<2';
/** Plan B3: the few verified procedures closest to this request, for the planner to choose from. Names of tools
 * only: no arguments, values or results enter the planning input. */
export function procedureCandidates(store:PackStore,project:string,request:string,limit=3){
  init(store);const terms=requestTerms(request);if(terms.length<2)return [];
  return (store.hermesState.prepare(`SELECT id,request,terms,steps,successes,failures,consecutive_failures,disabled FROM office_procedure WHERE project_id=? AND ${offerable} ORDER BY updated_at DESC LIMIT 200`).all(project) as ProcedureRow[])
    .map(row=>({id:row.id,request:row.request,grade:grade(row),verified_runs:row.successes,failed_runs:row.failures,similarity:Math.round(overlap(terms,JSON.parse(row.terms) as string[])*100)/100,tools:[...new Set((JSON.parse(row.steps) as SavedProcedure['steps']).map(step=>step.tool))]}))
    .filter(item=>item.similarity>=0.3).sort((a,b)=>b.similarity-a.similarity).slice(0,limit);
}
/** The procedure the planner selected, if it is still offerable. */
export function selectedProcedure(store:PackStore,project:string,id:string,request:string):(SavedProcedure&{similarity:number;grade:ProcedureGrade})|null{
  init(store);const row=store.hermesState.prepare(`SELECT id,request,terms,steps,successes,failures,consecutive_failures,disabled,template,template_runs FROM office_procedure WHERE project_id=? AND id=? AND ${offerable}`).get(project,id) as ProcedureRow|undefined;
  return row?{id:row.id,request:row.request,steps:JSON.parse(row.steps) as SavedProcedure['steps'],successes:row.successes,failures:row.failures,similarity:overlap(requestTerms(request),JSON.parse(row.terms) as string[]),grade:grade(row),template:row.template?JSON.parse(row.template) as ProcedureTemplate:null,template_runs:row.template_runs??0}:null;
}
/** For the Control Center: what was learned, how it has done, and whether the owner switched it off. */
export function listProcedures(store:PackStore,project:string){
  init(store);
  return (store.hermesState.prepare('SELECT id,request,steps,successes,failures,consecutive_failures,disabled,updated_at FROM office_procedure WHERE project_id=? ORDER BY updated_at DESC LIMIT 200').all(project) as Array<{id:string;request:string;steps:string;successes:number;failures:number;consecutive_failures:number;disabled:number;updated_at:string}>)
    .map(row=>({id:row.id,request:row.request,grade:grade(row),successes:row.successes,failures:row.failures,steps:(JSON.parse(row.steps) as unknown[]).length,updated_at:row.updated_at}));
}
export function setProcedureDisabled(store:PackStore,project:string,id:string,disabled:boolean):boolean{
  init(store);return Number(store.hermesState.prepare('UPDATE office_procedure SET disabled=?,updated_at=? WHERE project_id=? AND id=?').run(Number(disabled),new Date().toISOString(),project,id).changes)===1;
}
/** Shortest path at intake: the same request (the same task words) was planned and verified before, so its plan is
 * used again instead of asking the planner. A reworded particle is the same request; a changed word is not. */
export function identicalProcedure(store:PackStore,project:string,request:string):{id:string;spec:unknown}|null{
  init(store);const terms=requestTerms(request);if(terms.length<2)return null;const wanted=[...terms].sort().join('\u0000');
  for(const row of store.hermesState.prepare(`SELECT id,terms,spec FROM office_procedure WHERE project_id=? AND spec IS NOT NULL AND ${offerable} ORDER BY updated_at DESC LIMIT 200`).all(project) as Array<{id:string;terms:string;spec:string}>){
    if([...(JSON.parse(row.terms) as string[])].sort().join('\u0000')===wanted)return {id:row.id,spec:JSON.parse(row.spec)};
  }
  return null;
}
/** A template that produced verified results this many times in a row is trusted: its repeats are verified in code. */
export const TRUSTED_TEMPLATE_RUNS=2;
