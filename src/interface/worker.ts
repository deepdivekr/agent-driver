import {fileURLToPath} from 'node:url';
import {loadHostConfig} from './config.js';
import {startRequest} from './catalog.js';
import {RecoveryStore,remainingBudget} from '../supervisor/store.js';
import {processIdentity} from '../supervisor/identity.js';
import {type CheckpointHook} from '../supervisor/contracts.js';
import {runBoundDraft} from '../browser/bound-draft.js';
import {requireCondition} from '../core/contracts.js';
import {configuredBoundary} from '../resources/configured.js';

export async function runWorker(configPath:string,taskId:string,ticket:string,generation:number,checkpoint?:CheckpointHook){
  const config=loadHostConfig(configPath),store=new RecoveryStore(config.dbPath);
  try{
  await configuredBoundary(config);
  requireCondition(store.task(taskId).project_id===config.project.id,'TASK_SCOPE_MISMATCH');
  const identity=await processIdentity(process.pid);requireCondition(typeof identity!=='string','PROCESS_IDENTITY_UNSUPPORTED');
  const row=store.claimWorker(taskId,config.fingerprint,ticket,generation,identity);
  if(checkpoint)await checkpoint('claimed');
  await runBoundDraft(store,config,taskId,startRequest.parse(JSON.parse(row.payload_json)),remainingBudget(row),checkpoint);
  store.workerFinished(taskId,ticket,generation);
  }catch{
    // Recovery and lease reclamation belong to the supervisor after death/profile checks.
    throw Error('WORKER_FAILED');
  }finally{store.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [configPath,taskId,ticket,generation]=process.argv.slice(2);
  try{requireCondition(configPath&&taskId&&ticket&&generation,'WORKER_ARGUMENTS_REQUIRED');await runWorker(configPath,taskId,ticket,Number(generation));}
  catch{process.exitCode=1;}
}
