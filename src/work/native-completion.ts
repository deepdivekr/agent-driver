import {type HostConfig} from '../interface/config.js';
import {nativeOutputCertificate} from '../packs/native-output-certificate.js';
import {type PackStore} from '../packs/store.js';
import {PACK_ENGINE_VERSION} from '../packs/runtime.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type WorkClientCheckpoint} from './client-executor.js';
import {nativeCompletionPredicateSchema,type NativeCompletionPredicate} from './completion-checks.js';
import {resolveNativeWatchCompletion} from './native-watch-completion.js';

type Observation=WorkClientCheckpoint['observations'][number];
export interface NativeCompletionResolution {
  verdict:'supported'|'unsupported'|'unknown';reason:string;evidence_ids:string[];
  certificate_sha256?:string;
}
export type NativeCompletionResolver=(predicate:NativeCompletionPredicate,observations:Observation[],allowedEvidenceIds:string[])=>Promise<NativeCompletionResolution>;
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;

/** Host-only resolver. Receipt certificate JSON is never authoritative: reopen
 * the same Work's owned durable run and independently check current bytes. */
export function createNativeCompletionResolver(store:PackStore,config:HostConfig,workId:string):NativeCompletionResolver{
  return async(rawPredicate,observations,allowedEvidenceIds)=>{
    const parsed=nativeCompletionPredicateSchema.safeParse(rawPredicate);
    if(!parsed.success)return {verdict:'unknown',reason:'The native completion contract is invalid.',evidence_ids:[]};
    const predicate=parsed.data,allowed=new Set(allowedEvidenceIds);
    if(predicate.kind==='native_watch_observations')return resolveNativeWatchCompletion(store,config,workId,predicate,observations,allowedEvidenceIds);
    let mismatch:NativeCompletionResolution|null=null;
    for(const observation of observations){
      try{
        if(!['runtime_pack_run','runtime_pack_status'].includes(observation.invocation.tool_name)||!observation.invocation.dispatched||observation.receipt.status!=='succeeded'||observation.receipt.effect_state==='uncertain')continue;
        const ids=observation.receipt.evidence_ids.filter(id=>allowed.has(id)),value=object(observation.receipt.value);
        if(ids.length===0||typeof value?.run_id!=='string'||value.status!=='succeeded')continue;
        const owned=store.officeWork(config.project.id,'pack',value.run_id) as {id:string}|null;
        if(owned?.id!==workId)continue;
        const run=store.packRun(config.project.id,value.run_id);
        const binding=snapshotHash({recipe:run.recipe,fingerprint:snapshotHash({config:config.fingerprint,engine:PACK_ENGINE_VERSION})});
        if(run.binding!==binding||run.status!=='succeeded'||run.task_id!==null||snapshotHash(value.result)!==snapshotHash(run.result))continue;
        if(observation.invocation.tool_name==='runtime_pack_run'&&run.request_id!==observation.invocation.request_id)continue;
        if(observation.invocation.tool_name==='runtime_pack_status'&&observation.invocation.arguments.run_id!==run.id)continue;
        const certificate=await nativeOutputCertificate(store,config,run);
        if(!certificate)continue;
        const expected={family:predicate.family,format:predicate.format,columns:predicate.columns,output_rows:predicate.output_rows==='observed_source_rows'?certificate.observed_source_rows:predicate.output_rows,numeric_columns:predicate.numeric_columns,sort:predicate.sort};
        const actual={family:certificate.family,format:certificate.format,columns:certificate.columns,output_rows:certificate.output_rows,numeric_columns:certificate.numeric_columns,sort:certificate.sort};
        const matches=snapshotHash(expected)===snapshotHash(actual);
        const resolution:NativeCompletionResolution={verdict:matches?'supported':'unsupported',reason:matches?'Fresh host readback matches every declared native output expectation.':'Fresh host readback differs from the declared native output expectations.',evidence_ids:ids,certificate_sha256:snapshotHash(certificate)};
        if(matches)return resolution;
        mismatch=resolution;
      }catch{/* Missing, changed or foreign provenance never acquires native authority. */}
    }
    return mismatch??{verdict:'unknown',reason:'No unchanged same-Work Pack result has a fresh valid native output certificate.',evidence_ids:[]};
  };
}
