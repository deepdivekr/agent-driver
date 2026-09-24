import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {FamilyRuntime} from '../dist/packs/runtime.js';
import {PackStore,PACK_LEASE_MS} from '../dist/packs/store.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';

const request=(family='research.search',sources=['records'])=>({version:1,family,request:'Recover observed data',sources:sources.map(id=>({id,parameters:{}})),filters:[],deduplicate_by:['id'],...(family==='research.search'?{query:'',search_fields:['id'],relevance:null,sort:null,limit:10}:{format:'json'})});
async function base(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'driver-pack-recovery-')),configPath=join(root,'host.json'),data=join(root,'records.json');
  await writeFile(data,JSON.stringify([{id:'local',value:7}]));
  await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'recovery-project',caller_ref:'recovery-agent',account_ref:'account-a',worktree:root,data_dir:join(root,'runtime'),environment:options.origin?'fixture':'production',...(options.origin?{fixture_url:`${options.origin}/lab/account-a/`}:{}),packs:{models:options.models??'off',model_data_approved:options.models==='jev',sources:options.sources??[{id:'records',kind:'file',path:'records.json',format:'json'}],targets:options.targets??[]}}));
  t.after(()=>rm(root,{recursive:true,force:true}));return {root,configPath,data,config:loadHostConfig(configPath)};
}
async function serverFor(t,handler){const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});return `http://127.0.0.1:${server.address().port}`;}
const httpSource=(origin,id)=>({id,kind:'http',url:`${origin}/${id}`,parameters:[],format:'json'});

test('native source recovery checkpoints successful reads, retries only the missing source, and never duplicates a completed receipt',async t=>{
  let available=false;const hits={first:0,second:0};
  const origin=await serverFor(t,(req,res)=>{const id=req.url.slice(1);if(id in hits){hits[id]++;res.writeHead(id==='second'&&!available?503:200,{'content-type':'application/json'});res.end(JSON.stringify([{id}]));}else res.end('ok');});
  const x=await base(t,{origin,sources:['first','second'].map(id=>httpSource(origin,id))});let api=new RuntimeApi(x.config);
  const recipe=request('research.search',['first','second']),failed=await api.call('runtime_pack_run',{request_id:'recover-source',recipe});assert.equal(failed.status,'retryable_failure');assert.deepEqual(hits,{first:1,second:1});api.close();
  available=true;api=new RuntimeApi(loadHostConfig(x.configPath));t.after(()=>api.close());
  const done=await api.call('runtime_pack_run',{request_id:'recover-source',recipe});assert.equal(done.status,'succeeded');assert.equal(done.run_id,failed.run_id);assert.deepEqual(hits,{first:1,second:2});assert.equal(done.result.rows.length,2);
  const duplicate=await api.call('runtime_pack_run',{request_id:'recover-source',recipe});assert.equal(duplicate.deduplicated,true);assert.deepEqual(hits,{first:1,second:2});
  assert.ok(api.store.runtimeActivities(x.config.project.id).some(event=>event.kind==='source.reused'));
});

test('native local checkpoints re-hash changed input and bounded failures stop retrying after three attempts',async t=>{
  const x=await base(t,{sources:[{id:'records',kind:'file',path:'records.json',format:'json'},{id:'missing',kind:'file',path:'missing.json',format:'json'}]}),api=new RuntimeApi(x.config);t.after(()=>api.close());
  const recipe=request('research.search',['records','missing']);const one=await api.call('runtime_pack_run',{request_id:'changed-source',recipe});assert.equal(one.status,'retryable_failure');
  await writeFile(x.data,JSON.stringify([{id:'updated',value:8}]));await writeFile(join(x.root,'missing.json'),JSON.stringify([{id:'restored'}]));
  const done=await api.call('runtime_pack_run',{request_id:'changed-source',recipe});assert.equal(done.status,'succeeded');assert.equal(done.result.rows[0].id,'updated');
  await writeFile(x.data,'not json');const bad=request();
  for(let i=1;i<=3;i++){const r=await api.call('runtime_pack_run',{request_id:'bounded',recipe:bad});assert.equal(r.status,i===3?'failed':'retryable_failure');assert.equal(r.result.recovery.attempts,i);}
  await writeFile(x.data,'[]');const exhausted=await api.call('runtime_pack_run',{request_id:'bounded',recipe:bad});assert.equal(exhausted.status,'failed');assert.equal(exhausted.deduplicated,true);
});

test('native watchdog tick resumes a technical failure without treating it as human approval',async t=>{
  const x=await base(t),api=new RuntimeApi(x.config);t.after(()=>api.close());await writeFile(x.data,'broken');
  const failed=await api.call('runtime_pack_run',{request_id:'tick-retry',recipe:request()});await writeFile(x.data,'[{"id":"restored"}]');
  const tick=await api.packs.tick(Date.now()+5000);assert.equal(tick.recovered.length,1);assert.equal(tick.recovered[0].run_id,failed.run_id);assert.equal(tick.recovered[0].status,'succeeded');
});

test('native overlapping callers share one active execution rather than duplicating source reads',async t=>{
  let release,seen;const gate=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{seen=resolve;});let hits=0;
  const origin=await serverFor(t,async(req,res)=>{if(req.url==='/records'){hits++;seen();await gate;res.end('[{"id":"shared"}]');}else res.end('ok');});
  const x=await base(t,{origin,sources:[httpSource(origin,'records')]}),api=new RuntimeApi(x.config);t.after(()=>api.close());const recipe=request();
  const first=api.call('runtime_pack_run',{request_id:'concurrent',recipe});await reached;
  const duplicate=await api.call('runtime_pack_run',{request_id:'concurrent',recipe});assert.equal(duplicate.status,'running');assert.equal(duplicate.recovery.state,'active_owner');assert.equal(hits,1);release();assert.equal((await first).status,'succeeded');
});

test('native graceful API drain rejects new admission but completes an accepted delayed source and preserves its receipt after reopen',async t=>{
  let release,seen;const gate=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{seen=resolve;});let hits=0;
  const origin=await serverFor(t,async(req,res)=>{if(req.url==='/records'){hits++;seen();await gate;res.end('[{"id":"drained"}]');}else res.end('ok');});
  const x=await base(t,{origin,sources:[httpSource(origin,'records')]}),recipe=request();let api=new RuntimeApi(x.config);t.after(()=>api.close());
  const accepted=api.call('runtime_pack_run',{request_id:'eof-in-flight',recipe});await reached;
  let drained=false;const draining=api.drain().then(()=>{drained=true;});
  await assert.rejects(api.call('runtime_pack_run',{request_id:'after-drain',recipe}),/PACK_RUNTIME_DRAINING/);
  await assert.rejects(api.packs.tick(),/PACK_RUNTIME_DRAINING/);assert.equal(drained,false);
  release();const completed=await accepted;assert.equal(completed.status,'succeeded');await draining;assert.equal(drained,true);api.close();
  api=new RuntimeApi(loadHostConfig(x.configPath));const reopened=await api.call('runtime_pack_run',{request_id:'eof-in-flight',recipe});assert.equal(reopened.status,'succeeded');assert.equal(reopened.deduplicated,true);assert.equal(hits,1);
});

test('contract five obsolete configuration receipts are durably paused and do not starve the sixth valid recovery',async t=>{
  const x=await base(t),api=new RuntimeApi(x.config);t.after(()=>api.close());const recipe=request(),currentBinding=snapshotHash({config:x.config.fingerprint,engine:'family_runtime_v1'});
  const stale=Array.from({length:5},(_,index)=>api.store.beginPack(x.config.project.id,`obsolete-${index}`,recipe,'old-configuration-binding').run);
  const valid=api.store.beginPack(x.config.project.id,'current-sixth',recipe,currentBinding).run;
  const first=await api.packs.tick();assert.equal(first.recovered.length,5);assert.ok(first.recovered.every(run=>run.status==='paused_config'));
  for(const run of stale){const stored=api.store.packRun(x.config.project.id,run.id);assert.equal(stored.status,'paused_config');assert.equal(stored.result.dispatch_allowed,false);}
  const second=await api.packs.tick();assert.equal(second.recovered.length,1);assert.equal(second.recovered[0].run_id,valid.id);assert.equal(second.recovered[0].status,'succeeded');
  assert.deepEqual((await api.packs.tick()).recovered,[]);
});

test('native legacy failed read receipt can recover while keeping its request binding',async t=>{
  const x=await base(t),api=new RuntimeApi(x.config);t.after(()=>api.close());const recipe=request(),binding=snapshotHash({config:x.config.fingerprint,engine:'family_runtime_v1'});
  const run=api.store.beginPack(x.config.project.id,'legacy-failed',recipe,binding).run;api.store.finishPack(x.config.project.id,run.id,'failed',{error:'PACK_EXECUTION_FAILED'});
  const done=await api.call('runtime_pack_run',{request_id:'legacy-failed',recipe});assert.equal(done.status,'succeeded');assert.equal(done.run_id,run.id);
  await assert.rejects(api.call('runtime_pack_run',{request_id:'legacy-failed',recipe:{...recipe,query:'changed'}}),/PACK_REQUEST_ID_CONFLICT/);
});

test('contract model outage resumes only unfinished judgments, while real uncertainty remains needs_review',async t=>{
  const x=await base(t,{models:'jev'});await writeFile(x.data,JSON.stringify([{id:'one',text:'routine'},{id:'two',text:'routine'}]));
  const store=new PackStore(x.config.dbPath);store.registerProject(x.config.project);t.after(()=>store.close());
  let available=false;const calls={one:0,two:0};
  const jev={async systemOne(packet){const id=packet.state.record.id;calls[id]++;if(id==='two'&&!available)throw Error('offline');return {answers:{label:{type:'choice',choice:'normal',confidence:.99,probabilities:{normal:.99,unknown:.01}}}};}};
  let runtime=new FamilyRuntime(store,x.config,{jev});
  const recipe={version:1,family:'inbox.triage',request:'Classify records',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],judgment:{question:'Classify this record',labels:{normal:'Routine request'}},draft_by_label:{normal:'Acknowledged'}};
  const first=await runtime.call('runtime_pack_run',{request_id:'model-recovery',recipe});assert.equal(first.status,'retryable_failure');assert.equal(first.result.error,'PACK_MODEL_UNAVAILABLE');assert.equal(first.result.checkpointed_decisions,1);runtime.close();
  available=true;runtime=new FamilyRuntime(store,x.config,{jev});t.after(()=>runtime.close());
  const done=await runtime.call('runtime_pack_run',{request_id:'model-recovery',recipe});assert.equal(done.status,'succeeded');assert.deepEqual(calls,{one:1,two:2});assert.equal(done.result.external_messages_sent,0);
  const uncertain=new FamilyRuntime(store,x.config,{jev:{async systemOne(){return {answers:{label:{type:'choice',choice:'unknown',confidence:.99,probabilities:{normal:.01,unknown:.99}}}};}}});t.after(()=>uncertain.close());
  const review=await uncertain.call('runtime_pack_run',{request_id:'semantic-unknown',recipe});assert.equal(review.status,'needs_review');assert.equal(review.result.items[0].failure_reason,'semantic_uncertainty');assert.equal(review.result.items[0].draft,null);
  let fixed=false;const invalid=new FamilyRuntime(store,x.config,{jev:{async systemOne(){return fixed?{answers:{label:{type:'choice',choice:'normal',confidence:.99,probabilities:{normal:.99,unknown:.01}}}}:{answers:{label:{type:'choice',choice:'normal',confidence:.99,probabilities:{normal:9,unknown:-8}}}};}}});t.after(()=>invalid.close());
  const bad=await invalid.call('runtime_pack_run',{request_id:'invalid-provider',recipe});assert.equal(bad.status,'retryable_failure');assert.equal(bad.result.error,'PACK_MODEL_INVALID');
  fixed=true;const corrected=await invalid.call('runtime_pack_run',{request_id:'invalid-provider',recipe});assert.equal(corrected.status,'succeeded');assert.equal(corrected.run_id,bad.run_id);
});

test('native export recovery reconciles full files and preserves partial files rather than overwriting them',async t=>{
  const x=await base(t),api=new RuntimeApi(x.config);t.after(()=>api.close());const recipe=request('portal.collect');
  const done=await api.call('runtime_pack_run',{request_id:'export-recovery',recipe});assert.equal(done.status,'succeeded');
  api.store.finishPack(x.config.project.id,done.run_id,'running',null);
  const reconciled=await api.call('runtime_pack_run',{request_id:'export-recovery',recipe});assert.equal(reconciled.status,'succeeded');assert.equal(reconciled.result.artifact.reconciled_existing,true);
  const another=await api.call('runtime_pack_run',{request_id:'partial-export',recipe});await writeFile(another.result.artifact.path,'partial');api.store.finishPack(x.config.project.id,another.run_id,'running',null);
  const repaired=await api.call('runtime_pack_run',{request_id:'partial-export',recipe});assert.equal(repaired.status,'succeeded');assert.notEqual(repaired.result.artifact.path,another.result.artifact.path);assert.equal(await readFile(another.result.artifact.path,'utf8'),'partial');
});

test('contract stale owners cannot checkpoint or settle after their lease is replaced',async t=>{
  const x=await base(t),store=new PackStore(x.config.dbPath);store.registerProject(x.config.project);t.after(()=>store.close());
  const run=store.beginPack(x.config.project.id,'fencing',request(),'test-binding').run,first=store.claimPackExecution(x.config.project.id,run.id);
  assert.equal(first.claimed,true);assert.equal(store.claimPackExecution(x.config.project.id,run.id).reason,'active_owner');
  const replacement=store.claimPackExecution(x.config.project.id,run.id,Date.now()+PACK_LEASE_MS+1);assert.equal(replacement.claimed,true);
  assert.throws(()=>store.checkpointPack(x.config.project.id,run.id,first.owner,{unsafe:true}),/PACK_EXECUTION_LEASE_LOST/);
  assert.throws(()=>store.settlePackExecution(x.config.project.id,run.id,first.owner,'succeeded',{}),/PACK_EXECUTION_LEASE_LOST/);
  assert.equal(store.packRun(x.config.project.id,run.id).status,'running');
});

test('contract exhausted interrupted attempts are finalized by watchdog tick instead of remaining running',async t=>{
  const x=await base(t),api=new RuntimeApi(x.config);t.after(()=>api.close());const recipe=request(),binding=snapshotHash({config:x.config.fingerprint,engine:'family_runtime_v1'});
  const run=api.store.beginPack(x.config.project.id,'exhausted-interruption',recipe,binding).run;
  for(let i=0;i<3;i++){const claim=api.store.claimPackExecution(x.config.project.id,run.id);assert.equal(claim.claimed,true);api.store.settlePackExecution(x.config.project.id,run.id,claim.owner,'running',null);}
  const result=await api.packs.tick();assert.equal(result.recovered.length,1);assert.equal(result.recovered[0].status,'failed');assert.equal(result.recovered[0].result.error,'PACK_RECOVERY_EXHAUSTED');assert.equal(api.store.packRun(x.config.project.id,run.id).status,'failed');
});

test('fixture authentication wait stays distinct, does not automatically retry, and resumes the same request after login',{timeout:30000},async t=>{
  let loggedIn=false,hits=0;
  const origin=await serverFor(t,(req,res)=>{if(req.url==='/table'){hits++;res.setHeader('content-type','text/html');res.end(loggedIn?'<span id=ready>Ready</span><span id=account>account-a</span><table><tbody><tr><td class=id>observed</td></tr></tbody></table>':'<span class=auth>Login required</span>');}else res.end('ok');});
  const x=await base(t,{origin,sources:[{id:'records',kind:'browser',url:`${origin}/table`,parameters:[],rows:'tbody tr',columns:{id:'.id'},ready:'#ready',auth_gate:'.auth',account_selector:'#account',account_text:'account-a'}]}),api=new RuntimeApi(x.config);t.after(()=>api.close());
  const recipe=request(),waiting=await api.call('runtime_pack_run',{request_id:'auth-recovery',recipe});assert.equal(waiting.status,'waiting_auth');
  for(let i=0;i<3;i++)assert.equal((await api.call('runtime_pack_run',{request_id:'auth-recovery',recipe})).status,'waiting_auth');
  const authenticationWait=api.store.packExecution(x.config.project.id,waiting.run_id);assert.equal(authenticationWait.auth_waits,4);assert.equal(authenticationWait.attempts,4);
  const before=hits;const tick=await api.packs.tick(Date.now()+60000);assert.deepEqual(tick.recovered,[]);assert.equal(hits,before);
  loggedIn=true;const done=await api.call('runtime_pack_run',{request_id:'auth-recovery',recipe});assert.equal(done.status,'succeeded');assert.equal(done.run_id,waiting.run_id);assert.equal(done.result.rows[0].id,'observed');
});

test('native SIGKILL during second source preserves first checkpoint and resumes through the public runtime call',{timeout:70000},async t=>{
  let unblock=false,secondSeen;const reached=new Promise(resolve=>{secondSeen=resolve;}),hits={first:0,second:0};
  const origin=await serverFor(t,(req,res)=>{const id=req.url.slice(1);if(!(id in hits)){res.end('ok');return;}hits[id]++;if(id==='second'&&!unblock){secondSeen();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify([{id}]));});
  const x=await base(t,{origin,sources:['first','second'].map(id=>httpSource(origin,id))}),recipe=request('research.search',['first','second']);
  const module=new URL('../dist/interface/api.js',import.meta.url).href,configModule=new URL('../dist/interface/config.js',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {RuntimeApi} from ${JSON.stringify(module)};import {loadHostConfig} from ${JSON.stringify(configModule)};const api=new RuntimeApi(loadHostConfig(${JSON.stringify(x.configPath)}));await api.call('runtime_pack_run',{request_id:'native-kill',recipe:${JSON.stringify(recipe)}});api.close();`],{stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  // The rendezvous only waits for a separately booted Node process to reach a
  // local HTTP fixture. It is not the recovery latency assertion; WSL startup
  // can exceed 10 s when the full native suite is running.
  await Promise.race([reached,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error(`Source not reached: ${JSON.stringify({hits,exitCode:child.exitCode,signalCode:child.signalCode,stderr:stderr.slice(-1000)})}`)),25000);timer.unref();})]);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;unblock=true;
  const api=new RuntimeApi(loadHostConfig(x.configPath));t.after(()=>api.close());const interrupted=api.store.packRuns(x.config.project.id)[0],execution=api.store.packExecution(x.config.project.id,interrupted.id);
  assert.equal(interrupted.status,'running');assert.equal(Object.keys(execution.checkpoint.sources).length,1);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,execution.lease_until_ms-Date.now()+50)));
  const done=await api.call('runtime_pack_run',{request_id:'native-kill',recipe});assert.equal(done.status,'succeeded');assert.equal(done.run_id,interrupted.id);assert.deepEqual(hits,{first:1,second:2});assert.equal(api.store.packExecution(x.config.project.id,done.run_id).attempts,2);
});

test('contract all three write families refuse to replay a consumed approval during recovery',async t=>{
  const families=['form.draft-submit','record.update','choose.stage'];
  const origin=await serverFor(t,(_req,res)=>res.end('ok'));
  const targets=families.map(family=>({id:family,family,action:family==='form.draft-submit'?'submit_form':family==='record.update'?'update_record':'stage_cart',effect_boundary:family==='form.draft-submit'?'single_form_submission':family==='record.update'?'allowlisted_field_update':'cart_or_draft_only',url:`${origin}/${family}`,draft_is_local:true,ready:'#ready',auth_gate:'.auth',account_selector:'#account',account_text:'account-a',fields:{id:{selector:'#id',kind:'text'}},identity_field:'id',submit:'#submit',readback_url:`${origin}/record`,identity_parameter:'id',known_popups:[]}));
  const x=await base(t,{origin,targets}),api=new RuntimeApi(x.config);t.after(()=>api.close());
  for(const family of families){
    const recipe={version:1,family,request:'Bounded test mutation',target:family,values:{id:'r1'},expected_before_sha256:null},binding=snapshotHash({config:x.config.fingerprint,engine:'family_runtime_v1'}),run=api.store.beginPack(x.config.project.id,`uncertain-${family}`,recipe,binding).run;
    const created=api.store.createTaskProposal(x.config.project.id,`pack.${family}`,{packId:`${family}.${family}`,packVersion:1,adapterId:`pack.browser.${family}.v1`,callerRef:x.config.project.callerRef,normalized:recipe});
    const approval=api.store.requestProposalApproval(created.task.id,{form:'unchanged'},Date.now()+60000);api.store.acceptProposalApproval(created.task.id,approval.approval_token,'test',{approved:true});api.store.consumeProposalApproval(created.task.id,approval.proposal_hash);api.store.finishPack(x.config.project.id,run.id,'running',null,created.task.id);
    const recovered=await api.call('runtime_pack_run',{request_id:`uncertain-${family}`,recipe});assert.equal(recovered.status,'reconciliation_required');assert.equal(recovered.result.write_replayed,false);assert.equal(api.store.proposal(created.task.id).state,'consumed');
  }
});
