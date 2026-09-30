import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {recipeSchema} from '../dist/packs/contracts.js';
import {sha} from '../dist/packs/data.js';

test('portal.collect projects explicitly selected CSV columns without modifying its source or legacy all-column export',async t=>{
  const root=await mkdtemp(join(tmpdir(),'phase112-portal-columns-')),source=join(root,'source.json'),configPath=join(root,'host.json');
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const rows=[{id:'a',type:'earthquake',mag:5.1},{id:'b',type:'quarry blast',mag:3.2},{id:'c',type:'earthquake',mag:4.7}];
  await writeFile(source,JSON.stringify(rows));
  await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'portal-columns-project',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'runtime'),environment:'production',packs:{models:'off',sources:[{id:'observed',kind:'file',path:'source.json',format:'json'}],targets:[]}}));
  const api=new RuntimeApi(loadHostConfig(configPath));t.after(async()=>{api.close();await api.drain();});
  const original=await readFile(source);
  const recipe={version:1,family:'portal.collect',request:'Store only unique earthquake IDs',sources:[{id:'observed',parameters:{}}],filters:[{field:'type',op:'eq',value:'earthquake'}],deduplicate_by:['id'],columns:['id'],format:'csv'};
  const projected=await api.call('runtime_pack_run',{request_id:'portal-selected',recipe});
  assert.equal(projected.status,'succeeded');
  assert.equal(projected.result.collected_rows,3);assert.equal(projected.result.matched_rows,2);
  const bytes=await readFile(projected.result.artifact.path);
  assert.equal(sha(bytes),projected.result.artifact.sha256);
  assert.equal(bytes.toString('utf8'),'\uFEFF"id"\r\n"a"\r\n"c"\r\n');
  const legacyRecipe={version:1,family:'portal.collect',request:recipe.request,sources:recipe.sources,filters:recipe.filters,deduplicate_by:recipe.deduplicate_by,format:'json'};
  const legacy=await api.call('runtime_pack_run',{request_id:'portal-legacy',recipe:legacyRecipe});
  assert.equal(legacy.status,'succeeded');
  assert.deepEqual(JSON.parse(await readFile(legacy.result.artifact.path,'utf8')),[rows[0],rows[2]]);
  assert.deepEqual(await readFile(source),original);
  const missing=await api.call('runtime_pack_run',{request_id:'portal-missing',recipe:{...recipe,columns:['absent']}});
  assert.equal(missing.status,'failed');assert.equal(missing.result.error,'PORTAL_COLUMN_MISSING');
  assert.deepEqual(await readFile(source),original);
});

test('portal selected columns reject empty, duplicate, and unsafe keys',()=>{
  const base={version:1,family:'portal.collect',request:'Collect observed ID',sources:[{id:'observed',parameters:{}}],filters:[],deduplicate_by:[],format:'csv'};
  for(const columns of [[],['id','id'],['__proto__']])assert.equal(recipeSchema.safeParse({...base,columns}).success,false);
  assert.equal(recipeSchema.safeParse({...base,columns:['id']}).success,true);
  assert.equal(recipeSchema.safeParse(base).success,true);
});
