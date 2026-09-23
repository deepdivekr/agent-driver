import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'yaml';
import {configureHermes,HERMES_AGENT_DRIVER_TOOLS,HermesElicitationApprovalDispatcher,hermesDoctor} from '../dist/integrations/hermes.js';
import {routeHumanChannelMessage} from '../dist/integrations/human-channel.js';
import {RuntimeStore} from '../dist/store/runtime-store.js';

async function temporary(t,prefix){const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('runtime contract configures Hermes MCP narrowly, preserves unrelated settings and never touches Telegram secrets',async t=>{
  const home=await temporary(t,'agent-driver-hermes-home-');
  await mkdir(home,{recursive:true});await writeFile(join(home,'config.yaml'),'# keep this comment\nmodel:\n  provider: local\nmcp_servers:\n  existing:\n    command: old\n');
  const secret='TELEGRAM_BOT_TOKEN=do-not-read-or-change\nTELEGRAM_ALLOWED_USERS=123\n';await writeFile(join(home,'.env'),secret,{mode:0o600});
  const configured=await configureHermes({home,command:'/usr/bin/node',args:['/opt/agent-driver/dist/cli.js','mcp']});assert.equal(configured.telegram_secret_touched,false);
  const configText=await readFile(join(home,'config.yaml'),'utf8'),config=parse(configText),entry=config.mcp_servers['agent-driver'];
  assert.match(configText,/keep this comment/u);assert.equal(config.model.provider,'local');assert.equal(config.mcp_servers.existing.command,'old');
  assert.deepEqual(entry.args,['/opt/agent-driver/dist/cli.js','mcp']);assert.equal(entry.sampling.enabled,true);assert.equal(entry.elicitation.enabled,true);assert.deepEqual(entry.tools.include,HERMES_AGENT_DRIVER_TOOLS);
  assert.equal(await readFile(join(home,'.env'),'utf8'),secret);assert.equal(((await stat(join(home,'config.yaml'))).mode&0o077),0);
  const doctor=hermesDoctor(home);assert.equal(doctor.agent_driver_mcp,'ready');assert.deepEqual(doctor.telegram,{token:'configured',allowed_users:'configured',allow_all:'disabled'});assert.equal(doctor.secrets_returned,false);
});

test('runtime contract routes Telegram task and intervention text with Jev but never models an approval',async()=>{
  const task=await routeHumanChannelMessage({message:'/task 연말 항공편 최저가를 찾아줘',pending:null});assert.equal(task.route,'task_request');assert.equal(task.dispatch_allowed,false);
  let called=0;const transport={async systemOne(request){called++;const pending=request.state.observed_state.pending!==null,choice=pending?'intervention_response':'task_request';const names=Object.keys(request.questions.route.parameters?.choices??{});void names;const probabilities=pending?{intervention_response:.98,task_request:.01,non_actionable:.01,UNSUPPORTED:0,CLARIFY:0}:{task_request:.98,non_actionable:.02,UNSUPPORTED:0,CLARIFY:0};return {model:'jev-test',answers:{route:{type:'choice',choice,confidence:.98,probabilities}}};}};
  const answer=await routeHumanChannelMessage({message:'도쿄로 해줘',pending:{kind:'clarification',intervention_id:'q-1'}},transport);assert.equal(answer.route,'intervention_response');assert.equal(answer.intervention_id,'q-1');assert.equal(answer.approval_granted,false);
  const approval=await routeHumanChannelMessage({message:'응 진행해',pending:{kind:'approval',intervention_id:'a-1'}},transport);assert.equal(approval.route,'approval_requires_trusted_elicitation');assert.equal(approval.approval_granted,false);assert.equal(called,1);
  const unknown=await routeHumanChannelMessage({message:'이어서 해',pending:null});assert.equal(unknown.route,'unknown');
});

test('runtime fixture Hermes elicitation binds a human accept to one exact unexpired snapshot and hides the token',async t=>{
  const root=await temporary(t,'agent-driver-hermes-approval-'),store=new RuntimeStore(join(root,'runtime.sqlite'));t.after(()=>store.close());
  const project={id:'p',callerRef:'c',worktree:root,profileRef:join(root,'profile'),accountRef:'a',allowedOrigins:['http://127.0.0.1'],capabilities:['fixture.draft.save']};store.registerProject(project);
  const created=store.createTaskProposal(project.id,'fixture.draft.save',{packId:'form.draft-submit',packVersion:1,adapterId:'fixture',callerRef:'c',normalized:{title:'review me'}}),lease=store.acquire(created.task.id,'approval-test','target');
  const requested=store.requestProposalApproval(created.task.id,{title:'review me'},Date.now()+60_000);store.release(lease);
  let prompt='';const dispatcher=new HermesElicitationApprovalDispatcher(store,{async elicitInput(params){prompt=params.message;return {action:'accept',content:{approved:true}};}});
  const opened=await dispatcher.deliver({...requested,capture_ref:join(root,'capture.png'),timing:[]});assert.equal(opened.opened,true);assert.equal(store.proposal(created.task.id).state,'approved');assert.match(prompt,/review me/u);assert.equal(prompt.includes(requested.approval_token),false);
  await assert.rejects(dispatcher.deliver({...requested,capture_ref:'x',timing:[]}),/APPROVAL_NOT_PENDING|APPROVAL_TOKEN/u);
});

test('runtime fixture Hermes decline cancels while cancel/expired callbacks grant no authority',async t=>{
  const root=await temporary(t,'agent-driver-hermes-reject-'),store=new RuntimeStore(join(root,'runtime.sqlite'));t.after(()=>store.close());
  const project={id:'p',callerRef:'c',worktree:root,profileRef:join(root,'profile'),accountRef:'a',allowedOrigins:['http://127.0.0.1'],capabilities:['fixture.draft.save']};store.registerProject(project);
  const prepare=(id,expiry)=>{const made=store.createTaskProposal(project.id,'fixture.draft.save',{packId:'form.draft-submit',packVersion:1,adapterId:'fixture',callerRef:'c',normalized:{id}}),lease=store.acquire(made.task.id,`approval-${id}`,`target-${id}`),requested=store.requestProposalApproval(made.task.id,{id},expiry);store.release(lease);return {...requested,capture_ref:'x',timing:[]};};
  const declined=prepare('decline',Date.now()+60_000),dispatcher=new HermesElicitationApprovalDispatcher(store,{async elicitInput(){return {action:'decline'};}});await dispatcher.deliver(declined);assert.equal(store.task(declined.task_id).status,'cancelled');assert.equal(store.proposal(declined.task_id).state,'invalidated');
  const cancelled=prepare('cancel',Date.now()+60_000),dismissed=new HermesElicitationApprovalDispatcher(store,{async elicitInput(){return {action:'cancel'};}});await dismissed.deliver(cancelled);assert.equal(store.proposal(cancelled.task_id).state,'waiting_approval');
  const preparedExpiry=prepare('expired',Date.now()+60_000),expired={...preparedExpiry,expires_at_ms:Date.now()-1};let calls=0;const stale=new HermesElicitationApprovalDispatcher(store,{async elicitInput(){calls++;return {action:'accept',content:{approved:true}};}});assert.equal((await stale.deliver(expired)).opened,false);assert.equal(calls,0);assert.equal(store.proposal(expired.task_id).state,'waiting_approval');
});
