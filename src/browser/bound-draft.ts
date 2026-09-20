import {chromium, type BrowserContext} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Runtime} from '../core/runtime.js';
import {RuntimeStore} from '../store/runtime-store.js';
import {requireCondition, type Lease, type Observation, type RuntimeAdapter} from '../core/contracts.js';
import {browserResource,guard} from '../policy/dispatch-guard.js';
import {FIXTURE_DRAFT} from './fixture-driver.js';
import {type HostConfig} from '../interface/config.js';
import {type StartRequest} from '../interface/catalog.js';

// This route speaks only the configured synthetic draft application contract.
// A future real-site adapter must supply its own observer/verifier and evidence.
export async function runBoundDraft(store:RuntimeStore,config:HostConfig,taskId:string,request:StartRequest,remainingMs:number){
  requireCondition(config.environment==='fixture'&&config.fixtureUrl,'FIXTURE_DISABLED');
  const started=performance.now(),url=config.fixtureUrl,project=config.project;
  let context:BrowserContext|undefined,lease:Lease|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  try {
    requireCondition(remainingMs>0,'DEADLINE_EXCEEDED');
    const target=`owned-page:${randomUUID()}`;let backoff=25;
    while(!lease){
      requireCondition(performance.now()-started<remainingMs,'DEADLINE_EXCEEDED');
      try{lease=store.acquire(taskId,browserResource(project),target);}catch(error){
        if(!(error instanceof Error)||error.message!=='RESOURCE_BUSY')throw error;
        await delay(Math.min(backoff,Math.max(1,remainingMs-(performance.now()-started))));backoff=Math.min(backoff*2,250);
      }
    }
    const ownedLease=lease,targetRef=store.task(taskId).target_ref!;
    await mkdir(project.profileRef,{recursive:true,mode:0o700});
    context=await chromium.launchPersistentContext(project.profileRef,{headless:true,timeout:Math.max(1,remainingMs-(performance.now()-started))});
    const budget=remainingMs-(performance.now()-started);requireCondition(budget>0,'DEADLINE_EXCEEDED');
    timer=setTimeout(()=>{void context?.close().catch(()=>{});},budget);
    const page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(Math.min(5000,budget));
    await page.goto(url,{timeout:budget,waitUntil:'domcontentloaded'});
    requireCondition(page.url()===url,'TARGET_URL_CHANGED');
    const observe=async():Promise<Observation>=>{
      const state=page.isClosed()?null:await page.evaluate(()=>({account:document.querySelector('#account')?.textContent,origin:location.origin,visibility:document.visibilityState}));
      return {targetRef,targetExists:state!==null,ownerTaskId:taskId,projectId:project.id,profileRef:project.profileRef,accountRef:state?.account??'unknown',origin:state?.origin??'unknown',generation:ownedLease.generation,observedMonoMs:performance.now(),visibility:state?.visibility==='visible'?'visible':state?.visibility==='hidden'?'hidden':'unknown',environment:'owned_headless'};
    };
    const adapter:RuntimeAdapter={observe,async execute(){
      await page.locator('#edit').click();await page.locator('#name').fill(request.input.name);await page.locator('#note').fill(request.input.note);
      // Filling can yield: recheck the cancellation/fence immediately before the committing click.
      guard(store,{taskId,callerRef:project.callerRef,lease:ownedLease,capability:FIXTURE_DRAFT,observation:await observe(),maxObservationAgeMs:3000},performance.now(),true);
      requireCondition(!store.task(taskId).cancel_requested,'CANCELLED_BEFORE_SAVE');
      await page.locator('#save').click();
      await page.waitForFunction(()=>['true','error'].includes(document.querySelector('#state')?.getAttribute('data-ready')??''));
      requireCondition(await page.locator('#state').getAttribute('data-ready')==='true','SAVE_RESPONSE_UNKNOWN');
    },async verify(){
      const response=await context!.request.get(url+'api/record',{maxRedirects:0,timeout:Math.max(1,remainingMs-(performance.now()-started))});
      requireCondition(response.ok(),'READBACK_FAILED');const data=await response.json() as Record<string,unknown>;
      return {result:data.name===request.input.name&&data.note===request.input.note?'MATCH':'NOT_MATCH',source:'application_get_record',accountRef:project.accountRef,targetRef,generation:ownedLease.generation,observedMonoMs:performance.now(),detail:{name_matches:data.name===request.input.name,note_matches:data.note===request.input.note}};
    }};
    await new Runtime(store,[FIXTURE_DRAFT]).execute(taskId,project.callerRef,ownedLease,FIXTURE_DRAFT.route,request.input,adapter,{releaseLeaseOnComplete:false});
  } catch(error){
    const current=store.task(taskId);
    if(!['succeeded','failed','cancelled'].includes(current.status)){
      if(current.effect_state==='none'){
        store.pauseBeforeDispatch(taskId,error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'BROWSER_DEPENDENCY_FAILED');
      }else store.recoverTask(taskId);
    }
  } finally {
    if(timer)clearTimeout(timer);await context?.close();
    // Do not hand a shared profile to another worker until this context is closed.
    if(lease&&['succeeded','cancelled','paused_dependency'].includes(store.task(taskId).status))store.release(lease);
  }
}
