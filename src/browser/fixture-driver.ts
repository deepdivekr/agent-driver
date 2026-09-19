// Test-app-only adapter. It cannot attach to user browsers or accept an external URL.
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startFixture } from '../evaluation-v2/fixture.js';
import { makeCase, verify as taskOracle } from '../evaluation-v2/oracle.js';
import { RuntimeStore } from '../store/runtime-store.js';
import { Runtime } from '../core/runtime.js';
import { browserResource } from '../policy/dispatch-guard.js';
import { chooseRoute } from '../policy/routes.js';
import { type Observation, type Capability, type RuntimeAdapter, requireCondition } from '../core/contracts.js';

export const FIXTURE_DRAFT:Capability={id:'fixture.draft.save',effect:'write_external',route:'playwright.fixture.draft.v1',environments:['owned_headless'],hiddenVerified:false,requiresForeground:false,requiresOsInput:false,usesUserTarget:false,requiresClipboard:false,requiresFileDialog:false,verification:'independent_readback'};
export async function runFixtureDemo(dbPath:string,dataRoot:string,options:{fault?:'before'|'after'|'none';wrongAccount?:boolean}={}) {
  await mkdir(dataRoot,{recursive:true,mode:0o700});
  const store=new RuntimeStore(dbPath);let fixture:Awaited<ReturnType<typeof startFixture>>|undefined,context:BrowserContext|undefined,page:Page|undefined;
  try {
  fixture=await startFixture();
  const id=randomUUID(),spec=makeCase(`demo-${id}`,'S02',17,'normal');
  if(options.fault==='before')spec.responseFault='drop_before_save';if(options.fault==='after')spec.responseFault='drop_after_save';
  const original=fixture.create(spec),url=options.wrongAccount?original.replace('/account-a/','/account-b/'):original,origin=new URL(original).origin;
  const profile=await mkdtemp(join(dataRoot,'owned-profile-'));
  const project={id:`demo-${id}`,callerRef:'local-demo-owner',worktree:process.cwd(),profileRef:profile,accountRef:spec.account,allowedOrigins:[origin],capabilities:[FIXTURE_DRAFT.id]};
  store.registerProject(project);const task=store.createTask(project.id,FIXTURE_DRAFT.id),targetRef=`owned-page:${randomUUID()}`,lease=store.acquire(task.id,browserResource(project),targetRef);
  try {
    // Startup scope is fixed to this freshly created loopback fixture and fresh profile.
    requireCondition(new URL(url).origin===origin&&new URL(url).hostname==='127.0.0.1','DEMO_ORIGIN_ONLY');
    context=await chromium.launchPersistentContext(profile,{headless:true});
    page=context.pages()[0]??await context.newPage();await page.goto(url);page.setDefaultTimeout(5000);
    const owned=page;
    const observe=async():Promise<Observation>=>{
      if(owned.isClosed())return {targetRef,targetExists:false,ownerTaskId:task.id,projectId:project.id,profileRef:profile,accountRef:'unknown',origin,generation:lease.generation,observedMonoMs:performance.now(),visibility:'unknown',environment:'owned_headless'};
      const state=await owned.evaluate(()=>({account:document.querySelector('#account')?.textContent??'unknown',visibility:document.visibilityState,origin:location.origin}));
      return {targetRef,targetExists:true,ownerTaskId:task.id,projectId:project.id,profileRef:profile,accountRef:state.account,origin:state.origin,generation:lease.generation,observedMonoMs:performance.now(),visibility:state.visibility==='hidden'?'hidden':'visible',environment:'owned_headless'};
    };
    const adapter:RuntimeAdapter={observe,async execute(){
      await owned.locator('#edit').click();await owned.locator('#name').fill(spec.fields.name);await owned.locator('#note').fill(spec.fields.note);await owned.locator('#save').click();
      await owned.waitForFunction(()=>['true','error'].includes(document.querySelector('#state')?.getAttribute('data-ready')??''));
      requireCondition(await owned.locator('#state').getAttribute('data-ready')==='true','SAVE_RESPONSE_UNKNOWN');
    },async verify(){
      const response=await context!.request.get(original+'api/record',{maxRedirects:0});requireCondition(response.ok(),'READBACK_FAILED');
      const record=await response.json() as Record<string,unknown>;
      return {result:record.name===spec.fields.name&&record.note===spec.fields.note?'MATCH':'NOT_MATCH',source:'application_get_record',accountRef:spec.account,targetRef,generation:lease.generation,observedMonoMs:performance.now(),detail:{name_matches:record.name===spec.fields.name,note_matches:record.note===spec.fields.note}};
    }};
    const observation=await observe(),route=chooseRoute([{capability:FIXTURE_DRAFT,health:'ready',verifiedForEnvironment:true,dependency:'owned_chromium'}],FIXTURE_DRAFT.id,observation);
    const runtime=new Runtime(store,[FIXTURE_DRAFT]),result=await runtime.execute(task.id,project.callerRef,lease,route.route,spec.fields,adapter),snapshot=fixture.snapshot(spec.runId);
    return {...result,evidence_level:'native_integration' as const,environment:'owned_loopback_fixture_headless',oracle:taskOracle(spec,snapshot,[]),effect_count:snapshot?.effects.length??'unobserved',host_foreground_events:'unobserved',model_calls:0};
  } catch(error) {
    const reason=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'ADAPTER_ERROR';
    if(store.task(task.id).effect_state==='none'){store.pauseBeforeDispatch(task.id,reason);store.release(lease);}else store.recoverTask(task.id);
    const current=store.task(task.id),snapshot=fixture.snapshot(spec.runId);
    return {task_id:task.id,project_id:project.id,status:current.status,blocked:true,reason,effect_state:current.effect_state,next_action:current.next_action,effect_count:snapshot?.effects.length??'unobserved',evidence_level:'native_integration' as const,host_foreground_events:'unobserved',model_calls:0};
  }
  } finally {
    try {await context?.close();} finally {try {await fixture?.close();} finally {store.close();}}
  }
}
