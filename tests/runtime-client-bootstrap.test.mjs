import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClientBootstrapController,CLIENT_BOOTSTRAP_CATALOG} from '../dist/onboarding/client-bootstrap.js';
import {resolveSubscriptionClientExecutable} from '../dist/integrations/subscription-auth.js';

test('runtime contract client bootstrap catalog uses exact official HTTPS installers and never exposes credentials',()=>{
  assert.deepEqual(CLIENT_BOOTSTRAP_CATALOG.map(item=>item.id),['codex','claude','opencode','cursor','hermes']);
  for(const item of CLIENT_BOOTSTRAP_CATALOG){assert.equal(new URL(item.installer_url).protocol,'https:');assert.equal(new URL(item.docs_url).protocol,'https:');assert.match(item.install_command,/^curl /u);}
  let installed=false;const resolver=()=>{if(!installed)throw Error('missing');return '/home/fixture/.local/bin/codex';};
  const view=new ClientBootstrapController({}, {run:async()=>({code:0,stdout:'',stderr:''})},fetch,resolver,'linux').view();
  assert.equal(view.credentials_exposed,false);assert.equal(view.clients[0].installed,false);assert.equal(view.clients[0].managed_install,true);assert.doesNotMatch(JSON.stringify(view),/token|password|secret/iu);
});

test('runtime contract managed client install downloads one allowlisted script, runs without shell composition, verifies and removes the temporary file',async()=>{
  let installed=false,scriptPath='';const stages=[];
  const resolver=id=>{assert.equal(id,'codex');if(!installed)throw Error('missing');return '/home/fixture/.local/bin/codex';};
  const fetcher=async(url,options)=>{assert.equal(url,'https://chatgpt.com/codex/install.sh');assert.equal(options.redirect,'error');return new Response('#!/usr/bin/env bash\nprintf ready\n',{status:200,headers:{'content-type':'text/x-shellscript'}});};
  const runner={async run(request){assert.equal(request.executable,'/bin/bash');assert.equal(request.args.length,1);assert.equal(request.timeout_ms,600000);scriptPath=request.args[0];assert.match(await readFile(scriptPath,'utf8'),/^#!\/usr\/bin\/env bash/u);installed=true;return {code:0,stdout:'credential-like-output-must-not-escape',stderr:''};}};
  const controller=new ClientBootstrapController({},runner,fetcher,resolver,'linux'),result=await controller.install('codex',stage=>stages.push(stage));
  assert.deepEqual(stages,['downloading','running','verifying']);assert.equal(result.clients[0].installed,true);assert.doesNotMatch(JSON.stringify(result),/credential-like-output/iu);await assert.rejects(readFile(scriptPath,'utf8'),/ENOENT/);
});

test('runtime contract managed install rejects unsupported platform, redirect and non-shell payload before execution',async()=>{
  const missing=()=>{throw Error('missing');};let calls=0;const runner={async run(){calls++;return {code:0,stdout:'',stderr:''};}};
  await assert.rejects(new ClientBootstrapController({},runner,fetch,missing,'win32').install('codex'),/CLIENT_INSTALL_PLATFORM_UNSUPPORTED/);
  const redirected=async()=>({ok:true,redirected:true,url:'https://evil.test/install',arrayBuffer:async()=>new TextEncoder().encode('#!/bin/bash\n').buffer});
  await assert.rejects(new ClientBootstrapController({},runner,redirected,missing,'linux').install('codex'),/CLIENT_INSTALL_DOWNLOAD_REJECTED/);
  const invalid=async()=>new Response('console.log(1)',{status:200});
  await assert.rejects(new ClientBootstrapController({},runner,invalid,missing,'linux').install('codex'),/CLIENT_INSTALL_SCRIPT_INVALID/);assert.equal(calls,0);
});

test('runtime native client resolver finds managed Linux paths and the official Cursor agent command',async()=>{
  const home=await mkdtemp(join(tmpdir(),'driver-client-paths-'));
  try{
    const files=[['.cursor/bin','agent'],['.opencode/bin','opencode'],['.hermes/bin','hermes']];for(const [dir,name] of files){const root=join(home,dir);await mkdir(root,{recursive:true});await writeFile(join(root,name),'#!/bin/sh\n');await chmod(join(root,name),0o700);}
    const environment={HOME:home,PATH:'/usr/bin',WSL_DISTRO_NAME:'Ubuntu-24.04'};
    assert.equal(resolveSubscriptionClientExecutable('cursor',environment),join(home,'.cursor','bin','agent'));
    assert.equal(resolveSubscriptionClientExecutable('opencode',environment),join(home,'.opencode','bin','opencode'));
    assert.equal(resolveSubscriptionClientExecutable('hermes',environment),join(home,'.hermes','bin','hermes'));
  }finally{await rm(home,{recursive:true,force:true});}
});
