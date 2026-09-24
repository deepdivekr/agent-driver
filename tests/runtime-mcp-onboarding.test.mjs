import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'yaml';
import {McpRegistrationController} from '../dist/onboarding/mcp-registration.js';
import {SetupActivityStream,appendSetupActivity,readSetupActivity} from '../dist/onboarding/setup-activity.js';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {ControlSettings} from '../dist/observability/control-settings.js';
import {loadHostConfig} from '../dist/interface/config.js';

async function setup(t){const root=await mkdtemp(join(tmpdir(),'driver-mcp-onboarding-'));t.after(()=>rm(root,{recursive:true,force:true}));const paths=await prepareLocalConnection(root);return {root,paths,config:loadHostConfig(paths.runtimeConfig)};}
function environment(root){return {HOME:root,WSL_DISTRO_NAME:'Ubuntu-24.04',HERMES_HOME:join(root,'.hermes'),AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude',AGENT_DRIVER_OPENCODE_EXECUTABLE:'/fixture/opencode',AGENT_DRIVER_CURSOR_EXECUTABLE:'/fixture/cursor-agent',AGENT_DRIVER_HERMES_EXECUTABLE:'/fixture/hermes',AGENT_DRIVER_CURSOR_MCP_CONFIG:join(root,'.cursor','mcp.json')};}

test('runtime contract onboarding registers five clients without a shell and preserves unrelated config',async t=>{
  const x=await setup(t),env=environment(x.root),calls=[],runner={async run(request){calls.push(request);return {code:0,stdout:'configured',stderr:''};}};
  await mkdir(join(x.root,'.cursor'),{recursive:true});await writeFile(env.AGENT_DRIVER_CURSOR_MCP_CONFIG,JSON.stringify({theme:'dark',mcpServers:{other:{command:'other'}}}));
  await mkdir(env.HERMES_HOME,{recursive:true});await writeFile(join(env.HERMES_HOME,'config.yaml'),'model: fixture\nmcp_servers:\n  other:\n    command: /other\n');
  const controller=new McpRegistrationController(x.root,env,runner);assert.equal((await controller.view()).registered_count,0);
  for(const id of ['codex','claude','opencode','cursor','hermes'])await controller.register(id);
  const view=await controller.view();assert.equal(view.registered_count,5);assert.equal(view.credentials_exposed,false);assert.ok(view.clients.every(item=>item.registration==='registered'));
  assert.equal(calls.length,3);assert.deepEqual(calls.map(item=>item.args.slice(0,4)),[['mcp','add','agent-driver','--'],['mcp','add','--scope','user'],['mcp','add','agent-driver','--global']]);assert.ok(calls.every(item=>item.executable.startsWith('/fixture/')&&!('shell' in item)));
  const cursor=JSON.parse(await readFile(env.AGENT_DRIVER_CURSOR_MCP_CONFIG,'utf8'));assert.equal(cursor.theme,'dark');assert.equal(cursor.mcpServers.other.command,'other');assert.equal(cursor.mcpServers['agent-driver'].command,process.execPath);assert.equal(cursor.mcpServers['agent-driver'].args.at(-1),'mcp');
  const hermes=parse(await readFile(join(env.HERMES_HOME,'config.yaml'),'utf8'));assert.equal(hermes.model,'fixture');assert.equal(hermes.mcp_servers.other.command,'/other');assert.equal(hermes.mcp_servers['agent-driver'].command,process.execPath);
  const receipt=await readFile(join(x.root,'mcp-registrations.json'),'utf8');assert.doesNotMatch(receipt,/configured|fixture\/codex|secret/iu);assert.match(receipt,/command_fingerprint/);
});

test('runtime contract registration refuses conflicting Cursor entry and failed CLI registration',async t=>{
  const x=await setup(t),env=environment(x.root);await mkdir(join(x.root,'.cursor'),{recursive:true});await writeFile(env.AGENT_DRIVER_CURSOR_MCP_CONFIG,JSON.stringify({mcpServers:{'agent-driver':{command:'/different',args:['mcp']}}}));
  const failed=new McpRegistrationController(x.root,env,{async run(){return {code:2,stdout:'secret should not persist',stderr:'failed'};}});
  await assert.rejects(failed.register('cursor'),/MCP_REGISTRATION_CONFLICT/);await assert.rejects(failed.register('codex'),/MCP_REGISTRATION_FAILED/);assert.equal((await failed.view()).registered_count,0);assert.equal(readSetupActivity(x.root).length,0);
});

test('runtime native setup activity SSE replays history and streams sanitized MCP progress',async t=>{
  const x=await setup(t),secret='sk-fixture-secret-value-123456789';await appendSetupActivity(x.root,'setup','success','Agent Driver 설치를 확인했습니다.');await assert.rejects(appendSetupActivity(x.root,'ai','info',secret),/SETUP_ACTIVITY_UNSAFE/);
  let registered=false;const mcp={async view(){return {agent_driver:{installed:true,mcp_command:'agent-driver mcp'},clients:[{id:'codex',installed:true,registration:registered?'registered':'not_registered',automatic:true,reason:'fixture',restart_required:registered}],registered_count:registered?1:0,credentials_exposed:false};},async register(){registered=true;return this.view();}};
  const auth={async connections(){return [];},view(){return {state:'idle'};},async start(){return {state:'idle'};},close(){}};const activity=new SetupActivityStream(x.root),settings=new ControlSettings(x.config,auth,{},fetch,mcp,activity);let host;
  const server=createServer((req,res)=>void settings.handle(req,res,req.url.slice(1),host));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));host='127.0.0.1:'+server.address().port;t.after(async()=>{settings.close();await new Promise(resolve=>server.close(resolve));});
  const stream=await fetch('http://'+host+'/settings/activity');assert.match(stream.headers.get('content-type'),/text\/event-stream/);const reader=stream.body.getReader(),decoder=new TextDecoder();let text=decoder.decode((await reader.read()).value);assert.match(text,/Agent Driver 설치/);
  const headers={origin:'http://'+host,'content-type':'application/json','x-agent-driver':'human-settings'},response=await fetch('http://'+host+'/settings/mcp/register',{method:'POST',headers,body:JSON.stringify({client:'codex'})});assert.equal(response.status,200);assert.equal((await response.json()).registered_count,1);
  for(let i=0;i<4&&!/Codex MCP 등록 완료/u.test(text);i++)text+=decoder.decode((await reader.read()).value);assert.match(text,/Codex에 agent-driver mcp 등록 요청/u);assert.match(text,/Codex MCP 등록 완료 · [0-9.]+초/u);assert.doesNotMatch(text,/\$ Codex/u);assert.doesNotMatch(text,new RegExp(secret));await reader.cancel();
  const page=await fetch('http://'+host+'/settings');const html=await page.text();assert.equal(page.status,200);assert.match(html,/연결 작업 기록/u);assert.match(html,/터미널 원문은 저장하지 않습니다/u);assert.match(html,/실제 업무 기록은/u);assert.doesNotMatch(html,/SETUP TAIL/u);
});
