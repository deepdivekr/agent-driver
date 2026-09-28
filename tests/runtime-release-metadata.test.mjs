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
    assert.ok(text.includes('/agent-office/'+tag+'/install.sh'),path);
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

test('runtime contract renamed repository preserves installation identity and README screenshots',async()=>{
  const pkg=JSON.parse(await readFile('package.json','utf8'));
  assert.equal(pkg.repository.url,'https://github.com/deepdivekr/agent-office.git');
  assert.ok(pkg.bin['agent-driver'],'Existing CLI name must remain available');
  assert.equal(pkg.name,'agent-office');
  assert.equal(pkg.bin['agent-office'],'dist/cli.js');
  assert.match(await readFile('install.sh','utf8'),/DEFAULT_REPOSITORY="https:\/\/github\.com\/deepdivekr\/agent-office\.git"/u);
  for(const path of ['README.md','README.ko.md']){
    const text=await readFile(path,'utf8');
    assert.ok(text.includes('agent-office mcp'));
    assert.ok(text.includes('~/.agent-driver'));
    assert.ok(text.includes('~/.agent-office'));
    assert.ok(text.includes('cd agent-office'));
    assert.doesNotMatch(text,/deepdivekr\/agent-driver/u);
    const screenshots=[...text.matchAll(/!\[[^\]]*\]\((docs\/images\/[^)]+)\)/gu)].map(match=>match[1]);
    assert.equal(screenshots.length,3);
    for(const screenshot of screenshots){
      const bytes=await readFile(screenshot);
      assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      assert.ok(bytes.length<300_000,'Keep README screenshots light');
    }
  }
  const receipt=JSON.parse(await readFile('docs/images/capture.json','utf8'));
  assert.equal(receipt.sample_data,true);
  assert.equal(receipt.live_task_run,false);
  assert.equal(receipt.paid_model_calls,0);
});
