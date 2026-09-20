import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, statSync, existsSync,openSync,ftruncateSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadHostConfig} from '../dist/interface/config.js';
import {TerminalStore} from '../dist/terminal/store.js';
import {ScopedFiles, sha256} from '../dist/terminal/scoped-files.js';
import {FileBroker} from '../dist/terminal/file-broker.js';
import {processIdentitySync, liveness} from '../dist/supervisor/identity.js';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {fileRead, fileWrite, wirePrompt} from '../dist/terminal/file-contracts.js';
import {runSandbox, verifyFiles} from '../dist/terminal/verify-files.js';
import {prepareTerminalHandoff} from '../dist/terminal/handoff.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

function fixture(t, overrides = {}, brokerBinding = true, storage = null) {
  const root = mkdtempSync(join(tmpdir(), 'apd-file-test-')), worktree = join(root, 'owned'), path = join(root, 'host.json');
  mkdirSync(worktree); mkdirSync(join(worktree, 'src'));
  writeFileSync(join(worktree, 'src/app.mjs'), "process.stdout.write('broken')");
  const raw = {schema_version: 1, project_id: 'files', caller_ref: 'test', account_ref: 'synthetic', worktree, data_dir: join(root, 'data'), terminal: {executable: process.execPath, version: '2.1.126', files: {ownership: 'exclusive_runtime', read: ['src/app.mjs', 'README.md'], write: ['src/app.mjs', 'README.md'], verifier: {kind: 'node_stdio_cases', entry: 'src/app.mjs', cases: [{id: 'answer', stdout: '정답🐈'}]}, ...overrides}}};
  if(storage)raw.storage=storage;
  writeFileSync(path, JSON.stringify(raw)); const config = loadHostConfig(path), store = new TerminalStore(config.dbPath); store.registerProject(config.project);
  // Synthetic host/CLI/broker identities are intentionally one process. Tests below
  // are contract tests unless they independently test filesystem/namespace behavior.
  const identity = processIdentitySync(process.pid), host = store.claimTerminalHost(config, identity, null, 'test-only', 'test-only');
  const {session} = store.startSession(config, 'start'); store.claimSession(session.id, host, config); store.bindProcess(session.id, host, 1, identity); store.ready(session.id, host, 1);
  const {turn} = store.submit(config, {request_id: 'turn', session_ref: session.id, expected_generation: 1, expected_previous_turn_id: null, prompt: 'synthetic'});
  store.dispatch(session.id, host, 1, config); store.acknowledge(session.id, host, 1, turn.id);
  const authority = {session: session.id, generation: 1, host, broker: JSON.stringify(identity), cli: JSON.stringify(identity)}; if(brokerBinding)store.bindBroker(config, authority);
  const x = {root, worktree, path, raw, config, store, host, session: session.id, turn: turn.id, authority, files: new ScopedFiles(config)};
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  return x;
}
async function tool(x, name, input, cut) {
  const parsed = (name === 'read_file' ? fileRead : fileWrite).parse(input), id = randomUUID();
  x.store.toolRequested(x.session, x.host, 1, id, `mcp__runtime_files__${name}`, parsed);
  const answer = await new FileBroker(x.config, x.store, x.authority, cut).call(name, parsed);
  x.store.observeToolResult(x.session, x.host, 1, id, answer.content, !!answer.isError);
  return JSON.parse(answer.content[0].text);
}
function finish(x) {x.store.assertToolsSettled(x.session); x.store.result(x.session, x.host, 1, {outcome: 'completed', text: 'claim is not evidence', is_error: false, source: 'official_result', project_completed: false}); x.store.ready(x.session, x.host, 1);}
test('runtime contract file delegation rejects traversal, hidden auth, arbitrary verifier and data overlap', t => {
  const x = fixture(t);
  for (const path of ['../outside', '/etc/passwd', 'src/../../x', 'src/.env', '.claude/settings.json', 'src\\evil', 'src//app', 'credentials.json']) assert.throws(() => fileRead.parse({turn_id: x.turn, path}));
  assert.throws(() => fileWrite.parse({turn_id: x.turn, path: 'README.md', content: '', request_id: 'x', expected_sha256: null, approved: true}));
  writeFileSync(x.path, JSON.stringify({...x.raw, terminal: {...x.raw.terminal, files: {...x.raw.terminal.files, verifier: {kind: 'shell', executable: '/bin/sh', args: ['-c','true']}}}})); assert.throws(() => loadHostConfig(x.path));
  writeFileSync(x.path, JSON.stringify({...x.raw, data_dir: join(x.worktree, 'data')})); assert.throws(() => loadHostConfig(x.path), /OUTSIDE_WORKTREE/);
  assert.match(wirePrompt(x.turn, 'user', true), new RegExp(x.turn));
});
test('runtime native scoped files reject symlink parents, symlink leaves, hardlinks, oversize and invalid UTF8', t => {
  const x = fixture(t), outside = join(x.root, 'secret'); writeFileSync(outside, 'outside sentinel');
  rmSync(join(x.worktree, 'src/app.mjs')); symlinkSync(outside, join(x.worktree, 'src/app.mjs')); assert.throws(() => x.files.read('src/app.mjs'));
  rmSync(join(x.worktree, 'src/app.mjs')); linkSync(outside, join(x.worktree, 'src/app.mjs')); assert.throws(() => x.files.read('src/app.mjs'), /SINGLE_LINK/);
  rmSync(join(x.worktree, 'src/app.mjs')); writeFileSync(join(x.worktree, 'src/app.mjs'), Buffer.from([0xff])); assert.throws(() => x.files.read('src/app.mjs'));
  writeFileSync(join(x.worktree, 'src/app.mjs'), 'a'.repeat(65537)); assert.throws(() => x.files.read('src/app.mjs'), /SIZE_LIMIT/);
  rmSync(join(x.worktree, 'src'), {recursive: true}); symlinkSync(x.root, join(x.worktree, 'src')); assert.throws(() => x.files.read('src/app.mjs'));
  assert.equal(readFileSync(outside, 'utf8'), 'outside sentinel');
});
test('runtime contract file broker writes Unicode with intent/readback and deduplicates request without repeating effect', async t => {
  const x = fixture(t), input = {turn_id: x.turn, path: 'README.md', request_id: 'create', expected_sha256: null, content: '# 한국어 🐈\n'};
  const missing = await tool(x, 'read_file', {turn_id: x.turn, path: input.path}); assert.equal(missing.sha256, null);
  const first = await tool(x, 'write_file', input), inode = statSync(join(x.worktree, input.path)).ino;
  const duplicate = await tool(x, 'write_file', input); assert.equal(duplicate.deduplicated, true); assert.equal(first.sha256, sha256(input.content));
  assert.equal(statSync(join(x.worktree, input.path)).ino, inode); assert.equal(x.store.fileIntents(x.session).length, 1);
  const conflict = await tool(x, 'write_file', {...input, content: 'changed'}); assert.equal(conflict.error, 'REQUEST_ID_CONFLICT');
  finish(x); assert.equal(x.store.terminalStatus(x.session).project_completed, false);
});
test('runtime fixture configured storage admits scoped Unicode writes and rechecks budget immediately before replacement',async t=>{
  const x=fixture(t,{},true,{max_bytes:33554432,min_free_bytes:16777216,journal_margin_bytes:1048576});
  const first={turn_id:x.turn,path:'README.md',request_id:'admitted',expected_sha256:null,content:'한국어🐈'};
  assert.equal((await tool(x,'write_file',first)).sha256,sha256(first.content));
  const original=x.files.read('src/app.mjs'),input={turn_id:x.turn,path:'src/app.mjs',request_id:'blocked-after-intent',expected_sha256:original.sha256,content:'never replace'};
  const result=await tool(x,'write_file',input,point=>{if(point==='before_replace'){const fd=openSync(join(x.root,'data','owned-sparse-pressure'),'wx');try{ftruncateSync(fd,33554432);}finally{closeSync(fd);}}});
  assert.equal(result.error,'STORAGE_BUDGET_EXCEEDED');assert.equal(x.files.read(input.path).sha256,original.sha256);assert.equal(x.store.fileIntents(x.session).at(-1).status,'uncertain');
  assert.equal(x.store.storage(x.config).status().reserved_bytes,0);
});
test('runtime contract file broker fences undelegated paths, wrong hash, stale turns, cancellation and missing official calls', async t => {
  const x = fixture(t), input = {turn_id: x.turn, path: 'src/app.mjs', request_id: 'write', expected_sha256: null, content: 'wrong'};
  assert.equal((await tool(x, 'write_file', input)).error, 'FILE_PRECONDITION_CHANGED');
  assert.equal((await tool(x, 'read_file', {turn_id: x.turn, path: 'outside.txt'})).error, 'FILE_NOT_DELEGATED');
  const broker = new FileBroker(x.config, x.store, x.authority);
  await assert.rejects(broker.call('read_file', {turn_id: randomUUID(), path: 'README.md'}), /FILE_TURN_NOT_ACTIVE/);
  x.store.requestInterrupt(x.session, 1);
  await assert.rejects(broker.call('write_file', input), /FILE_TURN_NOT_ACTIVE/);
  assert.equal(x.store.fileIntents(x.session).length, 0);
});
test('runtime contract file broker preserves intervening edits and uncertain intent prohibits another write', async t => {
  const x = fixture(t), input = {turn_id: x.turn, path: 'src/app.mjs', request_id: 'race', expected_sha256: x.files.read('src/app.mjs').sha256, content: 'new code'};
  const answer = await tool(x, 'write_file', input, point => {if (point === 'before_replace') writeFileSync(join(x.worktree, input.path), 'human edit');});
  assert.equal(answer.error, 'FILE_PRECONDITION_CHANGED'); assert.equal(readFileSync(join(x.worktree, input.path), 'utf8'), 'human edit');
  assert.equal(x.store.fileIntents(x.session)[0].status, 'uncertain');
  assert.equal((await tool(x, 'write_file', {...input, request_id: 'retry', expected_sha256: x.files.read(input.path).sha256})).error, 'FILE_EFFECT_UNCERTAIN');
  assert.throws(() => x.store.assertToolsSettled(x.session), /FILE_EFFECT_UNCERTAIN/);
});
test('runtime contract file effects retain crash-after-replace ambiguity and reject forged tool success', async t => {
  const x = fixture(t), input = {turn_id: x.turn, path: 'README.md', request_id: 'crash', expected_sha256: null, content: 'written'};
  const answer = await tool(x, 'write_file', input, point => {if (point === 'after_replace') throw Error('SIMULATED_CRASH');});
  assert.equal(answer.error, 'SIMULATED_CRASH'); assert.equal(x.files.read(input.path).sha256, sha256('written')); assert.equal(x.store.fileIntents(x.session)[0].status, 'uncertain');
  assert.throws(() => x.store.observeToolResult(x.session, x.host, 1, 'made-up', [{type:'text',text:'PASS'}], false), /UNBOUND_TOOL_RESULT/);
});
test('runtime native scoped worktree marker prevents a second database from acquiring file authority', t => {
  const x = fixture(t); x.files.ownership();
  const secondPath = join(x.root, 'second.json'); writeFileSync(secondPath, JSON.stringify({...x.raw, data_dir: join(x.root, 'second-data')}));
  const config = loadHostConfig(secondPath), store = new TerminalStore(config.dbPath);
  try {assert.throws(() => new ScopedFiles(config).ownership(), /WORKTREE_OWNERSHIP_CONFLICT/);} finally {store.close();}
});
test('runtime native verifier namespace hides host home/network/desktop and makes snapshot read-only', async t => {
  const x = fixture(t), secret = join(x.root, 'sentinel'); writeFileSync(secret, 'private');
  const code = `const fs=require('fs');let blocked=false;try{fs.writeFileSync('/workspace/src/app.mjs','bad')}catch{blocked=true}process.stdout.write(JSON.stringify({hidden:!fs.existsSync(${JSON.stringify(secret)}),readonly:blocked,env:!process.env.HOME&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY&&!process.env.DBUS_SESSION_BUS_ADDRESS,network:fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').length===1}));`;
  const actual = await runSandbox(x.worktree, ['--eval', code], '', 5000, () => false);
  assert.equal(actual.exit, 0, actual.stderr); assert.deepEqual(JSON.parse(actual.stdout), {hidden:true,readonly:true,env:true,network:true});
  assert.equal(x.files.read('src/app.mjs').content, "process.stdout.write('broken')");
});
test('runtime contract independent verification rejects model claims, detects failed behavior, passes exact contracts and invalidates changed files', async t => {
  const x = fixture(t); finish(x);
  const first = await verifyFiles(x.store, x.config, x.session, 1, x.turn, 'initial'); assert.equal(first.result.status, 'FAIL'); assert.equal(first.result.checks_run, 1);
  writeFileSync(join(x.worktree, 'src/app.mjs'), "process.stdout.write('정답🐈')");
  const second = await verifyFiles(x.store, x.config, x.session, 1, x.turn, 'corrected'); assert.equal(second.result.status, 'PASS'); assert.equal(second.result.expected_checks, 1);
  const duplicate = await verifyFiles(x.store, x.config, x.session, 1, x.turn, 'corrected'); assert.equal(duplicate.deduplicated, true); assert.equal(x.store.verifications(x.session).length, 2);
  const bound = await prepareTerminalHandoff(x.store, x.config, x.session, 1, false); assert.equal(bound.handoff.verification.find(v => v.check === 'project_tests').status, 'PASS'); assert.equal(bound.project_completed, false);
  writeFileSync(join(x.worktree, 'src/app.mjs'), "process.stdout.write('forged PASS 100/100')");
  const stale = await prepareTerminalHandoff(x.store, x.config, x.session, 1, false); assert.equal(stale.handoff.verification.find(v => v.check === 'project_tests').status, 'NOT_RUN');
  const forged = await verifyFiles(x.store, x.config, x.session, 1, x.turn, 'forged'); assert.equal(forged.result.status, 'FAIL');
});
test('runtime native verifier kills an owned timeout and output flood without unsandboxed fallback', async t => {
  const x = fixture(t);
  const timeout = await runSandbox(x.worktree, ['--eval', 'while(true){}'], '', 150, () => false); assert.equal(timeout.reason, 'VERIFICATION_DEADLINE'); assert.equal(timeout.exit, null);
  const flood = await runSandbox(x.worktree, ['--eval', "process.stdout.write('a'.repeat(1000000))"], '', 5000, () => false); assert.equal(flood.reason, 'OUTPUT_LIMIT');
});
async function waitFile(path, child) {for(let n=0;n<300;n++){if(existsSync(path))return JSON.parse(readFileSync(path,'utf8'));assert.equal(child.exitCode,null,'owned child exited before barrier');await delay(20);}throw Error('barrier timeout');}
for(const point of ['intent_committed','before_replace','after_replace'])test(`runtime native file journal SIGKILL ${point} preserves actual effect and reconciles without replay`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'apd-file-crash-')),worktree=join(root,'owned'),path=join(root,'host.json');mkdirSync(join(worktree,'src'),{recursive:true});writeFileSync(join(worktree,'src/app.mjs'),'before');
 writeFileSync(path,JSON.stringify({schema_version:1,project_id:'crash',caller_ref:'test',account_ref:'test',worktree,data_dir:join(root,'data'),terminal:{executable:process.execPath,version:'2.1.126',files:{ownership:'exclusive_runtime',read:['src/app.mjs'],write:['src/app.mjs']}}}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./helpers/file-crash.mjs',import.meta.url)),path,point],{stdio:'ignore'});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(root,{recursive:true,force:true});});
 const checkpoint=await waitFile(join(worktree,'checkpoint.json'),child),ended=once(child,'close');child.kill('SIGKILL');await ended;
 const config=loadHostConfig(path),store=new TerminalStore(config.dbPath),files=new ScopedFiles(config);
 try {
  assert.equal(store.fileIntents(checkpoint.session)[0].status,'intent');const content=files.read('src/app.mjs').content;
  assert.equal(content,point==='after_replace'?'after crash 🐈':'before');
  const inode=statSync(join(worktree,'src/app.mjs')).ino,observed=store.reconcileFiles(config,checkpoint.session,1,p=>files.read(p));
  assert.equal(observed.automatic_resume,false);assert.equal(observed.observations[0].match,point==='after_replace'?'desired_content_now':'previous_content_now');
  assert.equal(statSync(join(worktree,'src/app.mjs')).ino,inode);assert.equal(files.read('src/app.mjs').content,content);
  assert.throws(()=>store.fileFence(config,checkpoint.authority,checkpoint.turn),/FILE_OWNER_NOT_ALIVE/);
  assert.throws(()=>store.requestResume(checkpoint.session,1,config),/RESUME_REQUIRES_FINISHED_TRANSCRIPT/);
 }finally{store.close();}
});
test('runtime native verifier parent SIGKILL terminates the observed sandbox process tree',async t=>{
 const root=mkdtempSync(join(tmpdir(),'apd-verifier-death-'));
 const child=spawn(process.execPath,[fileURLToPath(new URL('./helpers/verifier-parent.mjs',import.meta.url)),root],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>{stderr+=b;});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(root,{recursive:true,force:true});});
 const identities=await waitFile(join(root,'verifier-ready.json'),child);assert.ok(identities.length>=2,stderr);
 const ended=once(child,'close');child.kill('SIGKILL');await ended;
 for(let n=0;n<200;n++){if((await Promise.all(identities.map(liveness))).every(x=>x==='dead'))break;await delay(20);}
 assert.deepEqual(await Promise.all(identities.map(liveness)),identities.map(()=> 'dead'));
});
test('runtime contract real MCP broker child verifies CLI parent identity, observed call and stops on host revocation',async t=>{
 const x=fixture(t,{},false),client=new Client({name:'synthetic-cli',version:'1.0.0'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/terminal/file-entry.js',import.meta.url)),x.path,x.session,'1',x.host],stderr:'pipe'});
 try{
  await client.connect(transport);transport.stderr?.resume();const record=x.store.broker(x.session,1);assert.equal(JSON.parse(record.cli_identity_json).pid,process.pid);assert.equal(JSON.parse(record.identity_json).pid,transport.pid);
  const catalog=await client.listTools();assert.deepEqual(catalog.tools.map(t=>t.name).sort(),['read_file','write_file']);
  const input=fileRead.parse({turn_id:x.turn,path:'src/app.mjs'}),toolId=randomUUID();x.store.toolRequested(x.session,x.host,1,toolId,'mcp__runtime_files__read_file',input);
  const observed=await client.callTool({name:'read_file',arguments:input});assert.equal(observed.isError,undefined);assert.equal(JSON.parse(observed.content[0].text).sha256,x.files.read(input.path).sha256);
  x.store.observeToolResult(x.session,x.host,1,toolId,observed.content,false);
  const missing=await client.callTool({name:'write_file',arguments:{turn_id:x.turn,path:'README.md',request_id:'unobserved',expected_sha256:null,content:'must not write'}});assert.equal(missing.isError,true);assert.equal(x.files.read('README.md').sha256,null);
  const identity=JSON.parse(record.identity_json);x.store.stopTerminalHost(x.config.project.id,x.host);
  for(let n=0;n<200&&await liveness(identity)!=='dead';n++)await delay(20);
  assert.equal(await liveness(identity),'dead');assert.equal(processIdentitySync(process.pid).pid,process.pid);
 }finally{await client.close();}
});
test('runtime contract killed MCP broker cannot commit a stale queued write',async t=>{
 const x=fixture(t,{},false),client=new Client({name:'synthetic-cli',version:'1.0.0'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/terminal/file-entry.js',import.meta.url)),x.path,x.session,'1',x.host],stderr:'pipe'});
 try{
  await client.connect(transport);transport.stderr?.resume();const row=x.store.broker(x.session,1),authority={...x.authority,broker:row.identity_json};
  const identity=JSON.parse(row.identity_json);assert.equal(identity.pid,transport.pid);process.kill(transport.pid,'SIGKILL');
  for(let n=0;n<200&&await liveness(identity)!=='dead';n++)await delay(20);
  assert.equal(await liveness(identity),'dead');assert.throws(()=>x.store.fileFence(x.config,authority,x.turn),/FILE_OWNER_NOT_ALIVE/);assert.equal(x.store.fileIntents(x.session).length,0);
 }finally{await client.close();}
});
test('runtime contract file dispatch cancellation and changed configuration after durable intent never write',async t=>{
 for(const mutation of ['cancel','config']){
  const x=fixture(t),input={turn_id:x.turn,path:'README.md',request_id:'cut',expected_sha256:null,content:'not allowed'};
  const observed=await tool(x,'write_file',input,point=>{if(point==='intent_committed'){if(mutation==='cancel')x.store.requestInterrupt(x.session,1);else writeFileSync(x.path,JSON.stringify({...x.raw,terminal:{...x.raw.terminal,max_turns:9}}));}});
  assert.equal(observed.error,mutation==='cancel'?'FILE_TURN_NOT_ACTIVE':'CONFIG_CHANGED');assert.equal(x.files.read('README.md').sha256,null);assert.equal(x.store.fileIntents(x.session)[0].status,'uncertain');
 }
});
