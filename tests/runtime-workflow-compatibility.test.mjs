import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkflowCompatibility} from '../dist/integrations/workflow-compatibility.js';
import {prepareWorkflowUpgrade,applyWorkflowUpgrade,rollbackWorkflowUpgrade} from '../dist/integrations/workflow-upgrade.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {tools} from '../dist/interface/catalog.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'workflow-compat-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const paths=await prepareLocalConnection(join(root,'host')),old=join(root,'legacy');await mkdir(join(old,'dist/workflows'),{recursive:true});
  await writeFile(join(old,'package.json'),JSON.stringify({type:'module'}));
  const contracts=join(old,'dist/workflows/contracts.js'),runtime=join(old,'dist/workflows/runtime.js');
  await writeFile(contracts,`import {z} from ${JSON.stringify(pathToFileURL(resolve('node_modules/zod/index.js')).href)};
export const workflowPolicy=z.object({example:z.object({id:z.literal('daily-read'),label:z.string()}).strict()}).strict();
export const workflowTools={runtime_workflow_catalog:{schema:z.object({}).strict(),implemented:true,readOnly:true},
runtime_workflow_status:{schema:z.object({request_id:z.string().regex(/^[a-z0-9-]+$/)}).strict(),implemented:true,readOnly:true},
runtime_workflow_run:{schema:z.object({request_id:z.string().regex(/^[a-z0-9-]+$/),workflow_id:z.literal('daily-read'),text:z.string().max(100),uncertain:z.boolean().optional()}).strict(),implemented:true,readOnly:false}};
`);
  await writeFile(runtime,`import {readFile,writeFile,mkdir} from 'node:fs/promises';import {join,dirname} from 'node:path';
export async function workflowCall(config,name,args){
 const root=dirname(config.dbPath),path=join(root,args.request_id+'.json');
 if(name==='runtime_workflow_catalog')return {workflows:[{id:config.workflows.example.id}]};
 if(name==='runtime_workflow_status')return JSON.parse(await readFile(path,'utf8'));
 await mkdir(root,{recursive:true});try{return {...JSON.parse(await readFile(path,'utf8')),deduplicated:true}}catch(e){if(e.code!=='ENOENT')throw e;}
 const receipt={status:args.uncertain?'reconciliation_required':'completed',effects:1};await writeFile(path,JSON.stringify(receipt));
 if(args.uncertain)throw Error('TEST_OUTCOME_UNKNOWN');return receipt;
}
`);
  const raw=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));raw.workflows={example:{id:'daily-read',label:'기존 업무'}};raw.work={model_data_approved:false};raw.recovery_policy='prepare_only';
  await writeFile(paths.runtimeConfig,JSON.stringify(raw,null,2)+'\n',{mode:0o600});
  const original=await readFile(paths.runtimeConfig),planPath=join(root,'upgrade.json');
  const plan=()=>prepareWorkflowUpgrade(paths.runtimeConfig,old,planPath);
  const apply=p=>applyWorkflowUpgrade(planPath,p.plan_sha256),rollback=p=>rollbackWorkflowUpgrade(planPath,p.plan_sha256);
  return {root,paths,old,runtime,contracts,raw,original,planPath,plan,apply,rollback};
}
test('runtime fixture preserved legacy policy is visible but cannot execute without an explicit local connection',async t=>{
 const x=await fixture(t),config=loadHostConfig(x.paths.runtimeConfig),bridge=new WorkflowCompatibility(config);
 assert.deepEqual(config.legacyWorkflows,x.raw.workflows);
 assert.equal((await bridge.call('runtime_workflow_catalog',{})).reason,'WORKFLOW_COMPATIBILITY_CONNECTION_REQUIRED');
 await assert.rejects(bridge.call('runtime_workflow_run',{request_id:'one',workflow_id:'daily-read',text:'x'}),/CONNECTION_REQUIRED/u);
 assert.deepEqual(await readFile(x.paths.runtimeConfig),x.original);
 const raw={...x.raw,unrecognized_setting:true};await writeFile(x.paths.runtimeConfig,JSON.stringify(raw));assert.throws(()=>loadHostConfig(x.paths.runtimeConfig));
});
test('runtime native workflow migration preserves all settings and exact-byte rollback across repeat apply',async t=>{
 const x=await fixture(t),p=x.plan();assert.deepEqual(await readFile(x.paths.runtimeConfig),x.original);
 assert.equal((await stat(x.planPath)).mode&0o777,0o600);assert.equal(x.apply(p).status,'applied');assert.equal(x.apply(p).status,'already_applied');
 const next=JSON.parse(await readFile(x.paths.runtimeConfig,'utf8'));delete next.workflow_bridge;assert.deepEqual(next,x.raw);
 assert.equal(loadHostConfig(x.paths.runtimeConfig).workflowBridge.protocol,'local-workflow-v1');
 assert.equal(x.rollback(p).status,'applied');assert.equal(x.rollback(p).status,'already_applied');assert.deepEqual(await readFile(x.paths.runtimeConfig),x.original);
});
test('runtime fixture workflow bridge validates the retained contract before calling and preserves old receipts',async t=>{
 const x=await fixture(t),p=x.plan();x.apply(p);let bridge=new WorkflowCompatibility(loadHostConfig(x.paths.runtimeConfig));
 const args={request_id:'one',workflow_id:'daily-read',text:'본문'};
 assert.equal((await bridge.call('runtime_workflow_catalog',{})).workflows[0].id,'daily-read');
 await assert.rejects(bridge.call('runtime_workflow_run',{...args,unauthorized:true}));
 assert.equal((await bridge.call('runtime_workflow_run',args)).effects,1);await bridge.drain();
 bridge=new WorkflowCompatibility(loadHostConfig(x.paths.runtimeConfig));
 assert.equal((await bridge.call('runtime_workflow_run',args)).deduplicated,true);
 assert.equal((await bridge.call('runtime_workflow_status',{request_id:'one'})).status,'completed');
 await assert.rejects(bridge.call('runtime_workflow_status',{request_id:'../escape'}));
});
test('runtime fixture uncertain local workflow result is never automatically retried by the bridge',async t=>{
 const x=await fixture(t),p=x.plan();x.apply(p);const bridge=new WorkflowCompatibility(loadHostConfig(x.paths.runtimeConfig));
 const args={request_id:'uncertain',workflow_id:'daily-read',text:'x',uncertain:true};await assert.rejects(bridge.call('runtime_workflow_run',args),/TEST_OUTCOME_UNKNOWN/u);
 assert.deepEqual(await bridge.call('runtime_workflow_status',{request_id:'uncertain'}),{status:'reconciliation_required',effects:1});
 assert.deepEqual(await bridge.call('runtime_workflow_run',args),{status:'reconciliation_required',effects:1,deduplicated:true});
});
test('runtime contract workflow connection rejects live revocation and policy changes after initialization',async t=>{
 const x=await fixture(t),p=x.plan();x.apply(p);const bridge=new WorkflowCompatibility(loadHostConfig(x.paths.runtimeConfig));
 await bridge.call('runtime_workflow_catalog',{});const raw=JSON.parse(await readFile(x.paths.runtimeConfig,'utf8'));raw.workflows.example.label='changed';
 await writeFile(x.paths.runtimeConfig,JSON.stringify(raw));await assert.rejects(bridge.call('runtime_workflow_catalog',{}),/CONFIGURATION_CHANGED/u);
 assert.throws(()=>x.rollback(p),/CONFIG_CHANGED/u);
});
for(const [field,value] of [['account_ref','other-account'],['caller_ref','other-caller'],['data_dir','other-data']]){
test('runtime contract workflow dispatch fences changed host '+field,async t=>{
 const x=await fixture(t),p=x.plan();x.apply(p);const bridge=new WorkflowCompatibility(loadHostConfig(x.paths.runtimeConfig));
 const raw=JSON.parse(await readFile(x.paths.runtimeConfig,'utf8'));raw[field]=value;await writeFile(x.paths.runtimeConfig,JSON.stringify(raw));
 await assert.rejects(bridge.call('runtime_workflow_catalog',{}),/CONFIGURATION_CHANGED/u);
});
}
test('runtime native workflow migration rejects plan tampering, configuration drift and concurrent locks',async t=>{
 const x=await fixture(t),p=x.plan(),planBytes=await readFile(x.planPath);
 await writeFile(x.planPath,Buffer.concat([planBytes,Buffer.from(' ')]));assert.throws(()=>x.apply(p),/PLAN_CHANGED/u);await writeFile(x.planPath,planBytes);
 await writeFile(x.paths.runtimeConfig,Buffer.concat([x.original,Buffer.from(' ')]));assert.throws(()=>x.apply(p),/CONFIG_CHANGED/u);await writeFile(x.paths.runtimeConfig,x.original);
 const lock=x.paths.runtimeConfig+'.workflow-compatibility.lock';await writeFile(lock,'busy');assert.throws(()=>x.apply(p),/UPGRADE_BUSY/u);await rm(lock);
 assert.equal(x.apply(p).status,'applied');
});
test('runtime native workflow modules are fingerprinted on dispatch and rollback works after module removal',async t=>{
 const x=await fixture(t),p=x.plan();x.apply(p);const bridge=new WorkflowCompatibility(loadHostConfig(x.paths.runtimeConfig));await bridge.call('runtime_workflow_catalog',{});
 await writeFile(x.runtime,'throw Error("MUST NOT EXECUTE")');await assert.rejects(bridge.call('runtime_workflow_catalog',{}),/MODULE_CHANGED/u);
 assert.throws(()=>x.apply(p),/MODULE_CHANGED/u);await rm(x.runtime);assert.equal(x.rollback(p).status,'applied');assert.deepEqual(await readFile(x.paths.runtimeConfig),x.original);
});
test('runtime contract workflow ABI mismatch and oversized arguments cannot invoke retained workflow',async t=>{
 const x=await fixture(t);await writeFile(x.contracts,'export const workflowTools={};');const p=x.plan();x.apply(p);
 const bridge=new WorkflowCompatibility(loadHostConfig(x.paths.runtimeConfig));await assert.rejects(bridge.call('runtime_workflow_catalog',{}),/ABI_INVALID/u);
 await assert.rejects(bridge.call('runtime_workflow_run',{request_id:'one',workflow_id:'daily-read',text:'x'.repeat(66000)}),/REQUEST_TOO_LARGE/u);
});
test('runtime fixture generic workflow tools are available through RuntimeApi and drain fences new calls',async t=>{
 const x=await fixture(t),p=x.plan();x.apply(p);const api=new RuntimeApi(loadHostConfig(x.paths.runtimeConfig));t.after(async()=>{await api.drain();api.close()});
 assert.equal(tools.runtime_workflow_run.readOnly,false);assert.equal((await api.call('runtime_workflow_catalog',{})).workflows.length,1);
 await api.drain();await assert.rejects(api.call('runtime_workflow_catalog',{}),/COMPATIBILITY_CLOSED/u);
});
test('runtime native workflow migration rejects symlinked configuration instead of replacing its target',async t=>{
 const x=await fixture(t),alias=join(x.root,'alias.json');await symlink(x.paths.runtimeConfig,alias);
 assert.throws(()=>prepareWorkflowUpgrade(alias,x.old,x.planPath));assert.deepEqual(await readFile(x.paths.runtimeConfig),x.original);
});
test('runtime contract changed retained module requires a new process instead of silently using the ESM cache',async t=>{
 const x=await fixture(t),p=x.plan();x.apply(p);await new WorkflowCompatibility(loadHostConfig(x.paths.runtimeConfig)).call('runtime_workflow_catalog',{});
 x.rollback(p);await writeFile(x.runtime,(await readFile(x.runtime,'utf8'))+'\n// next version\n');
 const next=join(x.root,'next-plan.json'),second=prepareWorkflowUpgrade(x.paths.runtimeConfig,x.old,next);applyWorkflowUpgrade(next,second.plan_sha256);
 await assert.rejects(new WorkflowCompatibility(loadHostConfig(x.paths.runtimeConfig)).call('runtime_workflow_catalog',{}),/MODULE_RESTART_REQUIRED/u);
});
test('runtime native workflow compatibility CLI plan apply rollback preserves config and never calls an adapter',async t=>{
 const x=await fixture(t),base=['dist/cli.js','compatibility'];
 const prepared=await exec(process.execPath,[...base,'plan','--config',x.paths.runtimeConfig,'--runtime-root',x.old,'--plan',x.planPath],{timeout:20000});
 const p=JSON.parse(prepared.stdout);assert.doesNotMatch(prepared.stdout,/original_base64|기존 업무/u);
 for(const command of ['apply','apply','rollback']){
  const result=await exec(process.execPath,[...base,command,'--plan',x.planPath,'--sha256',p.plan_sha256],{timeout:20000});assert.equal(JSON.parse(result.stdout).automatic_execution,false);
 }
 assert.deepEqual(await readFile(x.paths.runtimeConfig),x.original);
});
