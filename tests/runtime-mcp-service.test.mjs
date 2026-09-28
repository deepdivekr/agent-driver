import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CreateMessageRequestSchema,ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {startMcpService} from '../dist/interface/mcp-service.js';
import {readMcpService,mcpServiceHealth} from '../dist/interface/mcp-service-manager.js';
import {ownerAlive} from '../dist/interface/mcp-process.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {approveNonInterferingConnection} from '../dist/onboarding/connection.js';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'driver-mcp-service-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'shared-mcp',caller_ref:'local',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production'}));
  const cleanups=[];t.after(async()=>{try{for(const action of cleanups.reverse())await action();}finally{await rm(root,{recursive:true,force:true});}});
  return {root,path,cleanup:action=>cleanups.push(action)};
}
async function connect(url,token,name='test',capabilities={}){
  const client=new Client({name,version:'1.0.0'},{capabilities}),transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{authorization:'Bearer '+token}}});
  return {client,transport,open:()=>client.connect(transport),async close(){try{await transport.terminateSession();}finally{await client.close();}}};
}
const command=(args,root)=>new Promise((resolveResult,reject)=>{
  const child=spawn(process.execPath,[resolve('dist/cli.js'),...args],{env:{PATH:process.env.PATH,HOME:root},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('exit',code=>resolveResult({code,stdout,stderr}));
});
async function stop(record){if(await ownerAlive(record.owner))process.kill(record.owner.pid,'SIGTERM');for(let i=0;i<150;i++){if(!await ownerAlive(record.owner))return;await delay(100);}assert.fail('owned MCP did not drain');}
test('runtime native shared MCP concurrent startup uses one process and stable endpoint on restart',async t=>{
  const {root,path,cleanup}=await fixture(t);let record;
  cleanup(async()=>{if(record)await stop(record);});
  const results=await Promise.all(Array.from({length:8},()=>command(['mcp-service','start','--config',path],root)));
  for(const result of results)assert.equal(result.code,0,result.stderr);
  const values=results.map(r=>JSON.parse(r.stdout));assert.equal(new Set(values.map(v=>v.pid)).size,1);assert.equal(new Set(values.map(v=>v.url)).size,1);
  for(let round=0;round<3;round++){
    const reuse=await Promise.all(Array.from({length:8},()=>command(['mcp-service','start','--config',path],root)));
    for(const result of reuse){assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).pid,values[0].pid);}
  }
  record=await readMcpService(path);const original=record;
  const headers=await command(['mcp-service','headers','--config',path],root);assert.equal(headers.code,0);assert.equal(JSON.parse(headers.stdout).Authorization,'Bearer '+record.token);
  assert.ok(results.every(r=>!r.stdout.includes(record.token)&&!r.stderr.includes(record.token)));
  const clients=await Promise.all(Array.from({length:12},async(_,i)=>{const c=await connect(record.url,record.token,'client-'+i);await c.open();return c;}));
  cleanup(async()=>{for(const c of clients)await c.close().catch(()=>{});});
  assert.equal((await mcpServiceHealth(record)).sessions,12);
  for(const c of clients){assert.ok((await c.client.listTools()).tools.some(t=>t.name==='runtime_work_start'));assert.notEqual((await c.client.callTool({name:'runtime_health',arguments:{}})).isError,true);}
  await clients[0].close();assert.notEqual((await clients[1].client.callTool({name:'runtime_health',arguments:{}})).isError,true);
  for(const c of clients.slice(1))await c.close();
  assert.equal((await mcpServiceHealth(record)).sessions,0);
  await stop(record);
  const restart=await command(['mcp-service','start','--config',path],root);assert.equal(restart.code,0,restart.stderr);
  record=await readMcpService(path);assert.notEqual(record.owner.pid,original.owner.pid);assert.equal(record.url,original.url);assert.equal(record.token,original.token);
  assert.equal((await mcpServiceHealth(record)).sessions,0);
});
test('runtime native shared MCP rejects missing auth, foreign origins, bad hosts and excess sessions',async t=>{
  const {path,cleanup}=await fixture(t),token=randomBytes(32).toString('hex'),service=await startMcpService(path,{token,maxSessions:2});
  cleanup(()=>service.close());
  assert.equal((await fetch(service.url)).status,401);
  assert.equal((await fetch(service.url,{headers:{authorization:'Bearer '+token,origin:'https://evil.invalid'}})).status,403);
  const badHost=await new Promise((resolve,reject)=>{const req=request(service.url,{headers:{authorization:'Bearer '+token,host:'evil.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  assert.equal(badHost,403);
  assert.equal((await fetch(service.url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'x'.repeat(65537)})).status,413);
  const clients=await Promise.all([connect(service.url,token),connect(service.url,token),connect(service.url,token)]);cleanup(async()=>{for(const c of clients)await c.close().catch(()=>{});});
  await clients[0].open();await clients[1].open();await assert.rejects(clients[2].open(),/429|MCP_SESSION_LIMIT/);
  await clients[0].close();const next=await connect(service.url,token);await next.open();await next.close();
});

test('runtime native shared MCP update fence and explicit stop preserve active clients and endpoint',async t=>{
  const {root,path,cleanup}=await fixture(t);let record;
  cleanup(async()=>{if(record)await stop(record);});
  assert.equal((await command(['mcp-service','start','--config',path],root)).code,0);
  record=await readMcpService(path);const original=record;
  const c=await connect(record.url,record.token);await c.open();cleanup(()=>c.close().catch(()=>{}));
  const busy=await command(['mcp-service','stop','--config',path],root);
  assert.equal(busy.code,1);assert.match(busy.stderr,/MCP_SERVICE_DISCONNECT_CLIENTS_FIRST/);
  assert.notEqual((await c.client.callTool({name:'runtime_health',arguments:{}})).isError,true);
  await c.close();
  // A receipt written by the prior binary must not pass merely because its
  // executable path is unchanged. Cover both old and absent version metadata.
  for(const version of ['0.0.0',undefined]){
    await writeFile(join(root,'.mcp-service.json'),JSON.stringify({...record,version}));
    const stale=await command(['mcp-service','start','--config',path],root);
    assert.equal(stale.code,1);assert.match(stale.stderr,/MCP_SERVICE_VERSION_RESTART_REQUIRED/);
    assert.equal((await mcpServiceHealth(record)).pid,original.owner.pid);
  }
  const ended=await command(['mcp-service','stop','--config',path],root);
  assert.equal(ended.code,0,ended.stderr);assert.equal(await ownerAlive(original.owner),false);
  assert.equal((await command(['mcp-service','stop','--config',path],root)).code,0);
  const restarted=await command(['mcp-service','start','--config',path],root);assert.equal(restarted.code,0,restarted.stderr);
  record=await readMcpService(path);
  assert.notEqual(record.owner.pid,original.owner.pid);assert.equal(record.url,original.url);assert.equal(record.token,original.token);
  assert.ok(record.version&&record.version!=='0.0.0');
  assert.ok(!ended.stdout.includes(record.token)&&!restarted.stdout.includes(record.token));
});
test('runtime contract shared service isolates client sampling and human elicitation',async t=>{
  const {path,cleanup}=await fixture(t),token=randomBytes(32).toString('hex');
  const originalAttach=RuntimeApi.prototype.attachClientSampling,originalCall=RuntimeApi.prototype.call;
  const bindings=new Map();
  RuntimeApi.prototype.attachClientSampling=function(sampling){bindings.set(this,sampling);originalAttach.call(this,sampling);};
  const approvals=[];
  RuntimeApi.prototype.call=async function(name,args){if(name!=='runtime_health')return originalCall.call(this,name,args);const approval=this.packs.providers.approval;approvals.push(approval);return {sample:await bindings.get(this).call('design','return test identity',{},{}),elicitation:await approval.client.elicitInput({mode:'form',message:'Test connection isolation only',requestedSchema:{type:'object',properties:{label:{type:'string'}}}})};};
  cleanup(()=>{RuntimeApi.prototype.attachClientSampling=originalAttach;RuntimeApi.prototype.call=originalCall;});
  const service=await startMcpService(path,{token});cleanup(()=>service.close());
  const a=await connect(service.url,token,'A',{sampling:{},elicitation:{form:{}}}),b=await connect(service.url,token,'B',{sampling:{},elicitation:{form:{}}});
  for(const [c,label]of[[a,'A'],[b,'B']]){c.client.setRequestHandler(CreateMessageRequestSchema,async()=>({role:'assistant',model:'test-model',content:{type:'text',text:JSON.stringify({label})},stopReason:'endTurn'}));c.client.setRequestHandler(ElicitRequestSchema,async()=>({action:'accept',content:{label}}));await c.open();}
  cleanup(async()=>{await a.close().catch(()=>{});await b.close().catch(()=>{});});
  const [ar,br]=await Promise.all([a.client.callTool({name:'runtime_health',arguments:{}}),b.client.callTool({name:'runtime_health',arguments:{}})]);
  assert.equal(JSON.parse(ar.content[0].text).sample.label,'A');assert.equal(JSON.parse(br.content[0].text).sample.label,'B');assert.notEqual(approvals[0],approvals[1]);
  assert.equal(JSON.parse(ar.content[0].text).elicitation.content.label,'A');assert.equal(JSON.parse(br.content[0].text).elicitation.content.label,'B');
  await a.close();assert.equal(JSON.parse((await b.client.callTool({name:'runtime_health',arguments:{}})).content[0].text).sample.label,'B');
});
test('runtime native default stdio is a lightweight shared-server bridge',async t=>{
  const {root,cleanup}=await fixture(t),connection=join(root,'.agent-driver');await approveNonInterferingConnection(connection);
  let record;const clients=[];cleanup(async()=>{for(const {client}of clients)await client.close().catch(()=>{});if(record)await stop(record);});
  for(let i=0;i<3;i++){
    const client=new Client({name:'stdio-'+i,version:'1.0.0'}),transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.js'),'mcp'],env:{PATH:process.env.PATH,HOME:root},stderr:'pipe'});let stderr='';transport.stderr?.on('data',b=>stderr+=b);
    clients.push({client,transport});await client.connect(transport);assert.notEqual((await client.callTool({name:'runtime_health',arguments:{}})).isError,true,stderr);
  }
  record=await readMcpService(join(connection,'runtime-config.json'));assert.equal((await mcpServiceHealth(record)).sessions,3);
  for(const {client}of clients)await client.close();
  for(let i=0;i<60&&(await mcpServiceHealth(record)).sessions!==0;i++)await delay(50);
  assert.equal((await mcpServiceHealth(record)).sessions,0);
  const slots=await readdir(join(root,'.agent-driver','mcp-processes'));assert.deepEqual(slots,['0']);
});
test('runtime native explicit stdio compatibility refuses a fourth full runtime',async t=>{
  const {root,path,cleanup}=await fixture(t),clients=[];cleanup(async()=>{for(const c of clients)await c.close().catch(()=>{});});
  for(let i=0;i<3;i++){const c=new Client({name:'direct-'+i,version:'1.0.0'}),transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.js'),'mcp','--config',path],env:{PATH:process.env.PATH,HOME:root},stderr:'pipe'});clients.push(c);await c.connect(transport);}
  const result=await command(['mcp','--config',path],root);assert.equal(result.code,1);assert.match(result.stderr,/MCP_PROCESS_LIMIT_USE_SHARED_SERVER/);
  await clients[0].close();const resultAfter=await command(['mcp','--config',path],root);assert.equal(resultAfter.code,0,resultAfter.stderr);
});
test('runtime contract idle session expiry does not abandon an admitted operation',async t=>{
  const {path,cleanup}=await fixture(t),token=randomBytes(32).toString('hex');
  const originalCall=RuntimeApi.prototype.call;let entered;const started=new Promise(r=>entered=r);let release;const gate=new Promise(r=>release=r);
  RuntimeApi.prototype.call=async function(name,args){if(name!=='runtime_health')return originalCall.call(this,name,args);entered();await gate;return {complete:true};};
  cleanup(()=>{RuntimeApi.prototype.call=originalCall;});
  const service=await startMcpService(path,{token,idleMs:250});cleanup(()=>service.close());
  const c=await connect(service.url,token);cleanup(async()=>{release();await c.close().catch(()=>{});});await c.open();
  const pending=c.client.callTool({name:'runtime_health',arguments:{}});await started;await delay(700);
  const health=()=>fetch(new URL('/health',service.url),{headers:{authorization:'Bearer '+token}}).then(r=>r.json());
  assert.equal((await health()).sessions,1);release();assert.equal(JSON.parse((await pending).content[0].text).complete,true);
  await delay(600);assert.equal((await health()).sessions,0);
});
