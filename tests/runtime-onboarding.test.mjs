import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {approveNonInterferingConnection,approvedMcpConfigPath,connectionRoot,localConnectionPaths,localConnectionScreen,readLocalConnection} from '../dist/onboarding/connection.js';
import {startLocalConnectionScreen} from '../dist/onboarding/local-screen.js';

async function root(t){const value=await mkdtemp(join(tmpdir(),'agent-driver-connect-'));t.after(async()=>{await rm(value,{recursive:true,force:true});});return value;}

test('first-run connection has exactly one available non-interfering approval and creates the private default MCP config',async t=>{
  const stateRoot=await root(t),connected=await approveNonInterferingConnection(stateRoot,new Date('2026-09-21T12:00:00.000Z')),paths=localConnectionPaths(stateRoot);
  assert.equal(localConnectionScreen.title,'내 컴퓨터 연결');assert.deepEqual(localConnectionScreen.modes.filter(mode=>mode.available).map(mode=>mode.id),['non_interfering']);
  assert.equal(connected.state.mode,'non_interfering');assert.equal(connected.state.computer.host_desktop_access,'none');assert.equal(connected.state.computer.host_file_bridge,'explicit_transfer_only');assert.equal(connected.state.mcp.command,'agent-driver mcp');assert.equal(connected.state.jev.status,'optional');
  assert.equal(approvedMcpConfigPath(stateRoot),paths.runtimeConfig);assert.equal(readLocalConnection(stateRoot)?.connection_id,connected.state.connection_id);
  const config=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));assert.deepEqual(config,{schema_version:1,project_id:'agent-driver-local',caller_ref:'local-agent',account_ref:'owner',worktree:'workspace',data_dir:'data',environment:'production',recovery_policy:'auto_resume'});
  assert.equal((await stat(paths.state)).mode&0o077,0);assert.equal((await stat(paths.runtimeConfig)).mode&0o077,0);
});

test('loopback connection screen exposes no shared-screen consent and accepts only a one-time anti-forgery protected approval',async t=>{
  const stateRoot=await root(t),screen=await startLocalConnectionScreen(stateRoot);t.after(async()=>{await screen.close().catch(()=>undefined);});
  assert.match(screen.url,/^http:\/\/127\.0\.0\.1:\d+\/$/u);
  const initial=await fetch(screen.url),html=await initial.text();assert.equal(initial.status,200);assert.match(html,/방해하지 않는 모드/u);assert.match(html,/에이전트 전용 데스크톱/u);assert.match(html,/공유 화면 허용/u);assert.match(html,/현재 사용할 수 없음/u);
  const token=/name="token" value="([a-f0-9]{64})"/u.exec(html)?.[1];assert.ok(token);
  const denied=await fetch(`${screen.url}approve`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,mode:'shared_screen'})});assert.equal(denied.status,403);assert.equal(readLocalConnection(stateRoot),null);
  const accepted=await fetch(`${screen.url}approve`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,mode:'non_interfering'})});assert.equal(accepted.status,200);assert.match(await accepted.text(),/이 컴퓨터가 연결되었습니다/u);
  const result=await screen.approved;assert.equal(result.paths.root,stateRoot);assert.equal(readLocalConnection(stateRoot)?.mode,'non_interfering');
});

test('connection root accepts only an explicit absolute per-user location',()=>{
  assert.equal(connectionRoot({AGENT_DRIVER_CONNECTION_ROOT:'/tmp/agent-driver-user'}),'/tmp/agent-driver-user');
  assert.throws(()=>connectionRoot({AGENT_DRIVER_CONNECTION_ROOT:'relative'}),/CONNECTION_ROOT_ABSOLUTE_REQUIRED/);
});
