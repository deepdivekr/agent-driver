import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {observationScript,browserObservationSchema} from '../dist/browser/executor-contracts.js';

// Native Chromium DOM execution against synthetic, owned loopback HTML only.
// These are native_integration driver checks, not live search-provider evidence.
// No user browser/profile, model, bot, external request or persistent data is used.
const escaped=value=>String(value).replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

async function fixture(t,body,title='Owned browser observation fixture'){
  const requests=[],server=createServer((req,res)=>{
    requests.push({method:req.method,url:req.url});
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(`<!doctype html><html><head><title>${escaped(title)}</title></head><body>${body}</body></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  t.after(async()=>{
    try{await browser?.close();}
    finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
  });
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:800,height:600}});
  await page.route('**/*',route=>route.request().method()==='GET'&&new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  await page.goto(origin+'/observation',{waitUntil:'load',timeout:15000});
  const observe=async()=>browserObservationSchema.parse(await page.evaluate(`(${observationScript()})()`));
  return {page,origin,requests,observe};
}

test('runtime native browser observation excludes non-rendered or accessibility-hidden links and retains rendered links below the fold',async t=>{
  const x=await fixture(t,`
    <a href="/visible">Visible link</a>
    <a style="display:none" href="/display-none">Display-hidden link</a>
    <div style="display:none"><a href="/ancestor-display">Ancestor-display link</a></div>
    <a style="visibility:hidden" href="/visibility-hidden">Visibility-hidden link</a>
    <div style="visibility:hidden"><a href="/ancestor-visibility">Ancestor-visibility link</a></div>
    <a style="visibility:collapse" href="/collapse">Collapsed link</a>
    <a hidden href="/hidden">Hidden attribute link</a>
    <div hidden><a href="/ancestor-hidden">Ancestor-hidden link</a></div>
    <div aria-hidden="true"><a href="/ancestor-aria">Accessibility-hidden link</a></div>
    <div inert><a href="/ancestor-inert">Inert link</a></div>
    <a style="opacity:0" href="/opacity">Transparent link</a>
    <div style="opacity:0"><a href="/ancestor-opacity">Ancestor-transparent link</a></div>
    <div style="content-visibility:hidden"><a href="/content-visibility">Content-hidden link</a></div>
    <a style="display:inline-block;width:0;height:0;font-size:0;overflow:hidden" href="/zero-size">Zero-size link</a>
    <div style="height:1600px"></div><a id="below-fold" href="/below-fold">Below-fold link</a>
  `);
  assert.ok(await x.page.locator('#below-fold').evaluate(a=>a.getBoundingClientRect().top>innerHeight),'the below-fold link is rendered but outside the viewport');
  const result=await x.observe();
  assert.deepEqual(result.links,[{text:'Visible link',url:x.origin+'/visible'},{text:'Below-fold link',url:x.origin+'/below-fold'}]);
  assert.equal(result.url,x.origin+'/observation');
  assert.ok(x.requests.every(request=>request.method==='GET'));
});

test('runtime native browser observation uses rendered anchor text and exact observed hrefs without evaluating injection-like labels',async t=>{
  const literal='" ); globalThis.injected = true; // </script><img src=x onerror=globalThis.injected=true>',href='https://example.test/article?q=%22%3Cscript%3E&topic=AST%20SpaceMobile';
  const x=await fixture(t,`
    <a id="rendered-label" href="${escaped(href)}"><span>자료 source 한글</span><span hidden>HIDDEN CHILD DECOY</span><span style="display:none">ANOTHER DECOY</span></a>
    <a href="/literal">${escaped(literal)}</a>
    <a href="javascript:globalThis.injected=true">Script URL</a>
    <a href="data:text/plain,untrusted">Data URL</a>
    <a href="file:///private/local">File URL</a>
    <a href="mailto:nobody@example.test">Mail URL</a>
    <a href="/blank">   </a>
  `);
  const result=await x.observe();
  assert.deepEqual(result.links,[{text:'자료 source 한글',url:href},{text:literal,url:x.origin+'/literal'}]);
  assert.equal(await x.page.locator('#rendered-label').innerText(),'자료 source 한글');
  assert.ok(result.text.includes('자료 source 한글'));
  assert.doesNotMatch(result.text,/HIDDEN CHILD DECOY|ANOTHER DECOY/u);
  assert.equal(await x.page.evaluate(()=>typeof globalThis.injected),'undefined');
  assert.equal(x.page.url(),x.origin+'/observation','reading anchors never navigates to a linked target');
  assert.ok(x.requests.every(request=>['/observation','/favicon.ico'].includes(request.url)),'only the owned fixture document and an optional browser favicon request reach the server');
});

test('runtime native browser observation applies existing schema bounds after excluding hidden candidates',async t=>{
  const hidden=Array.from({length:125},(_,i)=>`<a style="display:none" href="/hidden-${i}">Hidden ${i}</a>`).join(''),visible=Array.from({length:130},(_,i)=>`<a href="/visible-${i}">Visible ${i}</a><br>`).join('');
  const x=await fixture(t,hidden+visible+'<a href="/long-label">'+'L'.repeat(200)+'</a><p>'+'T'.repeat(25000)+'</p>','Q'.repeat(550));
  const result=await x.observe();
  assert.equal(result.title.length,500);
  assert.equal(result.text.length,24000);
  assert.equal(result.links.length,120);
  assert.deepEqual(result.links[0],{text:'Visible 0',url:x.origin+'/visible-0'});
  assert.deepEqual(result.links.at(-1),{text:'Visible 119',url:x.origin+'/visible-119'});
  assert.ok(result.links.every(link=>!link.url.includes('/hidden-')));
  assert.deepEqual(Object.keys(result).sort(),['links','observed_at','text','title','url']);
  assert.ok(Number.isFinite(Date.parse(result.observed_at)));
  await x.page.setContent(`<a href="/long-label">${'L'.repeat(200)}</a><a href="https://example.test/${'x'.repeat(4100)}">Too-long URL</a>`);
  const longLabel=await x.observe();
  assert.deepEqual(longLabel.links,[{text:'L'.repeat(160),url:x.origin+'/long-label'}]);
});

test('runtime native browser observation does not manufacture search evidence from forty hidden links on a complete short page',async t=>{
  const decoys=Array.from({length:40},()=>'<a style="display:none" href="https://example.test/unrelated-result">Hidden unrelated result</a>').join('');
  const x=await fixture(t,`<header>Public search header</header>${decoys}<footer>Privacy and terms</footer>`,'AST SpaceMobile search');
  assert.equal(await x.page.evaluate(()=>document.readyState),'complete');
  assert.equal(await x.page.locator('a').count(),40);
  assert.equal(await x.page.locator('a').first().evaluate(a=>a.getClientRects().length),0);
  const result=await x.observe();
  assert.equal(result.title,'AST SpaceMobile search');
  assert.deepEqual(result.links,[]);
  assert.equal(result.text,'Public search header\nPrivacy and terms');
  assert.doesNotMatch(result.text,/Hidden unrelated result/u);
  assert.equal(Object.hasOwn(result,'search_complete'),false,'an observed page is not a claim of successful research');
});
