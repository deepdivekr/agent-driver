import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceInputs,changedInputs} from '../scripts/runtime/evidence-inputs.mjs';

test('runtime unit reporter fingerprints all four live Pack acceptance inputs but no private evidence output',()=>{
  const inputs=evidenceInputs(),paths=Object.keys(inputs);
  const helpers=['live-pack-browser-acceptance.mjs','live-pack-data-acceptance.mjs','live-pack-research-watch-acceptance.mjs','live-pack-work-matrix.mjs'].map(name=>`scripts/${name}`);
  for(const path of helpers){assert.match(inputs[path],/^[a-f0-9]{64}$/u);assert.deepEqual(changedInputs(inputs,{...inputs,[path]:'0'.repeat(64)}),[path]);}
  assert.equal(paths.filter(path=>path.startsWith('scripts/live-pack-')).length,4);
  assert.equal(paths.some(path=>path.startsWith('tests/evidence/')),false);
  assert.deepEqual(changedInputs(inputs,inputs),[]);
});
