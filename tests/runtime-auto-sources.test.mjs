import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig} from '../dist/interface/config.js';
import {detectTable,registerAutoSource,readAutoSources,compareSavedRows,sameValue,tableRows} from '../dist/packs/auto-sources.js';
import {connectedSourceCatalog} from '../dist/packs/source-catalog.js';
import {collectSource} from '../dist/packs/sources.js';

const bytes=text=>new TextEncoder().encode(text);
const csv='time,mag,place,note\n2026-10-01T01:00:00Z,4.6,"10 km S of Town, Country",\n2026-10-01T02:00:00Z,5.1,Offshore,felt\n';

// Plan B5/B2: a public table the host read completely becomes a read-only source for later Works.
test('a complete CSV or flat JSON body is recognised as a table; pages, nested documents and tiny tables are not',async()=>{
  assert.deepEqual(await detectTable(bytes(csv),'text/csv; charset=utf-8','https://example.org/feed'),{format:'csv',columns:['time','mag','place','note'],numeric_columns:['mag'],rows:2});
  assert.equal((await detectTable(bytes(csv),'text/plain','https://example.org/quakes.csv')).format,'csv','The path decides when the type is generic.');
  assert.deepEqual(await detectTable(bytes(JSON.stringify([{version:'v1',lts:false,n:1},{version:'v2',lts:true,n:2}])),'application/json','https://example.org/index.json'),{format:'json',columns:['version','lts','n'],numeric_columns:['n'],rows:2});
  const nested=await detectTable(bytes(JSON.stringify([{version:'v1',date:'2026-01-01',files:['a']},{version:'v2',date:'2026-02-01',files:[]}])),'application/json','https://example.org/index.json');
  assert.deepEqual(nested,{format:'json',columns:['version','date'],numeric_columns:[],json_fields:['version','date'],rows:2},'Nested values are left out by projection.');
  assert.equal(await detectTable(bytes('{"type":"FeatureCollection","features":[]}'),'application/json','https://example.org/feed.geojson'),null);
  const geo=JSON.stringify({type:'FeatureCollection',metadata:{count:2},features:[{type:'Feature',properties:{mag:4.6,place:'Offshore',time:1790000000000,ids:',a,'},geometry:{type:'Point',coordinates:[1,2,3]}},{type:'Feature',properties:{mag:5.1,place:'Inland',time:1790000100000,ids:',b,'},geometry:null}]});
  assert.deepEqual(await detectTable(bytes(geo),'application/geo+json','https://example.org/summary/4.5_day.geojson'),{format:'json',columns:['mag','place','time','ids'],numeric_columns:['mag','time'],json_fields:['mag','place','time','ids'],json_rows:'features',rows:2},'A GeoJSON feed is a table of its features\' properties.');
  assert.equal(await detectTable(bytes('<html><body>hello</body></html>'),'text/html','https://example.org/'),null);
  assert.equal(await detectTable(bytes('only\n1\n'),'text/csv','https://example.org/one.csv'),null,'One column is not worth a source.');
  assert.equal((await detectTable(bytes('a,b\n1,x\n,y\n'),'text/csv','https://example.org/t.csv')).numeric_columns.length,0,'A column with an empty value is not declared numeric.');
});

test('a remembered source joins the loaded config without changing its fingerprint, shows its columns to the planner, and is collected by the Pack reader',async t=>{
  const server=createServer((request,response)=>{response.writeHead(200,{'content-type':'text/csv'});response.end(csv);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url=`http://127.0.0.1:${server.address().port}/feeds/quakes.csv`;
  const root=await mkdtemp(join(tmpdir(),'auto-sources-')),host=join(root,'host.json');t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'auto',caller_ref:'owner',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:'http://127.0.0.1:9999/test/account-a/'}));
  const {mkdir}=await import('node:fs/promises');await mkdir(join(root,'data'),{recursive:true});
  const config=loadHostConfig(host),fingerprint=config.fingerprint;assert.equal(config.packs,null);
  const table=await detectTable(bytes(csv),'text/csv',url);
  for(const refused of ['https://example.org/query?format=csv&starttime=2026-09-30T14%3A04%3A08Z','https://user:pw@example.org/a.csv','https://example.org/a.csv?api_key=1','https://192.168.0.2/a.csv','http://example.org/a.csv','https://intranet.local/a.csv'])assert.equal(registerAutoSource(config,refused,table),null,refused);
  const registered=registerAutoSource(config,url,table);
  assert.equal(registered.created,true);assert.match(registered.id,/^auto_127_0_0_1_feeds_quakes_[a-f0-9]{6}$/u);
  assert.deepEqual(registerAutoSource(config,url,table),{id:registered.id,created:false},'The same URL is remembered once.');
  assert.equal(config.packs.sources.length,1,'The running process sees it at once.');assert.equal(config.fingerprint,fingerprint);
  const reloaded=loadHostConfig(host);assert.equal(reloaded.fingerprint,fingerprint,'Learned sources are not owner configuration: no run is invalidated.');
  assert.deepEqual(reloaded.packs.sources.map(source=>[source.id,source.kind,source.format,source.numeric_columns,source.parameters]),[[registered.id,'http','csv',['mag'],[]]]);
  const listed=connectedSourceCatalog(reloaded)[0];assert.equal(listed.registration,'remembered_public_read');assert.deepEqual(listed.declared_columns,['time','mag','place','note']);
  const collected=await collectSource(reloaded.packs.sources[0],{},reloaded);
  assert.deepEqual(collected.rows.map(row=>[row.mag,row.place]),[[4.6,'10 km S of Town, Country'],[5.1,'Offshore']],'Rows come from the Pack reader with the numeric column normalised.');
  // A GeoJSON feed is collected through the same reader.
  const geoServer=createServer((request,response)=>{response.writeHead(200,{'content-type':'application/geo+json'});response.end(JSON.stringify({type:'FeatureCollection',features:[{properties:{mag:4.6,place:'Offshore',extra:{nested:true}}},{properties:{mag:5.1,place:'Inland',extra:null}}]}));});
  await new Promise(resolve=>geoServer.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{geoServer.close(resolve);geoServer.closeAllConnections();}));
  const geoUrl=`http://127.0.0.1:${geoServer.address().port}/summary/day.geojson`,geoBody=new Uint8Array(await (await fetch(geoUrl)).arrayBuffer()),geoTable=await detectTable(geoBody,'application/geo+json',geoUrl);
  assert.deepEqual(geoTable.json_fields,['mag','place']);const geoSource=registerAutoSource(config,geoUrl,geoTable);
  const features=await collectSource(config.packs.sources.find(source=>source.id===geoSource.id),{},config);
  assert.deepEqual(features.rows,[{mag:4.6,place:'Offshore'},{mag:5.1,place:'Inland'}]);assert.equal(features.evidence.response_shape,'feature_collection');
  // A damaged or foreign list is ignored rather than trusted.
  await writeFile(join(root,'data','auto-sources.json'),JSON.stringify([{source:{id:'x',kind:'file',path:'/etc/passwd',format:'csv'},columns:['a','b'],observed_at:new Date().toISOString()},{source:{id:'y',kind:'http',url:'https://example.org/a.csv',parameters:['token'],format:'csv'},columns:['a','b'],observed_at:new Date().toISOString()}]));
  assert.deepEqual(readAutoSources(join(root,'data')),[]);assert.equal(loadHostConfig(host).packs,null);
  assert.ok(JSON.parse(await readFile(host,'utf8')).packs===undefined,'The owner file is never written.');
});

// Plan B2: the owner sees what was learned and can switch a procedure off or forget a source. Nothing else changes them.
test('Control Center lists learned procedures and remembered sources; the owner switches one off and forgets the other',{timeout:60000},async t=>{
  const {chromium}=await import('playwright'),{startControlCenter}=await import('../dist/observability/control-center.js'),{PackStore}=await import('../dist/packs/store.js'),{recordVerifiedProcedure,similarProcedure}=await import('../dist/work/procedures.js');
  const root=await mkdtemp(join(tmpdir(),'learned-ui-')),host=join(root,'host.json');
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'learned',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production'}));
  const config=loadHostConfig(host),store=new PackStore(config.dbPath);store.registerProject(config.project);
  const request='Python과 Node.js 최신 안정 버전을 각 공식 사이트에서 확인해 JSON으로 저장해줘';
  const observation={invocation:{request_id:'r-1',turn:0,stage_id:'read',tool_name:'office_browser_read',arguments:{url:'https://www.python.org/downloads/'},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{},evidence_ids:['e-1'],effect_state:'none',retry_safe:true},observed_at:new Date().toISOString()};
  const saved=recordVerifiedProcedure(store,'learned','w1',request,[observation]);
  registerAutoSource(config,'https://data.example.org/feeds/quakes.csv',await detectTable(bytes(csv),'text/csv','https://data.example.org/feeds/quakes.csv'));
  const server=await startControlCenter(config),browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await server.close();store.close();await rm(root,{recursive:true,force:true});});
  const status=await (await fetch(new URL('learned/status',server.url))).json();
  assert.deepEqual(status.procedures.map(item=>[item.id,item.grade,item.successes,item.steps]),[[saved.id,'candidate',1,1]]);assert.equal(status.sources[0].url,'https://data.example.org/feeds/quakes.csv');
  assert.equal((await fetch(new URL('learned/action',server.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'procedure',id:saved.id,disabled:true})})).status,403,'Only the Control Center page may change it.');
  const context=await browser.newContext();await context.addInitScript(()=>localStorage.setItem('office-lang','ko'));
  const page=await context.newPage();await page.goto(server.url,{waitUntil:'domcontentloaded'});
  await page.locator('#learned summary').click();await page.locator('[data-learned-procedure]').waitFor();
  assert.match(await page.locator('#learned-body').innerText(),/후보 · 성공 1회 · 실패 0회 · 1단계/u);
  await page.locator('[data-learned-procedure]').click();await page.getByText('꺼짐').waitFor();
  assert.equal(similarProcedure(store,'learned',request),null,'A switched-off procedure is no longer offered.');
  await page.locator('[data-learned-source]').click();await page.locator('[data-learned-source]').waitFor({state:'detached'});
  assert.deepEqual(readAutoSources(join(root,'data')),[]);assert.equal(loadHostConfig(host).packs,null);
});

// Live: a verifier that saw only an excerpt of a 14-row feed could not decide and escalated. The host has the whole body.
test('saved rows are compared with the complete source table by value, across renamed columns and time formats',async()=>{
  const geo=JSON.stringify({type:'FeatureCollection',features:[{properties:{mag:4.6,place:'10 km S of Town, Country',time:1790000000000}},{properties:{mag:5.1,place:'Offshore',time:1790000100000}},{properties:{mag:4.5,place:'Inland',time:1790000200000}}]});
  const table=await detectTable(bytes(geo),'application/geo+json','https://example.org/day.geojson'),source=await tableRows(bytes(geo),table);
  assert.equal(source.length,3);
  const iso=ms=>new Date(ms).toISOString();
  assert.deepEqual(compareSavedRows([{시각:iso(1790000000000),규모:'4.6',위치:'10 km S of Town, Country'},{시각:iso(1790000100000),규모:'5.1',위치:'Offshore'}],source),{saved_rows:2,found:2,missing:[]});
  assert.deepEqual(compareSavedRows([{시각:iso(1790000000000),규모:'4.6',위치:'Offshore'},{시각:iso(1790000100000),규모:'5.1',위치:'Offshore'},{시각:'',규모:'9.9',위치:''}],source),{saved_rows:3,found:1,missing:[1,3]},'Values taken from two different source rows, and an invented row, are not found.');
  assert.equal(compareSavedRows([],source),null);
  assert.ok(sameValue('4.60',4.6));assert.ok(sameValue('2026-09-21 13:33:20','2026-09-21T13:33:20.000Z'));assert.ok(sameValue(1790000000000,iso(1790000000000)));assert.ok(!sameValue('4.6','4.7'));assert.ok(!sameValue('Offshore','Inland'));
});
