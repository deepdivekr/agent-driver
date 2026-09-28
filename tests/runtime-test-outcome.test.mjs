import test from 'node:test';
import assert from 'node:assert/strict';
import {testOutcome} from '../scripts/runtime/test-outcome.mjs';

test('runtime test evidence never counts skipped environment checks as PASS',()=>{
  assert.equal(testOutcome({type:'test:pass',data:{}}).status,'PASS');
  assert.equal(testOutcome({type:'test:fail',data:{}}).status,'FAIL');
  assert.deepEqual(testOutcome({type:'test:pass',data:{skip:'BLOCKED_ENV: file symlink privilege'}}),{status:'BLOCKED_ENV',reason:'BLOCKED_ENV: file symlink privilege'});
  assert.equal(testOutcome({type:'test:pass',data:{skip:'optional unavailable'}}).status,'NOT_RUN');
  assert.equal(testOutcome({type:'test:pass',data:{todo:'not implemented'}}).status,'NOT_RUN');
  assert.equal(testOutcome({type:'test:pass',data:{skip:true}}).status,'NOT_RUN');
});
