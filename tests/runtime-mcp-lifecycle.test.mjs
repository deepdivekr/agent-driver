import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {McpLifetime} from '../dist/interface/mcp-lifetime.js';
import {tools} from '../dist/interface/catalog.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('runtime contract MCP close fences dispatch and drains every admitted call before disposal',async()=>{
  const gate=deferred(),trace=[];
  let lifecycle;
  lifecycle=new McpLifetime({fence(){trace.push('fence');},async disconnect(){trace.push('disconnect');void lifecycle.close();},async dispose(){trace.push('dispose');}});
  const admitted=lifecycle.run(async()=>{trace.push('start');await gate.promise;trace.push('stored');return 42;});
  const closing=lifecycle.close();assert.equal(lifecycle.close(),closing);
  await assert.rejects(lifecycle.run(async()=>{assert.fail('late dispatch');}),/MCP_CONNECTION_CLOSED/);
  await delay(10);assert.deepEqual(trace,['start','fence','disconnect']);
  gate.resolve();assert.equal(await admitted,42);await closing;
  assert.deepEqual(trace,['start','fence','disconnect','stored','dispose']);
});
test('runtime contract MCP failing requests and broken transport still dispose once',async()=>{
  let disposed=0;
  const lifecycle=new McpLifetime({fence(){},async disconnect(){throw Error('closed pipe');},async dispose(){disposed++;}});
  await assert.rejects(lifecycle.run(()=>{throw Error('sync failure');}),/sync failure/);
  await assert.rejects(lifecycle.close(),/closed pipe/);
  await assert.rejects(lifecycle.close(),/closed pipe/);assert.equal(disposed,1);
});
test('runtime contract closing one MCP connection does not fence another client',async()=>{
  const hooks=()=>({fence(){},async disconnect(){},async dispose(){}});
  const first=new McpLifetime(hooks()),second=new McpLifetime(hooks());
  await first.close();assert.equal(await second.run(async()=>17),17);await second.close();
});

async function setup(t,blockImports=false){
  const root=await mkdtemp(join(tmpdir(),'driver-mcp-lifetime-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'lifetime',caller_ref:'tester',account_ref:'tester',worktree:root,data_dir:join(root,'data'),environment:'production'}));
  const args=[];
  if(blockImports){
    const hook=join(root,'guard.mjs');
    await writeFile(hook,`import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(specifier==='playwright'||/\\/(?:observability\\/control-center|onboarding\\/cli|soak\\/cli|isolation\\/cli)\\.js$/.test(result.url))throw Error('UNEXPECTED_EAGER_IMPORT:'+specifier);return result;}});`);
    args.push('--import',hook);
  }
  const child=spawn(process.execPath,[...args,resolve('dist/cli.js'),'mcp','--config',path],{env:{PATH:process.env.PATH,HOME:root},stdio:['pipe','pipe','pipe']});
  let stderr='',next=0;const pending=new Map();
  child.stderr.on('data',data=>stderr+=data);
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{const value=JSON.parse(line);if(value.id!==undefined){pending.get(value.id)?.(value);pending.delete(value.id);}});
  async function rpc(method,params={}){
    const id=++next;const reply=new Promise(resolve=>pending.set(id,resolve));
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    let timer;try{return await Promise.race([reply,exited.then(()=>{throw Error('MCP_EXITED:'+stderr);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('MCP_REPLY_TIMEOUT:'+stderr)),10000);})]);}finally{clearTimeout(timer);pending.delete(id);}
  }
  async function closed(){
    let timer;try{return await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('MCP_DID_NOT_EXIT:'+stderr)),10000);})]);}finally{clearTimeout(timer);}
  }
  const presence=()=>{const db=new DatabaseSync(join(root,'data','runtime.sqlite'),{readOnly:true});try{return db.prepare('SELECT state,stopped_at FROM runtime_presence').all();}finally{db.close();}};
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;lines.close();await rm(root,{recursive:true,force:true});});
  const initialized=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'owned-lifetime-test',version:'1'}});
  assert.ok(initialized.result,JSON.stringify(initialized));
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  return {child,rpc,closed,presence};
}
test('runtime native idle MCP lists all tools and reads health without loading browsers or Control Center',{timeout:20000},async t=>{
  const x=await setup(t,true),list=await x.rpc('tools/list');
  assert.deepEqual(list.result.tools.map(tool=>tool.name).sort(),[...Object.keys(tools),'runtime_task_intake'].sort());
  const health=await x.rpc('tools/call',{name:'runtime_health',arguments:{}});assert.notEqual(health.result.isError,true);
  assert.equal(x.presence()[0].state,'active');
  x.child.stdin.end();assert.deepEqual(await x.closed(),{code:0,signal:null});
  assert.equal(x.presence()[0].state,'stopped');assert.ok(x.presence()[0].stopped_at);
});
for(const [signal,code]of [['SIGTERM',143],['SIGINT',130]])test('runtime native MCP '+signal+' records stopped presence and exits without forced kill',{skip:process.platform==='win32',timeout:20000},async t=>{
  const x=await setup(t);x.child.kill(signal);assert.deepEqual(await x.closed(),{code,signal:null});assert.equal(x.presence()[0].state,'stopped');
});
test('runtime native MCP reader loss disposes its presence and does not leave a live process',{timeout:20000},async t=>{
  const x=await setup(t);x.child.stdout.destroy();x.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:999,method:'tools/list'})+'\n');
  const exit=await x.closed();assert.equal(exit.signal,null);assert.equal(exit.code,1);assert.equal(x.presence()[0].state,'stopped');
});
test('runtime native MCP oversized transport input closes without retaining its presence',{timeout:20000},async t=>{
  const x=await setup(t);x.child.stdin.write('x'.repeat(65537));
  assert.deepEqual(await x.closed(),{code:0,signal:null});assert.equal(x.presence()[0].state,'stopped');
});
test('runtime native closing one stdio client leaves the other connection responsive',{timeout:30000},async t=>{
  const first=await setup(t),second=await setup(t);first.child.stdin.end();await first.closed();
  const result=await second.rpc('tools/call',{name:'runtime_health',arguments:{}});assert.notEqual(result.result.isError,true);assert.equal(second.presence()[0].state,'active');
  second.child.stdin.end();await second.closed();
});
