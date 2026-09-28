import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {RoutedBrowser} from '../dist/browser/executor-routing.js';
import {browserTargetSchema} from '../dist/browser/executor-contracts.js';

const root=await mkdtemp(join(tmpdir(),'agent-driver-public-browser-'));
const target=browserTargetSchema.parse(JSON.parse(process.env.AGENT_DRIVER_BROWSER_TEST_TARGET));
const report={at:new Date().toISOString(),evidence_level:'user_environment',platform:process.platform,node:process.version,engine:target.engine,environment:target.environment,url:'https://example.com/',status:'NOT_RUN',events:[],repeat_reads:[],model_calls:0,comparison:'Acceptance timing; not a controlled cross-engine benchmark'};
report.adapter_sha256=createHash('sha256').update(await readFile(new URL(`../dist/browser/${target.engine==='playwright'?'playwright-executor':'mcp-executor'}.js`,import.meta.url))).digest('hex');
const browser=new RoutedBrowser({environment:'production',fingerprint:'public-acceptance',dbPath:join(root,'runtime.db'),project:{id:'test',profileRef:join(root,'profiles')},browserExecutors:{targets:[target]}},{profile_key:'public',context_id:'public',preference:{environment:target.environment},event:e=>report.events.push(e)},['https://example.com']);
try{
  let started=performance.now();await browser.open(report.url);report.open_ms=Math.round(performance.now()-started);
  for(let n=0;n<3;n++){started=performance.now();const result=await browser.observe();if(result.title!=='Example Domain'||!result.text.includes('Example Domain'))throw Error('PUBLIC_READBACK_MISMATCH');report.repeat_reads.push({elapsed_ms:Math.round(performance.now()-started),title:result.title});}
  report.status='PASS';
}catch(error){report.status='FAIL';report.error=error.message;}
finally{
  const started=performance.now();try{await browser.close();report.cleanup='owned_tab_and_transport_closed';}catch(error){report.cleanup_error=error.message;report.status='FAIL';}report.close_ms=Math.round(performance.now()-started);
  const path=resolve(process.env.AGENT_DRIVER_BROWSER_TEST_REPORT??join(root,'report.json'));await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({path,...report},null,2));if(report.status==='FAIL')process.exitCode=1;
}
