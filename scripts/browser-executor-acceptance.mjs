import {createServer} from 'node:http';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {RoutedBrowser} from '../dist/browser/executor-routing.js';
import {browserTargetSchema} from '../dist/browser/executor-contracts.js';
import {collectSource} from '../dist/packs/sources.js';

// Owned harmless HTML only. No installed user's page, profile data or external write is touched.
const root=await mkdtemp(join(tmpdir(),'agent-driver-browser-acceptance-'));
console.log(JSON.stringify({stage:'starting',pid:process.pid,root}));
const server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><title>Executor acceptance</title><h1>Agent Office 검증</h1><main id="ready"><table><tr class="row"><td class="name">Alpha</td><td class="value">42</td></tr></table><a href="/second">Second page</a></main>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
console.log(JSON.stringify({stage:'fixture_ready',origin}));
const report={format:1,at:new Date().toISOString(),platform:process.platform,node:process.version,root,cases:[]};
const targets=JSON.parse(process.env.AGENT_DRIVER_BROWSER_TEST_TARGETS??'[]').map(t=>browserTargetSchema.parse(t));
if(!targets.length)targets.push(browserTargetSchema.parse({id:'playwright',engine:'playwright',environment:'owned_headless',profile_ref:'test',platform:process.platform}));
const source={id:'table',kind:'browser',url:origin,parameters:[],ready:'#ready',auth_gate:'#login',auth_required:false,account_selector:'#account',account_text:'fixture',rows:'.row',columns:{name:'.name',value:'.value'}};
try{
  for(const target of targets){
    const config={environment:'fixture',fingerprint:'acceptance',dbPath:join(root,'runtime.sqlite'),project:{id:'acceptance',profileRef:join(root,'profiles')},browserExecutors:{targets:[target]}};
    const events=[],started=performance.now();console.log(JSON.stringify({stage:'target_start',target:target.id}));
    try{const result=await collectSource(source,{},config,{preference:{environment:target.environment},event:e=>events.push(e)});if(result.rows[0]?.name!=='Alpha'||result.rows[0]?.value!=='42')throw Error('READBACK_MISMATCH');report.cases.push({target:target.id,status:'PASS',evidence_level:'user_environment',elapsed_ms:Math.round(performance.now()-started),executor:result.evidence.executor,rows:result.rows,events});}
    catch(error){report.cases.push({target:target.id,status:'FAIL',evidence_level:'user_environment',elapsed_ms:Math.round(performance.now()-started),error:String(error.message).slice(0,300),events});}
  }
  const foreground=targets.filter(t=>t.environment==='host_foreground');
  if(foreground.length>1){
    const config={environment:'fixture',fingerprint:'handoff',dbPath:join(root,'runtime.sqlite'),project:{id:'acceptance',profileRef:join(root,'profiles')},browserExecutors:{targets:foreground}},events=[],browser=new RoutedBrowser(config,{profile_key:'handoff',context_id:'handoff',preference:{environment:'host_foreground'},event:e=>events.push(e)},[origin]);
    const started=performance.now();try{await browser.open(origin);const first=await browser.observe();await browser.navigate(origin+'/second');const second=await browser.observe();if(first.title!==second.title)throw Error('READBACK_MISMATCH');report.cases.push({target:'fallback-chain',status:'PASS',elapsed_ms:Math.round(performance.now()-started),events,checkpoint:browser.checkpoint()});}catch(error){report.cases.push({target:'fallback-chain',status:'FAIL',error:error.message,events});}finally{await browser.close().catch(()=>{});}
  }
}finally{console.log(JSON.stringify({stage:'closing_fixture',cases:report.cases}));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const output=resolve(process.env.AGENT_DRIVER_BROWSER_TEST_REPORT??join(root,'report.json'));await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,...report},null,2));}
