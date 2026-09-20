import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {requireCondition} from '../core/contracts.js';
import {loadHostConfig,type HostConfig} from '../interface/config.js';
import {RecoveryStore,remainingBudget} from './store.js';
import {bootClock,liveness,processIdentity,profileOccupancy,type ProcessIdentity} from './identity.js';
import {type SubmissionRecord} from './contracts.js';
import {readDraftResult} from './reconcile.js';
import {configuredBoundary,resourceFence} from '../resources/configured.js';
import {type BudgetHandle} from '../resources/budget.js';

export function workerEnvironment(){
  const keys=['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','PLAYWRIGHT_BROWSERS_PATH','XDG_CACHE_HOME'];
  return Object.fromEntries(keys.flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]]));
}
export function launchWorker(config:HostConfig,row:SubmissionRecord):Promise<ProcessIdentity|'dead'|'unknown'>{
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../interface/worker.js',import.meta.url)),config.path,row.task_id,row.launch_nonce!,String(row.dispatch_generation)],{detached:true,windowsHide:true,shell:false,stdio:'ignore',env:workerEnvironment()});
    child.once('error',reject);child.once('spawn',()=>{child.unref();void processIdentity(child.pid!).then(resolve);});
  });
}
export class Supervisor{
  readonly store:RecoveryStore;nonce:string|null=null;
  private resourceBoundary:BudgetHandle|null=null;
  constructor(readonly config:HostConfig,readonly launch:typeof launchWorker=launchWorker){this.store=new RecoveryStore(config.dbPath);this.store.registerProject(config.project);}
  async start(){
    this.resourceBoundary=await configuredBoundary(this.config);
    const old=this.store.supervisor(this.config.project.id);
    if(old?.active){requireCondition(await liveness(JSON.parse(old.identity_json) as ProcessIdentity)==='dead','SUPERVISOR_ALREADY_ACTIVE_OR_UNKNOWN');}
    const identity=await processIdentity(process.pid);requireCondition(typeof identity!=='string','PROCESS_IDENTITY_UNSUPPORTED');
    this.nonce=this.store.claimSupervisor(this.config.project.id,this.config.fingerprint,identity,old?.nonce??null);
  }
  async step(){
    resourceFence(this.resourceBoundary);
    requireCondition(this.nonce,'SUPERVISOR_NOT_STARTED');const nonce=this.nonce,project=this.config.project.id;
    this.store.own(project,nonce);requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');
    for(const row of this.store.submissions(project)){
      this.store.own(project,nonce);
      if(row.recovery_state==='reserved'){
        // Revoking an UNCLAIMED ticket is safe even if its process is alive: the
        // atomic worker claim is required before ANY browser or external effect.
        if(row.launch_owner!==nonce||row.retry_after_ms<=bootClock().uptimeMs||(row.worker_identity_json&&await liveness(JSON.parse(row.worker_identity_json) as ProcessIdentity)==='dead')){
          const latest=this.store.submission(row.task_id);
          if(latest.recovery_state==='reserved')this.store.recoverDead(latest,nonce,this.config.recoveryPolicy,this.config.fingerprint);
        }
        continue;
      }
      if(row.recovery_state==='running'){
        if(await liveness(row.worker_identity_json?JSON.parse(row.worker_identity_json) as ProcessIdentity:null)!=='dead')continue;
        if(await profileOccupancy(this.config.project.profileRef)!=='clear')continue;
        this.store.recoverDead(row,nonce,this.config.recoveryPolicy,this.config.fingerprint);
      }
      const current=this.store.submission(row.task_id);
      if(current.recovery_state==='reconcile'){
        if(await liveness(current.worker_identity_json?JSON.parse(current.worker_identity_json) as ProcessIdentity:null)!=='dead')continue;
        if(await profileOccupancy(this.config.project.profileRef)!=='clear')continue;
        this.store.reconcile(current,nonce,await readDraftResult(this.config,this.store,current));
      }
    }
    const rows=this.store.submissions(project);
    if(rows.some(r=>['reserved','running','reconcile','legacy_unknown'].includes(r.recovery_state))||this.store.resourceBusy(project))return;
    for(const row of rows){
      if(row.recovery_state!=='pending')continue;
      if(this.store.task(row.task_id).status==='cancelled'){this.store.recoverDead(row,nonce,this.config.recoveryPolicy,this.config.fingerprint);continue;}
      const reason=row.config_hash!==this.config.fingerprint?'CONFIG_CHANGED':remainingBudget(row)<=0?'DEADLINE_OR_BOOT_CHANGED':row.attempt_count>=3?'RESTART_BUDGET_EXHAUSTED':null;
      if(reason){this.store.block(row,nonce,reason);continue;}
      if(row.retry_after_ms>bootClock().uptimeMs)continue;
      if(await profileOccupancy(this.config.project.profileRef)!=='clear')return;
      const reserved=this.store.reserve(project,nonce,row.task_id);
      let launched:ProcessIdentity|'dead'|'unknown';
      try{launched=await this.launch(this.config,reserved);}catch{launched='dead';}
      if(typeof launched!=='string')this.store.noteLaunch(reserved,nonce,launched);
      else if(launched==='dead'){
        const current=this.store.submission(row.task_id);
        if(current.recovery_state==='reserved')this.store.recoverDead(current,nonce,this.config.recoveryPolicy,this.config.fingerprint);
      }
      return;
    }
  }
  async run(){try{await this.start();while(true){
    try{await this.step();}catch(error){if(!(error instanceof Error)||error.message!=='RECOVERY_RACE')throw error;}
    await delay(200);
  }}finally{this.close();}}
  close(){if(this.nonce){this.store.retireSupervisor(this.config.project.id,this.nonce);this.nonce=null;}this.store.close();}
}
