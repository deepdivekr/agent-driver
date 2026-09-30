import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sourceSchema} from '../dist/packs/contracts.js';
import {collectSource} from '../dist/packs/sources.js';

const base={id:'market-prices',kind:'http',url:'https://example.test/observed.json',parameters:[],format:'json',json_fields:['id','usd']};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

test('HTTP JSON field projection retains raw-byte hash and records selected fields',async()=>{
  const raw=Buffer.from('[{"id":"eth","usd":4200,"roi":{"times":12}},{"id":"btc","usd":73000,"roi":{"times":8}}]');
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(raw,{status:200,headers:{'content-type':'application/json'}});
  try{
    const result=await collectSource(sourceSchema.parse(base),{},{});
    assert.deepEqual(result.rows,[{id:'eth',usd:4200},{id:'btc',usd:73000}]);
    assert.equal(result.evidence.content_sha256,digest(raw));
    assert.deepEqual(result.evidence.projection_fields,['id','usd']);
    assert.equal(result.evidence.executor,'http_get');
  }finally{globalThis.fetch=original;}
});

test('projection rejects absent or non-scalar selected fields without dropping rows',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response('[{"id":"eth"}]',{status:200});
    await assert.rejects(()=>collectSource(sourceSchema.parse(base),{},{}),/SOURCE_PROJECTION_FIELD_MISSING/);
    globalThis.fetch=async()=>new Response('[{"id":"eth","usd":{"nested":1}}]',{status:200});
    await assert.rejects(()=>collectSource(sourceSchema.parse(base),{},{}));
  }finally{globalThis.fetch=original;}
});

test('projection schema allows only unique JSON scalar field names',()=>{
  assert.equal(sourceSchema.safeParse({...base,format:'csv'}).success,false);
  assert.equal(sourceSchema.safeParse({...base,json_fields:['id','id']}).success,false);
  assert.equal(sourceSchema.safeParse({...base,json_fields:[]}).success,false);
  assert.equal(sourceSchema.safeParse({...base,json_fields:['__proto__']}).success,false);
});
