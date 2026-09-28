// Opt-in acceptance: only a newly built/owned native canvas, no user app or send.
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadHostConfig} from '../../dist/interface/config.js';
import {RuntimeApi} from '../../dist/interface/api.js';
import {ConfiguredStructuredModel} from '../../dist/onboarding/configured-model.js';
import {modelSettingsPath,saveModelSettings} from '../../dist/onboarding/model-settings.js';

const [flag,executable]=process.argv.slice(2);
const probe=flag==='--owned-canvas-probe';
const fixtureModels=flag==='--owned-canvas-contract';
if(!['--owned-canvas','--owned-canvas-probe','--owned-canvas-contract'].includes(flag)||process.platform!=='win32'||!executable)throw Error('EXPLICIT_WINDOWS_ACCEPTANCE_REQUIRED');
const root=mkdtempSync(join(tmpdir(),'agent-office-visual-native-')),started=performance.now(),sha=b=>createHash('sha256').update(b).digest('hex');
const report={evidence_level:'native_integration',status:'FAIL',root,executor:'Agent Office RuntimeApi -> owned CUA 0.30.2 + Windows local OCR',surface:'controlled native canvas; no UIA child controls',codex_computer_use:false,external_effects:0,stages:[],models:[]};
let app,api,model;
function stage(name,at,extra){const value={name,elapsed_ms:Math.round(performance.now()-at),...extra};report.stages.push(value);console.log(JSON.stringify(value));}
console.log(JSON.stringify({stage:'start',root}));
try{
  const binary=join(root,'OwnedCanvas.exe'),source=join(dirname(fileURLToPath(import.meta.url)),'visual-owned-canvas.cs');
  execFileSync(join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:exe','/out:'+binary,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',source],{windowsHide:true,stdio:'pipe'});
  app=spawn(binary,process.argv.includes('--dpi-unaware')?['--dpi-unaware']:[],{windowsHide:true,stdio:['pipe','pipe','pipe']});app.stderr.resume();
  const identity=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('OWNED_WINDOW_TIMEOUT')),10000);let buffer='';app.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const value=JSON.parse(line);if(value.event){report.app_events??=[];report.app_events.push(value);}else{clearTimeout(timer);resolve(value);}}catch{reject(Error('OWNED_WINDOW_PROTOCOL'));}}});app.on('error',reject);});
  if(identity.pid!==app.pid)throw Error('OWNED_PID_MISMATCH');
  const host=join(root,'host.json'),config={schema_version:1,project_id:'visual-native',caller_ref:'acceptance',account_ref:'local-owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'jev_llm',model_data_approved:true,sources:[],targets:[]}};
  writeFileSync(host,JSON.stringify(config));let loaded=loadHostConfig(host);
  saveModelSettings(modelSettingsPath(loaded),{revision:0,onboarding_step:2,selection:{mode:'subscription',client:'auto',api_provider:'openai',api_model:'gpt-6-luna',api_base_url:'',api_to_subscription:false,reasoning:'low',jev:'off'}},{});
  model=new ConfiguredStructuredModel(modelSettingsPath(loaded));
  // Diagnostic only: these are synthetic labels from our owned test window.
  // Do not copy private application judgments into public acceptance reports.
  const fixturePlan={title:'Read details and return',boundary:'Two navigation actions only in owned window',completion:'Details then workspace observed',inputs:[],steps:[
    {id:'open',goal:'Open details',action:'invoke',input:null,effect:'navigate',desktop:{window_ref:'canvas',target:{label:'Open details',role:'visual'},before:[],after:[{kind:'control_present',label:'Details ready',role:'visual'}]}},
    {id:'back',goal:'Return to workspace',action:'invoke',input:null,effect:'navigate',desktop:{window_ref:'canvas',target:{label:'Return to workspace',role:'visual'},before:[],after:[{kind:'control_present',label:'Workspace ready',role:'visual'}]}}
  ]};
  const auditedModel={calls:model.calls,async call(...args){
    let value;if(fixtureModels){const input=args[2];if(input.capabilities)value=fixturePlan;else{const [key,row]=Object.entries(input.candidates).find(([,c])=>c.label.toLowerCase()===input.step.goal.toLowerCase())??['unknown',{}];value={state:'ready',target:key,evidence_quote:row.label??''};}}
    else value=await model.call(...args);
    if(args[0]==='correct'){report.target_judgments??=[];report.target_judgments.push(value);}return value;}};
  api=new RuntimeApi(loaded,{swarmModel:auditedModel});
  let at=performance.now();
  const prompt='Agent Office visual acceptance 테스트 창에서 Open details를 눌러 Details ready가 나타나는지 확인한 다음 Return to workspace를 눌러 Workspace ready 화면으로 돌아와줘. 이 창에서만 두 번의 읽기 전용 화면 이동을 하고, 파일 저장이나 메시지 전송은 하지 마.';
  const fixtureWork=probe||fixtureModels?api.store.beginWork(loaded.project.id,'probe',prompt,'quick').work:null;
  const fixtureSpec={title:'Read details',desired_outcome:prompt,completion_checks:[{id:'read',result:'Two navigation effects',evidence:'Independent local OCR'}],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',assumptions:[],questions:[],recurrence:{kind:'once',rule:null}};
  if(fixtureWork)api.store.desktopState.prepare("UPDATE office_intake SET status='ready',revision=1,spec=? WHERE work_id=?").run(JSON.stringify(fixtureSpec),fixtureWork.id);
  const work=fixtureWork?{work_id:fixtureWork.id,status:'ready',spec:fixtureSpec}:await api.call('runtime_work_start',{request_id:'canvas-first',prompt,intake_mode:'quick'});
  report.model_evidence=fixtureWork?'contract_fake':'live_subscription';
  report.work_spec=work.spec;stage('work-definition',at,{status:work.status,route:work.spec?.route});if(work.status!=='ready'||work.spec.route.kind!=='pack')throw Error('WORK_NOT_READY');
  api.close();await api.drain();api=null;
  const manifest=join(root,'visual.yaml'),content='version: 3\nexpires_after: 30m\nidle_timeout: 10m\nallow:\n  tools: [list_windows, get_window_state, click, set_value]\nresources:\n  desktop:\n    applications: ['+identity.pid+']\n    windows:\n      - pid: '+identity.pid+'\n        window_id: '+identity.window_id+'\n    display: false\n';
  writeFileSync(manifest,content);
  config.windows_executor={kind:'cua-desktop',executable:resolve(executable),executable_sha256:sha(readFileSync(executable)),version:'0.30.2',manifest,manifest_sha256:sha(content),manifest_reviewed:true,grants:[{grant_id:'owned-canvas',work_id:work.work_id,expires_at_ms:Date.now()+15*60000,effects:['navigate'],windows:[{ref:'canvas',pid:identity.pid,window_id:identity.window_id,app_name:'OwnedCanvas.exe',title:'Agent Office visual acceptance',value_encoding:'exact'}]}]};
  writeFileSync(host,JSON.stringify(config));loaded=loadHostConfig(host);api=new RuntimeApi(loaded,{swarmModel:auditedModel});
  report.owned_identity=identity;
  const ownedDriver=api.windows.options.driver,originalCall=ownedDriver.port.call.bind(ownedDriver.port),originalObserve=ownedDriver.observe.bind(ownedDriver);
  ownedDriver.port.call=async(name,args)=>{const value=await originalCall(name,args);if(name==='click'){report.clicks??=[];report.clicks.push({args,result:value});}return value;};
  ownedDriver.observe=async(job)=>{const value=await originalObserve(job);report.observations??=[];report.observations.push({labels:value.controls.map(c=>c.label),fact_keys:value.facts.map(f=>f.key)});return value;};
  if(probe){
    const driver=api.windows.options.driver;
    report.probe_uia=await driver.port.call('get_window_state',{pid:identity.pid,window_id:identity.window_id,include_screenshot:false,max_elements:256,max_depth:12,timeout_ms:1000});
    console.log(JSON.stringify({probe_uia:report.probe_uia}));
    report.probe_visual=await driver.planningSnapshot(work.work_id,'visual');console.log(JSON.stringify({probe_visual:report.probe_visual}));
    const metadata=await driver.port.call('get_window_state',{pid:identity.pid,window_id:identity.window_id,include_accessibility_tree:false,include_screenshot:true,max_image_dimension:0});
    const png=driver.port.takeScreenshot();if(png)writeFileSync(join(root,'owned-canvas.png'),png);
    console.log(JSON.stringify({capture_metadata:metadata,owned_image:join(root,'owned-canvas.png')}));
    report.scope='Read-only native observation only; fixture Work identity, zero model calls and zero input.';
  }
  for(let attempt=0;!probe&&attempt<2;attempt++){
    at=performance.now();const planned=await api.call('runtime_windows_design',{work_id:work.work_id});stage('design-'+(attempt+1),at,{status:planned.status,reused:planned.procedure_reused});
    if(planned.status!=='planned'||planned.workflow.steps.length!==2||planned.workflow.steps.some(s=>s.effect!=='navigate'||s.desktop.target.role!=='visual'))throw Error('VISUAL_PLAN_REQUIRED');
    if(attempt===0)report.plan=planned.workflow;
    let run=await api.call('runtime_windows_start',{...planned.start_arguments,request_id:'canvas-'+attempt});
    for(let i=0;i<2;i++){at=performance.now();run=await api.call('runtime_windows_step',{run_id:run.run_id,expected_revision:run.revision});stage('input-'+(attempt+1)+'-'+(i+1),at,{status:run.status,reason:run.reason,decider:run.receipts.at(-1)?.decision?.decider});if(!['ready','completed'].includes(run.status))break;}
    report['run_'+attempt]=run;report['diagnostics_'+attempt]=(await api.call('runtime_windows_catalog',{})).executor_diagnostics;
    if(run.status!=='completed')throw Error('NATIVE_VISUAL_NOT_VERIFIED');
    if(attempt===1&&!planned.procedure_reused)throw Error('VERIFIED_REPEAT_NOT_REUSED');
  }
  report.status='PASS';
}catch(error){report.error=String(error);if(probe&&process.argv.includes('--expect-dpi-refusal')&&error instanceof Error&&error.message==='CUA_VISUAL_DPI_UNVERIFIED'){report.status='PASS';report.scope='Expected refusal of DPI-unaware capture before any input; not a successful navigation.';report.guard_outcome='refused_before_input';}}
finally{
  report.executor_timings=api?.windows.options.driver?.port?.timings??[];
  report.models=model?.calls.map(({purpose,provider,model,status,elapsed_ms,input_tokens,output_tokens,failure_kind})=>({purpose,provider,model,status,elapsed_ms,failure_kind,input_tokens:input_tokens??'unobserved',output_tokens:output_tokens??'unobserved'}))??[];
  api?.close();await api?.drain();
  if(app&&app.exitCode===null&&app.signalCode===null)await new Promise(resolve=>{app.once('exit',resolve);app.kill();});
  report.owned_window_cleanup=app&&(app.exitCode!==null||app.signalCode!==null)?'closed':'unverified';report.total_ms=Math.round(performance.now()-started);
  const output=join(root,'report.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,output,stages:report.stages,error:report.error,models:report.models}));if(report.status!=='PASS')process.exitCode=1;
}
