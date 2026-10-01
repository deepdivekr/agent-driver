import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {McpBrowserExecutor,closeSharedBrowserConnections} from '../dist/browser/mcp-executor.js';
import {browserTargetSchema} from '../dist/browser/executor-contracts.js';

async function fixture(t,{limits,hangFirst=0}={}){
  const calls=[],state={mine:true,closed:0,hang:hangFirst},session='fixture-private-session',mcp=new Server({name:'neo-contract-fixture',version:'1'},{capabilities:{tools:{}}});
  mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'name_session',inputSchema:{type:'object',properties:{name:{type:'string'}}}},{name:'run',inputSchema:{type:'object',properties:{code:{type:'string'},session:{type:'string'}}}}]}));
  mcp.setRequestHandler(CallToolRequestSchema,async request=>{
    calls.push(request.params);const args=request.params.arguments??{};let value=true;
    if(request.params.name==='run'){
      assert.equal(args.session,session);const code=args.code;
      if(code.includes('ownership')&&!state.mine)return {isError:false,content:[],structuredContent:{ok:false,error:'BROWSER_TAB_OWNERSHIP_LOST'},_meta:{'com.browseros.neo/session':session}};
      if(code.includes('newPage')){if(state.hang>0){state.hang--;return new Promise(()=>{});}value=42;}
      else if(code.includes('browser.evaluate'))value={url:'https://example.test/',title:'Contract fixture',text:'Observed',links:[],observed_at:new Date().toISOString()};
      else if(code.includes('pages.list()).length'))value=3;
      else if(code.includes('pages.close')){assert.match(code,/pages.close\(42\)/);state.closed++;}
    }
    return {content:[],structuredContent:{ok:true,value},_meta:{'com.browseros.neo/session':session}};
  });
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:true});await mcp.connect(transport);
  const http=createServer(async(req,res)=>{try{let body;if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw);}await transport.handleRequest(req,res,body);}catch(error){res.writeHead(500);res.end('contract server error');}});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const target=browserTargetSchema.parse({id:'neo',engine:'neo',environment:'host_foreground',profile_ref:'fixture',platform:process.platform,endpoint:`http://127.0.0.1:${http.address().port}/mcp`}),adapter=new McpBrowserExecutor(target,limits);
  t.after(async()=>{await adapter.close().catch(()=>{});await closeSharedBrowserConnections();await mcp.close();await new Promise(resolve=>{http.close(resolve);http.closeAllConnections();});});return {adapter,state,calls,target};
}
test('runtime contract Neo adapter preserves server session and confines operations to its owned page',async t=>{
  const {adapter,calls,state}=await fixture(t);await adapter.probe();await adapter.open('https://example.test/');const observation=await adapter.observe();assert.equal(observation.text,'Observed');await adapter.scroll('down');await adapter.close();
  assert.equal(state.closed,1);assert.equal(calls[0].name,'name_session');assert.ok(calls.filter(c=>c.name==='run').every(c=>c.arguments.session==='fixture-private-session'));assert.equal(calls.filter(c=>c.arguments?.code?.includes('newPage')).length,1);
});
test('runtime contract Neo ownership loss never closes a user-controlled tab',async t=>{
  const {adapter,state}=await fixture(t);await adapter.open('https://example.test/');state.mine=false;await assert.rejects(adapter.observe(),/TAB_OWNERSHIP_LOST/);await assert.rejects(adapter.close(),/TAB_OWNERSHIP_LOST/);assert.equal(state.closed,0);
});

// B5 (live): a cold foreground browser answered its first operation late once per
// new origin, costing ~30s and a run retry each time. One retry after a timeout.
test('runtime contract a timed-out first page operation is retried once, a second timeout is not hidden',async t=>{
  const {adapter,calls}=await fixture(t,{limits:{operation_ms:400},hangFirst:1});
  await adapter.open('https://example.test/');assert.equal((await adapter.observe()).text,'Observed');
  assert.equal(calls.filter(c=>c.arguments?.code?.includes('newPage')).length,2,'The late first answer is followed by exactly one retry.');
  const twice=await fixture(t,{limits:{operation_ms:400},hangFirst:2});
  await assert.rejects(twice.adapter.open('https://example.test/'),/timed out/iu);
});

// B5: starting the foreground browser CLI cost ~28s per origin live. One
// connection per CLI/endpoint is shared by the runtime's tabs and lingers briefly.
test('runtime contract tabs on the same browser endpoint share one lingering MCP connection and each keeps its own page',async t=>{
  const {adapter,calls,target,state}=await fixture(t);
  const second=new McpBrowserExecutor(target);t.after(()=>second.close().catch(()=>{}));
  await adapter.open('https://example.test/a');await second.open('https://example.test/b');
  assert.equal(calls.filter(c=>c.name==='name_session').length,1,'One session for one endpoint.');
  assert.equal(calls.filter(c=>c.arguments?.code?.includes('newPage')).length,2,'Each executor owns its own page.');
  await adapter.close();await second.close();assert.equal(state.closed,2);
  const third=new McpBrowserExecutor(target);t.after(()=>third.close().catch(()=>{}));
  await third.open('https://example.test/c');
  assert.equal(calls.filter(c=>c.name==='name_session').length,1,'A connection released moments ago is reused, not restarted.');
});
