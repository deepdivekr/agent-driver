import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const read=path=>readFileSync(resolve(root,path),'utf8');

test('Apache license, package metadata and notices remain consistent',()=>{
  const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json'));
  assert.equal(pkg.license,'Apache-2.0');
  assert.equal(lock.packages[''].license,'Apache-2.0');
  // Canonical https://www.apache.org/licenses/LICENSE-2.0.txt, retrieved 2026-09-23.
  assert.equal(createHash('sha256').update(read('LICENSE').replace(/\r\n/gu,'\n')).digest('hex'),'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
  assert.match(read('NOTICE'),/Copyright 2026 Agent Driver contributors/u);
  assert.match(read('THIRD_PARTY_NOTICES.md'),/Dependencies keep their own licenses/u);
  assert.match(read('README.md'),/Apache License 2\.0/u);
  assert.doesNotMatch(read('README.md'),/별도 재사용 권한은 부여하지 않습니다/u);
  assert.ok(existsSync(resolve(root,'docs/licensing.md')));
});

if(JSON.parse(read('package.json')).name==='agent-driver')test('public package excludes private registered-workflow bindings',()=>{
  assert.equal(existsSync(resolve(root,'src/workflows')),false);
  assert.doesNotMatch(read('src/interface/api.ts'),/runtime_workflow_|workflowCall/u);
  assert.doesNotMatch(read('src/interface/config.ts'),/workflowPolicy|received_data/u);
  assert.doesNotMatch(read('src/interface/catalog.ts'),/workflowTools/u);
  assert.doesNotMatch(read('src/interface/mcp.ts'),/runtime_workflow_/u);
  assert.doesNotMatch(read('src/integrations/hermes.ts'),/runtime_workflow_/u);
  assert.ok(read('src/interface/mcp.ts').includes(`version:'${JSON.parse(read('package.json')).version}'`));
});
