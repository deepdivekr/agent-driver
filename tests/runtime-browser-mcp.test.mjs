import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {McpBrowserExecutor} from '../dist/browser/mcp-executor.js';
import {browserTargetSchema} from '../dist/browser/executor-contracts.js';

async function fixture(t){
  const calls=[],state={mine:true,closed:0},session='fixture-private-session',mcp=new Server({name:'neo-contract-fixture',version:'1'},{capabilities:{tools:{}}});
  mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'name_session',inputSchema:{type:'object',properties:{name:{type:'string'}}}},{name:'run',inputSchema:{type:'object',properties:{code:{type:'string'},session:{type:'string'}}}}]}));
  mcp.setRequestHandler(CallToolRequestSchema,async request=>{
    calls.push(request.params);const args=request.params.arguments??{};let value=true;
    if(request.params.name==='run'){
      assert.equal(args.session,session);const code=args.code;
      if(code.includes('ownership')&&!state.mine)return {isError:false,content:[],structuredContent:{ok:false,error:'BROWSER_TAB_OWNERSHIP_LOST'},_meta:{'com.browseros.neo/session':session}};
      if(code.includes('newPage'))value=42;
      else if(code.includes('browser.evaluate'))value={url:'https://example.test/',title:'Contract fixture',text:'Observed',links:[],observed_at:new Date().toISOString()};
      else if(code.includes('pages.list()).length'))value=3;
      else if(code.includes('pages.close')){assert.match(code,/pages.close\(42\)/);state.closed++;}
    }
    return {content:[],structuredContent:{ok:true,value},_meta:{'com.browseros.neo/session':session}};
  });
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:true});await mcp.connect(transport);
  const http=createServer(async(req,res)=>{try{let body;if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw);}await transport.handleRequest(req,res,body);}catch(error){res.writeHead(500);res.end('contract server error');}});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const target=browserTargetSchema.parse({id:'neo',engine:'neo',environment:'host_foreground',profile_ref:'fixture',platform:process.platform,endpoint:`http://127.0.0.1:${http.address().port}/mcp`}),adapter=new McpBrowserExecutor(target);
  t.after(async()=>{await adapter.close().catch(()=>{});await mcp.close();await new Promise(resolve=>{http.close(resolve);http.closeAllConnections();});});return {adapter,state,calls};
}
test('runtime contract Neo adapter preserves server session and confines operations to its owned page',async t=>{
  const {adapter,calls,state}=await fixture(t);await adapter.probe();await adapter.open('https://example.test/');const observation=await adapter.observe();assert.equal(observation.text,'Observed');await adapter.scroll('down');await adapter.close();
  assert.equal(state.closed,1);assert.equal(calls[0].name,'name_session');assert.ok(calls.filter(c=>c.name==='run').every(c=>c.arguments.session==='fixture-private-session'));assert.equal(calls.filter(c=>c.arguments?.code?.includes('newPage')).length,1);
});
test('runtime contract Neo ownership loss never closes a user-controlled tab',async t=>{
  const {adapter,state}=await fixture(t);await adapter.open('https://example.test/');state.mine=false;await assert.rejects(adapter.observe(),/TAB_OWNERSHIP_LOST/);await assert.rejects(adapter.close(),/TAB_OWNERSHIP_LOST/);assert.equal(state.closed,0);
});
