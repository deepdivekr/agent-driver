import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {startControlCenter} from '../dist/observability/control-center.js';

const proposal={title:'Read fixture source',desired_outcome:'Read the delegated source value.',completion_checks:[{id:'result',result:'Source value is observed.',evidence:'Delegated source contents.'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
const recipe={version:1,family:'research.search',request:'Read source data',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'office-stream-budget-')),host=join(root,'host.json');
  await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'observed result'}]));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'stream-budget',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(host),api=new RuntimeApi(config,{swarmModel:{calls:[],async call(){return proposal;}}}),works=[];
  for(let index=0;index<3;index++)works.push(await api.call('runtime_work_start',{request_id:`stream-work-${index}`,prompt:'Read delegated source '+index}));
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const server=await startControlCenter(config,{workModel:{calls:[],async call(_purpose,instructions,input){
    if(instructions.startsWith('Independently verify'))return {checks:input.checks.map(check=>{
      const evidence_ids=input.observations.filter(item=>item.tool_name==='runtime_pack_run'&&JSON.stringify(item.value).includes('observed result')).flatMap(item=>item.evidence_ids).filter(id=>check.allowed_evidence_ids.includes(id));
      assert.ok(evidence_ids.length>0);return {id:check.id,verdict:'supported',evidence_use:'observed_result',evidence_ids,evidence_quotes:evidence_ids.map(evidence_id=>({evidence_id,quote:'observed result'})),reason:'Actual fixture file observation.'};
    })};
    assert.ok(instructions.startsWith('Execute the registered Work'));
    if(input.checkpoint.observations.length){const receipt=input.checkpoint.observations[0].receipt;return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Source value: observed result',completed_checks:input.completion_checks.map(check=>({id:check.id,evidence_ids:receipt.evidence_ids})),wait_reason:null};}
    await gate;return {action:'tool',stage_id:'read',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({recipe}),summary:'Read the delegated fixture source.',completed_checks:[],wait_reason:null};
  }}});
  t.after(async()=>{release();await server.close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  return {api,config,works,server,release};
}

test('runtime native HTTP multiplexes board and selected Work activity on one response with scoped events and shutdown cleanup',{timeout:15000},async t=>{
  const x=await setup(t),id=x.works[0].work_id,abort=new AbortController();t.after(()=>abort.abort());
  assert.equal((await fetch(x.server.url+'work/events?work_id=missing')).status,404);
  assert.equal((await fetch(x.server.url+'work/events?work_id=')).status,400);
  assert.equal((await fetch(x.server.url+'work/events',{method:'POST'})).status,405);
  const response=await fetch(x.server.url+'work/events?work_id='+id,{signal:abort.signal});assert.equal(response.status,200);
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
  while(!text.includes('event: activity')){const part=await reader.read();assert.equal(part.done,false);text+=decoder.decode(part.value);}
  assert.match(text,/event: board/u);assert.match(text,/event: activity/u);
  const activity=JSON.parse(text.split('event: activity\ndata: ')[1].split('\n\n')[0]);assert.equal(activity.work_id,id);
  assert.equal(activity.activity.some(event=>event.kind==='received'),true);assert.equal(activity.activity.some(event=>event.kind==='defined'),true);assert.equal(activity.activity.some(event=>event.kind==='definition.started'),true);assert.equal(activity.activity.some(event=>event.kind==='definition.finished'),true);assert.equal(activity.display_status,'ready');
  await x.server.close();let part;do{part=await reader.read();}while(!part.done);assert.equal(part.done,true);
});

test('runtime fixture three same-origin browser tabs execute concurrently and keep one live stream per page',{timeout:35000},async t=>{
  const x=await setup(t),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext(),errors=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.addInitScript(()=>{
    try{localStorage.setItem('office-lang','en');}catch{}
    const Native=window.EventSource;window.__workStreams={active:0,peak:0,urls:[]};
    window.EventSource=class extends Native{
      constructor(...args){super(...args);this.__closed=false;window.__workStreams.active++;window.__workStreams.peak=Math.max(window.__workStreams.peak,window.__workStreams.active);window.__workStreams.urls.push(String(args[0]));}
      close(){if(!this.__closed){this.__closed=true;window.__workStreams.active--;}super.close();}
    };
  });
  const pages=await Promise.all(x.works.map(()=>context.newPage()));
  await Promise.all(pages.map((page,index)=>page.goto(x.server.url+'?work='+x.works[index].work_id,{waitUntil:'domcontentloaded'})));
  await Promise.all(pages.map(page=>page.locator('#execute-work').waitFor({timeout:7000})));
  for(const [index,page] of pages.entries()){
    const streams=await page.evaluate(()=>window.__workStreams);assert.equal(streams.active,1);assert.equal(streams.peak,1);
    assert.deepEqual(streams.urls,['work/events?work_id='+x.works[index].work_id]);assert.equal(await page.locator('#execution-consent').count(),0);assert.equal(await page.locator('#execute-work').isEnabled(),true);
  }
  const responses=pages.map(page=>page.waitForResponse(response=>response.url().endsWith('/work/execute')&&response.request().method()==='POST',{timeout:7000}));
  await Promise.all(pages.map(page=>page.locator('#execute-work').click({timeout:7000})));
  for(const response of await Promise.all(responses))assert.equal(response.status(),202);
  // All POSTs reach the actual durable queue. The default two-run host ceiling
  // may leave the third Work queued while the fixture model gate is closed.
  await Promise.all(pages.map(page=>page.waitForFunction(()=>document.getElementById('work-tail-output')?.textContent.includes('supervisor.queued'),{},{timeout:7000})));
  x.release();await Promise.all(pages.map(page=>page.waitForFunction(()=>document.getElementById('work-tail-output')?.textContent.includes('supervisor.result'),{},{timeout:10000})));
  for(const work of x.works){const detail=await (await fetch(x.server.url+'work/detail?id='+work.work_id)).json();assert.equal(detail.supervisor.state,'succeeded');assert.equal(detail.runs.length,1);}
  const page=pages[0];await page.locator('#back').click();await page.locator('#prompt').waitFor();
  let streams=await page.evaluate(()=>window.__workStreams);assert.equal(streams.active,1);assert.equal(streams.peak,1);assert.equal(streams.urls.at(-1),'work/events');
  await page.locator('[data-work="'+x.works[0].work_id+'"]').click();await page.locator('#work-timeline').waitFor();assert.equal(await page.locator('#work-tail-output').isVisible(),false);
  streams=await page.evaluate(()=>window.__workStreams);assert.equal(streams.active,1);assert.equal(streams.peak,1);assert.equal(streams.urls.at(-1),'work/events?work_id='+x.works[0].work_id);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{get:()=>true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal((await page.evaluate(()=>window.__workStreams)).active,0);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal((await page.evaluate(()=>window.__workStreams)).active,1);assert.equal((await page.evaluate(()=>window.__workStreams)).peak,1);
  assert.deepEqual(errors,[]);
});
