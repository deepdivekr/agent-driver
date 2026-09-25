import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import YAML from 'yaml';

test('runtime contract release version, installer, docs and gated publication agree',async()=>{
  const pkg=JSON.parse(await readFile('package.json','utf8'));
  const lock=JSON.parse(await readFile('package-lock.json','utf8'));
  const tag='v'+pkg.version;
  assert.equal(lock.version,pkg.version);
  assert.equal(lock.packages[''].version,pkg.version);
  assert.ok((await readFile('install.sh','utf8')).includes('AGENT_DRIVER_VERSION:-'+tag));
  for(const path of ['README.md','README.ko.md','docs/first-run.md']){
    const text=await readFile(path,'utf8');
    assert.ok(text.includes('/agent-driver/'+tag+'/install.sh'),path);
    assert.doesNotMatch(text,/agent-driver\/v0\.1\.0\/install\.sh/u,path);
  }
  assert.ok((await readFile('docs/releases/'+tag+'.md','utf8')).includes(tag));
  const workflow=YAML.parse(await readFile('.github/workflows/runtime.yml','utf8'));
  assert.equal(workflow.jobs.release.needs,'runtime');
  assert.equal(workflow.jobs.release.if,"github.event_name == 'push' && github.ref == 'refs/heads/main'");
  assert.equal(workflow.permissions.contents,'read');
  assert.equal(workflow.jobs.release.permissions.contents,'write');
  assert.ok(workflow.jobs.runtime.steps.some(s=>s.run==='node scripts/release/verify-install.mjs'));
});
