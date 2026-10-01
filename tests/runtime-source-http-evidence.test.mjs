import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {collectSource} from '../dist/packs/sources.js';
import {sha} from '../dist/packs/data.js';

test('runtime contract HTTP source records actual status, original array shape and bytes without response headers',async t=>{
 const body=JSON.stringify([{id:'one',price:12.5,unused:{value:'not projected'}},{id:'two',price:34}]);
 const server=createServer((request,response)=>{response.writeHead(202,{'Content-Type':'application/json','Set-Cookie':'private-fixture'});response.end(body);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const source={id:'http-evidence',kind:'http',url:`http://127.0.0.1:${server.address().port}/rows`,format:'json',parameters:[],json_fields:['id','price']};
 const result=await collectSource(source,{},{});
 assert.deepEqual(result.rows,[{id:'one',price:12.5},{id:'two',price:34}]);
 assert.equal(result.evidence.http_status,202);assert.equal(result.evidence.response_shape,'array');
 assert.equal(result.evidence.response_bytes,Buffer.byteLength(body));assert.equal(result.evidence.content_sha256,sha(Buffer.from(body)));
 assert.equal(result.evidence.rows,2);assert.equal(JSON.stringify(result.evidence).includes('private-fixture'),false);
 assert.equal(Object.hasOwn(result.evidence,'headers'),false);
});

test('runtime contract invalid original JSON object cannot claim an observed array or successful source',async t=>{
 const server=createServer((request,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end('{"rows":[{"id":"one"}]}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 await assert.rejects(collectSource({id:'invalid-array',kind:'http',url:`http://127.0.0.1:${server.address().port}/rows`,format:'json',parameters:[],json_fields:['id']},{},{}),/SOURCE_ROWS_REQUIRED/u);
});
