import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ownerMcpServers,refreshOwnerMcp,callOwnerMcp,enableOwnerMcp,disableOwnerMcp,ownerMcpSnapshot} from '../dist/integrations/owner-mcp.js';

// Owner direction 2026-10-03: the MCP servers the owner already uses are taken along by themselves. What fits is
// used, what does not is left out, and nothing is asked one server at a time.
const tool=(name,annotations,description='Looks something up.')=>({name,description,inputSchema:{type:'object',properties:{query:{type:'string'}}},...(annotations?{annotations}:{})});
const servers={
  docs:[tool('search_docs',{readOnlyHint:true}),tool('resolve-library-id'),tool('create_note',{readOnlyHint:false}),tool('delete_everything',{destructiveHint:true}),tool('get_and_delete')],
  writer:[tool('create_issue'),tool('send_message')],
  coder:[tool('read_file'),tool('list_dir'),tool('find_symbol'),tool('search_for_pattern')],
};
const connectTo=calls=>async launch=>{
  const id=launch.kind==='http'?new URL(launch.url).hostname.split('.')[0]:launch.command;calls.push({id,launch});
  if(id==='broken')throw Error('spawn ENOENT');
  return {client:{async listTools(){return {tools:servers[id]??[]};},async callTool({name,arguments:args}){return name==='search_docs'?{content:[{type:'text',text:'결과 '+'가'.repeat(6000)+' '+JSON.stringify(args)}]}:{isError:true,content:[{type:'text',text:'failed'}]};},async close(){}}};
};
test('runtime contract servers that fit are used with their read tools only; the rest are left out with a reason',async t=>{
  enableOwnerMcp();t.after(()=>disableOwnerMcp());const calls=[];
  const definitions=[
    {id:'docs',side:'local',disabled:false,launch:{kind:'stdio',command:'docs',args:['--token','fixture-secret-do-not-read'],env:{API_KEY:'fixture-secret-do-not-read'}}},
    {id:'writer',side:'local',disabled:false,launch:{kind:'stdio',command:'writer',args:[],env:{}}},
    {id:'coder',side:'local',disabled:false,launch:{kind:'stdio',command:'coder',args:[],env:{}}},
    {id:'broken',side:'local',disabled:false,launch:{kind:'stdio',command:'broken',args:[],env:{}}},
    {id:'playwright',side:'local',disabled:false,launch:{kind:'stdio',command:'playwright',args:[],env:{}}},
    {id:'agent_driver',side:'local',disabled:false,launch:{kind:'stdio',command:'node',args:[],env:{}}},
    {id:'node_repl',side:'windows',disabled:false,launch:null},
    {id:'windows_only',side:'windows',disabled:false,launch:null},
    {id:'off',side:'local',disabled:true,launch:{kind:'stdio',command:'off',args:[],env:{}}},
  ];
  const snapshot=await refreshOwnerMcp({},{servers:definitions,connect:connectTo(calls)});
  assert.deepEqual(snapshot.used,[{server:'docs',tools:['search_docs','resolve-library-id']}]);
  assert.deepEqual(snapshot.tools.map(item=>item.name),['owner_docs_resolve_library_id','owner_docs_search_docs']);
  assert.deepEqual(Object.fromEntries(snapshot.left_out.map(item=>[item.server,item.reason])),{agent_driver:'covered_by_office',broken:'not_reachable',coder:'reads_local_files',node_repl:'runs_code_or_controls_computer',off:'disabled',playwright:'covered_by_office',windows_only:'other_computer',writer:'no_read_tool'});
  assert.deepEqual(calls.map(call=>call.id).sort(),['broken','coder','docs','writer'],'A server that is left out by name is never started.');
  assert.doesNotMatch(JSON.stringify(snapshot),/fixture-secret/u,'What starts a server is not part of what Office keeps or shows.');
  assert.equal(ownerMcpSnapshot(),snapshot);
  const answer=await callOwnerMcp(snapshot.tools[1],{query:'react hooks'},{},connectTo(calls));
  assert.equal(answer.status,'succeeded');assert.equal(answer.provenance,'owner_mcp_server');assert.equal(answer.truncated,true);assert.ok(Buffer.byteLength(answer.text)<=10000);assert.doesNotMatch(answer.text,/\uFFFD/u,'The text is cut on a character boundary.');
  assert.equal((await callOwnerMcp(snapshot.tools[0],{},{},connectTo(calls))).status,'retryable_failure');
  assert.equal((await callOwnerMcp({name:'owner_writer_create_issue',server:'writer',tool:'create_issue',description:'',input_schema:{}},{},{},connectTo(calls))).reason,'OWNER_MCP_SERVER_NOT_AVAILABLE','A server that was left out cannot be called.');
  disableOwnerMcp();assert.equal(ownerMcpSnapshot(),null,'Nothing is offered unless a service enabled it.');
});
test('runtime contract server definitions are read from both sides; a Windows program is not started from here',async t=>{
  const local=await mkdtemp(join(tmpdir(),'owner-mcp-local-')),windows=await mkdtemp(join(tmpdir(),'owner-mcp-windows-'));t.after(()=>Promise.all([rm(local,{recursive:true,force:true}),rm(windows,{recursive:true,force:true})]));
  await mkdir(join(local,'.codex'),{recursive:true});await mkdir(join(windows,'.codex'),{recursive:true});
  await writeFile(join(local,'.codex','config.toml'),'model = "x"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n\n[mcp_servers.context7.env]\nAPI_KEY = "k"\n\n[mcp_servers.sleeping]\ncommand = "sleep"\nenabled = false\n');
  await writeFile(join(windows,'.codex','config.toml'),'[mcp_servers.aside]\r\ncommand = "C:\\\\Apps\\\\aside.exe"\r\n\r\n[mcp_servers.openaiDeveloperDocs]\r\nurl = "https://developers.example.com/mcp"\r\n\r\n[mcp_servers.plain]\r\nurl = "http://internal.example.com/mcp"\r\n');
  await writeFile(join(local,'.claude.json'),JSON.stringify({mcpServers:{context7:{command:'other'},notes:{url:'http://127.0.0.1:9010/mcp'}}}));
  const found=Object.fromEntries(ownerMcpServers({HOME:local,AGENT_OFFICE_WINDOWS_PROFILE:windows}).map(server=>[server.id,server]));
  assert.deepEqual(found.context7.launch,{kind:'stdio',command:'npx',args:['-y','@upstash/context7-mcp'],env:{API_KEY:'k'}},'The first definition of a name is kept.');
  assert.equal(found.sleeping.disabled,true);assert.equal(found.aside.launch,null,'A Windows program is not started from WSL.');
  assert.deepEqual(found.openaideveloperdocs.launch,{kind:'http',url:'https://developers.example.com/mcp'});assert.equal(found.plain.launch,null,'A plain-http address that is not this computer is not used.');
  assert.deepEqual(found.notes.launch,{kind:'http',url:'http://127.0.0.1:9010/mcp'});
});
