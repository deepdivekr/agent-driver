import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeCodingReply} from '../dist/coding/reply-safety.js';

test('coding answer keeps ordinary prose but masks credentials before persistence',()=>{
  const answer='완료했습니다. 파일 3개 변경. URL https://example.test/path?q=one';
  assert.deepEqual(sanitizeCodingReply(answer),{text:answer,redacted:false});
  const secrets=[
    'password: hunter2',
    '{"password": "hunter2"}',
    '{"apiKey": "some-service-key"}',
    'API_KEY=abc123456789',
    'Cookie: session=abc; theme=dark',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.QWE12345678',
    ['AKIA','ABCDEFGHIJKLMNOP'].join(''),
  ];
  for(const secret of secrets){
    const result=sanitizeCodingReply(`Answer: ${secret}`);
    assert.equal(result.redacted,true,secret);
    assert.equal(result.text.includes(secret),false,secret);
  }
});
