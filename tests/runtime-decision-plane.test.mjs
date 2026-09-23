import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,link,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {choice,noul} from '@typesafe-ai/sdk';
import {DecisionPlane,DecisionProfileRegistry,FileDecisionJournal,MemoryDecisionJournal,auditDecisionJournal,buildDecisionDataset,catalogHash,decisionOperationsReport,fitDecisionCalibration,provisionalProfile,structuredModelShadowProvider} from '../dist/decision-plane/index.js';

const catalog={format:1,id:'fixture.decisions',version:'1',judgments:[
  {id:'fixture.route',primitive:'choice',risk:'reversible',question_version:'1',no_match_values:['NONE'],fallback:'llm'},
  {id:'fixture.complete',primitive:'noul',risk:'informational',question_version:'1',no_match_values:[],fallback:'continue_code'},
]};
const request={model:'jev-latest',state:{goal:'fixture',secret_not_stored:'evidence'},questions:{
  route:choice('Which current route fits?',{alpha:'First supported route.',beta:'Second supported route.',NONE:'No supplied route fits.'}),
  complete:noul('Is the bounded fixture complete?',{true:'All fixture evidence is present.',false:'Evidence is missing.'}),
}};
const answer=(route='alpha',confidence=.95,complete=.9)=>({model:'fixture-jev',answers:{route:{type:'choice',choice:route,confidence,probabilities:{alpha:route==='alpha'?confidence:(1-confidence)/2,beta:route==='beta'?confidence:(1-confidence)/2,NONE:route==='NONE'?confidence:(1-confidence)/2}},complete:{type:'noul',noul:complete}}});
const exec=promisify(execFile);

test('runtime decision plane keeps live and shadow independent and journals disagreement without authority',async()=>{
  const journal=new MemoryDecisionJournal(),profile=provisionalProfile(catalog,'jev-latest',{'fixture.route':{min_confidence:.8,min_selected_probability:.8},'fixture.complete':{noul_review_low:.2,noul_review_high:.8}});
  const primary={id:'primary',async systemOne(){return answer('alpha',.95,.9);}},shadow={id:'shadow',async systemOne(){return answer('beta',.96,.1);}};
  const plane=new DecisionPlane({catalog,profile,primary,shadow,journal,shadow_sample_rate:1}),result=await plane.evaluate(request,{context_id:'fixture-1',bindings:[{question_id:'route',decision_id:'fixture.route'},{question_id:'complete',decision_id:'fixture.complete'}]});
  assert.equal(result.judgments[0].value,'alpha');assert.equal(result.judgments[0].status,'accepted');assert.deepEqual(result.judgments[0].probabilities,{alpha:.95,beta:.025000000000000022,NONE:.025000000000000022});assert.deepEqual(result.judgments[1].probabilities,{true:.9,false:.09999999999999998});assert.deepEqual(result.event.shadow.disagreements,['route','complete']);
  assert.equal(result.event.execution_authority,false);assert.equal(result.event.approval_granted,false);assert.equal(journal.events.length,1);assert.equal(JSON.stringify(journal.events[0]).includes('secret_not_stored'),false);
});

test('runtime decision plane applies per-judgment thresholds and explicit no-match instead of forcing a choice',async()=>{
  const profile=provisionalProfile(catalog,'jev-latest',{'fixture.route':{min_confidence:.98,min_selected_probability:.98}}),provider={id:'primary',async systemOne(){return answer('alpha',.95,.9);}},plane=new DecisionPlane({catalog,profile,primary:provider});
  const reviewed=await plane.evaluate(request,{context_id:'threshold',bindings:[{question_id:'route',decision_id:'fixture.route'},{question_id:'complete',decision_id:'fixture.complete'}]});assert.equal(reviewed.judgments[0].status,'review');assert.equal(reviewed.judgments[1].status,'accepted');
  provider.systemOne=async()=>answer('NONE',1,.9);const none=await plane.evaluate(request,{context_id:'none',bindings:[{question_id:'route',decision_id:'fixture.route'},{question_id:'complete',decision_id:'fixture.complete'}]});assert.equal(none.judgments[0].status,'no_match');assert.equal(none.judgments[0].reason,'EXPLICIT_NO_MATCH');
});

test('runtime calibration fits each judgment on disjoint holdout and leaves underpowered or irreversible heads shadow-only',()=>{
  const calibrationCatalog={format:1,id:'fixture.calibration',version:'1',judgments:[
    {id:'fixture.safe',primitive:'choice',risk:'reversible',question_version:'1',no_match_values:[],fallback:'llm'},
    {id:'fixture.rare',primitive:'choice',risk:'reversible',question_version:'1',no_match_values:[],fallback:'human'},
    {id:'fixture.irreversible',primitive:'choice',risk:'irreversible',question_version:'1',no_match_values:[],fallback:'human'},
  ]};
  const rows=(prefix,decision,count,correct=true)=>Array.from({length:count},(_,i)=>({id:`${prefix}-${i}`,decision_id:decision,strength:.9,correct}));
  const train=[...rows('ts','fixture.safe',4),...rows('tr','fixture.rare',1),...rows('ti','fixture.irreversible',4)],holdout=[...rows('hs','fixture.safe',3),...rows('hr','fixture.rare',1),...rows('hi','fixture.irreversible',3)];
  const fit=fitDecisionCalibration(calibrationCatalog,'jev-latest',train,holdout,{target_precision:.4,min_train:3,min_holdout:2});
  assert.equal(fit.profile.catalog_sha256,catalogHash(calibrationCatalog));assert.equal(fit.profile.rules['fixture.safe'].execution,'live');assert.equal(fit.profile.rules['fixture.rare'].execution,'shadow_only');assert.equal(fit.profile.rules['fixture.irreversible'].execution,'shadow_only');assert.equal(fit.profile.status,'partial');
  assert.equal(fit.profile.rules['fixture.safe'].min_confidence,.9);assert.ok(fit.profile.rules['fixture.safe'].holdout_precision_lower_bound>=.4);
  const highAssurance=fitDecisionCalibration(calibrationCatalog,'jev-latest',train,holdout,{target_precision:.9,min_train:3,min_holdout:2});assert.equal(highAssurance.profile.rules['fixture.safe'].execution,'shadow_only');
  assert.throws(()=>fitDecisionCalibration(calibrationCatalog,'jev-latest',train,[train[0]],{target_precision:.9,min_train:1,min_holdout:1}),/CALIBRATION_SPLIT_LEAKAGE/);
});

test('runtime decision plane rejects catalog/profile drift, primitive drift and malformed distributions',async()=>{
  const profile=provisionalProfile(catalog,'jev-latest'),provider={id:'primary',async systemOne(){const raw=answer();raw.answers.route.probabilities.alpha=.8;return raw;}};
  assert.throws(()=>new DecisionPlane({catalog:{...catalog,version:'2'},profile,primary:provider}),/DECISION_PROFILE_CATALOG_MISMATCH/);
  const plane=new DecisionPlane({catalog,profile,primary:provider}),bad=await plane.evaluate(request,{context_id:'bad',bindings:[{question_id:'route',decision_id:'fixture.route'},{question_id:'complete',decision_id:'fixture.complete'}]});assert.equal(bad.judgments[0].status,'invalid');
  await assert.rejects(plane.evaluate(request,{context_id:'primitive',bindings:[{question_id:'complete',decision_id:'fixture.route'}]}),/DECISION_PRIMITIVE_MISMATCH/);
});

test('runtime LLM baseline is shadow-only and deterministic audit sampling is stable for the same evidence',async()=>{
  const calls=[],model={calls,async call(purpose){calls.push({purpose,model:'fixture-luna',elapsed_ms:1,input_sha256:'x',status:'accepted'});return {answers:{route:{type:'choice',value:'beta'},complete:{type:'noul',value:false}}};}},journal=new MemoryDecisionJournal(),shadow=structuredModelShadowProvider(model),profile=provisionalProfile(catalog,'jev-latest'),primary={id:'primary',async systemOne(){return answer('alpha',.95,.9);}};
  const plane=new DecisionPlane({catalog,profile,primary,shadow,journal,shadow_sample_rate:.5}),context={context_id:'stable-audit-key',bindings:[{question_id:'route',decision_id:'fixture.route'},{question_id:'complete',decision_id:'fixture.complete'}]},first=await plane.evaluate(request,context),second=await plane.evaluate(request,context);
  assert.equal(first.event.shadow.sampled,second.event.shadow.sampled);assert.equal(first.judgments[0].value,'alpha');
  if(first.event.shadow.sampled){assert.equal(first.event.shadow.judgments[0].value,'beta');assert.equal(first.event.execution_authority,false);assert.ok(calls.length>0);}
});

test('runtime decision journal binds labels to one exact judgment and excludes orphan duplicate and conflicting labels',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-driver-decisions-')),events=join(root,'events.jsonl'),journal=new FileDecisionJournal(events),profile=provisionalProfile(catalog,'jev-latest'),primary={id:'primary',async systemOne(){return answer('alpha',.96,.01);}},plane=new DecisionPlane({catalog,profile,primary,journal});
  try{
    const result=await plane.evaluate(request,{context_id:'journal-audit',bindings:[{question_id:'route',decision_id:'fixture.route'},{question_id:'complete',decision_id:'fixture.complete'}]});
    await plane.label(result.event.event_id,{question_id:'complete',decision_id:'fixture.complete',correct:true,expected:false,source:'fixture',evidence_level:'fixture',split:'train'});
    await plane.label(result.event.event_id,{question_id:'route',decision_id:'fixture.route',correct:true,expected:'alpha',source:'fixture',evidence_level:'fixture',split:'train'});
    await plane.label(result.event.event_id,{question_id:'route',decision_id:'fixture.route',correct:false,expected:'beta',source:'fixture',evidence_level:'fixture',split:'train'});
    await journal.label(randomUUID(),{question_id:'route',decision_id:'fixture.route',correct:true,source:'fixture',evidence_level:'fixture',split:'holdout'});
    const audited=await auditDecisionJournal(events);assert.equal(audited.events.length,1);assert.equal(audited.labels.length,4);assert.deepEqual(audited.valid_labels.map(item=>item.question_id),['complete']);
    assert.ok(audited.errors.some(item=>item.code==='CONFLICTING_LABEL'));assert.ok(audited.errors.some(item=>item.code==='ORPHAN_LABEL'));
    const dataset=buildDecisionDataset(catalog,'jev-latest',audited);assert.equal(dataset.examples.length,1);assert.equal(dataset.examples[0].strength,.98);assert.equal(dataset.examples[0].primitive,'noul');
    const report=decisionOperationsReport(catalog,'jev-latest',audited);assert.equal(report.journal_errors.length,2);assert.equal(report.by_decision['fixture.complete'].labeled,1);assert.equal(report.dataset_evidence,'fixture');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('runtime decision journal and activation history refuse redirected or multiply-linked files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-driver-decision-files-')),sentinel=join(root,'sentinel'),eventLink=join(root,'events.jsonl'),historyTarget=join(root,'history-target'),registryRoot=join(root,'registry');
  const one={...catalog,judgments:[catalog.judgments[0]]},rows=(prefix,count)=>Array.from({length:count},(_,i)=>({id:`${prefix}-${i}`,decision_id:'fixture.route',strength:.9,correct:true}));
  try{
    const memory=new MemoryDecisionJournal(),plane=new DecisionPlane({catalog,profile:provisionalProfile(catalog,'jev-latest'),primary:{id:'primary',async systemOne(){return answer();}},journal:memory}),evaluated=await plane.evaluate(request,{context_id:'redirect-test',bindings:[{question_id:'route',decision_id:'fixture.route'},{question_id:'complete',decision_id:'fixture.complete'}]});
    await writeFile(sentinel,'unchanged');await symlink(sentinel,eventLink);const journal=new FileDecisionJournal(eventLink);
    await assert.rejects(journal.append(evaluated.event),/ELOOP|DECISION_JOURNAL_UNSAFE/);assert.equal(await readFile(sentinel,'utf8'),'unchanged');
    const hardSource=join(root,'hard-source'),hardJournal=join(root,'hard-events.jsonl');await writeFile(hardSource,'');await link(hardSource,hardJournal);
    await assert.rejects(new FileDecisionJournal(hardJournal).append(evaluated.event),/DECISION_JOURNAL_UNSAFE/);
    const fit=fitDecisionCalibration(one,'jev-latest',rows('train',4),rows('holdout',3),{target_precision:.9,min_train:3,min_holdout:2,evidence_level:'fixture',dataset_sha256:'4'.repeat(64)}),registry=new DecisionProfileRegistry(registryRoot),installed=await registry.install(one,fit.profile,fit.report);
    await writeFile(historyTarget,'unchanged');await symlink(historyTarget,join(registryRoot,'activation-history.jsonl'));
    await assert.rejects(registry.promote(one,installed.profile_sha256,'fixture'),/ELOOP|DECISION_REGISTRY_UNSAFE/);assert.equal(await readFile(historyTarget,'utf8'),'unchanged');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('runtime decision registry content-addresses candidates, blocks fixture production promotion and rolls back atomically',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-driver-profiles-')),registry=new DecisionProfileRegistry(root),rows=(prefix,count,correct=true)=>Array.from({length:count},(_,i)=>({id:`${prefix}-${i}`,decision_id:'fixture.route',strength:.9,correct}));
  const one={...catalog,judgments:[catalog.judgments[0]]},train=rows('train',4),holdout=rows('holdout',3);
  try{
    const first=fitDecisionCalibration(one,'jev-latest',train,holdout,{target_precision:.9,min_train:3,min_holdout:2,evidence_level:'fixture',dataset_sha256:'1'.repeat(64)}),installed=await registry.install(one,first.profile,first.report);
    await assert.rejects(registry.promote(one,installed.profile_sha256,'production'),/DECISION_PROFILE_SCOPE_UNVERIFIED/);
    const active1=await registry.promote(one,installed.profile_sha256,'fixture');assert.equal(active1.profile_sha256,installed.profile_sha256);
    const second=fitDecisionCalibration(one,'jev-latest',train.map(row=>({...row,strength:.95})),holdout.map(row=>({...row,strength:.95})),{target_precision:.9,min_train:3,min_holdout:2,evidence_level:'fixture',dataset_sha256:'2'.repeat(64)}),installed2=await registry.install(one,second.profile,second.report);
    await registry.promote(one,installed2.profile_sha256,'fixture');const rolled=await registry.rollback(one,'fixture');assert.equal(rolled.profile_sha256,installed.profile_sha256);
    const status=await registry.status(one,'fixture');assert.equal(status.status,'active');assert.equal(status.evidence_level,'fixture');
    const production=fitDecisionCalibration(one,'jev-latest',train,holdout,{target_precision:.9,min_train:3,min_holdout:2,evidence_level:'user_environment',dataset_sha256:'3'.repeat(64)}),prod=await registry.install(one,production.profile,production.report);await registry.promote(one,prod.profile_sha256,'production');assert.equal((await registry.status(one,'production')).evidence_level,'user_environment');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('runtime decision operator CLI reports, fits and promotes fixture evidence without exposing production mutation through MCP',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-driver-decision-cli-')),events=join(root,'events.jsonl'),labels=join(root,'labels.jsonl'),catalogPath=join(root,'catalog.json'),registry=join(root,'registry'),journal=new FileDecisionJournal(events,labels),one={...catalog,judgments:[catalog.judgments[0]]},profile=provisionalProfile(one,'jev-latest'),primary={id:'primary',async systemOne(){return {model:'fixture-jev',answers:{route:answer('alpha',.95,.9).answers.route}};}},plane=new DecisionPlane({catalog:one,profile,primary,journal});
  try{
    await writeFile(catalogPath,JSON.stringify(one));for(let i=0;i<7;i++){const evaluated=await plane.evaluate({model:'jev-latest',state:{case:i},questions:{route:request.questions.route}},{context_id:`cli-${i}`,bindings:[{question_id:'route',decision_id:'fixture.route'}]});await plane.label(evaluated.event.event_id,{question_id:'route',decision_id:'fixture.route',correct:true,expected:'alpha',source:'fixture',evidence_level:'fixture',split:i<4?'train':'holdout'});}
    const common=['--events',events,'--labels',labels,'--catalog',catalogPath,'--model','jev-latest'],reported=JSON.parse((await exec(process.execPath,['dist/cli.js','decision','report',...common])).stdout);assert.equal(reported.events,7);assert.equal(reported.labels.train,4);assert.equal(reported.labels.holdout,3);
    const fitted=JSON.parse((await exec(process.execPath,['dist/cli.js','decision','fit','--root',registry,...common,'--target-precision','.9','--min-train','3','--min-holdout','2'])).stdout);assert.equal(fitted.candidate,true);assert.equal(fitted.evidence_level,'fixture');
    await exec(process.execPath,['dist/cli.js','decision','promote','--root',registry,'--catalog',catalogPath,'--profile',fitted.profile_sha256,'--scope','fixture']);const status=JSON.parse((await exec(process.execPath,['dist/cli.js','decision','status','--root',registry,'--catalog',catalogPath,'--scope','fixture'])).stdout);assert.equal(status.status,'active');
    await assert.rejects(exec(process.execPath,['dist/cli.js','decision','promote','--root',registry,'--catalog',catalogPath,'--profile',fitted.profile_sha256,'--scope','production']),error=>String(error.stderr).includes('DECISION_PROFILE_SCOPE_UNVERIFIED'));
  }finally{await rm(root,{recursive:true,force:true});}
});
