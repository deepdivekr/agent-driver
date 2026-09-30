import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {browserTargetSchema} from '../dist/browser/executor-contracts.js';
import {RoutedBrowser,publicBrowserRecovery,unusualSearchTraffic} from '../dist/browser/executor-routing.js';
import {BrowserExecutorJournal} from '../dist/browser/executor-journal.js';

const requested='https://www.google.com/search?q=public+company+filings';
const origin='https://www.google.com';
const target=(id,environment,engine='playwright')=>browserTargetSchema.parse({id,environment,engine,platform:process.platform,profile_ref:id,
  ...(engine==='aside'?{executable:'/fixture/aside'}:engine==='neo'?{endpoint:'http://127.0.0.1:49991/mcp'}:{})});
const targets=()=>[target('headless','owned_headless'),target('guest','ubuntu_vm'),target('aside','host_foreground','aside')];
const observed=(url,title,text,sequence=0)=>({url,title,text,links:[],observed_at:new Date(Date.UTC(2026,8,30,0,0,sequence)).toISOString()});
const unusual=()=>observed(origin+'/sorry/index?continue=search','Google Search','Our systems have detected unusual traffic from your computer network.');
const result=(id,sequence)=>({...observed(requested,'Search results',`Fresh ${id} DOM ${sequence}`,sequence),links:[{text:'Public filing',url:'https://www.google.com/url?q=filing'}]});

function fixture(t,{registered=targets(),preference={environment:'owned_headless'},responses,checkpoint,extra={}}={}){
  const log=[],events=[],counts=new Map(),config={fingerprint:'unusual-traffic-fixture',dbPath:'/fixture/unused.sqlite',environment:'production',project:{id:'unusual-traffic',profileRef:'/fixture/profiles'},browserExecutors:{targets:registered}};
  const browser=new RoutedBrowser(config,{profile_key:'fixture',context_id:'search',request:'Read public company filings',preference,fallback_preferences:publicBrowserRecovery(preference),
    ...extra,...(checkpoint?{checkpoint}:{}),event:event=>events.push(event),factory:executor=>({
      target:executor,
      async probe(){log.push({id:executor.id,action:'probe'});},
      async open(url){log.push({id:executor.id,action:'open',url});},
      async navigate(url){log.push({id:executor.id,action:'navigate',url});},
      async observe(){const sequence=(counts.get(executor.id)??0)+1;counts.set(executor.id,sequence);log.push({id:executor.id,action:'observe',sequence});return responses?responses(executor,sequence):executor.engine==='aside'?result(executor.id,sequence):unusual();},
      async extract(){throw Error('UNEXPECTED_EXTRACTION');},
      async scroll(){throw Error('UNEXPECTED_SCROLL');},
      async close(){log.push({id:executor.id,action:'close'});},
    })},[origin]);
  t.after(()=>browser.close());return {browser,log,events,counts};
}
const opened=f=>f.log.filter(entry=>entry.action==='open');
const probed=f=>f.log.filter(entry=>entry.action==='probe').map(entry=>entry.id);

test('runtime unit unusual search traffic requires the exact Google search and observed sorry-page evidence',()=>{
  assert.equal(unusualSearchTraffic(requested,unusual()),true);
  for(const [url,page] of [
    [requested,{...unusual(),text:'Verify you are human. Complete the CAPTCHA.'}],
    [requested,{...unusual(),url:origin+'/accounts/Login'}],
    [requested,{...unusual(),url:origin+'/sorry-looking-article'}],
    [requested,{...unusual(),url:'https://www.google.com.evil.test/sorry/'}],
    [requested,{...unusual(),text:'Access denied. You do not have permission to access this page.'}],
    ['https://www.google.com/news',unusual()],
    ['https://www.bing.com/search?q=public',unusual()],
    ['http://www.google.com/search?q=public',unusual()],
    ['invalid-url',unusual()],
  ])assert.equal(unusualSearchTraffic(url,page),false,JSON.stringify({url,page}));
});

test('runtime contract unusual headless Google traffic skips the VM and hands the same search to fresh Aside DOM',async t=>{
  const f=fixture(t);await f.browser.open(requested);
  const page=await f.browser.observe();
  assert.equal(f.browser.target.id,'aside');assert.deepEqual(probed(f),['headless','aside']);
  assert.deepEqual(opened(f).map(({id,url})=>({id,url})),[{id:'headless',url:requested},{id:'aside',url:requested}]);
  assert.equal(f.log.some(entry=>entry.id==='guest'),false,'Unusual traffic must skip guest preparation and probes');
  assert.equal(page.text,'Fresh aside DOM 2');assert.equal(page.url,requested);assert.deepEqual(page.links,result('aside',2).links);
  assert.equal(f.events.filter(event=>event.kind==='handoff').length,1);
  assert.ok(f.events.some(event=>event.kind==='handoff'&&event.from==='headless'&&event.target_id==='aside'));
  assert.ok(f.events.some(event=>event.kind==='failed'&&event.target_id==='headless'&&event.reason==='unusual_traffic_environment_block'));
  assert.deepEqual(f.browser.checkpoint().environment_recovery,{reason:'unusual_traffic',target_id:'aside'});
  assert.equal(f.browser.checkpoint().url,requested);assert.equal(f.browser.checkpoint().effect_state,'none');
});

test('runtime contract a persisted exact Aside recovery never reprobes headless candidates or calls a selection model',async t=>{
  let modelCalls=0;const f=fixture(t,{registered:[target('headless-a','owned_headless'),target('headless-b','owned_headless'),target('aside','host_foreground','aside')],extra:{recover_from_unusual_traffic:'aside',providers:{llm:{calls:[],async call(){modelCalls++;throw Error('Selection is already bound');}}}}});
  await f.browser.open(requested);assert.deepEqual(probed(f),['aside']);assert.equal(modelCalls,0);assert.deepEqual(opened(f).map(entry=>entry.url),[requested]);
});

test('runtime contract unusual traffic in the selected Playwright guest also hands off directly to Aside',async t=>{
  const f=fixture(t,{preference:{environment:'ubuntu_vm'}});await f.browser.open(requested);
  assert.equal((await f.browser.observe()).text,'Fresh aside DOM 2');
  assert.deepEqual(probed(f),['guest','aside']);assert.equal(f.log.some(entry=>entry.id==='headless'),false);
  assert.ok(f.events.some(event=>event.kind==='handoff'&&event.from==='guest'&&event.target_id==='aside'));
});

test('runtime contract persisted unusual-traffic recovery resumes only the same Aside profile without repeating headless',async t=>{
  const db=new DatabaseSync(':memory:'),journal=new BrowserExecutorJournal(db);t.after(()=>db.close());
  const checkpoint={load:()=>journal.checkpoint('unusual-traffic','search'),save:value=>journal.saveCheckpoint('unusual-traffic','search',value)};
  const first=fixture(t,{checkpoint});await first.browser.open(requested);await first.browser.observe();await first.browser.close();
  const saved=journal.checkpoint('unusual-traffic','search');assert.deepEqual(saved.environment_recovery,{reason:'unusual_traffic',target_id:'aside'});
  assert.deepEqual(saved.completed_steps,['observe']);
  // A prior browser may still have been displaying its challenge cursor.
  journal.saveCheckpoint('unusual-traffic','search',{...saved,url:unusual().url});
  const resumed=fixture(t,{checkpoint});await resumed.browser.open(requested);
  assert.deepEqual(probed(resumed),['aside']);assert.deepEqual(opened(resumed).map(entry=>entry.url),[requested]);
  assert.deepEqual(resumed.browser.completedSteps,['observe']);assert.equal((await resumed.browser.observe()).text,'Fresh aside DOM 2');
  assert.equal(resumed.log.some(entry=>['headless','guest'].includes(entry.id)),false);
});

test('runtime contract Aside unusual traffic stays blocked after one environment handoff and never cycles accounts',async t=>{
  const f=fixture(t,{registered:[...targets(),target('aside-second','host_foreground','aside')],responses:()=>unusual()});
  await f.browser.open(requested);assert.deepEqual(await f.browser.observe(),unusual());
  assert.deepEqual(probed(f),['headless','aside']);assert.equal(opened(f).length,2);
  assert.deepEqual(await f.browser.observe(),unusual());
  assert.equal(opened(f).length,2);assert.equal(f.events.filter(event=>event.kind==='handoff').length,1);
  assert.equal(f.log.some(entry=>['guest','aside-second'].includes(entry.id)),false);
  assert.equal(f.browser.checkpoint().url,unusual().url);
  assert.deepEqual(f.browser.checkpoint().environment_recovery,{reason:'unusual_traffic',target_id:'aside'});
});

test('runtime contract CAPTCHA-only login and permission-denial observations never trigger search-environment recovery',async t=>{
  for(const page of [
    {...unusual(),text:'Verify you are human. Complete the CAPTCHA.'},
    observed(origin+'/accounts/Login','Sign in','Sign in to continue.'),
    observed(requested,'Access denied','You do not have permission to access this page.'),
  ]){
    const f=fixture(t,{responses:()=>page});await f.browser.open(requested);assert.deepEqual(await f.browser.observe(),page);
    assert.deepEqual(probed(f),['headless']);assert.equal(opened(f).length,1);assert.equal(f.browser.checkpoint().environment_recovery,undefined);
  }
});

test('runtime contract semantic authentication and access errors propagate without opening another browser',async t=>{
  for(const message of ['PACK_WAITING_AUTH','PACK_ACCOUNT_MISMATCH','PACK_UNKNOWN_DIALOG','BROWSER_AUTH_REQUIRED','BROWSER_ACCESS_DENIED','HTTP_403_FORBIDDEN']){
    const f=fixture(t,{responses:(_target,sequence)=>{if(sequence>1)throw Error(message);return result('headless',sequence);}});
    await f.browser.open(requested);await assert.rejects(f.browser.observe(),new RegExp(message));
    assert.deepEqual(probed(f),['headless']);assert.equal(opened(f).length,1);assert.equal(f.browser.checkpoint().environment_recovery,undefined);
  }
});

test('runtime contract fixed engines uncertain effects and an unoffered Aside recovery keep the original observation',async t=>{
  for(const scenario of [
    {preference:{environment:'owned_headless',preferred_engine:'playwright'},extra:{fallback_preferences:publicBrowserRecovery()}},
    {uncertain:true},
    {extra:{fallback_preferences:[],fallback_environments:['ubuntu_vm','host_foreground']}},
    {extra:{fallback_preferences:[{environment:'ubuntu_vm',preferred_engine:'playwright'}]}},
  ]){
    const f=fixture(t,scenario);await f.browser.open(requested);if(scenario.uncertain)f.browser.markUncertainEffect();
    assert.deepEqual(await f.browser.observe(),unusual());assert.deepEqual(probed(f),['headless']);
    assert.equal(opened(f).length,1);assert.equal(f.browser.checkpoint().environment_recovery,undefined);
    assert.equal(f.browser.checkpoint().effect_state,scenario.uncertain?'uncertain':'none');
  }
});

test('runtime contract a non-Playwright guest is not the approved unusual-traffic recovery source',async t=>{
  const f=fixture(t,{registered:[target('guest-neo','ubuntu_vm','neo'),target('aside','host_foreground','aside')],preference:{environment:'ubuntu_vm'},responses:()=>unusual()});
  await f.browser.open(requested);assert.deepEqual(await f.browser.observe(),unusual());
  assert.deepEqual(probed(f),['guest-neo']);assert.equal(f.browser.checkpoint().environment_recovery,undefined);
});

test('runtime contract an absent registered Aside preserves the original unusual-traffic observation without guest fallback',async t=>{
  const f=fixture(t,{registered:targets().filter(target=>target.engine!=='aside')});await f.browser.open(requested);
  assert.deepEqual(await f.browser.observe(),unusual());assert.deepEqual(probed(f),['headless']);
  assert.equal(f.browser.target.id,'headless');assert.equal(f.browser.checkpoint().environment_recovery,undefined);
});
