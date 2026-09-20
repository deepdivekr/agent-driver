import {randomUUID} from 'node:crypto';
import {loadHostConfig} from './config.js';
import {startRequest} from './catalog.js';
import {RuntimeStore} from '../store/runtime-store.js';
import {runBoundDraft} from '../browser/bound-draft.js';
import {requireCondition} from '../core/contracts.js';

const [configPath,taskId]=process.argv.slice(2);
let store:RuntimeStore|undefined,claimed=false;
try{
  requireCondition(configPath&&taskId,'WORKER_ARGUMENTS_REQUIRED');
  const config=loadHostConfig(configPath);store=new RuntimeStore(config.dbPath);
  requireCondition(store.task(taskId).project_id===config.project.id,'TASK_SCOPE_MISMATCH');
  const submission=store.claimSubmission(taskId,config.fingerprint,randomUUID());claimed=true;
  const request=startRequest.parse(submission.payload);
  const age=Math.max(0,Date.now()-Date.parse(submission.acceptedAt));
  await runBoundDraft(store,config,taskId,request,request.deadline_ms-age);
}catch{
  // Never print prompts, configuration values or upstream errors to inherited logs.
  if(claimed&&store&&taskId){try{const t=store.task(taskId);if(!['succeeded','failed','cancelled','paused_dependency','reconciliation_required'].includes(t.status))store.recoverTask(taskId);}catch{}}
  process.exitCode=1;
}finally{store?.close();}
