import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {initWorkSupervisor} from '../dist/work/supervisor.js';
import {WorkExecutionTools,readTextResource} from '../dist/work/execution-tools.js';
import {setSiteAuth,authSites} from '../dist/swarm/browser-auth.js';
import {workTail} from '../dist/work/activity.js';
import {browserCheckpointBinding} from '../dist/browser/executor-routing.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';

const observedAt='2026-09-29T00:00:00.000Z',query='ASTS public source 한글';
const headless={id:'unusual-headless',engine:'playwright',environment:'owned_headless',platform:process.platform,profile_ref:'public-headless',priority:80};
const guest={id:'unusual-guest',engine:'playwright',environment:'ubuntu_vm',platform:process.platform,profile_ref:'owned-guest',priority:80};
const aside={id:'unusual-aside',engine:'aside',environment:'host_foreground',platform:process.platform,profile_ref:'personal-aside',executable:'/fixture/aside',priority:20};
const neo={id:'unusual-neo',engine:'neo',environment:'host_foreground',platform:process.platform,profile_ref:'personal-neo',endpoint:'http://127.0.0.1:9010/mcp',priority:100};
const article='https://example.org/observed-asts-report';
const searchUrl=value=>{const url=new URL('https://www.google.com/search');url.searchParams.set('q',value);url.searchParams.set('num','10');return url.href;};
const observation=(url,patch={})=>({url,title:'Observed source results',text:'Fixture page with a visible source link.',links:[{text:'Observed ASTS report',url:article}],observed_at:observedAt,...patch});
const unusual=()=>observation('https://www.google.com/sorry/index',{title:'Google',text:'Our systems have detected unusual traffic from your computer network.',links:[]});
const proposal={title:'ASTS source research',desired_outcome:'Read public ASTS articles and report observed sources.',completion_checks:[{id:'sources',result:'Sources are saved',evidence:'Observed browser receipts'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],browser:{environment:'owned_headless'}};

async function setup(t,{browser=proposal.browser,requested_effect=proposal.requested_effect,prompt='Research ASTS articles',observe=(target,url)=>target.environment==='owned_headless'?unusual():observation(url),probeFail=[],download=()=>false,digest=null,workPolicy=null,marker=true}={}){
  const root=await mkdtemp(join(tmpdir(),'work-unusual-traffic-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'unusual-traffic-fixture',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true},...(workPolicy?{work:workPolicy}:{}),browser_executors:{targets:[headless,guest,aside,neo]}}));
  const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);initWorkSupervisor(store);
  const spec={...proposal,browser,requested_effect};if(browser===null)delete spec.browser;
  const model={calls:[],async call(purpose,instructions,input,schema){if(schema?.properties?.quotes){model.calls.push(input);if(!digest)throw Error('MODEL_UNAVAILABLE');return digest(input);}return structuredClone(spec);}},runtime=new WorkRuntime(store,config,model),work=await runtime.start({request_id:'unusual-work',prompt}),run=randomUUID(),events=[],instances=[];
  const api={async call(name){assert.equal(name,'runtime_pack_catalog');return {families:[{id:'research.search'}],connected:true,models:'off'};}};
  const factory=target=>{
    events.push({kind:'factory',id:target.id,engine:target.engine,environment:target.environment});let current='';
    return {target,async probe(){events.push({kind:'probe',id:target.id});if(probeFail.includes(target.id))throw Object.assign(Error('spawn ENOENT'),{code:'ENOENT'});},async open(url){current=url;events.push({kind:'open',id:target.id,url});if(download(url))throw Error('page.goto: Download is starting');},async navigate(url){current=url;events.push({kind:'navigate',id:target.id,url});},async observe(){events.push({kind:'observe',id:target.id,url:current});return observe(target,current);},async extract(){events.push({kind:'extract',id:target.id});return marker?[{marker:'fixture signed-in marker'}]:[];},async scroll(){assert.fail('Search read must not need scrolling.');},async close(){events.push({kind:'close',id:target.id});}};
  };
  const create=()=>{const tools=new WorkExecutionTools(store,config,api,work.work_id,run,work.spec,work.prompt,()=>{},model,{browserFactory:factory});instances.push(tools);return tools;};
  const seed=checkpoint=>{const stamp=new Date().toISOString();store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET checkpoint=excluded.checkpoint').run(run,config.project.id,work.work_id,work.revision,'paused',JSON.stringify(checkpoint),config.fingerprint,0,stamp,stamp);};
  const checkpoint=()=>store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(run)?.checkpoint??null;
  t.after(async()=>{for(const tools of instances)await tools.close();store.close();await rm(root,{recursive:true,force:true});});
  return {config,store,work,run,events,create,seed,checkpoint,model};
}

// This is an explicit historical contract fixture, not a native browser receipt.
function historicalCheckpoint(x,executor,{runId=x.run,effectState='none'}={}){
  return {format:1,work_id:x.work.work_id,run_id:runId,binding:'a'.repeat(64),turn:1,pending:null,summary:'Preserved historical search environment observation',observations:[{
    invocation:{request_id:'historical-search',turn:0,stage_id:'sources',tool_name:'office_web_search',arguments:{query,provider:'google'},effect:'read_only',dispatched:true},
    receipt:{status:'retryable_failure',effect_state:effectState,retry_safe:false,evidence_ids:[],value:{...unusual(),requested_url:searchUrl(query),provenance:'live_browser_dom',executor,effect:'read_only',search_provider:'google',search_access:'challenge_observed',status:'retryable_failure',reason:'WORK_SEARCH_PROVIDER_CHALLENGE'}},observed_at:observedAt,
  }]};
}
const opens=x=>x.events.filter(event=>event.kind==='open'||event.kind==='navigate');

test('runtime fixture a Work search moves observed headless unusual traffic once to Aside with the original query and skips the guest',async t=>{
  const x=await setup(t),tools=x.create(),value=await tools.execute('office_web_search',{query},'current-search'),receipt=await tools.receipt('office_web_search',value,'current-search');
  assert.deepEqual(opens(x).map(({id,url})=>({id,url})),[{id:headless.id,url:searchUrl(query)},{id:aside.id,url:searchUrl(query)}]);
  assert.ok(!x.events.some(event=>event.id===guest.id),'The same Google network block must not be repeated in the guest');
  assert.equal(value.executor,aside.id);assert.equal(value.url,searchUrl(query));assert.equal(value.requested_url,searchUrl(query));assert.equal(value.search_access,'unclassified_dom');assert.equal(value.links[0].url,article);
  assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'none');assert.deepEqual(receipt.evidence_ids,['current-search']);
  const history=workTail(x.store,x.config.project.id,x.work.work_id);
  assert.ok(history.some(event=>event.kind==='browser.failed'&&event.metadata.reason==='unusual_traffic_environment_block'));
  assert.ok(history.some(event=>event.kind==='source.observed'&&event.metadata.executor===aside.id));
});

test('runtime contract a same-run historical headless unusual-traffic receipt resumes the exact query directly in registered Aside',async t=>{
  const x=await setup(t);x.seed(historicalCheckpoint(x,headless.id));const before=x.checkpoint(),tools=x.create();
  assert.equal(tools.validate('office_web_search',{query},'resume-search').query,query);
  const value=await tools.execute('office_web_search',{query},'resume-search'),receipt=await tools.receipt('office_web_search',value,'resume-search');
  assert.deepEqual(opens(x).map(({id,url})=>({id,url})),[{id:aside.id,url:searchUrl(query)}]);
  assert.ok(x.events.filter(event=>event.kind==='factory').every(event=>event.id===aside.id),'No headless or guest instance may repeat the preserved block');
  assert.equal(value.executor,aside.id);assert.equal(receipt.status,'succeeded');assert.equal(x.checkpoint(),before,'Reading a prior receipt does not rewrite it');
});

test('runtime contract a preserved Aside search block cannot restart the same query in any environment',async t=>{
  const x=await setup(t);x.seed(historicalCheckpoint(x,aside.id));const before=x.checkpoint(),tools=x.create();
  assert.throws(()=>tools.validate('office_web_search',{query},'repeat-aside'),/WORK_SEARCH_PROVIDER_BLOCKED/u);
  await assert.rejects(tools.execute('office_web_search',{query},'repeat-aside'),/WORK_SEARCH_PROVIDER_BLOCKED/u);
  assert.deepEqual(x.events,[]);assert.equal(x.checkpoint(),before);
});

for(const restore of [false,true])test(`runtime contract report-file Work keeps browser recovery read-only (historical=${restore})`,async t=>{
  const x=await setup(t,{requested_effect:'local_file_write'});
  if(restore)x.seed(historicalCheckpoint(x,headless.id));
  const tools=x.create(),value=await tools.execute('office_web_search',{query},'report-search'),receipt=await tools.receipt('office_web_search',value,'report-search');
  assert.equal(x.work.spec.requested_effect,'local_file_write');assert.equal(value.executor,aside.id);
  assert.equal(value.effect,'read_only');assert.equal(receipt.effect_state,'none');assert.equal(receipt.status,'succeeded');
  assert.deepEqual(opens(x).map(event=>event.id),restore?[aside.id]:[headless.id,aside.id]);
  assert.ok(!x.events.some(event=>event.id===guest.id));
});

for(const pinned of [false,true])for(const uncertain of [false,true])test(`runtime contract explicit Aside revision preserves original browser checkpoint fences (pinned=${pinned}, uncertain=${uncertain})`,async t=>{
  const x=await setup(t,{browser:{environment:'host_foreground',preferred_engine:'aside'}});x.seed(historicalCheckpoint(x,headless.id));
  const entry=searchUrl(query),journal=x.store.browserExecutors(),key=`work:${x.run}:https://www.google.com:${hashJson({entry_url:entry})}`;
  const original={version:1,binding:browserCheckpointBinding(x.config,{preference:{environment:'owned_headless',...(pinned?{preferred_engine:'playwright'}:{})},request:x.work.prompt}),target_id:headless.id,entry_url:entry,url:unusual().url,completed_steps:[],effect_state:uncertain?'uncertain':'none',observation_hash:null};
  journal.saveCheckpoint(x.config.project.id,key,original);const tools=x.create();
  if(uncertain){await assert.rejects(tools.execute('office_web_search',{query},'revised-search'),/BROWSER_RECONCILIATION_REQUIRED/u);assert.deepEqual(x.events,[]);}
  else{
    const value=await tools.execute('office_web_search',{query},'revised-search');assert.equal(value.executor,aside.id);assert.deepEqual(opens(x).map(event=>event.id),[aside.id]);
    await tools.close();x.events.length=0;
    x.seed({...historicalCheckpoint(x,headless.id),observations:[]}); // Bounded trace compaction does not change the bound browser scope.
    await x.create().execute('office_web_search',{query},'revised-search-again');assert.deepEqual(opens(x).map(event=>event.id),[aside.id]);
  }
  assert.deepEqual(journal.checkpoint(x.config.project.id,key),original,'Original observation and uncertainty must not be rewritten');
});

for(const variant of ['foreign-run','uncertain'])test(`runtime contract ${variant} historical data cannot select Aside before a new verified environment observation`,async t=>{
  const x=await setup(t);x.seed(historicalCheckpoint(x,headless.id,variant==='foreign-run'?{runId:randomUUID()}:{effectState:'uncertain'}));const before=x.checkpoint(),tools=x.create();
  const value=await tools.execute('office_web_search',{query},'new-observation');
  assert.deepEqual(opens(x).map(event=>event.id),[headless.id,aside.id]);assert.equal(value.executor,aside.id);assert.equal(x.checkpoint(),before);
});

test('runtime fixture an explicit headless engine pin retains the observed block and never acquires the personal Aside profile',async t=>{
  const x=await setup(t,{browser:{environment:'owned_headless',preferred_engine:'playwright'}}),tools=x.create(),value=await tools.execute('office_web_search',{query},'pinned-search'),receipt=await tools.receipt('office_web_search',value,'pinned-search');
  assert.deepEqual(opens(x).map(event=>event.id),[headless.id]);assert.equal(value.executor,headless.id);assert.equal(value.search_access,'challenge_observed');assert.equal(receipt.status,'retryable_failure');assert.equal(receipt.retry_safe,false);assert.deepEqual(receipt.evidence_ids,[]);
});

test('runtime fixture the default public headless placement keeps authenticated social reads on the verified Aside profile',async t=>{
  const x=await setup(t,{prompt:'Read ASTS stock discussion from X and public articles',observe:(_target,url)=>observation(url,{title:'Observed ASTS social discussion'})});
  setSiteAuth(x.store,x.config,'x.com','ready',false,aside);setSiteAuth(x.store,x.config,'x.com','ready',false,neo);
  const beforeAside=authSites(x.store,x.config,aside),beforeNeo=authSites(x.store,x.config,neo),tools=x.create();
  const value=await tools.execute('office_social_search',{site:'x.com',query:'ASTS'},'social-search'),receipt=await tools.receipt('office_social_search',value,'social-search');
  assert.deepEqual(opens(x).map(event=>event.id),[aside.id]);assert.match(opens(x)[0].url,/^https:\/\/x\.com\/search\?q=ASTS/u);
  assert.equal(value.executor,aside.id);assert.equal(value.social_access,'signed_in_marker_observed');assert.equal(receipt.status,'succeeded');assert.ok(x.events.some(event=>event.kind==='extract'&&event.id===aside.id));
  assert.deepEqual(authSites(x.store,x.config,aside),beforeAside);assert.deepEqual(authSites(x.store,x.config,neo),beforeNeo);assert.deepEqual(authSites(x.store,x.config),[]);
});

// A7 regression (P5 "nodejs.org 블로그"): a site the user wrote without a scheme is
// an explicit source, and an unlisted URL is a correctable refusal before dispatch
// instead of an execution error that ended the Work after three resumes.
test('runtime fixture a scheme-less site in the request is readable and an unlisted URL is refused before dispatch',async t=>{
  const x=await setup(t,{prompt:'nodejs.org 블로그 최신 글 제목과 httpbin.org/forms/post 양식을 확인하고 Node.js와 sample.json은 이름일 뿐이다',observe:(target,url)=>observation(url)}),tools=x.create();
  for(const url of ['https://nodejs.org','https://nodejs.org/','https://httpbin.org/forms/post'])assert.doesNotThrow(()=>tools.validate('office_browser_read',{url},'user-site'),url);
  const proposed=()=>workTail(x.store,x.config.project.id,x.work.work_id).filter(event=>event.kind==='source.proposed').map(event=>event.metadata.target_url);
  assert.deepEqual(proposed(),[],'User-written sites are not model proposals.');
  for(const url of ['https://node.js/','https://sample.json/'])tools.validate('office_browser_read',{url},'name-only');
  assert.deepEqual(proposed(),['https://node.js/','https://sample.json/'],'Names such as Node.js or sample.json were not read as user-written sites; opening them is a recorded model proposal.');
  assert.throws(()=>tools.validate('office_browser_read',{url:'http://example.net/unlisted'},'unlisted'),error=>error.name==='WorkClientToolInputError'&&error.code==='BROWSER_URL_NOT_OBSERVED'&&/office_web_search/u.test(error.detail));
  assert.equal(opens(x).length,0,'Nothing is opened by validation.');
  const value=await tools.execute('office_browser_read',{url:'https://nodejs.org'},'user-site');
  assert.equal(value.url,'https://nodejs.org');assert.deepEqual(opens(x).map(event=>event.url),['https://nodejs.org']);
  assert.doesNotThrow(()=>tools.validate('office_browser_read',{url:article},'observed-link'),'A link observed on the user site becomes readable.');
});

// B5 ladder: the runtime-owned background browser reads first; a page that refuses it (bot wall, human
// check) moves the same read once to the Aside the owner registered. A normal page never touches Aside.
test('runtime fixture a public page that refuses the background browser is reread once in the registered Aside; a normal page stays headless',async t=>{
  const wall=url=>observation(url,{title:'Just a moment...',text:'Checking your browser before accessing the site.',links:[]});
  const x=await setup(t,{browser:null,prompt:'Read https://example.org/observed-asts-report',observe:(target,url)=>target.environment==='owned_headless'?wall(url):observation(url)}),tools=x.create();
  const value=await tools.execute('office_browser_read',{url:article},'walled-read');
  assert.equal(value.executor,aside.id,'The blocked read was handed to the registered Aside.');assert.equal(value.title,'Observed source results');
  assert.deepEqual(opens(x).map(({id,url})=>({id,url})),[{id:headless.id,url:article},{id:aside.id,url:article}]);
  assert.ok(!x.events.some(event=>event.id===guest.id||event.id===neo.id),'No guest or other foreground browser is tried.');
  const y=await setup(t,{browser:null,prompt:'Read https://example.org/observed-asts-report',observe:(target,url)=>observation(url)}),plain=y.create();
  assert.equal((await plain.execute('office_browser_read',{url:article},'plain-read')).executor,headless.id);
  assert.ok(!y.events.some(event=>event.id===aside.id),'A page the background browser can read never opens the owner\'s foreground browser.');
  const pinned=await setup(t,{browser:{environment:'owned_headless',preferred_engine:'playwright'},prompt:'Read https://example.org/observed-asts-report',observe:(target,url)=>wall(url)}),explicit=pinned.create();
  assert.equal((await explicit.execute('office_browser_read',{url:article},'pinned-read')).executor,headless.id,'An explicit headless engine pin never acquires the foreground browser.');
});

// Live: one link in a list of originals was a PDF. The read threw, the run restarted and lost its turn.
test('runtime fixture an address that downloads a file that is not text is a read the run cannot make, not a failed run',async t=>{
  const pdf='https://example.org/report.pdf',fetched=globalThis.fetch;t.after(()=>{globalThis.fetch=fetched;});
  globalThis.fetch=async()=>new Response('%PDF-1.7',{status:200,headers:{'content-type':'application/pdf'}});
  const x=await setup(t,{browser:null,prompt:`Read ${pdf} and ${article}`,observe:(target,url)=>observation(url),download:url=>url===pdf}),tools=x.create();
  await assert.rejects(tools.execute('office_browser_read',{url:pdf},'pdf-read'),error=>error.name==='WorkClientToolInputError'&&error.code==='WORK_RESOURCE_NOT_READABLE_TEXT'&&/another page/u.test(error.detail));
  assert.equal((await tools.execute('office_browser_read',{url:article},'next-read')).title,'Observed source results','The run keeps reading after the file it could not read.');
});

// A long article used to cost one read per 10 KB. The host now reads it whole, keeps the text and hands on a digest.
test('runtime fixture a long page is one read: its text is kept whole and the run gets a digest whose quotes the host found in the page',async t=>{
  const body=Array.from({length:400},(_,index)=>`Paragraph ${index} of the long report about launch cadence.`).join('\n')+'\nThe constellation reached 61 satellites on 2026-09-28.';
  const long=url=>observation(url,{text:body});
  const x=await setup(t,{browser:null,prompt:`Read ${article}`,observe:(target,url)=>long(url),digest:input=>({summary:`Digest of ${input.page.title}: 61 satellites on 2026-09-28.`,quotes:['The constellation reached 61 satellites on 2026-09-28.','A sentence the page never contained.'],source_links:[]})}),tools=x.create();
  const value=await tools.execute('office_browser_read',{url:article},'long-read');
  assert.equal(value.rendered.from,'page_digest');assert.equal(value.rendered.text_bytes_total,Buffer.byteLength(body));assert.equal(value.has_more,undefined,'One read covers the page.');
  assert.match(value.text,/^Digest of Observed source results/u);assert.match(value.text,/"The constellation reached 61 satellites on 2026-09-28\."/u);
  assert.doesNotMatch(value.text,/never contained/u,'A quote the page does not contain is dropped by code.');assert.deepEqual([value.rendered.quotes_found_in_page,value.rendered.quotes_not_found],[1,1]);
  assert.equal(x.model.calls[0].page.text,body,'The reader model saw the whole page.');
  assert.equal(await readFile(join(dirname(x.config.dbPath),'work-pages',x.work.work_id,`${value.rendered.text_sha256}.txt`),'utf8'),body,'The full text stays with the Work.');
  const part=await tools.execute('office_browser_read',{url:article,offset:10000},'raw-part');
  assert.equal(part.rendered,undefined);assert.equal(part.offset,10000);assert.equal(part.text,Buffer.from(body).subarray(10000,20000).toString('utf8'),'The page\'s own text is still readable by offset.');
  // A post about something published elsewhere: the digest names the original, and only an address the page links to.
  const original='https://vendor.example.com/blog/launch',post=await setup(t,{browser:null,prompt:`Read ${article}`,observe:(target,url)=>observation(url,{text:body,links:[{text:'Announcement',url:original},{text:'Home',url:'https://example.org/'}]}),digest:input=>{assert.deepEqual(input.links.map(link=>link.url),[original],'The reader is shown the links that leave the site.');return {summary:'A post about the launch.',quotes:[],source_links:[original,'https://invented.example.net/x']};}});
  const posted=await post.create().execute('office_browser_read',{url:article},'post-read');
  assert.match(posted.text,/Originals this page links to:\nhttps:\/\/vendor\.example\.com\/blog\/launch/u);assert.doesNotMatch(posted.text,/invented/u);
  const y=await setup(t,{browser:null,prompt:`Read ${article}`,observe:(target,url)=>long(url)}),plain=y.create(),fallback=await plain.execute('office_browser_read',{url:article},'no-reader');
  assert.equal(fallback.has_more,true,'Without a reader the page is read in parts as before.');assert.equal(fallback.rendered,undefined);
});

// Live: nine long pages digested one after another took 225 seconds.
// Live: digests went into the run's single app session and all but one failed; Swarm synthesis keeps its session.
test('runtime contract a page digest is a one-off call outside the run\'s session; other roles keep theirs',async()=>{
  const {ConfiguredStructuredModel}=await import('../dist/onboarding/configured-model.js');
  const bound=new ConfiguredStructuredModel('/tmp/settings.json').forWork({work_id:'work-1',run_id:'run-1'});
  assert.ok(bound.forRole('worker').sessionOptions('worker').session,'The run\'s worker keeps its session.');
  assert.ok(bound.forRole('synthesis').sessionOptions('synthesis').session,'A Swarm synthesis worker keeps its session.');
  assert.deepEqual(bound.forRole('worker').oneOff().sessionOptions('worker'),{},'A one-off read has no session.');
});
test('runtime fixture the reads of one decision are opened in order and their digests are written at the same time',async t=>{
  const body='Long page. '+'Sentence about the launch cadence of the constellation. '.repeat(400),second='https://example.org/second-report';
  let running=0,most=0;
  const digest=async input=>{running++;most=Math.max(most,running);await new Promise(done=>setTimeout(done,120));running--;return {summary:`Digest of ${input.page.url}`,quotes:['Sentence about the launch cadence of the constellation.'],source_links:[]};};
  const x=await setup(t,{browser:null,prompt:`Read ${article} and ${second}`,observe:(target,url)=>observation(url,{text:body,links:[]}),digest}),tools=x.create();
  tools.prepareReads([{tool:'office_browser_read',arguments:{url:article}},{tool:'office_browser_read',arguments:{url:second}}]);
  const first=await tools.execute('office_browser_read',{url:article},'read-1'),next=await tools.execute('office_browser_read',{url:second},'read-2');
  assert.equal(first.text.split('\n')[0],`Digest of ${article}`);assert.equal(next.text.split('\n')[0],`Digest of ${second}`);assert.equal(most,2,'Both digests were being written at once.');
  assert.deepEqual(opens(x).map(event=>event.url),[article,second],'Each page was opened once, in order.');
  const again=await tools.execute('office_browser_read',{url:article},'read-3');assert.equal(again.rendered.from,'page_digest');assert.equal(opens(x).length,3,'A later read of the same address opens the page again.');
});

// Live: X and Reddit were signed in inside the owner's Aside and the Work still stopped to ask for a sign-in,
// because nobody had pressed "Check sign-in" for those sites in this installation.
test('runtime fixture under delegation a social page is read in the registered Aside and an observed sign-in is remembered',async t=>{
  const page='https://www.reddit.com/r/ASTSpaceMobile/',request=`ASTS 주식 종목 reddit 반응을 ${page} 에서 확인해줘`;
  const x=await setup(t,{browser:null,prompt:request,observe:(target,url)=>observation(url,{title:'r/ASTSpaceMobile',text:'Posts from the community.'}),workPolicy:{model_data_approved:true,autonomy:'delegated'}}),tools=x.create();
  assert.deepEqual(authSites(x.store,x.config,aside).filter(row=>row.site==='reddit.com'),[],'Nothing was recorded for the site before.');
  const value=await tools.execute('office_browser_read',{url:page},'social-read');
  assert.equal(value.executor,aside.id);assert.equal(value.social_access,'signed_in_marker_observed');
  assert.equal(authSites(x.store,x.config,aside).find(row=>row.site==='reddit.com')?.state,'ready','The sign-in the page showed is remembered.');
  assert.ok(workTail(x.store,x.config.project.id,x.work.work_id).some(row=>row.kind==='source.signed_in'));
  const strict=await setup(t,{browser:null,prompt:request,observe:(target,url)=>observation(url)}),approved=strict.create();
  await assert.rejects(approved.execute('office_browser_read',{url:page},'social-read'),error=>/WORK_SOCIAL_PROFILE_NOT_READY/u.test(error.code??error.message),'Without the owner\'s delegation the site still needs a checked sign-in.');
});

// Live (2026-10-03): X was signed in but its posts had not been drawn yet, and Reddit, signed in inside Aside, did
// not show the account menu this host looks for. The owner was asked to sign in again to both.
test('runtime fixture a social page is given time to draw its posts, and a page that shows posts is a read without the account marker',async t=>{
  const page='https://www.reddit.com/r/ASTSpaceMobile/',request=`ASTS 주식 종목 reddit 반응을 ${page} 에서 확인해줘`;
  const posts=Array.from({length:8},(_,index)=>({text:`Post ${index}`,url:`https://www.reddit.com/r/ASTSpaceMobile/comments/${index}/`}));
  let looks=0;
  const x=await setup(t,{browser:null,prompt:request,workPolicy:{model_data_approved:true,autonomy:'delegated'},marker:false,observe:(target,url)=>{looks++;return looks<3?observation(url,{title:'Reddit',text:'Loading',links:[]}):observation(url,{title:'r/ASTSpaceMobile',text:'Retail investors discuss the latest launch. '.repeat(20),links:posts});}});
  const factory=x.create();
  // The fixture browser shows the posts on the third look and never the account menu.
  const value=await factory.execute('office_browser_read',{url:page},'social-late');
  assert.ok(looks>=3,'The page was looked at again while it was still drawing.');assert.equal(value.social_access,'content_observed');assert.equal(value.links.length,8);
  assert.equal((await factory.receipt('office_browser_read',value,'social-late')).status,'succeeded');
});

// Live (2026-10-03): a retried Work kept the earlier attempt's "sign-in not seen" for Reddit and never looked again.
test('runtime fixture a resumed run looks again at a site whose sign-in was not seen, but keeps a site\'s own refusal',async t=>{
  const page='https://www.reddit.com/r/ASTSpaceMobile/',request=`ASTS 주식 종목 reddit 반응을 ${page} 에서 확인해줘`;
  const blocked=(reason)=>({format:1,work_id:null,run_id:null,binding:'a'.repeat(64),turn:1,pending:null,summary:'earlier attempt',observations:[{
    invocation:{request_id:'social-before',turn:0,stage_id:'sources',tool_name:'office_browser_read',arguments:{url:page},effect:'read_only',dispatched:true},
    receipt:{status:'retryable_failure',effect_state:'none',retry_safe:false,evidence_ids:[],value:{status:'retryable_failure',reason,requested_url:page,observed_at:observedAt,social_site:'reddit.com',provenance:'live_browser_dom',executor:aside.id,effect:'read_only',social_access:'not_verified',text:'',links:[]}},observed_at:observedAt}]});
  for(const [reason,expectRead] of [['WORK_SOCIAL_AUTH_NOT_VERIFIED',true],['WORK_SOCIAL_CHALLENGE',false]]){
    const x=await setup(t,{browser:null,prompt:request,workPolicy:{model_data_approved:true,autonomy:'delegated'},observe:(target,url)=>observation(url,{title:'r/ASTSpaceMobile',text:'Retail investors discuss the latest launch. '.repeat(20),links:Array.from({length:8},(_,index)=>({text:`Post ${index}`,url:`${page}comments/${index}/`}))})});
    x.seed({...blocked(reason),work_id:x.work.work_id,run_id:x.run});const tools=x.create();
    if(expectRead)assert.equal((await tools.execute('office_browser_read',{url:page},'social-again')).title,'r/ASTSpaceMobile',reason);
    else await assert.rejects(tools.execute('office_browser_read',{url:page},'social-again'),/WORK_SOCIAL_PROFILE_NOT_READY/u,reason);
  }
});

// Live (2026-10-03): X's search showed "문제가 발생했습니다. 새로고침해 보세요." in one tab and worked when opened again.
test('runtime fixture a site\'s own "try reloading" page is reloaded, and social searches ask for the newest posts',async t=>{
  const page='https://x.com/search?q=ASTS&f=live',request='ASTS 주식 종목 X 반응을 '+page+' 에서 확인해줘',holder={};
  // The error page stays until the page is opened again, however long it is watched.
  const reloaded=()=>holder.x?.events.some(event=>event.kind==='navigate'&&event.url===page);
  const x=await setup(t,{browser:null,prompt:request,workPolicy:{model_data_approved:true,autonomy:'delegated'},observe:(target,url)=>!reloaded()?observation(url,{title:'X',text:'문제가 발생했습니다. 새로고침해 보세요. 다시 시도',links:[]}):observation(url,{title:'ASTS - 검색 / X',text:'Retail investors discuss the launch. '.repeat(20),links:Array.from({length:8},(_,index)=>({text:`Post ${index}`,url:`https://x.com/user/status/${index}`}))})});
  holder.x=x;const value=await x.create().execute('office_browser_read',{url:page},'x-reload');
  assert.equal(value.title,'ASTS - 검색 / X');assert.equal(opens(x).filter(event=>event.url===page).length,2,'The page was opened once and reloaded once.');
  const {socialSearchUrlForTest}=await import('../dist/work/execution-tools.js');
  assert.equal(socialSearchUrlForTest({site:'reddit.com',query:'ASTS'}),'https://www.reddit.com/search/?q=ASTS&type=posts&sort=new');
  assert.equal(socialSearchUrlForTest({site:'x.com',query:'ASTS'}),'https://x.com/search?q=ASTS&f=live');
});

// B5 (P2 live): a CSV/JSON feed URL only starts a browser download. The host
// reads such public text resources over HTTPS in bounded pages.
test('runtime contract a public text resource is read over HTTPS in pages with its hash, never through a browser download',async t=>{
  const body='time,mag,place\n2026-10-01T00:00:00Z,4.7,Somewhere\n2026-10-01T01:00:00Z,5.1,Elsewhere\n',calls=[];
  const fetcher=async(url,init)=>{calls.push({url,accept:init.headers.accept});return new Response(body,{status:200,headers:{'content-type':'text/csv; charset=utf-8'}});};
  const first=await readTextResource('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.csv',{offset:0,max_bytes:1000},fetcher);
  assert.equal(first.provenance,'http_text_resource');assert.equal(first.executor,'host_http');assert.equal(first.text,body);assert.equal(first.has_more,false);assert.equal(first.bytes_total,Buffer.byteLength(body));assert.equal(first.title,'4.5_day.csv');assert.match(first.sha256,/^[0-9a-f]{64}$/u);
  const page=await readTextResource('https://earthquake.usgs.gov/feed.csv',{offset:15,max_bytes:20},fetcher);
  assert.equal(page.text,body.slice(15,35));assert.equal(page.next_offset,35);assert.equal(page.has_more,true);
  await assert.rejects(readTextResource('http://earthquake.usgs.gov/feed.csv',{offset:0,max_bytes:1000},fetcher),/BROWSER_RESOURCE_HTTPS_REQUIRED/u);
  await assert.rejects(readTextResource('https://example.org/archive.zip',{offset:0,max_bytes:1000},async()=>new Response('x',{status:200,headers:{'content-type':'application/zip'}})),/BROWSER_RESOURCE_NOT_TEXT/u);
  await assert.rejects(readTextResource('https://example.org/missing.csv',{offset:0,max_bytes:1000},async()=>new Response('',{status:404,headers:{'content-type':'text/plain'}})),/BROWSER_RESOURCE_HTTP_ERROR/u);
  const x=await setup(t,{prompt:'Read https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.csv',observe:(target,url)=>observation(url)}),tools=x.create();
  assert.equal(tools.validate('office_browser_read',{url:'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.csv',max_bytes:5000}).max_bytes,5000,'Paging arguments are accepted.');
  assert.equal(calls.length,2,'Only the two shared-fetcher reads reached the network stub.');
});

// B5 (owner decision): a public https page the model knows for the named source may
// be opened; the host records only what the page shows. Private hosts, login sites,
// challenge pages and credential-like parameters keep the user-written/observed rule.
test('runtime fixture a model-proposed public https URL is readable and recorded; private, login, challenge and credential URLs are refused',async t=>{
  const x=await setup(t,{prompt:'USGS 지난 24시간 규모 4.5 이상 지진을 CSV로 저장해줘',observe:(target,url)=>observation(url)}),tools=x.create();
  const page='https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php';
  assert.doesNotThrow(()=>tools.validate('office_browser_read',{url:page},'proposed'));
  const value=await tools.execute('office_browser_read',{url:page},'proposed');assert.equal(value.url,page);
  assert.ok(workTail(x.store,x.config.project.id,x.work.work_id).some(event=>event.kind==='source.proposed'&&event.metadata.target_url===page),'The proposal is recorded separately from the observation.');
  for(const url of ['http://example.org/plain','https://192.168.0.1/admin','https://intranet.local/report','https://x.com/home','https://example.org/?session=abc','https://www.google.com/sorry/index']){
    assert.throws(()=>tools.validate('office_browser_read',{url},'refused'),error=>error.name==='WorkClientToolInputError'&&error.code==='BROWSER_URL_NOT_OBSERVED',url);
  }
});
