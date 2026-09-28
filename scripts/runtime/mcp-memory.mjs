// Linux-only, bounded read-only MCP workload against a disposable host configuration.
// Does not load personal settings, execute Work, or terminate existing clients.
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

if(process.platform!=='linux')throw Error('LINUX_PROC_REQUIRED');
const root=mkdtempSync(join(tmpdir(),'driver-mcp-memory-'));
const entry=resolve('dist/cli.js'),config=join(root,'host.json'),clients=[],stages=[];
writeFileSync(config,JSON.stringify({schema_version:1,project_id:'memory-audit',caller_ref:'audit',account_ref:'audit',worktree:root,data_dir:join(root,'data'),environment:'production'}));
const memory=pid=>{
  const status=readFileSync(`/proc/${pid}/status`,'utf8'),smaps=readFileSync(`/proc/${pid}/smaps_rollup`,'utf8');
  return {rss_kib:Number(status.match(/^VmRSS:\s+(\d+)/m)[1]),pss_kib:Number(smaps.match(/^Pss:\s+(\d+)/m)[1])};
};
const sample=stage=>stages.push({stage,processes:clients.map(({transport})=>({pid:transport.pid,...memory(transport.pid)}))});
let result;
try{
  const started=performance.now();
  for(let i=0;i<3;i++){
    const client=new Client({name:'owned-memory-audit',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[entry,'mcp','--config',config],env:{PATH:process.env.PATH,HOME:root},stderr:'pipe'});
    transport.stderr?.resume();clients.push({client,transport});await client.connect(transport);
  }
  await delay(500);sample('initialized');
  const catalog=await Promise.all(clients.map(({client})=>client.listTools()));
  await delay(500);sample('tools_listed');
  for(const {client} of clients){const health=await client.callTool({name:'runtime_health',arguments:{}});if(health.isError)throw Error('HEALTH_FAILED');}
  await delay(500);sample('read_only_health');
  result={evidence_level:'native_integration',status:'PASS',at:new Date().toISOString(),node:process.version,entry_sha256:createHash('sha256').update(readFileSync(entry)).digest('hex'),client_count:3,tools:catalog.map(c=>c.tools.length),elapsed_ms:Math.round(performance.now()-started),stages};
}finally{
  const pids=clients.map(c=>c.transport.pid);
  await Promise.all(clients.map(({client})=>client.close()));
  const remaining=pids.filter(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});
  if(result)result.cleanup={remaining_owned_pids:remaining};
  if(remaining.length)throw Error('OWNED_PROCESS_CLEANUP_FAILED');
  rmSync(root,{recursive:true,force:true});
}
console.log(JSON.stringify(result,null,2));
