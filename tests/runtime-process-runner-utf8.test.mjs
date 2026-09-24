import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeProcessRunner} from '../dist/integrations/subscription-auth.js';

test('native CLI stream preserves Korean when UTF-8 code points cross chunks',async()=>{
  const source=[
    "const text=Buffer.from('한글');",
    'process.stdout.write(text.subarray(0,1));',
    'setTimeout(()=>process.stdout.write(text.subarray(1,4)),15);',
    'setTimeout(()=>process.stdout.write(text.subarray(4)),30);',
  ].join('');
  let observed='';
  const result=await nativeProcessRunner.run({
    executable:process.execPath,args:['-e',source],timeout_ms:3000,
    onStdout:chunk=>{observed+=chunk;},
  });
  assert.equal(result.code,0);
  assert.equal(observed,'한글');
  assert.equal(result.stdout,'한글');
});
