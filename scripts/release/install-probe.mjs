import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const [installed,stateRoot,mode,expectedVersion]=process.argv.slice(2);
const load=relative=>import(pathToFileURL(join(installed,relative)).href);
const {prepareLocalConnection,approveNonInterferingConnection}=await load('dist/onboarding/connection.js');
const {loadHostConfig}=await load('dist/interface/config.js');
const {RuntimeApi}=await load('dist/interface/api.js');
const paths=await prepareLocalConnection(stateRoot);
if(mode==='seed'){
  await approveNonInterferingConnection(stateRoot);
  const raw=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));
  // v0.1.0 predates the explicit Work consent section; use its existing
  // swarm consent contract when seeding an old-version database.
  if(expectedVersion==='0.1.0')delete raw.work;
  else raw.work={model_data_approved:true};
  raw.swarm={enabled:true,model_data_approved:true};
  await writeFile(paths.runtimeConfig,JSON.stringify(raw)+'\n',{mode:0o600});
}
const config=loadHostConfig(paths.runtimeConfig);
const model={calls:[],async call(){return {title:'Upgrade preservation check',desired_outcome:'Keep this synthetic Work across an installer update',completion_checks:[{id:'keep',result:'Keep the Work record',evidence:'Same Work ID and stored prompt after upgrade'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};}};
const api=new RuntimeApi(config,{swarmModel:model});
try{
  const work=await api.call('runtime_work_start',{request_id:'release-upgrade-preserve',prompt:'Preserve this synthetic Work through the upgrade'});
  assert.equal(work.status,'ready');
  if(mode==='seed')await writeFile(join(stateRoot,'release-work-id.json'),JSON.stringify({work_id:work.work_id}));
  else{
    const prior=JSON.parse(await readFile(join(stateRoot,'release-work-id.json'),'utf8'));
    assert.equal(work.work_id,prior.work_id);
    assert.equal(work.deduplicated,true);
    assert.equal(api.store.intakeWork(config.project.id,work.work_id).prompt,'Preserve this synthetic Work through the upgrade');
  }
}finally{api.close();await api.drain();}
if(mode==='seed'){console.log(JSON.stringify({seeded:true,model_calls:'injected fixture only'}));process.exit(0);}

const {Client}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {StdioClientTransport}=await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const client=new Client({name:'release-install-probe',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(installed,'dist/cli.js'),'mcp'],env:{...process.env,AGENT_DRIVER_CONNECTION_ROOT:stateRoot},stderr:'pipe'});
try{
  await client.connect(transport);
  assert.equal(client.getServerVersion().version,expectedVersion);
  const {tools}=await client.listTools();
  assert.ok(tools.some(t=>t.name==='runtime_work_status'));
  const health=await client.callTool({name:'runtime_health',arguments:{}});
  assert.notEqual(health.isError,true);
}finally{await client.close();}

const {startControlCenter}=await load('dist/observability/control-center.js');
const {chromium}=await load('node_modules/playwright/index.mjs');
const server=await startControlCenter(config);
let browser;
try{
  const response=await fetch(server.url+'fonts/pretendard-1.3.9.woff2');
  assert.equal(response.status,200);
  assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),'9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);
  await page.locator('h1').waitFor();
  await page.evaluate(async()=>{await document.fonts.load('600 20px "Pretendard Variable"','업무 연결');await document.fonts.ready;});
  assert.equal(await page.evaluate(()=>[...document.fonts].some(f=>f.family==='Pretendard Variable'&&f.status==='loaded')),true);
  assert.deepEqual(errors,[]);
}finally{await browser?.close();await server.close();}
console.log(JSON.stringify({version:expectedVersion,mcp:'PASS',work_preserved:'PASS',font:'PASS',browser:'PASS',external_model_calls:0}));
