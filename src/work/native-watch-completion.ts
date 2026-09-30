import {type HostConfig} from '../interface/config.js';
import {rowSchema,type Row,type Source} from '../packs/contracts.js';
import {applyFilters,deduplicate,MAX_ROWS,parseData,readScopedFile,sha} from '../packs/data.js';
import {PACK_ENGINE_VERSION,watchBaseline} from '../packs/runtime.js';
import {sourceNormalizationMatches,type SourceEvidence} from '../packs/sources.js';
import {type PackStore} from '../packs/store.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type WorkClientCheckpoint} from './client-executor.js';
import {type NativeWatchCompletionPredicate} from './completion-checks.js';
import {type NativeCompletionResolution} from './native-completion.js';

const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const hash=snapshotHash;
const validTime=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=Date.now();

function sourceProof(source:Source,requested:{id:string;parameters:Record<string,string>},rows:Row[],raw:unknown):SourceEvidence|null{
  const proof=object(raw);
  if(!proof||proof.source_id!==requested.id||proof.request_sha256!==hash(requested)||proof.rows!==rows.length||typeof proof.content_sha256!=='string'||!/^[a-f0-9]{64}$/u.test(proof.content_sha256)||!validTime(proof.observed_at))return null;
  if(source.kind==='file'&&proof.executor!=='local_file'||source.kind==='http'&&proof.executor!=='http_get')return null;
  if(source.kind==='http'&&source.json_fields&&hash(proof.projection_fields)!==hash(source.json_fields))return null;
  if(source.kind==='browser'&&!(typeof proof.executor==='string'&&proof.executor.length>0))return null;
  const evidence=proof as unknown as SourceEvidence;
  if(!sourceNormalizationMatches(source,rows,evidence))return null;
  if(source.kind==='browser'&&!source.numeric_columns?.length&&proof.content_sha256!==hash(rows))return null;
  return evidence;
}

/** Saved baseline + latest committed source observation only. A latest tick
 * whose previous snapshot no longer binds the retained original baseline is
 * unknown, because earlier tick rows are not retained by the current store. */
export async function resolveNativeWatchCompletion(store:PackStore,config:HostConfig,workId:string,predicate:NativeWatchCompletionPredicate,observations:WorkClientCheckpoint['observations'],allowedEvidenceIds:string[]):Promise<NativeCompletionResolution>{
  const allowed=new Set(allowedEvidenceIds);let mismatch:NativeCompletionResolution|null=null;
  for(const observed of observations){
    try{
      if(observed.invocation.tool_name!=='runtime_pack_watch_tick'||!observed.invocation.dispatched||observed.receipt.status!=='succeeded'||observed.receipt.effect_state!=='verified')continue;
      const value=object(observed.receipt.value),ids=observed.receipt.evidence_ids.filter(id=>allowed.has(id));
      if(ids.length===0||typeof value?.run_id!=='string'||value.pending!==false||observed.invocation.arguments.run_id!==value.run_id||!Array.isArray(value.processed)||value.processed.length!==1)continue;
      if((store.officeWork(config.project.id,'pack',value.run_id) as {id:string}|null)?.id!==workId)continue;
      const run=store.packRun(config.project.id,value.run_id),recipe=run.recipe;
      if(recipe.family!=='monitor.watch'||run.status!=='watching'||run.task_id!==null||!config.packs||run.binding!==hash({recipe,fingerprint:hash({config:config.fingerprint,engine:PACK_ENGINE_VERSION})}))continue;
      const execution=store.packExecution(config.project.id,run.id),sources=object(execution?.checkpoint.sources),tick=object(execution?.checkpoint.watch_tick),result=object(run.result);
      if(!sources||Object.keys(sources).length!==recipe.sources.length||!tick||!result||!Array.isArray(result.evidence)||!Array.isArray(tick.rows)||!Array.isArray(tick.evidence)||tick.evidence.length!==recipe.sources.length||!validTime(tick.observed_at))continue;
      const state=store.watchState(config.project.id,run.id),reported=object(value.watch),processed=object(value.processed[0]);
      if(!Number.isInteger(tick.cycle)||Number(tick.cycle)<1||tick.cycle!==state.cycle||reported?.run_id!==run.id||reported.cycle!==state.cycle||processed?.run_id!==run.id||processed.cycle!==state.cycle||!['changed','unchanged'].includes(String(processed.status))||hash(processed.evidence)!==hash(tick.evidence))continue;
      const baselineRows:Row[]=[],baselineEvidence:SourceEvidence[]=[],currentRows=tick.rows.map(row=>rowSchema.parse(row));let cursor=0,timeValid=true;
      if(currentRows.length>MAX_ROWS)continue;
      for(const [index,requested] of recipe.sources.entries()){
        const source=config.packs.sources.find(entry=>entry.id===requested.id),saved=object(sources[String(index)]),collected=object(saved?.result);
        if(!source||!saved||saved.binding!==hash({source,requested,config:config.fingerprint})||!collected||saved.digest!==hash(collected)||!Array.isArray(collected.rows))throw Error('WATCH_BASELINE_UNBOUND');
        const initial=collected.rows.map(row=>rowSchema.parse(row)),first=sourceProof(source,requested,initial,collected.evidence),rawLast=object(tick.evidence[index]);
        if(!first||!rawLast||typeof rawLast.rows!=='number'||!Number.isInteger(rawLast.rows)||rawLast.rows<0||cursor+rawLast.rows>currentRows.length)throw Error('WATCH_SOURCE_PROOF_INVALID');
        const latest=currentRows.slice(cursor,cursor+rawLast.rows),last=sourceProof(source,requested,latest,rawLast);cursor+=rawLast.rows;
        if(!last)throw Error('WATCH_SOURCE_PROOF_INVALID');
        const elapsed=Date.parse(last.observed_at)-Date.parse(first.observed_at);
        if(elapsed<=0||elapsed<predicate.minimum_elapsed_seconds*1000)timeValid=false;
        if(source.kind==='file'){
          const bytes=await readScopedFile(source.path),rawRows=parseData(bytes.toString('utf8'),source.format);
          if(sha(bytes)!==last.content_sha256||!sourceNormalizationMatches(source,latest,last,rawRows))throw Error('WATCH_CURRENT_SOURCE_CHANGED');
          if(!source.numeric_columns?.length&&hash(rawRows)!==hash(latest))throw Error('WATCH_CURRENT_ROWS_CHANGED');
        }
        baselineRows.push(...initial);baselineEvidence.push(first);if(baselineRows.length>MAX_ROWS)throw Error('WATCH_ROWS_EXCEEDED');
      }
      if(cursor!==currentRows.length||result.collected_rows!==baselineRows.length||hash(result.evidence)!==hash(baselineEvidence)||tick.observed_at!==object(tick.evidence.at(-1))?.observed_at)continue;
      const before=watchBaseline(recipe,deduplicate(applyFilters(baselineRows,recipe.filters),recipe.deduplicate_by)),after=watchBaseline(recipe,deduplicate(applyFilters(currentRows,recipe.filters),recipe.deduplicate_by));
      const persisted=store.hermesState.prepare('SELECT baseline FROM family_watch WHERE run_id=?').get(run.id);
      if(hash(result.baseline)!==hash(before)||hash(tick.before)!==hash(before)||hash(tick.after)!==hash(after)||!persisted||hash(JSON.parse(String(persisted.baseline)))!==hash(after))continue;
      const changed=recipe.mode==='any_change'?before.digest!==after.digest:Object.entries(after.minima).some(([group,price])=>before.minima[group]!==undefined&&price<before.minima[group]!);
      const change=changed?'changed':'unchanged';if(processed.status!==change)continue;
      // Event schemas do not carry an explicit cycle. Bind the exact before,
      // after and timestamped source proofs to the already checked tick cycle.
      const matching=store.hermesState.prepare("SELECT kind,body,created_at FROM family_event WHERE project_id=? AND run_id=? AND kind='changed'").all(config.project.id,run.id).filter(event=>{
        const body=object(JSON.parse(String(event.body)));
        return body&&hash(body.before)===hash(before)&&hash(body.after)===hash(after)&&hash(body.evidence)===hash(tick.evidence)&&validTime(event.created_at)&&Date.parse(String(event.created_at))>=Date.parse(String(tick.observed_at));
      });
      if(changed&&matching.length!==1||!changed&&matching.length!==0)continue;
      const matches=timeValid&&predicate.mode===recipe.mode&&predicate.value_field===recipe.value_field&&hash(predicate.comparison_fields)===hash(recipe.comparison_fields)&&predicate.expected_change===change;
      const resolution:NativeCompletionResolution={verdict:matches?'supported':'unsupported',reason:matches?'The host independently confirmed two timestamped saved source observations, their declared comparison result and corresponding local event.':'The actual comparison or observation timing differs from the declared native watch contract.',evidence_ids:ids,certificate_sha256:hash({run_id:run.id,cycle:tick.cycle,recipe,before,after,baseline_evidence:baselineEvidence,tick,event:matching,scope:'saved_observations_only',external_notification_absence:'not_asserted'})};
      if(matches)return resolution;mismatch=resolution;
    }catch{/* Missing, corrupt, foreign or unretained source provenance stays unknown. */}
  }
  return mismatch??{verdict:'unknown',reason:'No same-Work current-cycle tick binds two retained source observations and the required local event.',evidence_ids:[]};
}
