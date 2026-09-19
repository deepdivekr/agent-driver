import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork,spawn} from 'node:child_process';
import {once} from 'node:events';
import {runFixtureDemo} from '../dist/browser/fixture-driver.js';
import {RuntimeStore} from '../dist/store/runtime-store.js';
async function temporary(t){const root=await mkdtemp(join(tmpdir(),'agent-driver-native-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
for(const fault of ['none','before','after'])test(`runtime native owned headless browser ${fault} verifies effects without blind retries`,{timeout:60000},async t=>{
 const root=await temporary(t),result=await runFixtureDemo(join(root,'runtime.sqlite'),root,{fault});
 assert.equal(result.status,fault==='before'?'reconciliation_required':'succeeded');assert.equal(result.effect_count,fault==='before'?0:1);assert.equal(result.oracle.result,fault==='before'?'REFUTED':'VERIFIED');assert.equal(result.model_calls,0);assert.equal(result.host_foreground_events,'unobserved');
 const reopened=new RuntimeStore(join(root,'runtime.sqlite'));try{assert.equal(reopened.task(result.task_id).status,result.status);const events=reopened.events(result.project_id,'test');assert.equal(events.filter(e=>e.kind==='command.intent').length,1);assert.equal(events.filter(e=>e.kind==='command.verification').length,1);}finally{reopened.close();}
});
test('runtime native wrong-account browser is blocked before form writes',{timeout:60000},async t=>{const root=await temporary(t),result=await runFixtureDemo(join(root,'runtime.sqlite'),root,{wrongAccount:true});assert.equal(result.blocked,true);assert.equal(result.reason,'ACCOUNT_OR_PROFILE_MISMATCH');assert.equal(result.effect_count,0);});
for(const cut of ['before_effect','after_effect'])test(`runtime native SIGKILL at ${cut} preserves intent and never replays`,{timeout:15000},async t=>{
 const root=await temporary(t),db=join(root,'crash.sqlite'),external=join(root,'external-effects.txt'),child=fork(new URL('./fixtures/runtime-crash-child.mjs',import.meta.url),[db,external,cut],{stdio:['ignore','ignore','pipe','ipc']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('child exited before readiness');})]);const exit=once(child,'exit');child.kill('SIGKILL');await exit;
 const store=new RuntimeStore(db);try{assert.equal(store.recoverTask(message.taskId).status,'reconciliation_required');assert.equal(store.task(message.taskId).effect_state,'unknown');const tasks=store.tasks('crash');assert.equal(tasks.length,1);assert.equal(store.events('crash','restart').filter(e=>e.kind==='command.intent').length,1);}finally{store.close();}
 let effects='';try{effects=await readFile(external,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}assert.equal(effects,cut==='after_effect'?'effect\n':'');
});
test('runtime native CLI help and invalid commands keep machine output separate',{timeout:15000},async()=>{
 async function run(args){const child=spawn(process.execPath,['dist/cli.js',...args],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const [code]=await once(child,'exit');return {code,out,err};}
 assert.match((await run(['help'])).out,/No real-site/);const invalid=await run(['arbitrary-shell']);assert.equal(invalid.code,1);assert.equal(invalid.out,'');assert.match(invalid.err,/UNKNOWN_COMMAND/);
});
