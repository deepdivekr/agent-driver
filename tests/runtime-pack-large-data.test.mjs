import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {scopedFileChunks,hashScopedFile,responseChunks,iterateParsedRows,readScopedTextPage,encodedRowsChunks,hashEncodedRows,exportRows,encodeCsv} from '../dist/packs/data.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'pack-large-data-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function* smallChunks(bytes,size=17){for(let i=0;i<bytes.length;i+=size)yield bytes.subarray(i,i+size);}

test('local and HTTP source chunks retain full bytes beyond the legacy 8 MiB cap',async t=>{
  const root=await fixture(t),path=join(root,'source.txt'),content=Buffer.from('a'.repeat(9*1024*1024+7));await writeFile(path,content);
  assert.deepEqual(await hashScopedFile(path),{sha256:hash(content),bytes:content.length});
  let fileBytes=0;for await(const chunk of scopedFileChunks(path)){assert.ok(chunk.length<=64*1024);fileBytes+=chunk.length;}assert.equal(fileBytes,content.length);
  const response=new Response(content,{headers:{'content-length':String(content.length)}});let httpBytes=0;const digest=createHash('sha256');
  for await(const chunk of responseChunks(response)){assert.ok(chunk.length<=64*1024);digest.update(chunk);httpBytes+=chunk.length;}
  assert.equal(httpBytes,content.length);assert.equal(digest.digest('hex'),hash(content));
});

test('real fetch accepts decoded gzip content without comparing it to compressed wire Content-Length',async t=>{
  const plain=Buffer.from(JSON.stringify([{id:'a',note:'x'.repeat(120000)}])),compressed=gzipSync(plain);
  const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json','content-encoding':'gzip','content-length':String(compressed.length)});response.end(compressed);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const address=server.address(),response=await fetch(`http://127.0.0.1:${address.port}/`),digest=createHash('sha256');let bytes=0;
  for await(const chunk of responseChunks(response)){digest.update(chunk);bytes+=chunk.length;}
  assert.equal(bytes,plain.length);assert.equal(digest.digest('hex'),hash(plain));assert.notEqual(compressed.length,plain.length);
});

test('HTTP idle timeout resets for each chunk instead of limiting total stream duration',async()=>{
  let sent=0;const stream=new ReadableStream({async pull(controller){await delay(20);if(sent===8){controller.close();return;}controller.enqueue(Uint8Array.of(sent++));}});
  const started=Date.now(),values=[];for await(const chunk of responseChunks(new Response(stream),100))values.push(...chunk);
  assert.deepEqual(values,[0,1,2,3,4,5,6,7]);assert.ok(Date.now()-started>100,'total streaming time may exceed one idle window');
});

test('HTTP genuinely idle read fails, cancels its pending stream and does not claim partial completion',async()=>{
  let cancelled=0;const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled++;}});
  await assert.rejects(async()=>{for await(const _ of responseChunks(new Response(stream),20)){}},/PACK_SOURCE_HTTP_IDLE_TIMEOUT/u);
  assert.equal(cancelled,1);
});

test('streaming JSON and CSV parse all rows past 10,000 and reject incomplete documents',async()=>{
  const rows=Array.from({length:10001},(_,i)=>({id:String(i),status:i%2?'Closed':'Open'}));
  for(const format of ['json','csv']){
    const bytes=Buffer.from(format==='json'?JSON.stringify(rows):encodeCsv(rows,['id','status']));let count=0;
    for await(const row of iterateParsedRows(smallChunks(bytes,13),format)){assert.equal(row.id,String(count));count++;}
    assert.equal(count,rows.length);
  }
  const projected=Buffer.from('[{"id":"a","unused":{"nested":true}}]');
  const only=[];for await(const row of iterateParsedRows(smallChunks(projected,5),'json',['id']))only.push(row);
  assert.deepEqual(only,[{id:'a'}]);
  await assert.rejects(async()=>{for await(const _ of iterateParsedRows(smallChunks(Buffer.from('[{"id":"a"},]')),'json')){}},/SOURCE_JSON_TRAILING_COMMA/u);
  await assert.rejects(async()=>{for await(const _ of iterateParsedRows(smallChunks(Buffer.from('[{"id":"a"}')),'json')){}},/SOURCE_JSON_INCOMPLETE/u);
  await assert.rejects(async()=>{for await(const _ of iterateParsedRows(smallChunks(Buffer.from('[{"id":"a"}]')),'json',['missing'])){}},/SOURCE_PROJECTION_FIELD_MISSING/u);
  await assert.rejects(async()=>{for await(const _ of iterateParsedRows(smallChunks(Buffer.from('\uFEFF[{"id":"a"}]')),'json')){}},/SOURCE_ROWS_REQUIRED/u);
  await assert.rejects(async()=>{for await(const _ of iterateParsedRows(smallChunks(Buffer.from('[{"id":"a"}]\u00A0')),'json')){}},/SOURCE_JSON_TRAILING_DATA/u);
  await assert.rejects(async()=>{for await(const _ of iterateParsedRows(smallChunks(Buffer.from([0x5b,0x7b,0x22,0x69,0x64,0x22,0x3a,0x22,0xff,0x22,0x7d,0x5d])),'json')){}},/encoded data|invalid|utf-8/iu);
});

test('streaming CSV rejects explicit HTML signatures without rejecting valid header-only data',async()=>{
  for(const text of ['<html>sign in</html>','<!DOCTYPE html><html>error</html>','\uFEFF  <BODY>login</BODY>']){
    await assert.rejects(async()=>{for await(const _ of iterateParsedRows(smallChunks(Buffer.from(text),3),'csv')){}},/SOURCE_HTML_NOT_CSV/u);
  }
  for(const text of ['id,status\r\n','single_column\n']){
    const rows=[],headers=[];for await(const row of iterateParsedRows(smallChunks(Buffer.from(text),3),'csv',undefined,header=>headers.push([...header])))rows.push(row);
    assert.deepEqual(rows,[],'a legitimate header-only CSV still represents zero observed rows');
    assert.deepEqual(headers,[text.trim().split(',')],'the parsed header remains observable even without any data row');
  }
});

test('a schema-valid wide row above one million characters has no added row-size cap',async()=>{
  const wide=Object.fromEntries(Array.from({length:100},(_,i)=>[`field${i}`,'x'.repeat(12000)]));
  for(const format of ['json','csv']){
    const bytes=Buffer.from(format==='json'?JSON.stringify([wide]):encodeCsv([wide],Object.keys(wide)));
    assert.ok(bytes.length>1_000_000);
    const rows=[];for await(const row of iterateParsedRows(smallChunks(bytes,8192),format))rows.push(row);
    assert.deepEqual(rows,[wide]);
  }
});

test('streamed export preserves exact legacy JSON/CSV bytes and verifies a complete output above 8 MiB',async t=>{
  const root=await fixture(t),small=[{id:'a',note:'hello'},{id:'b',note:'=formula'}];
  for(const format of ['json','csv']){
    const selected=['id','note'],expected=Buffer.from(format==='json'?JSON.stringify(small,null,2)+'\n':encodeCsv(small,selected));
    assert.equal(Buffer.from([...encodedRowsChunks(small,format,selected)].join('')).equals(expected),true);
    assert.deepEqual(hashEncodedRows(small,format,selected),{sha256:hash(expected),bytes:expected.length});
  }
  const large=Array.from({length:1000},(_,i)=>({id:String(i),note:'x'.repeat(9000)}));
  const artifact=await exportRows(root,'large-output',large,'json',['id','note']);
  assert.ok(artifact.bytes>8*1024*1024);assert.deepEqual(await hashScopedFile(artifact.path),{sha256:artifact.sha256,bytes:artifact.bytes});
  let count=0;for await(const _ of iterateParsedRows(scopedFileChunks(artifact.path),'json'))count++;assert.equal(count,1000);
});

test('paged text read verifies the entire file, preserves UTF-8 boundaries and refuses binary tails',async t=>{
  const root=await fixture(t),path=join(root,'result.txt'),content=Buffer.from('\uFEFFhello 🌐\n'+'z'.repeat(9*1024*1024));await writeFile(path,content);
  const first=await readScopedTextPage(path,0,10);assert.equal(first.page.startsWith('\uFEFFhello '),true);assert.equal(first.bytes,content.length);assert.equal(first.sha256,hash(content));
  assert.ok(first.next_offset>0);const second=await readScopedTextPage(path,first.next_offset,10);assert.equal(second.page.startsWith('🌐'),true);
  await assert.rejects(readScopedTextPage(path,10,10),/PACK_TEXT_PAGE_OFFSET_INVALID/u);
  await writeFile(path,Buffer.concat([content,Buffer.from([0])]));
  await assert.rejects(readScopedTextPage(path,0,10),/PACK_TEXT_FILE_UNSUPPORTED_FORMAT/u);
});

test('file path replacement and in-place mutation never produce a verified full stream',async t=>{
  const root=await fixture(t),path=join(root,'source.txt'),alias=join(root,'alias.txt');await writeFile(path,'first content');await symlink(path,alias);
  await assert.rejects(hashScopedFile(alias),/PACK_FILE_REDIRECTED/u);
  const iterator=scopedFileChunks(path);assert.equal((await iterator.next()).done,false);await writeFile(path,'changed content');
  await assert.rejects(async()=>{for await(const _ of iterator){}},/PACK_SOURCE_CHANGED/u);
  assert.equal((await readFile(path,'utf8')),'changed content');
});
