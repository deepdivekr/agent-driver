import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig} from '../dist/interface/config.js';
import {detectTable,registerAutoSource,readAutoSources} from '../dist/packs/auto-sources.js';
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
  for(const refused of ['https://user:pw@example.org/a.csv','https://example.org/a.csv?api_key=1','https://192.168.0.2/a.csv','http://example.org/a.csv','https://intranet.local/a.csv'])assert.equal(registerAutoSource(config,refused,table),null,refused);
  const registered=registerAutoSource(config,url,table);
  assert.equal(registered.created,true);assert.match(registered.id,/^auto_127_0_0_1_feeds_quakes_[a-f0-9]{6}$/u);
  assert.deepEqual(registerAutoSource(config,url,table),{id:registered.id,created:false},'The same URL is remembered once.');
  assert.equal(config.packs.sources.length,1,'The running process sees it at once.');assert.equal(config.fingerprint,fingerprint);
  const reloaded=loadHostConfig(host);assert.equal(reloaded.fingerprint,fingerprint,'Learned sources are not owner configuration: no run is invalidated.');
  assert.deepEqual(reloaded.packs.sources.map(source=>[source.id,source.kind,source.format,source.numeric_columns,source.parameters]),[[registered.id,'http','csv',['mag'],[]]]);
  const listed=connectedSourceCatalog(reloaded)[0];assert.equal(listed.registration,'remembered_public_read');assert.deepEqual(listed.declared_columns,['time','mag','place','note']);
  const collected=await collectSource(reloaded.packs.sources[0],{},reloaded);
  assert.deepEqual(collected.rows.map(row=>[row.mag,row.place]),[[4.6,'10 km S of Town, Country'],[5.1,'Offshore']],'Rows come from the Pack reader with the numeric column normalised.');
  // A damaged or foreign list is ignored rather than trusted.
  await writeFile(join(root,'data','auto-sources.json'),JSON.stringify([{source:{id:'x',kind:'file',path:'/etc/passwd',format:'csv'},columns:['a','b'],observed_at:new Date().toISOString()},{source:{id:'y',kind:'http',url:'https://example.org/a.csv',parameters:['token'],format:'csv'},columns:['a','b'],observed_at:new Date().toISOString()}]));
  assert.deepEqual(readAutoSources(join(root,'data')),[]);assert.equal(loadHostConfig(host).packs,null);
  assert.ok(JSON.parse(await readFile(host,'utf8')).packs===undefined,'The owner file is never written.');
});
