import test from 'node:test';
import assert from 'node:assert/strict';
import {basename} from 'node:path';
import {runtimeTestFiles} from '../scripts/runtime/run-tests.mjs';

test('runtime contract quick regression excludes long soak while explicit modes retain it',()=>{
  const quick=runtimeTestFiles('quick').map(path=>basename(path)),soak=runtimeTestFiles('soak').map(path=>basename(path)),full=runtimeTestFiles('full').map(path=>basename(path));
  assert.ok(quick.length>1);assert.equal(quick.includes('runtime-soak.test.mjs'),false);
  assert.deepEqual(soak,['runtime-soak.test.mjs']);assert.ok(full.includes('runtime-soak.test.mjs'));
  assert.throws(()=>runtimeTestFiles('unknown'),/RUNTIME_TEST_MODE_INVALID/);
});
