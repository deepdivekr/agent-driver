import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {runInNewContext} from 'node:vm';
import {chromium} from 'playwright';
import {PlaywrightBrowserExecutor} from '../dist/browser/playwright-executor.js';
import {browserTargetSchema} from '../dist/browser/executor-contracts.js';
import {RoutedBrowser} from '../dist/browser/executor-routing.js';

const navigationMessage='Execution context was destroyed, most likely because of a navigation';
const navigationError=()=>Error(`page.evaluate: ${navigationMessage}`);
const target=id=>browserTargetSchema.parse({id,engine:'playwright',environment:'owned_headless',profile_ref:id,platform:process.platform});
const config=targets=>({fingerprint:'observation-navigation-fixture',dbPath:'/tmp/unused-observation-navigation.db',environment:'fixture',project:{id:'observation-navigation',profileRef:'/tmp/unused-observation-navigation'},browserExecutors:{targets}});
const observation=(url='https://example.test/settled')=>({url,title:'Settled evidence',text:'Actual fixture page text',links:[],observed_at:'2026-09-29T00:00:00.000Z'});

// Only the private Page seam is synthetic. Every check invokes the production
// PlaywrightBrowserExecutor.observe method; no replacement observe algorithm,
// model, external browser, persistent profile or data store is used.
function fakePage({waits=[],evaluations=[observation()],closed=false}={}){
  const calls={wait:[],evaluate:[],forbidden:[]};
  const forbidden=name=>()=>{calls.forbidden.push(name);throw Error(`Fixture forbids ${name}`);};
  const take=async(queue,fallback)=>{
    const value=queue.length?queue.shift():fallback;
    if(value instanceof Error)throw value;
    return typeof value==='function'?await value({page,calls}):value;
  };
  const page={
    closed,
    isClosed(){return this.closed;},
    async waitForFunction(fn,arg,options){calls.wait.push({fn,arg,options,receiver:this});return take(waits,{fixture_handle:true});},
    async evaluate(script){calls.evaluate.push({script,receiver:this});assert.ok(evaluations.length,'fixture requires an explicit observation or error for every read');return take(evaluations);},
    goto:forbidden('goto'),newPage:forbidden('newPage'),reload:forbidden('reload'),close:forbidden('close'),
    mouse:{wheel:forbidden('wheel')},locator:forbidden('locator'),
  };
  return {page,calls};
}
function portFor(page,id='first'){
  const selected=target(id),port=new PlaywrightBrowserExecutor(selected,config([selected]),'navigation-test',true);
  port.page=page;
  return port;
}
function assertSamePage(x){
  assert.ok(x.calls.wait.every(call=>call.receiver===x.page));
  assert.ok(x.calls.evaluate.every(call=>call.receiver===x.page));
  assert.deepEqual(x.calls.forbidden,[],'observation must not navigate, open, scroll or close a page');
  assert.ok(x.calls.wait.every(call=>Number.isFinite(call.options.timeout)&&call.options.timeout>0&&call.options.timeout<=3000));
}

test('runtime unit browser observation retries one genuine navigation-context signature on the same page',async()=>{
  const expected=observation(),x=fakePage({evaluations:[navigationError(),expected]}),port=portFor(x.page);
  assert.deepEqual(await port.observe(),expected);
  assert.equal(x.calls.wait.length,2);assert.equal(x.calls.evaluate.length,2);assertSamePage(x);
});

test('runtime unit browser observation allows at most two retries including readiness between DOM reads',async()=>{
  const expected=observation(),x=fakePage({evaluations:[navigationError(),navigationError(),expected]}),port=portFor(x.page);
  assert.deepEqual(await port.observe(),expected);
  assert.equal(x.calls.wait.length,3);assert.equal(x.calls.evaluate.length,3);assertSamePage(x);
});

test('runtime unit browser observation exhausted navigation attempts remain a failure without a fourth read',async()=>{
  const x=fakePage({evaluations:[navigationError(),navigationError(),navigationError(),observation()]}),port=portFor(x.page);
  await assert.rejects(port.observe(),/BROWSER_OBSERVATION_NAVIGATING/u);
  assert.equal(x.calls.wait.length,3);assert.equal(x.calls.evaluate.length,3);assertSamePage(x);
});

test('runtime unit browser observation also bounds navigation errors raised by the readiness wait',async()=>{
  const expected=observation(),x=fakePage({waits:[navigationError(),{}],evaluations:[expected]}),port=portFor(x.page);
  assert.deepEqual(await port.observe(),expected);
  assert.equal(x.calls.wait.length,2);assert.equal(x.calls.evaluate.length,1);assertSamePage(x);
});

test('runtime unit browser observation shares a single three-second budget across navigation attempts',async t=>{
  const times=[1000,1000,2500,4000];let index=0;
  const clock=t.mock.method(Date,'now',()=>times[Math.min(index++,times.length-1)]);
  try{
    const x=fakePage({evaluations:[navigationError(),navigationError(),observation()]}),port=portFor(x.page);
    await assert.rejects(port.observe(),/BROWSER_OBSERVATION_NAVIGATING/u);
    assert.deepEqual(x.calls.wait.map(call=>call.options.timeout),[3000,1500]);
    assert.equal(x.calls.evaluate.length,2);assertSamePage(x);
  }finally{clock.mock.restore();}
});

for(const [label,error] of [
  ['readiness timeout',Error('page.waitForFunction: Timeout 3000ms exceeded')],
  ['ordinary JavaScript error',Error('page.evaluate: ReferenceError: fixtureMissing is not defined')],
  ['unrelated context error',Error('page.evaluate: Execution context was destroyed')],
  ['authentication refusal',Error('PACK_WAITING_AUTH')],
])test(`runtime unit browser observation does not retry ${label}`,async()=>{
  const waiting=label==='readiness timeout',x=fakePage({waits:waiting?[error]:[],evaluations:waiting?[observation()]:[error,observation()]}),port=portFor(x.page);
  await assert.rejects(port.observe(),failure=>failure===error);
  assert.equal(x.calls.wait.length,1);assert.equal(x.calls.evaluate.length,waiting?0:1);assertSamePage(x);
});

test('runtime unit browser observation rejects invalid schema instead of retrying or manufacturing a successful snapshot',async()=>{
  const x=fakePage({evaluations:[{...observation(),unobserved_authority:true},observation()]}),port=portFor(x.page);
  await assert.rejects(port.observe(),error=>error?.name==='ZodError');
  assert.equal(x.calls.wait.length,1);assert.equal(x.calls.evaluate.length,1);assertSamePage(x);
});

test('runtime unit browser observation readiness predicate excludes loading documents and absent bodies',async()=>{
  const x=fakePage(),port=portFor(x.page);
  await port.observe();
  const fn=x.calls.wait[0].fn;
  const ready=document=>runInNewContext(`(${fn.toString()})()`,{document});
  assert.equal(ready({readyState:'loading',body:{}}),false);
  assert.equal(ready({readyState:'interactive',body:null}),false);
  assert.equal(ready({readyState:'complete',body:null}),false);
  assert.equal(ready({readyState:'interactive',body:{}}),true);
  assert.equal(ready({readyState:'complete',body:{}}),true);
  assert.deepEqual(x.calls.wait[0].arg,{});assertSamePage(x);
});

for(const [label,document] of [
  ['loading after readiness', {readyState:'loading',body:{}}],
  ['missing body after readiness', {readyState:'complete',body:null}],
])test(`runtime unit browser observation rejects ${label} without reporting success or reopening the page`,async()=>{
  const x=fakePage({evaluations:[()=>runInNewContext(x.calls.evaluate[0].script,{document}),observation()]}),port=portFor(x.page);
  await assert.rejects(port.observe(),/BROWSER_OBSERVATION_NAVIGATING/u);
  assert.equal(x.calls.wait.length,1);assert.equal(x.calls.evaluate.length,1);assertSamePage(x);
});

test('runtime unit browser observation rejects a closed page and an unknown dialog before any read',async()=>{
  for(const kind of ['closed','dialog']){
    const x=fakePage({closed:kind==='closed'}),port=portFor(x.page);
    if(kind==='dialog')port.unknownDialog=true;
    await assert.rejects(port.observe(),kind==='closed'?/BROWSER_TAB_NOT_OPEN/u:/PACK_UNKNOWN_DIALOG/u);
    assert.equal(x.calls.wait.length,0);assert.equal(x.calls.evaluate.length,0);assertSamePage(x);
  }
  await assert.rejects(new PlaywrightBrowserExecutor(target('not-open'),config([]),'navigation-test',true).observe(),/BROWSER_TAB_NOT_OPEN/u);
});

for(const kind of ['closed','dialog','replacement'])test(`runtime unit browser observation fences ${kind} arriving during the DOM read`,async()=>{
  let port;
  const replacement=fakePage(),x=fakePage({evaluations:[()=>{
    if(kind==='closed')x.page.closed=true;
    else if(kind==='dialog')port.unknownDialog=true;
    else port.page=replacement.page;
    return observation();
  },observation()]});
  port=portFor(x.page);
  await assert.rejects(port.observe(),kind==='dialog'?/PACK_UNKNOWN_DIALOG/u:/BROWSER_TAB_NOT_OPEN/u);
  assert.equal(x.calls.wait.length,1);assert.equal(x.calls.evaluate.length,1);assertSamePage(x);
  assert.equal(replacement.calls.wait.length,0);assert.equal(replacement.calls.evaluate.length,0);
});

test('runtime unit browser observation rechecks ownership and dialogs before a navigation retry',async()=>{
  for(const kind of ['closed','dialog','replacement']){
    let port;
    const replacement=fakePage(),x=fakePage({evaluations:[()=>{
      if(kind==='closed')x.page.closed=true;
      else if(kind==='dialog')port.unknownDialog=true;
      else port.page=replacement.page;
      throw navigationError();
    },observation()]});
    port=portFor(x.page);
    await assert.rejects(port.observe(),kind==='dialog'?/PACK_UNKNOWN_DIALOG/u:/BROWSER_TAB_NOT_OPEN/u);
    assert.equal(x.calls.wait.length,1);assert.equal(x.calls.evaluate.length,1);assertSamePage(x);
    assert.equal(replacement.calls.wait.length,0);assert.equal(replacement.calls.evaluate.length,0);
  }
});

function routedFixture(evaluations){
  const targets=[target('first'),target('second')],c=config(targets),x=fakePage({evaluations}),events=[],opened=[],created=[];
  const browser=new RoutedBrowser(c,{profile_key:'navigation-test',context_id:'navigation-test',event:event=>events.push(event),factory:selected=>{
    created.push(selected.id);
    const port=new PlaywrightBrowserExecutor(selected,c,'navigation-test',true);
    port.probe=async()=>{};
    port.open=async url=>{opened.push({id:selected.id,url});port.page=x.page;};
    return port;
  }},['https://example.test']);
  return {browser,x,events,opened,created};
}

test('runtime contract browser same-page navigation recovery never selects another executor or reopens the entry',async t=>{
  const entry='https://example.test/entry',expected=observation('https://example.test/settled'),x=routedFixture([observation(entry),navigationError(),expected]);
  t.after(()=>x.browser.close());
  await x.browser.open(entry);
  assert.deepEqual(await x.browser.observe(),expected);
  assert.deepEqual(x.created,['first']);assert.deepEqual(x.opened,[{id:'first',url:entry}]);
  assert.equal(x.events.some(event=>event.kind==='handoff'),false);
  assert.equal(x.browser.checkpoint().entry_url,entry);assert.equal(x.browser.checkpoint().url,expected.url);
  assert.deepEqual(x.browser.completedSteps,['observe']);assert.equal(x.browser.checkpoint().effect_state,'none');assertSamePage(x.x);
});

test('runtime contract browser recovered DOM still rejects an undelegated origin without checkpoint authority expansion',async t=>{
  const entry='https://example.test/entry',x=routedFixture([observation(entry),navigationError(),observation('https://foreign.test/redirect')]);
  t.after(()=>x.browser.close());
  await x.browser.open(entry);
  const before=x.browser.checkpoint();
  await assert.rejects(x.browser.observe(),/BROWSER_URL_NOT_DELEGATED/u);
  assert.deepEqual(x.created,['first']);assert.deepEqual(x.opened,[{id:'first',url:entry}]);
  assert.equal(x.events.some(event=>event.kind==='handoff'),false);
  assert.deepEqual(x.browser.checkpoint(),before);assert.deepEqual(x.browser.completedSteps,[]);assertSamePage(x.x);
});

test('runtime contract browser exhausted observation race does not become executor failover or successful evidence',async t=>{
  const entry='https://example.test/entry',x=routedFixture([observation(entry),navigationError(),navigationError(),navigationError(),observation()]);
  t.after(()=>x.browser.close());
  await x.browser.open(entry);
  const before=x.browser.checkpoint();
  await assert.rejects(x.browser.observe(),/BROWSER_OBSERVATION_NAVIGATING/u);
  assert.deepEqual(x.created,['first']);assert.deepEqual(x.opened,[{id:'first',url:entry}]);
  assert.equal(x.events.some(event=>event.kind==='handoff'),false);
  assert.deepEqual(x.browser.checkpoint(),before);assert.deepEqual(x.browser.completedSteps,[]);assertSamePage(x.x);
});

// Native checks use isolated Chromium and synthetic owned loopback documents.
// They are driver/readiness acceptance, not a real Bing/provider/Work run.
// The controlled navigation fault below is a real protocol context loss; its
// fixture trigger is explicitly injected and never substitutes a fake error.
async function nativeFixture(t,handler){
  const requests=[],server=createServer((req,res)=>{requests.push({method:req.method,url:req.url});handler(req,res);});
  let browser;
  t.after(async()=>{
    try{await browser?.close();}
    finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block'}),page=await context.newPage();
  await page.route('**/*',route=>route.request().method()==='GET'&&new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  const port=portFor(page,'native-owned');
  return {browser,context,page,port,origin,requests};
}
function preventNewNavigation(t,page){
  const original=page.goto;
  page.goto=async()=>{throw Error('observe must not issue another goto');};
  t.after(()=>{page.goto=original;});
}
const settledDocument='<!doctype html><html><head><title>Settled native document</title></head><body><h1>Owned redirect evidence</h1><a href="/next">Next owned page</a></body></html>';

test('runtime native browser production observer reads settled same-origin HTTP redirect without another goto or tab',async t=>{
  const x=await nativeFixture(t,(req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:'/settled'});res.end();return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(settledDocument);
  });
  await x.page.goto(x.origin+'/redirect',{waitUntil:'domcontentloaded',timeout:15000});
  preventNewNavigation(t,x.page);
  const page=x.page,result=await x.port.observe();
  assert.equal(x.port.page,page);assert.equal(x.context.pages().length,1);
  assert.equal(result.url,x.origin+'/settled');assert.equal(result.title,'Settled native document');
  assert.ok(result.text.includes('Owned redirect evidence'));assert.deepEqual(result.links,[{text:'Next owned page',url:x.origin+'/next'}]);
  assert.equal(x.requests.filter(request=>request.url==='/redirect').length,1);
  assert.equal(x.requests.filter(request=>request.url==='/settled').length,1);
  assert.ok(x.requests.every(request=>request.method==='GET'&&['/redirect','/settled','/favicon.ico'].includes(request.url)));
});

test('runtime native browser production observer recovers an actual controlled context loss on the same Chromium page',async t=>{
  const x=await nativeFixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(settledDocument);});
  await x.page.goto(x.origin+'/race',{waitUntil:'domcontentloaded',timeout:15000});
  preventNewNavigation(t,x.page);
  const originalEvaluate=x.page.evaluate.bind(x.page),scripts=[];let protocolLoss=null;
  x.page.evaluate=async(script,...args)=>{
    scripts.push(script);
    if(scripts.length===1){
      try{
        // This is fixture-only native fault injection, not executor behavior.
        // A real pending protocol evaluation loses its execution context when
        // the fixture page itself redirects to another owned document.
        return await originalEvaluate(()=>new Promise(resolve=>{
          setTimeout(()=>location.replace('/settled'),0);
          setTimeout(()=>resolve(null),10000);
        }));
      }catch(error){protocolLoss=error;throw error;}
    }
    return originalEvaluate(script,...args);
  };
  const page=x.page,result=await x.port.observe();
  assert.ok(protocolLoss instanceof Error,'the native fault must actually occur, not be inferred from a redirect');
  assert.ok(protocolLoss.message.includes(navigationMessage));
  assert.ok(scripts.length>=2&&scripts.length<=3);
  assert.ok(scripts.slice(1).every(script=>typeof script==='string'&&script.includes('document.readyState')&&script.includes('querySelectorAll')),'recovered reads use the production fixed DOM script');
  assert.equal(x.port.page,page);assert.equal(x.context.pages().length,1);
  assert.equal(result.url,x.origin+'/settled');assert.equal(result.title,'Settled native document');
  assert.ok(result.text.includes('Owned redirect evidence'));assert.deepEqual(result.links,[{text:'Next owned page',url:x.origin+'/next'}]);
  assert.equal(x.requests.filter(request=>request.url==='/race').length,1);
  assert.equal(x.requests.filter(request=>request.url==='/settled').length,1);
  assert.ok(x.requests.every(request=>request.method==='GET'&&['/race','/settled','/favicon.ico'].includes(request.url)));
});

test('runtime native browser production observer waits for the current loading document instead of accepting a partial body',async t=>{
  let streamResponse;
  const x=await nativeFixture(t,(req,res)=>{
    if(req.url==='/stream'){
      streamResponse=res;res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.write('<!doctype html><html><head><title>Owned streaming document</title></head><body><p>Initial partial body</p>');return;
    }
    res.writeHead(204);res.end();
  });
  await x.page.goto(x.origin+'/stream',{waitUntil:'commit',timeout:15000});
  await x.page.waitForFunction(()=>document.readyState==='loading'&&document.body!==null,{},{timeout:3000});
  assert.equal(await x.page.evaluate(()=>document.readyState),'loading');
  preventNewNavigation(t,x.page);
  const originalWait=x.page.waitForFunction.bind(x.page);let waits=0;
  x.page.waitForFunction=(...args)=>{
    waits++;
    if(waits===1)setImmediate(()=>streamResponse.end('<p>Complete observed evidence</p><a href="/next">Next owned page</a></body></html>'));
    return originalWait(...args);
  };
  const page=x.page,result=await x.port.observe();
  assert.equal(waits,1);assert.equal(x.port.page,page);assert.equal(x.context.pages().length,1);
  assert.equal(result.url,x.origin+'/stream');assert.equal(result.title,'Owned streaming document');
  assert.ok(result.text.includes('Complete observed evidence'));assert.deepEqual(result.links,[{text:'Next owned page',url:x.origin+'/next'}]);
  assert.equal(x.requests.filter(request=>request.url==='/stream').length,1);
  assert.ok(x.requests.every(request=>request.method==='GET'&&['/stream','/favicon.ico'].includes(request.url)));
});
