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

test('a link path is kept while an opaque token is still masked',()=>{
  const link='https://www.reddit.com/r/ASTSpaceMobile/comments/1wwdmyw/ast_spacemobile_asts_daily_discussion_thread/';
  assert.equal(sanitizeCodingReply(`Read ${link}`).text,`Read ${link}`);
  const token=['Zx9','Qw8','Er7','Ty6','Ui5','Op4','As3','Df2','Gh1','Jk0','LmNoPq','Rs7Tu8'].join('');assert.ok(token.length>=40);
  assert.equal(sanitizeCodingReply(`key ${token}`).text.includes(token),false);
});
