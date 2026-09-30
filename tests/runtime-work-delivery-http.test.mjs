import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {PackStore} from '../dist/packs/store.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {WorkDeliverySettings,readDeliverySettings} from '../dist/work/delivery-settings.js';
import {WorkResults} from '../dist/work/results.js';
import {initWorkSupervisor} from '../dist/work/supervisor.js';

const telegram={id:'updates',platform:'telegram',label:'My chat',telegram_bot_token:'123456789:'+'A'.repeat(32),telegram_chat_id:'-1001234567890'};
const slack={id:'team',platform:'slack',label:'Team updates',webhook_url:'https://hooks.slack.com/services/AAAA/BBBB/CCCC'};
const proposal={title:'Local source report',desired_outcome:'Report the observed title and value.',completion_checks:[{id:'records',result:'The source title and value are present.',evidence:'Observed file receipt'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
const recipe={version:1,family:'research.search',request:'Read the local records',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
function fixtureModel(){const calls=[];return {calls,async call(purpose,instructions,input){
  calls.push(purpose);
  if(instructions.startsWith('Define one durable'))return structuredClone(proposal);
  if(instructions.startsWith('Independently verify'))return {checks:input.checks.map(check=>{const evidence=check.allowed_evidence_ids.filter(id=>input.observations.some(observation=>observation.tool_name!=='office_controlled_run_trace'&&observation.evidence_ids.includes(id)));return {id:check.id,verdict:'supported',evidence_ids:evidence,evidence_quotes:evidence.map(id=>({evidence_id:id,quote:'Observed source'})),reason:'The local file receipt contains the requested row.'};})};
  assert.ok(instructions.startsWith('Execute the registered Work'),instructions);
  const observed=input.checkpoint.observations.find(item=>item.invocation.tool_name==='runtime_pack_run');
  if(observed)return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Observed source: 23',completed_checks:input.completion_checks.map(check=>({id:check.id,evidence_ids:observed.receipt.evidence_ids})),wait_reason:null};
  return {action:'tool',stage_id:'collect',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({work_id:input.work_id,request_id:'delivery-fixture',recipe}),summary:'Read the delegated local source.',completed_checks:[],wait_reason:null};
}};}
async function fixture(t,{telegramStatus=200}={}){
  const root=await mkdtemp(join(tmpdir(),'office-delivery-http-')),host=join(root,'host.json');
  await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'Observed source',value:23}]));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'delivery-http',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',work:{model_data_approved:true},packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(host),model=fixtureModel(),nativeFetch=globalThis.fetch,providerCalls=[];
  globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(url.hostname==='api.telegram.org'){
      providerCalls.push({platform:'telegram',path:url.pathname});return new Response(telegramStatus===200?JSON.stringify({ok:true,result:{message_id:41,chat:{id:-1001234567890}}}):'rate limited',{status:telegramStatus});
    }
    if(url.hostname==='hooks.slack.com'){providerCalls.push({platform:'slack',path:url.pathname});return new Response('ok',{status:200});}
    if(url.hostname!=='127.0.0.1')throw Error('UNEXPECTED_EXTERNAL_REQUEST');
    return nativeFetch(input,init);
  };
  const servers=[];t.after(async()=>{for(const server of servers.reverse())await server.close();globalThis.fetch=nativeFetch;await rm(root,{recursive:true,force:true});});
  const start=async()=>{const server=await startControlCenter(config,{workModel:model,poll_ms:25});servers.push(server);return server;};
  return {root,config,model,providerCalls,start};
}
const url=(server,path)=>new URL(path,server.url);
const headers=server=>({'origin':new URL(server.url).origin,'x-agent-driver':'human-office','sec-fetch-site':'same-origin','content-type':'application/json'});
async function post(server,path,body,override={}){return fetch(url(server,path),{method:'POST',headers:{...headers(server),...override},body:JSON.stringify(body)});}
async function json(server,path){const response=await fetch(url(server,path));assert.equal(response.status,200);return response.json();}
async function until(action,predicate,label){for(let index=0;index<160;index++){const value=await action();if(predicate(value))return value;await delay(50);}assert.fail(`Timed out waiting for ${label}`);}
const currentResult=detail=>detail.results?.find(result=>result.source_kind==='client'&&result.work_completion_verified);

test('real loopback routes protect secrets and CSRF, persist Work selection, and automatically deliver a verified result',async t=>{
  const x=await fixture(t),server=await x.start();
  assert.equal((await post(server,'delivery/settings',{revision:0,targets:[telegram],default_target_ids:['app','updates']},{origin:'https://other.example'})).status,403);
  assert.equal((await post(server,'delivery/settings',{revision:0,targets:[telegram],default_target_ids:['app','updates']},{'x-agent-driver':'wrong'})).status,403);
  assert.equal((await json(server,'delivery/status')).revision,0);
  const saved=await post(server,'delivery/settings',{revision:0,targets:[telegram],default_target_ids:['app','updates']});assert.equal(saved.status,200);const savedText=await saved.text();assert.equal(savedText.includes(telegram.telegram_bot_token),false);
  assert.equal((await json(server,'delivery/status')).targets[0].connection,'stored_unverified');
  const input={request_id:'auto-delivery',prompt:'Read and report the local source.',completion_condition:'Report the observed title and value.',delivery_target_ids:['app','updates']};
  const registered=await post(server,'work/start',{...input,execute:false,cost_acknowledged:false});assert.equal(registered.status,200);const work=await registered.json();
  assert.deepEqual((await json(server,`work/delivery?work_id=${work.work_id}`)).target_ids,['app','updates']);
  for(let index=0;index<3;index++)await json(server,`work/detail?id=${work.work_id}`);
  assert.equal(x.providerCalls.length,0,'Read-only GETs must not send');
  const started=await post(server,'work/start',{...input,execute:true,cost_acknowledged:true});assert.equal(started.status,200);assert.equal((await started.json()).admission.requested,true);
  const detail=await until(()=>json(server,`work/detail?id=${work.work_id}`),value=>currentResult(value)?.deliveries.some(delivery=>delivery.channel==='telegram'&&delivery.status==='delivered'),'verified automatic Telegram delivery');
  const result=currentResult(detail);assert.equal(result.verification,'verified');assert.equal(result.work_completion_verified,true);assert.match(result.text,/23/u);assert.equal(x.providerCalls.length,1);
  for(let index=0;index<3;index++)await json(server,`work/detail?id=${work.work_id}`);
  assert.equal(x.providerCalls.length,1,'Repeated reads must not replay a delivered output');
  const store=new PackStore(x.config.dbPath);try{assert.equal(store.officeRuns(x.config.project.id,work.work_id).length,1);}finally{store.close();}
});

test('failed provider acknowledgement retargets the same verified result without rerunning Work',async t=>{
  const x=await fixture(t,{telegramStatus:429}),server=await x.start();
  assert.equal((await post(server,'delivery/settings',{revision:0,targets:[telegram,slack],default_target_ids:['app']})).status,200);
  const input={request_id:'retarget-delivery',prompt:'Read and report the local source.',completion_condition:'Report observed title and value.',delivery_target_ids:['updates']};
  const started=await post(server,'work/start',{...input,execute:true,cost_acknowledged:true});assert.equal(started.status,200);const work=await started.json();
  const failed=await until(()=>json(server,`work/detail?id=${work.work_id}`),value=>currentResult(value)?.deliveries.some(delivery=>delivery.channel==='telegram'&&delivery.status==='failed'),'failed Telegram acknowledgement');
  const before=currentResult(failed),runId=before.run_id,resultId=before.id;assert.equal(before.deliveries.find(delivery=>delivery.channel==='telegram').reason,'DELIVERY_PROVIDER_HTTP_429');
  const changed=await post(server,'work/delivery',{work_id:work.work_id,revision:1,target_ids:['team']});assert.equal(changed.status,200);
  const delivered=await until(()=>json(server,`work/detail?id=${work.work_id}`),value=>currentResult(value)?.deliveries.some(delivery=>delivery.channel==='slack'&&delivery.status==='delivered'),'retargeted Slack delivery');
  const after=currentResult(delivered);assert.equal(after.id,resultId);assert.equal(after.run_id,runId);assert.deepEqual(x.providerCalls.map(call=>call.platform),['telegram','slack']);
  const store=new PackStore(x.config.dbPath);try{assert.equal(store.officeRuns(x.config.project.id,work.work_id).length,1);}finally{store.close();}
});

test('startup dispatcher sends a saved pending receipt without restarting Work; malformed saved host is rejected',async t=>{
  const x=await fixture(t),settings=WorkDeliverySettings.fromConfig(x.config);settings.save({revision:0,targets:[telegram],default_target_ids:['app']});
  const store=new PackStore(x.config.dbPath);store.registerProject(x.config.project);initWorkSupervisor(store);
  const work=store.beginWork(x.config.project.id,'pending-before-restart','Saved result','quick').work,runId=randomUUID(),stamp=new Date().toISOString();
  store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,result,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(runId,x.config.project.id,work.id,work.revision,'succeeded',JSON.stringify({summary:'Verified saved receipt',completion_verified:true}),x.config.fingerprint,0,stamp,stamp);
  const results=new WorkResults(store,[],settings);results.setSelection(x.config.project.id,work.id,{revision:0,target_ids:['updates']});const output=results.record(x.config.project.id,{work_id:work.id,run_id:runId,source_kind:'client',work_revision:work.revision,summary:'Verified saved receipt',text:'Verified saved receipt'});
  assert.equal(output.deliveries.find(delivery=>delivery.channel==='telegram').status,'pending');store.close();
  const server=await x.start();const detail=await until(()=>json(server,`work/detail?id=${work.id}`),value=>value.results?.some(result=>result.id===output.id&&result.deliveries.some(delivery=>delivery.channel==='telegram'&&delivery.status==='delivered')),'startup pending dispatcher');
  assert.equal(detail.results.find(result=>result.id===output.id).run_id,runId);assert.equal(x.providerCalls.length,1);
  const observer=new PackStore(x.config.dbPath);try{assert.equal(observer.officeRuns(x.config.project.id,work.id).length,0);}finally{observer.close();}
  const raw=JSON.parse(await readFile(settings.path,'utf8'));raw.targets[0].telegram_bot_token=telegram.telegram_bot_token;raw.targets=[{id:'team',platform:'slack',label:'Unsafe',webhook_url:'https://127.0.0.1/services/A/B/C'}];raw.default_target_ids=['team'];await writeFile(settings.path,JSON.stringify(raw));
  assert.throws(()=>readDeliverySettings(settings.path),/DELIVERY_SETTINGS_INVALID/u);
  assert.equal((await fetch(url(server,'delivery/status'))).status,409);
  assert.equal(x.providerCalls.length,1);
});
