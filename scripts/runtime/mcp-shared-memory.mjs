import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {readMcpService,mcpServiceHealth} from '../../dist/interface/mcp-service-manager.js';
import {ownerAlive} from '../../dist/interface/mcp-process.js';
if(process.platform!=='linux')throw Error('LINUX_MEASUREMENT_ONLY');
const root=await mkdtemp(join(tmpdir(),'mcp-shared-memory-')),config=join(root,'host.json'),clients=[];let record;
try{
  await writeFile(config,JSON.stringify({schema_version:1,project_id:'memory',caller_ref:'probe',account_ref:'owner',worktree:root,data_dir:'data',environment:'production'}));
  await new Promise((accept,reject)=>{const child=spawn(process.execPath,[resolve('dist/cli.js'),'mcp-service','start','--config',config],{env:{PATH:process.env.PATH,HOME:root},stdio:'ignore'});child.once('error',reject);child.once('exit',code=>code===0?accept():reject(Error('START_FAILED')));});
  record=await readMcpService(config);const snapshots=[];
  const snapshot=async n=>{await delay(300);const text=await readFile('/proc/'+record.owner.pid+'/smaps_rollup','utf8');snapshots.push({clients:n,rss_mib:Number(text.match(/^Rss:\s+(\d+)/m)[1])/1024,pss_mib:Number(text.match(/^Pss:\s+(\d+)/m)[1])/1024,...await mcpServiceHealth(record)});};
  await snapshot(0);
  for(let n=1;n<=12;n++){
    const client=new Client({name:'memory-'+n,version:'1'}),transport=new StreamableHTTPClientTransport(new URL(record.url),{requestInit:{headers:{authorization:'Bearer '+record.token}}});
    clients.push({client,transport});await client.connect(transport);const tools=await client.listTools();if(tools.tools.length<100)throw Error('CATALOG_INCOMPLETE');const health=await client.callTool({name:'runtime_health',arguments:{}});if(health.isError)throw Error('HEALTH_FAILED');
    if([1,3,6,12].includes(n))await snapshot(n);
  }
  for(const {client,transport}of clients){await transport.terminateSession();await client.close();}
  await snapshot(0);console.log(JSON.stringify({evidence_level:'native_integration',status:'PASS',environment:'Linux '+process.version,runtime_processes:1,workload:'initialize/listTools/read-only health; no browser, model or Work execution',snapshots},null,2));
}finally{
  for(const {client,transport}of clients){await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}
  if(record&&await ownerAlive(record.owner)){process.kill(record.owner.pid,'SIGTERM');for(let i=0;i<100&&await ownerAlive(record.owner);i++)await delay(100);if(await ownerAlive(record.owner))throw Error('OWNED_SERVER_DID_NOT_EXIT');}
  await rm(root,{recursive:true,force:true});
}
