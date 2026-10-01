import test from 'node:test';
import assert from 'node:assert/strict';
import {connectedSourceCatalog,observedWorkSourceSchemas} from '../dist/packs/source-catalog.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';
import {PACK_ENGINE_VERSION} from '../dist/packs/engine-version.js';
import {WORK_CONNECTED_SOURCE_INSTRUCTIONS} from '../dist/work/runtime.js';

test('configured source inventory gives exact declared names without credentials, selectors or filesystem paths',()=>{
 const config={packs:{sources:[
  {id:'official',kind:'browser',url:'https://example.org/releases?access_token=private-value#private-fragment',parameters:['version'],columns:{version:'td:first-child',first_released:'td:nth-child(2)',session_cookie:'.private-cookie'},rows:'tbody tr',ready:'.ready',auth_gate:'.gate',account_selector:'.profile',account_text:'PRIVATE_ACCOUNT',auth_required:true},
  {id:'local',kind:'file',path:'/private/user/records.json',format:'json'},
  {id:'market',kind:'http',url:'https://example.org/api?api_key=private-api-value',parameters:['ids'],format:'json',json_fields:['id','current_price']},
  {id:'userinfo',kind:'http',url:'https://private-user:private-password@example.org/data',parameters:[],format:'json'},
 ]}};
 const catalog=connectedSourceCatalog(config),serialized=JSON.stringify(catalog);
 assert.deepEqual(catalog[0].declared_columns,['version','first_released']);
 assert.equal(catalog[0].public_location,'https://example.org/releases');
 assert.deepEqual(catalog[0].parameter_names,['version']);
 assert.equal(catalog[0].observation,'not_asserted');assert.equal(catalog[0].auth_required,true);
 assert.deepEqual(catalog[1],{id:'local',kind:'file',registration:'configured',observation:'not_asserted',format:'json',declared_columns:[]});
 assert.deepEqual(catalog[2].declared_columns,['id','current_price']);assert.equal(catalog[3].public_location,null);
 for(const secret of ['private-value','private-fragment','PRIVATE_ACCOUNT','private-api-value','private-user','private-password','session_cookie','tbody','nth-child','/private/user'])assert.equal(serialized.includes(secret),false,secret);
 assert.equal(catalog.some(source=>source.ready===true||source.verified===true||source.observed_at),false);
});

test('source selection guidance never converts registration into observation or challenge authority',()=>{
 assert.match(WORK_CONNECTED_SOURCE_INSTRUCTIONS,/prefer its exact source ID through the Pack tools/u);
 assert.match(WORK_CONNECTED_SOURCE_INSTRUCTIONS,/configured names, not guesses or observed result data/u);
 assert.match(WORK_CONNECTED_SOURCE_INSTRUCTIONS,/registration never bypasses login, challenge, scope or effect boundaries/u);
 assert.deepEqual(connectedSourceCatalog({}),[]);
});

function retained(){
 const config={project:{id:'project'},fingerprint:'current',packs:{sources:[{id:'rows',kind:'file',format:'json',path:'/private/path'}]}};
 const requested={id:'rows',parameters:{}},recipe={sources:[requested]},result={rows:[{id:'private-value',score:1,session_cookie:'secret',only_first:true},{id:'second',score:2,session_cookie:'secret'}],evidence:{source_id:'rows',request_sha256:snapshotHash(requested),rows:2,observed_at:'2026-10-01T00:00:00.000Z'}};
 const run={id:'owned-run',project_id:'project',status:'succeeded',recipe,binding:snapshotHash({recipe,fingerprint:snapshotHash({config:config.fingerprint,engine:PACK_ENGINE_VERSION})})};
 const saved={digest:snapshotHash(result),result};
 const store={officeRuns:()=>[{source_kind:'pack',source_id:run.id}],packRun:()=>run,officeWork:()=>({id:'owned-work'}),packExecution:()=>({checkpoint:{sources:{0:saved}}})};
 return {config,run,saved,store};
}
test('retained same-Work schema context exposes common observed names, not values, paths or current freshness',()=>{
 const x=retained(),schemas=observedWorkSourceSchemas(x.store,x.config,'owned-work');
 assert.deepEqual(schemas,[{source_id:'rows',run_id:'owned-run',observed_at:'2026-10-01T00:00:00.000Z',fields:['id','score'],scope:'saved_response_rows',freshness:'historical_only'}]);
 for(const privateText of ['private-value','private/path','session_cookie','secret','only_first'])assert.equal(JSON.stringify(schemas).includes(privateText),false);
});
for(const mode of ['foreign_work','stale_binding','tampered_snapshot','wrong_source','empty_rows'])test('retained source schema context rejects '+mode,()=>{
 const x=retained();
 if(mode==='foreign_work')x.store.officeWork=()=>({id:'foreign-work'});
 if(mode==='stale_binding')x.run.binding='stale';
 if(mode==='tampered_snapshot')x.saved.result.rows[0].score=99;
 if(mode==='wrong_source'){x.saved.result.evidence.source_id='foreign';x.saved.digest=snapshotHash(x.saved.result);}
 if(mode==='empty_rows'){x.saved.result.rows=[];x.saved.result.evidence.rows=0;x.saved.digest=snapshotHash(x.saved.result);}
 assert.deepEqual(observedWorkSourceSchemas(x.store,x.config,'owned-work'),[]);
});
