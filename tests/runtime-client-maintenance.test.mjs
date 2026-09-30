import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {ClientMaintenanceController,isClientCliProcess} from '../dist/onboarding/client-maintenance.js';

async function fixture(){
  const home=await mkdtemp(join(tmpdir(),'agent-office-maintenance-'));
  const bin=join(home,'.nvm','versions','node','v22.22.0','bin');
  const packageBin=join(home,'.nvm','versions','node','v22.22.0','lib','node_modules','@openai','codex','bin');
  await mkdir(bin,{recursive:true});await mkdir(packageBin,{recursive:true});
  await writeFile(join(packageBin,'codex.js'),'#!/usr/bin/env node\n');await symlink(join(packageBin,'codex.js'),join(bin,'codex'));
  await writeFile(join(bin,'npm'),'#!/usr/bin/env node\n');
  const claudeBin=join(home,'.local','bin');const claudeVersions=join(home,'.local','share','claude','versions');
  await mkdir(claudeBin,{recursive:true});await mkdir(claudeVersions,{recursive:true});
  await writeFile(join(claudeVersions,'2.1.285'),'#!/bin/sh\n');await symlink(join(claudeVersions,'2.1.285'),join(claudeBin,'claude'));
  const cursorVersions=join(home,'.local','share','cursor-agent','versions','2026.09.28-test');await mkdir(cursorVersions,{recursive:true});await writeFile(join(cursorVersions,'cursor-agent'),'#!/bin/sh\n');await symlink(join(cursorVersions,'cursor-agent'),join(claudeBin,'agent'));
  const opencodeBin=join(home,'.opencode','bin');await mkdir(opencodeBin,{recursive:true});await writeFile(join(opencodeBin,'opencode'),'#!/bin/sh\n');
  const binaries={codex:join(bin,'codex'),claude:join(claudeBin,'claude'),cursor:join(claudeBin,'agent'),opencode:join(opencodeBin,'opencode')};
  return {home,statePath:join(home,'office','.connection','cli-maintenance.json'),binaries,env:{HOME:home,PATH:bin},resolver:id=>{if(!binaries[id])throw Error('missing');return binaries[id];},cleanup:()=>rm(home,{recursive:true,force:true})};
}
const make=(fixture,overrides={})=>new ClientMaintenanceController({statePath:fixture.statePath,env:fixture.env,resolver:fixture.resolver,platform:'linux',isBusy:()=>false,externalClientActive:()=>false,runner:{async run(){return {code:0,stdout:'',stderr:''};}},...overrides});

test('runtime fixture Windows profile can persist maintenance preferences without HOME but never updates unsupported clients',async()=>{
  const f=await fixture();try{
    let calls=0;const controller=make(f,{platform:'win32',env:{USERPROFILE:f.home},runner:{async run(){calls++;throw Error('MUST_NOT_RUN');}}});
    const saved=await controller.save({revision:0,enabled:true});assert.equal(saved.preference_saved,true);assert.equal(saved.enabled,true);
    const result=await controller.runNow();assert.deepEqual(result.attempted_ids,[]);assert.equal(calls,0);assert.equal(result.skipped.find(item=>item.id==='codex').reason,'unsupported_platform');await controller.close();
    const missing=make(f,{env:{USERPROFILE:f.home}});await assert.rejects(missing.save({revision:1,enabled:false}),/CLIENT_MAINTENANCE_HOME_UNAVAILABLE/u);await missing.close();
    const unsafe=make(f,{platform:'win32',env:{USERPROFILE:'relative-profile'}});await assert.rejects(unsafe.runNow(),/CLIENT_MAINTENANCE_HOME_UNAVAILABLE/u);await unsafe.close();
  }finally{await f.cleanup();}
});

test('runtime fixture client maintenance updates only installed, owned allowlisted CLIs and never exposes updater output',async()=>{
  const f=await fixture();try{
    const calls=[],events=[];const controller=make(f,{runner:{async run(request){calls.push(request);return {code:0,stdout:'sensitive stdout',stderr:'sensitive stderr'};}},onEvent:event=>events.push(event)});
    const before=controller.view();assert.equal(before.enabled,true);assert.equal(before.preference_saved,false);assert.equal(before.state,'due');assert.equal(before.interval_hours,24);
    const result=await controller.runDue('startup');assert.deepEqual(result.updated_ids,['codex','claude','opencode','cursor']);
    assert.deepEqual(calls.map(call=>[call.executable,call.args]),[
      [join(f.home,'.nvm','versions','node','v22.22.0','bin','npm'),['install','-g','--prefix',join(f.home,'.nvm','versions','node','v22.22.0'),'@openai/codex@latest']],
      [f.binaries.claude,['update']],[f.binaries.opencode,['upgrade']],[f.binaries.cursor,['update']],
    ]);
    assert.ok(calls.every(call=>call.timeout_ms===600000&&call.output_limit_bytes===16384));
    assert.equal(result.skipped.find(item=>item.id==='hermes')?.reason,'not_installed');
    assert.deepEqual(events.filter(event=>event.stage==='succeeded').map(event=>event.id),result.updated_ids);
    assert.doesNotMatch(JSON.stringify({result,view:controller.view(),events}),/sensitive/u);
    assert.equal((await stat(f.statePath)).mode&0o777,0o600);
    assert.equal(controller.view().preference_saved,true);
    assert.equal((await readFile(f.statePath,'utf8')).includes('sensitive'),false);
  }finally{await f.cleanup();}
});

test('runtime fixture client maintenance observes 24h cadence, per-client failure cooldown, explicit runNow and OFF preference',async()=>{
  const f=await fixture();try{
    let now=Date.parse('2026-09-30T00:00:00.000Z'),calls=[];const runner={async run(request){calls.push(request.executable);return {code:request.executable===f.binaries.claude&&calls.length===2?1:0,stdout:'',stderr:''};}};
    const controller=make(f,{now:()=>now,runner});
    const first=await controller.runDue('startup');assert.deepEqual(first.updated_ids,['codex','opencode','cursor']);assert.equal(first.skipped.find(item=>item.id==='claude')?.reason,'update_failed');assert.equal(first.state,'cooldown');
    const current=await controller.runDue('tick');assert.equal(current.attempted_ids.length,0);
    now+=6*60*60_000+1000;const retry=await controller.runDue('tick');assert.deepEqual(retry.attempted_ids,['claude']);assert.equal(calls.length,5);
    const saved=await controller.save({revision:0,enabled:true});assert.equal(saved.revision,1);assert.notEqual(saved.next_due_at,null);
    const notDue=await controller.runDue('tick');assert.equal(notDue.attempted_ids.length,0);
    const off=await controller.save({revision:1,enabled:false});assert.equal(off.state,'disabled');assert.equal((await controller.runDue('tick')).attempted_ids.length,0);
    assert.equal((await controller.runNow()).updated_ids.length,4);
    await assert.rejects(controller.save({revision:1,enabled:true}),/CLIENT_MAINTENANCE_REVISION_CONFLICT/u);
  }finally{await f.cleanup();}
});

test('runtime fixture client maintenance defers during Work, external CLI activity, fixture mode and unknown managed paths',async()=>{
  const f=await fixture();try{
    let calls=0;const runner={async run(){calls++;return {code:0,stdout:'',stderr:''};}};
    const busy=make(f,{runner,isBusy:()=>true});assert.equal((await busy.runDue()).state,'deferred_busy');assert.equal(calls,0);
    const external=make(f,{runner,externalClientActive:()=>true});assert.equal((await external.runNow()).state,'deferred_busy');assert.equal(calls,0);
    const fixtureMode=make(f,{runner,fixture:true});assert.equal((await fixtureMode.runNow()).state,'deferred_busy');assert.equal(calls,0);
    const unmanaged=make(f,{runner,resolver:id=>id==='codex'?'/usr/local/bin/codex':f.resolver(id)});
    const result=await unmanaged.runNow();assert.ok(!result.attempted_ids.includes('codex'));assert.equal(result.skipped.find(item=>item.id==='codex')?.reason,'not_installed');
    const windows=make(f,{runner,platform:'win32'});assert.equal((await windows.runNow()).attempted_ids.length,0);
    const outside=join(f.home,'foreign-agent');await writeFile(outside,'#!/bin/sh\n');const foreign=join(f.home,'.local','bin','cursor-agent');await symlink(outside,foreign);
    const foreignController=make(f,{runner,resolver:id=>id==='cursor'?foreign:f.resolver(id)});
    const foreignResult=await foreignController.runNow();assert.equal(foreignResult.skipped.find(item=>item.id==='cursor')?.reason,'unmanaged_install');
  }finally{await f.cleanup();}
});

test('runtime fixture client maintenance user-scoped lock deduplicates concurrent hosts and close drains the updater',async()=>{
  const f=await fixture();try{
    let start;const started=new Promise(resolve=>{start=resolve;});let release;const blocked=new Promise(resolve=>{release=resolve;});let calls=0;
    const runner={async run(){calls++;start();await blocked;return {code:0,stdout:'',stderr:''};}};
    const first=make(f,{runner});const second=make(f,{runner,statePath:join(f.home,'other','.connection','cli-maintenance.json')});
    const run=first.runNow();await started;assert.equal(first.running,true);
    const duplicate=first.runNow();assert.strictEqual(duplicate,run);
    const competing=await second.runNow();assert.equal(competing.state,'deferred_busy');assert.equal(competing.skipped[0].reason,'locked');
    const drained=first.close();release();await drained;const result=await run;assert.deepEqual(result.updated_ids,['codex']);assert.equal(calls,1);
    assert.equal(first.running,false);assert.equal((await first.runNow()).attempted_ids.length,0);
  }finally{await f.cleanup();}
});

test('runtime fixture client maintenance reclaims only a verified dead same-host owner lock',async()=>{
  const f=await fixture();try{
    const lock=join(f.home,'.cache','agent-office','cli-maintenance.lock');await mkdir(join(f.home,'.cache','agent-office'),{recursive:true});
    await writeFile(lock,JSON.stringify({pid:2147483647,host:hostname(),token:'dead-owner',created_at:0}),{mode:0o600});
    let calls=0;const controller=make(f,{runner:{async run(){calls++;return {code:0,stdout:'',stderr:''};}}});
    assert.equal((await controller.runNow()).state,'idle');assert.equal(calls,4);
    await writeFile(lock,JSON.stringify({pid:process.pid,host:hostname(),token:'live-owner',created_at:0}),{mode:0o600});
    const denied=await controller.runNow();assert.equal(denied.state,'deferred_busy');assert.equal(calls,4);
  }finally{await f.cleanup();}
});

test('runtime fixture client maintenance serializes simultaneous stale-owner recovery across hosts',async()=>{
  const f=await fixture();try{
    const lock=join(f.home,'.cache','agent-office','cli-maintenance.lock');await mkdir(join(f.home,'.cache','agent-office'),{recursive:true});
    await writeFile(lock,JSON.stringify({pid:2147483647,host:hostname(),token:'dead-owner',created_at:0}),{mode:0o600});
    let entered;const started=new Promise(resolve=>{entered=resolve;});let release;const blocked=new Promise(resolve=>{release=resolve;});let calls=0;
    const runner={async run(){calls++;entered();await blocked;return {code:0,stdout:'',stderr:''};}};
    const first=make(f,{runner}),second=make(f,{runner,statePath:join(f.home,'another','.connection','cli-maintenance.json')});
    const initial=first.runNow(),competing=second.runNow();await started;
    let timer;try{
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('concurrent stale reapers both entered updater')),1500);});
      const loser=await Promise.race([initial,competing,timeout]);
      assert.equal(loser.state,'deferred_busy');assert.equal(loser.skipped[0].reason,'locked');
    }finally{clearTimeout(timer);release();}
    await Promise.all([initial,competing]);assert.equal(calls,4);
  }finally{await f.cleanup();}
});

test('runtime fixture client maintenance handles installed npm Claude via exact user prefix and recognizes Hermes comm',async()=>{
  const f=await fixture();try{
    const prefix=join(f.home,'.npm-global'),bin=join(prefix,'bin'),pkg=join(prefix,'lib','node_modules','@anthropic-ai','claude-code','bin');
    await mkdir(bin,{recursive:true});await mkdir(pkg,{recursive:true});await writeFile(join(pkg,'claude.exe'),'binary');await symlink(join(pkg,'claude.exe'),join(bin,'claude'));await writeFile(join(bin,'npm'),'#!/usr/bin/env node\n');
    const calls=[],controller=make(f,{resolver:id=>id==='claude'?join(bin,'claude'):f.resolver(id),runner:{async run(request){calls.push(request);return {code:0,stdout:'',stderr:''};}}});
    assert.ok((await controller.runNow()).updated_ids.includes('claude'));
    assert.deepEqual(calls.find(call=>call.args.includes('@anthropic-ai/claude-code@latest'))?.args,['install','-g','--prefix',prefix,'@anthropic-ai/claude-code@latest']);
    assert.equal(isClientCliProcess('hermes\n',['/usr/bin/python3.11','/home/fixture/other.py']),true);
    assert.equal(isClientCliProcess('python3.11\n',['/usr/bin/python3.11','/home/fixture/hermes']),true);
    assert.equal(isClientCliProcess('python3.11\n',['/usr/bin/python3.11','-m','hermes_cli']),true);
    assert.equal(isClientCliProcess('python3.11\n',['/usr/bin/python3.11','/home/fixture/other.py']),false);
  }finally{await f.cleanup();}
});

test('runtime fixture client maintenance close settles a failed pending state read without hiding the caller failure',async()=>{
  const f=await fixture();try{
    await mkdir(join(f.home,'office','.connection'),{recursive:true});await writeFile(f.statePath,'{invalid-json');
    const controller=make(f),run=controller.runNow(),failure=assert.rejects(run,/CLIENT_MAINTENANCE_STATE_INVALID/u);
    await controller.close();await failure;assert.equal(controller.running,false);
  }finally{await f.cleanup();}
});
