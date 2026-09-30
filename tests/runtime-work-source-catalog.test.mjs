import test from 'node:test';
import assert from 'node:assert/strict';
import {connectedSourceCatalog} from '../dist/packs/source-catalog.js';
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
