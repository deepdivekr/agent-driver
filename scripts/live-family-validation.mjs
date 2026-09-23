// Opt-in real-web validation. All execution goes through the stdio MCP server.
// No fixture service, direct page control, submission or external notification.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(process.argv[2]??join(repo,'.runtime',`live-families-${Date.now()}`));
await mkdir(out,{recursive:true,mode:0o700});
const configPath=join(out,'host.json'),dataPath=join(out,'news.json');
const receipts=[],started=Date.now();
const fields=Object.fromEntries(['firstName','lastName','email','jobTitle','companyName','helpOption','project'].map(name=>[name,{selector:`#contactForm-${name}`,kind:name==='helpOption'?'select':'text'}]));
const hn={id:'hn',kind:'browser',url:'https://news.ycombinator.com/',parameters:[],rows:'tr.athing',columns:{title:'.titleline > a',rank:'.rank'},ready:'.hnname',auth_gate:'form[action="login"]',auth_required:false,account_selector:'.hnname',account_text:'Hacker News'};
const target={id:'public-contact-draft',family:'form.draft-submit',action:'submit_form',effect_boundary:'single_form_submission',url:'https://www.browserbase.com/contact',draft_is_local:true,draft_only:true,auth_required:false,ready:'#contactForm-firstName',auth_gate:'form[action="login"]',account_selector:'h1',account_text:'Connect with Browserbase',fields,identity_field:'email',submit:'form button[type="submit"]',readback_url:null,identity_parameter:'email',known_popups:[]};
await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'public-live-validation',caller_ref:'release-validator',account_ref:'public-anonymous-draft-only',worktree:out,data_dir:join(out,'runtime'),environment:'production',packs:{models:process.env.TYPESAFE_API_KEY?'jev':'off',model_data_approved:Boolean(process.env.TYPESAFE_API_KEY),sources:[hn,{id:'saved-news',kind:'file',path:dataPath,format:'json'}],targets:[target]}}),{mode:0o600});
let client;
async function connect(){client=new Client({name:'agent-driver-real-case-validation',version:'1'});const transport=new StdioClientTransport({command:process.execPath,args:[join(repo,'dist/cli.js'),'mcp','--config',configPath],env:Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string')),stderr:'pipe'});await client.connect(transport);}
async function call(name,args){const begin=Date.now(),response=await client.callTool({name,arguments:args},undefined,{timeout:180000});const value=JSON.parse(response.content[0].text);receipts.push({tool:name,request_id:args.request_id??null,started_at:new Date(begin).toISOString(),elapsed_ms:Date.now()-begin,is_error:response.isError===true,response:value});console.log(JSON.stringify({tool:name,elapsed_ms:Date.now()-begin,status:value.status??(response.isError?'error':'ok')}));await writeFile(join(out,'receipts.json'),JSON.stringify(receipts,null,2));if(response.isError)throw Error(value.error);return value;}
const common=(family,request,source='hn')=>({version:1,family,request,sources:[{id:source,parameters:{}}],filters:[],deduplicate_by:['title']});
try{
  await connect();
  await call('runtime_pack_plan',{prompt:'Collect current public technology headlines, find AI items, triage a few locally, export a CSV and watch for changes. Prepare but never submit a public contact form.'});
  const collect=await call('runtime_pack_run',{request_id:'collect-public-news',recipe:{...common('portal.collect','Download current public technology headlines'),format:'json'}});
  assert.equal(collect.status,'succeeded');const original=await readFile(collect.result.artifact.path);const rows=JSON.parse(original);assert.ok(rows.length>=5);assert.equal(createHash('sha256').update(original).digest('hex'),collect.result.artifact.sha256);
  // Real runtime output is the next family's local input, never invented records.
  await copyFile(collect.result.artifact.path,dataPath);
  const search=await call('runtime_pack_run',{request_id:'search-ai-news',recipe:{...common('research.search','Find AI-related headlines','saved-news'),query:'AI',search_fields:['title'],sort:null,limit:10,relevance:null}});assert.equal(search.status,'succeeded');
  const pipeline=await call('runtime_pack_run',{request_id:'export-news-csv',recipe:{...common('file.pipeline','Create a portable headline CSV','saved-news'),columns:['rank','title'],numeric_columns:[],sort:null,format:'csv'}});assert.equal(pipeline.status,'succeeded');assert.equal(pipeline.result.artifact.rows,rows.length);
  const watch=await call('runtime_pack_run',{request_id:'watch-public-news',recipe:{...common('monitor.watch','Watch the public headline list'),interval_seconds:60,mode:'any_change',value_field:null,comparison_fields:['rank','title']}});assert.equal(watch.status,'watching');
  const triage=await call('runtime_pack_run',{request_id:'triage-headlines',recipe:{...common('inbox.triage','Triage the first public news item without sending anything','saved-news'),filters:[{field:'rank',op:'eq',value:rows[0].rank}],judgment:{question:'Classify the news title by explicit subject only. AI includes language models or AI products; software means other developer software; other means other explicit topics. No invented article-body knowledge.',labels:{ai:'The title explicitly concerns AI, language models or an AI product.',software:'The title explicitly concerns developer software unrelated to AI.',other:'Another explicitly described topic.'}},draft_by_label:{ai:'Saved for AI news review.',software:'Saved for software review.',other:'Saved for general review.'}}});assert.ok(['succeeded','needs_review'].includes(triage.status));assert.equal(triage.result.external_messages_sent,0);
  const form=await call('runtime_pack_run',{request_id:'public-contact-fill-only',recipe:{version:1,family:'form.draft-submit',request:'Prepare a contact draft only; never submit.',target:target.id,values:{firstName:'Agent',lastName:'Driver',email:'demo@example.com',jobTitle:'Open-source maintainer',companyName:'Agent Driver',helpOption:'other',project:'Local form-filling validation for an open-source agent runtime. This is an unsent demonstration draft.'},expected_before_sha256:null}});assert.equal(form.status,'draft_ready');assert.equal(form.result.external_submit,false);
  await copyFile(form.result.capture_ref,join(out,'contact-draft.png'));
  const submission=await client.callTool({name:'runtime_pack_execute_approved',arguments:{run_id:form.run_id}});assert.equal(submission.isError,true);assert.equal(JSON.parse(submission.content[0].text).error,'PACK_DRAFT_ONLY');
  await client.close();await connect();
  const reopened=await call('runtime_pack_status',{run_id:watch.run_id});assert.equal(reopened.status,'watching');
  // Pause after verifying persistence; this validation does not schedule ongoing work.
  await call('runtime_pack_watch_pause',{run_id:watch.run_id,paused:true});
  const duplicate=await call('runtime_pack_run',{request_id:'collect-public-news',recipe:{...common('portal.collect','Download current public technology headlines'),format:'json'}});assert.equal(duplicate.run_id,collect.run_id);assert.equal(duplicate.deduplicated,true);
  const summary={status:'PASS',observed_at:new Date().toISOString(),transport:'stdio_mcp',environment:'production',elapsed_ms:Date.now()-started,source_url:hn.url,rows:rows.length,search_matches:search.result.rows.length,csv_rows:pipeline.result.artifact.rows,triage:triage.result.items.map(x=>({label:x.label,decider:x.decider,confidence:x.confidence,elapsed_ms:x.elapsed_ms})),triage_status:triage.status,form:{url:target.url,status:form.status,fields:7,submitted:false,execute_guard:'PACK_DRAFT_ONLY',capture:'contact-draft.png'},watch:{persisted_across_mcp_restart:true,paused:true,change_event:'NOT_RUN'},duplicates:{same_run_id:true},limitations:['Read-only public source, not authenticated portal validation.','Triage result is observed model output, not accuracy calibration.','Form fill-only; no submission, record update or cart effect.','No full-workflow natural-language autonomous planning benchmark.']};
  await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({at:new Date().toISOString(),error:error instanceof Error?error.message:'UNKNOWN',elapsed_ms:Date.now()-started},null,2));throw error;}
finally{await client?.close();}
