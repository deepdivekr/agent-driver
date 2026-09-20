import {loadHostConfig,type HostConfig} from '../interface/config.js';
import {startRequest} from '../interface/catalog.js';
import {requireCondition,type Verification} from '../core/contracts.js';
import {type SubmissionRecord} from './contracts.js';
import {type RecoveryStore} from './store.js';

async function readJson(url:string):Promise<Record<string,unknown>>{
  const response=await fetch(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(3000),headers:{'cache-control':'no-store'}});
  requireCondition(response.ok&&response.body,'READBACK_FAILED');
  const reader=response.body.getReader();let total=0;const chunks:Uint8Array[]=[];
  try{while(true){const item=await reader.read();if(item.done)break;total+=item.value.byteLength;requireCondition(total<=16_384,'READBACK_TOO_LARGE');chunks.push(item.value);}}
  finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
}
export async function readDraftResult(config:HostConfig,store:RecoveryStore,row:SubmissionRecord):Promise<Verification>{
  const task=store.task(row.task_id),base={accountRef:config.project.accountRef,targetRef:task.target_ref??'unknown',generation:store.intentGeneration(task.id)};
  try{
    requireCondition(config.environment==='fixture'&&config.fixtureUrl&&loadHostConfig(config.path).fingerprint===row.config_hash,'CONFIG_CHANGED');
    const identity=await readJson(config.fixtureUrl+'api/identity');
    requireCondition(identity.account===base.accountRef&&identity.run_id===new URL(config.fixtureUrl).pathname.split('/')[1],'IDENTITY_MISMATCH');
    const data=await readJson(config.fixtureUrl+'api/record'),request=startRequest.parse(JSON.parse(row.payload_json));
    // Recheck identity and configuration after readback, not merely before it.
    const after=await readJson(config.fixtureUrl+'api/identity');
    requireCondition(after.account===identity.account&&after.run_id===identity.run_id&&loadHostConfig(config.path).fingerprint===row.config_hash,'IDENTITY_CHANGED');
    return {...base,result:data.name===request.input.name&&data.note===request.input.note?'MATCH':'NOT_MATCH',source:'application_identity_and_record',observedMonoMs:performance.now(),detail:{read_only:true}};
  }catch{return {...base,result:'UNKNOWN',source:'readback_unavailable_or_unbound',observedMonoMs:performance.now(),detail:{read_only:true}};}
}
