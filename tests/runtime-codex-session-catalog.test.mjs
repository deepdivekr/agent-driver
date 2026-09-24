import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {NativeCodexSessionCatalog} from '../dist/coding/session-catalog.js';

const fixture=fileURLToPath(new URL('./fixtures/fake-codex-session-app-server.mjs',import.meta.url));
const first='11111111-1111-4111-8111-111111111111';
const foreign='33333333-3333-4333-8333-333333333333';
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'driver-codex-catalog-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,catalog:new NativeCodexSessionCatalog(process.execPath,{args:[fixture],timeout_ms:3_000})};
}

test('session catalog lists only exact-project Codex CLI and exec sessions without reading turns',async t=>{
  const {root,catalog}=await setup(t);
  const sessions=await catalog.list(root);
  assert.deepEqual(sessions.map(session=>session.id),[first,'22222222-2222-4222-8222-222222222222']);
  assert.deepEqual(sessions[0],{id:first,title:'Feature work',preview:'Implement the feature',status:'notLoaded',created_at:1,updated_at:2});
  const selected=await catalog.inspect(root,first);
  assert.equal(selected.status,'idle');assert.equal(selected.updated_at,5);
  assert.equal('turns' in selected,false);
});

test('session catalog rejects another project and malformed explicit session IDs before reuse',async t=>{
  const {root,catalog}=await setup(t);
  await assert.rejects(catalog.inspect(root,foreign),/CODING_SESSION_PROJECT_MISMATCH/u);
  assert.throws(()=>catalog.inspect(root,'--last'),/CODING_SESSION_ID_INVALID/u);
});

test('session catalog reports process failure without exposing stderr or session content',async t=>{
  const {root}=await setup(t),catalog=new NativeCodexSessionCatalog('/path/that/does/not/exist');
  await assert.rejects(catalog.list(root),/CODEX_SESSION_CATALOG_PROCESS_FAILED|CODEX_SESSION_CATALOG_PROCESS_CLOSED/u);
});
