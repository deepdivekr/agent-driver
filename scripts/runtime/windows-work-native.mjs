// Explicit opt-in native acceptance. Only the newly launched Character Map
// window is touched; no clipboard button, file, message or user window is used.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {loadHostConfig} from '../../dist/interface/config.js';
import {RuntimeApi} from '../../dist/interface/api.js';
import {ConfiguredStructuredModel} from '../../dist/onboarding/configured-model.js';
import {modelSettingsPath,saveModelSettings} from '../../dist/onboarding/model-settings.js';

const [flag,cuaExecutable]=process.argv.slice(2);
if(flag!=='--owned-character-map'||process.platform!=='win32'||!cuaExecutable)throw Error('EXPLICIT_WINDOWS_ACCEPTANCE_REQUIRED');
const root=mkdtempSync(join(tmpdir(),'agent-office-work-native-')),started=performance.now(),sha=b=>createHash('sha256').update(b).digest('hex');
const report={evidence_level:'native_integration',status:'FAIL',root,executor:'Agent Office RuntimeApi -> owned CUA 0.30.2',codex_computer_use:false,stages:[],model_calls:[],external_effects:0};
const launcherManifest=join(root,'launcher.yaml');
writeFileSync(launcherManifest,'version: 3\nexpires_after: 30m\nidle_timeout: 10m\nallow:\n  tools: [launch_app, kill_app, list_windows]\nresources:\n  apps:\n    - executable: C:\\Windows\\System32\\charmap.exe\n      launch: true\n      terminate: driver_launched\n      windows: all\n  desktop:\n    display: false\n');
const launch=new Client({name:'agent-office-owned-acceptance',version:'0.2.0'}),transport=new StdioClientTransport({command:resolve(cuaExecutable),args:['mcp','--direct','--no-overlay'],stderr:'pipe',env:{CUA_DRIVER_PERMISSION_MODE:'bounded',CUA_DRIVER_CAPABILITY_MANIFEST_FILE:launcherManifest,CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED:'1',CUA_DRIVER_RS_TELEMETRY_ENABLED:'false',CUA_DRIVER_RS_UPDATE_CHECK:'false'}});
transport.stderr.on('data',()=>{});
let api,model,owned;
function record(stage,at,result){report.stages.push({stage,elapsed_ms:Math.round(performance.now()-at),...result});console.log(JSON.stringify(report.stages.at(-1)));}
try{
  await launch.connect(transport,{timeout:15000});
  const result=await launch.callTool({name:'launch_app',arguments:{path:'C:\\Windows\\System32\\charmap.exe'}},undefined,{timeout:15000});
  if(result.isError)throw Error('OWNED_APP_LAUNCH_FAILED');
  owned=result.structuredContent;const window=owned.windows?.find(w=>w.title==='문자표'||w.title==='Character Map');if(!window)throw Error('OWNED_WINDOW_UNAVAILABLE');
  const host=join(root,'host.json'),config={schema_version:1,project_id:'work-native',caller_ref:'acceptance',account_ref:'local-owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'jev_llm',model_data_approved:true,sources:[],targets:[]}};
  writeFileSync(host,JSON.stringify(config));let loaded=loadHostConfig(host);
  saveModelSettings(modelSettingsPath(loaded),{revision:0,onboarding_step:2,selection:{mode:'subscription',client:'auto',api_provider:'openai',api_model:'gpt-6-luna',api_base_url:'',api_to_subscription:false,reasoning:'low',jev:'off'}},{});
  model=new ConfiguredStructuredModel(modelSettingsPath(loaded));api=new RuntimeApi(loaded,{swarmModel:model});
  let at=performance.now();console.log(JSON.stringify({stage:'work-definition-start',root}));
  const work=await api.call('runtime_work_start',{request_id:'native-first',prompt:'Windows 문자표에서 복사할 문자 입력칸에 Agent Office generic draft라는 글자만 입력해줘. 선택·복사·클립보드 버튼을 누르거나 전송하지 말고 입력 상태만 확인해.',intake_mode:'quick'});
  record('work-definition',at,{status:work.status});if(work.status!=='ready'||work.spec.route.pack_family!=='form.draft-submit')throw Error('WORK_NOT_READY_FOR_NATIVE_DRAFT');
  api.close();await api.drain();api=null;
  const manifest=join(root,'desktop.yaml'),contents='version: 3\nexpires_after: 30m\nidle_timeout: 10m\nallow:\n  tools: [list_windows, get_window_state, click, set_value]\nresources:\n  desktop:\n    applications: ['+owned.pid+']\n    windows:\n      - pid: '+owned.pid+'\n        window_id: '+window.window_id+'\n    display: false\n';
  writeFileSync(manifest,contents);
  config.windows_executor={kind:'cua-desktop',executable:resolve(cuaExecutable),executable_sha256:sha(readFileSync(cuaExecutable)),version:'0.30.2',manifest,manifest_sha256:sha(contents),manifest_reviewed:true,
    grants:[{grant_id:'owned-native-draft',work_id:work.work_id,expires_at_ms:Date.now()+10*60000,effects:['navigate','local_draft'],windows:[{ref:'owned-window',pid:owned.pid,window_id:window.window_id,app_name:window.app_name??'charmap.exe',title:window.title,value_encoding:'uia_single_line_document'}]}]};
  writeFileSync(host,JSON.stringify(config));loaded=loadHostConfig(host);api=new RuntimeApi(loaded,{swarmModel:model});
  at=performance.now();console.log(JSON.stringify({stage:'generic-design-start'}));
  const planned=await api.call('runtime_windows_design',{work_id:work.work_id});record('generic-design',at,{status:planned.status,procedure_reused:planned.procedure_reused});
  if(planned.status!=='planned')throw Error('GENERIC_PLAN_NOT_CREATED');
  report.plan=planned.workflow;let run=await api.call('runtime_windows_start',planned.start_arguments);
  for(let i=0;i<planned.workflow.steps.length;i++){at=performance.now();run=await api.call('runtime_windows_step',{run_id:run.run_id,expected_revision:run.revision});record('native-step',at,{status:run.status,reason:run.reason});if(!['ready','completed'].includes(run.status))break;}
  report.run=run;report.diagnostics=(await api.call('runtime_windows_catalog',{})).executor_diagnostics;
  if(run.status!=='completed')throw Error('NATIVE_EFFECT_NOT_VERIFIED');
  at=performance.now();const repeat=await api.call('runtime_windows_design',{work_id:work.work_id});record('repeat-design',at,{procedure_reused:repeat.procedure_reused});
  report.status=repeat.procedure_reused?'PASS':'FAIL';
}catch(error){report.error=String(error);}
finally{
  report.model_calls=model?.calls.map(({purpose,provider,model,status,elapsed_ms,input_tokens,output_tokens,failure_kind})=>({purpose,provider,model,status,elapsed_ms,failure_kind,input_tokens:input_tokens??'unobserved',output_tokens:output_tokens??'unobserved'}))??[];
  api?.close();await api?.drain();
  if(owned?.pid)try{const closed=await launch.callTool({name:'kill_app',arguments:{pid:owned.pid}},undefined,{timeout:10000});report.owned_window_cleanup=closed.isError?'unverified':'closed';}catch{report.owned_window_cleanup='unverified';}
  await launch.close();await transport.close();report.total_ms=Math.round(performance.now()-started);
  const output=join(root,'report.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,output,stages:report.stages,model_calls:report.model_calls,error:report.error}));if(report.status!=='PASS')process.exitCode=1;
}
