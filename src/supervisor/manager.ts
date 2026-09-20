import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {RecoveryStore} from './store.js';
import {liveness,type ProcessIdentity} from './identity.js';
import {workerEnvironment} from './supervisor.js';

export async function ensureSupervisor(config:HostConfig){
  const store=new RecoveryStore(config.dbPath);store.registerProject(config.project);
  try{
    const old=store.supervisor(config.project.id);
    if(old?.active){
      const live=await liveness(JSON.parse(old.identity_json) as ProcessIdentity);
      requireCondition(live!=='unknown','SUPERVISOR_IDENTITY_UNKNOWN');
      if(live==='alive'){requireCondition(old.config_hash===config.fingerprint&&!old.stop_requested,'SUPERVISOR_CONFIG_OR_STOP_CHANGED');return old;}
    }
    const child=spawn(process.execPath,[fileURLToPath(new URL('./entry.js',import.meta.url)),config.path],{detached:true,windowsHide:true,shell:false,stdio:'ignore',env:workerEnvironment()});
    await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
    const end=performance.now()+10000;
    while(performance.now()<end){
      const row=store.supervisor(config.project.id);
      if(row?.active&&row.config_hash===config.fingerprint&&!row.stop_requested&&await liveness(JSON.parse(row.identity_json) as ProcessIdentity)==='alive')return row;
      await delay(25);
    }
    throw Error('SUPERVISOR_START_UNCONFIRMED');
  }finally{store.close();}
}
export async function stopSupervisor(config:HostConfig){
  const store=new RecoveryStore(config.dbPath);
  try{
    const row=store.supervisor(config.project.id);if(!row)return {stopped:true,workers:'unobserved'};
    store.stopSupervisor(config.project.id,row.nonce);const end=performance.now()+10000;
    while(performance.now()<end){
      if(await liveness(JSON.parse(row.identity_json) as ProcessIdentity)==='dead')return {stopped:true,workers:'not_terminated'};
      await delay(25);
    }
    return {stopped:false,workers:'not_terminated',reason:'STOP_UNCONFIRMED'};
  }finally{store.close();}
}
export async function supervisorStatus(config:HostConfig){
  const store=new RecoveryStore(config.dbPath);
  try{const row=store.supervisor(config.project.id);return row?{active:row.active===1,liveness:await liveness(JSON.parse(row.identity_json) as ProcessIdentity),stop_requested:row.stop_requested===1,config_matches:row.config_hash===config.fingerprint}:{active:false,liveness:'unobserved'};}
  finally{store.close();}
}
