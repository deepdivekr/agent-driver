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

test('a public content link is kept while keys, key-shaped base64 and capability URLs are still masked',()=>{
  for(const link of ['https://www.reddit.com/r/ASTSpaceMobile/comments/1wwdmyw/ast_spacemobile_asts_daily_discussion_thread/','https://x.com/AST_SpaceMobile/status/1790000000000000000','https://www.youtube.com/watch?v=dQw4w9WgXcQ'])
    assert.equal(sanitizeCodingReply(`Read ${link} now`).text,`Read ${link} now`,link);
  const key=['wJalrXUtnFEMI','K7MDENG','bPxRfiCYEXAMPLEKEY'].join('/')+'abcd';
  const secrets=[key,'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7dEf0h/Ij3kLm6n',
    // Built from parts so the repository never holds a webhook-shaped literal.
    ['https://hooks.slack','com/services/T024BE7LD/B01ABCDEF12/abcdEFGHijklMNOPqrstUVWX'].join('.'),
    ['https://outlook.office','com/webhook/0b7d3c52-8f8e-4b56-9b3e-2f1d4c6a7e10@0b7d3c52-8f8e-4b56-9b3e-2f1d4c6a7e11/IncomingWebhook/0123456789abcdef0123456789abcdef/0b7d3c52-8f8e-4b56-9b3e-2f1d4c6a7e12'].join('.'),
    'https://api.telegram.org/bot123456789:'+['AAH','dQw4w9WgXcQ','Zx9Qw8Er7Ty6Ui5Op4'].join('')+'/sendMessage'];
  for(const secret of secrets){const result=sanitizeCodingReply(`value ${secret} end`);assert.equal(result.text.includes(secret),false,secret);assert.equal(result.redacted,true,secret);}
  assert.equal(sanitizeCodingReply(`https://www.reddit.com/r/x,${key}`).text.includes(key),false,'a key glued to a kept link is still masked');
  assert.doesNotThrow(()=>sanitizeCodingReply('N\u0000a\u0000m\u0000e\u0000,\u00005\u0000'));
});
