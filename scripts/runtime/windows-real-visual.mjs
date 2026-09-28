// Opt-in installed-application acceptance. No hardcoded app selectors or coordinates.
// Existing windows are read-only except explicit --allow-restore permission.
// Only separately launched windows may receive workflow input/fault injection.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {OwnedCuaConnection} from '../../dist/desktop/cua-connection.js';
import {CuaDesktopDriver} from '../../dist/desktop/cua-desktop-driver.js';
import {RuntimeApi} from '../../dist/interface/api.js';
import {loadHostConfig} from '../../dist/interface/config.js';
import {ConfiguredStructuredModel} from '../../dist/onboarding/configured-model.js';
import {modelSettingsPath} from '../../dist/onboarding/model-settings.js';

const args=process.argv.slice(2),existing=args[0]==='--inspect-existing',ownedMode=args[0]==='--owned-app';
if(process.platform!=='win32'||(!existing&&!ownedMode))throw Error('EXPLICIT_WINDOWS_ACCEPTANCE_REQUIRED');
const pidArg=existing?Number(args[1]):null,windowArg=existing?Number(args[2]):null;
const executable=realpathSync(resolve(args[existing?3:2]??''));
const option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const probe=existing||args.includes('--inspect'),prompt=option('--prompt'),settings=option('--settings');
const restore=args.includes('--allow-restore'),minimizeOwned=args.includes('--minimize-owned');
const coverOwned=args.includes('--cover-owned');
if(coverOwned&&(!ownedMode||!probe||minimizeOwned))throw Error('OWNED_COVER_PROBE_REQUIRED');
if(minimizeOwned&&(!ownedMode||!restore))throw Error('OWNED_RESTORE_FAULT_SCOPE_REQUIRED');
if(!probe&&(!prompt||!settings))throw Error('EXPLICIT_PROMPT_AND_MODEL_SETTINGS_REQUIRED');
if(existing&&(!Number.isSafeInteger(pidArg)||!Number.isSafeInteger(windowArg)||pidArg<=0||windowArg<=0))throw Error('EXACT_EXISTING_WINDOW_REQUIRED');
const root=mkdtempSync(join(tmpdir(),'agent-office-real-visual-')),started=performance.now(),sha=b=>createHash('sha256').update(b).digest('hex');
const report={evidence_level:'native_integration',status:'FAIL',executor:'owned CUA 0.30.2',application_specific_adapter:false,codex_computer_use:false,mode:probe?'read_only_observation':'live_work_navigation',stages:[],models:[],external_effects:0};
let launcher,transport,owned,cover,port,driver,db,api,model,window;
function stage(name,at,data){const row={name,elapsed_ms:Math.round(performance.now()-at),...data};report.stages.push(row);console.log(JSON.stringify(row));}
function manifestFor(pid,windowId,write){
  const text='version: 3\nexpires_after: 20m\nidle_timeout: 5m\nallow:\n  tools: [list_windows, get_window_state'+(write?', click':'')+(restore?', bring_to_front':'')+']\nresources:\n  desktop:\n    applications: ['+pid+']\n    windows:\n      - pid: '+pid+'\n        window_id: '+windowId+'\n    display: false\n';
  const path=join(root,'desktop.yaml');writeFileSync(path,text);
  return {executable,executable_sha256:sha(readFileSync(executable)),version:'0.30.2',manifest:path,manifest_sha256:sha(text),manifest_reviewed:true};
}
try{
  let pid=pidArg,windowId=windowArg;
  if(ownedMode){
    const app=realpathSync(resolve(args[1])),path=join(root,'launcher.yaml');
    writeFileSync(path,'version: 3\nexpires_after: 20m\nidle_timeout: 5m\nallow:\n  tools: [launch_app, kill_app, list_windows]\nresources:\n  apps:\n    - executable: '+app+'\n      launch: true\n      terminate: driver_launched\n      windows: all\n  desktop:\n    display: false\n');
    launcher=new Client({name:'agent-office-real-acceptance',version:'0.2.0'});
    transport=new StdioClientTransport({command:executable,args:['mcp','--direct','--no-overlay'],stderr:'pipe',env:{CUA_DRIVER_PERMISSION_MODE:'bounded',CUA_DRIVER_CAPABILITY_MANIFEST_FILE:path,CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED:'1',CUA_DRIVER_RS_TELEMETRY_ENABLED:'false',CUA_DRIVER_RS_UPDATE_CHECK:'false'}});
    transport.stderr.on('data',()=>{});await launcher.connect(transport,{timeout:15000});
    const at=performance.now(),result=await launcher.callTool({name:'launch_app',arguments:{path:app}},undefined,{timeout:15000});
    if(result.isError)throw Error('OWNED_APP_LAUNCH_REFUSED');
    owned=result.structuredContent;const windows=(owned.windows??[]).filter(w=>w.title);
    if(windows.length!==1)throw Error('OWNED_WINDOW_NOT_UNIQUE');
    pid=owned.pid;windowId=windows[0].window_id;report.application=app;stage('launch',at,{status:'ready'});
  }
  const connection=manifestFor(pid,windowId,!probe);
  port=new OwnedCuaConnection(connection,'desktop');
  const listed=await port.call('list_windows',{pid});
  const windows=Array.isArray(listed)?listed:listed.windows;
  window=windows?.find(w=>w.window_id===windowId);
  if(!window)throw Error('CURRENT_WINDOW_NOT_FOUND');
  const scope={ref:'real-app',pid,window_id:windowId,app_name:window.app_name,title:window.title,allow_window_restore:restore};
  report.initial_window={minimized:window.minimized??'unobserved',is_on_screen:window.is_on_screen??'unobserved'};
  report.window_title=existing?'redacted':window.title;
  const grant=workId=>({grant_id:'real-app-acceptance',work_id:workId,expires_at_ms:Date.now()+15*60000,effects:['navigate'],windows:[scope]});
  if(probe){
    if(coverOwned){
      const app=realpathSync(resolve(args[1]));
      const result=await launcher.callTool({name:'launch_app',arguments:{path:app}},undefined,{timeout:15000});
      if(result.isError)throw Error('OWNED_COVER_LAUNCH_FAILED');cover=result.structuredContent;
      if(cover.pid===owned.pid||cover.windows?.length!==1)throw Error('OWNED_COVER_NOT_SEPARATE');
      const h=cover.windows[0].window_id,b=window.bounds;
      if(!b||!['x','y','width','height'].every(k=>Number.isFinite(b[k])))throw Error('OWNED_COVER_BOUNDS_UNKNOWN');
      const code='Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class OwnedCoverFault { [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c); [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr w,uint command); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint p); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr w, IntPtr after, int x,int y,int cx,int cy,uint flags); }\'; [void][OwnedCoverFault]::SetThreadDpiAwarenessContext([IntPtr](-4)); [uint32]$ownerId=0; [void][OwnedCoverFault]::GetWindowThreadProcessId([IntPtr]'+h+', [ref]$ownerId); if($ownerId -ne '+cover.pid+'){throw "OWNED_PID_CHANGED"}; if(-not [OwnedCoverFault]::SetWindowPos([IntPtr]'+h+', [IntPtr]::Zero, '+[b.x-32,b.y-32,b.width+64,b.height+64].map(Math.round).join(', ')+', 64)){throw "COVER_POSITION_FAILED"}; $cursor=[IntPtr]'+windowId+'; $above=$false; for($i=0;$i -lt 512;$i++){ $cursor=[OwnedCoverFault]::GetWindow($cursor,3); if($cursor -eq [IntPtr]::Zero){break}; if($cursor -eq [IntPtr]'+h+'){ $above=$true;break } }; if(-not $above){throw "OWNED_COVER_ORDER_UNVERIFIED"}';
      const injected=spawnSync(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,timeout:10000,encoding:'utf8'});
      if(injected.status!==0)throw Error('OWNED_COVER_POSITION_FAILED');
      const coverResult=await launcher.callTool({name:'list_windows',arguments:{pid:cover.pid}},undefined,{timeout:10000});
      const coverWindow=coverResult.structuredContent?.windows?.find(w=>w.window_id===h);
      const target=(await port.call('list_windows',{pid})).windows?.find(w=>w.window_id===windowId);
      report.cover_evidence={cover:coverWindow?{bounds:coverWindow.bounds,z_index:coverWindow.z_index,is_on_screen:coverWindow.is_on_screen}:null,target:target?{bounds:target.bounds,z_index:target.z_index,is_on_screen:target.is_on_screen}:null};
      // CUA's z_index is relative to each PID-filtered inventory, not comparable
      // between processes. The native fault above independently checked order.
      if(!coverWindow||!target)throw Error('OWNED_COVER_WINDOW_MISSING');
      report.cover_evidence.order_source='native_GetWindow_previous_chain';
      const c=coverWindow.bounds,t=target.bounds;
      if(!(c.x<=t.x&&c.y<=t.y&&c.x+c.width>=t.x+t.width&&c.y+c.height>=t.y+t.height))throw Error('OWNED_COVER_OVERLAP_UNVERIFIED');
      report.injected_cover=true;
    }
    if(ownedMode){
      const raw=await port.call('get_window_state',{pid,window_id:windowId,include_screenshot:false,max_elements:256,max_depth:12});
      report.additional_uia=(raw.elements??[]).filter(e=>['CheckBox','ComboBox','Text'].includes(e.role));
      console.log(JSON.stringify({additional_uia:report.additional_uia}));
    }
    if(minimizeOwned){
      // Test fault only: enforce the launcher-owned PID/HWND before minimizing.
      // Recovery itself must pass through the product's owned CUA driver.
      if(owned?.pid!==pid)throw Error('NOT_TEST_OWNED');
      const faultScript='Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class OwnedWindowFault { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint p); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr w, int n); }\'; [uint32]$ownerId=0; [void][OwnedWindowFault]::GetWindowThreadProcessId([IntPtr]'+windowId+', [ref]$ownerId); if($ownerId -ne '+pid+'){throw "OWNED_PID_CHANGED"}; [void][OwnedWindowFault]::ShowWindow([IntPtr]'+windowId+', 6)';
      const injected=spawnSync(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',faultScript],{windowsHide:true,timeout:10000,encoding:'utf8'});
      if(injected.status!==0)throw Error('OWNED_MINIMIZE_FAILED');
      const current=await port.call('list_windows',{pid}),minimized=current.windows?.find(w=>w.window_id===windowId);
      if(minimized?.minimized!==true)throw Error('OWNED_MINIMIZE_UNVERIFIED');
      report.injected_minimized=true;
    }
    const probeId=randomUUID();db=new DatabaseSync(':memory:');driver=new CuaDesktopDriver({...connection,kind:'cua-desktop',grants:[grant(probeId)]},db,port);
    for(const observation of minimizeOwned?['visual','visual']:['auto','visual']){
      const at=performance.now();try{
        const snapshot=await driver.planningSnapshot(probeId,observation),controls=snapshot.windows[0].controls;
        const requested=(option('--labels')??'').split(',').filter(Boolean);
        const labels=existing?controls.filter(c=>requested.includes(c.label)):controls;
        stage(observation,at,{status:'observed',uia:controls.filter(c=>c.source==='uia').length,visual:controls.filter(c=>c.source==='windows_ocr').length,controls:labels.map(c=>({label:c.label,role:c.role,enabled:c.enabled,source:c.source})).slice(0,80)});
      }catch(error){
        stage(observation,at,{status:'refused',error:String(error)});
        // Read-only diagnosis, excluding UI text, pixels and private values.
        if(port.connected()){
          const raw=await port.call('get_window_state',{pid,window_id:windowId,include_accessibility_tree:false,include_screenshot:true,max_image_dimension:0});
          report.capture_metadata={keys:Object.keys(raw),...Object.fromEntries(Object.entries(raw).filter(([k])=>/^(window_bounds|capture_id|screenshot_|degraded|is_minimized|is_visible|capture_error|error|status)/u.test(k)&&!/(base64|data|image)$/u.test(k)))};
          port.takeScreenshot();console.log(JSON.stringify({capture_metadata:report.capture_metadata}));
        }
      }
    }
    if(ownedMode&&args.includes('--capture-owned')){
      await port.call('get_window_state',{pid,window_id:windowId,include_accessibility_tree:false,include_screenshot:true,max_image_dimension:0});
      const png=port.takeScreenshot();if(png){const path=join(root,'owned-app.png');writeFileSync(path,png);console.log(JSON.stringify({owned_capture:path}));}
    }
    report.diagnostics=driver.diagnostics();report.status=report.stages.filter(s=>s.name==='auto'||s.name==='visual').every(s=>s.status==='observed')?'PASS':'FAIL';
    if(minimizeOwned&&report.diagnostics.window_restores!==1)report.status='FAIL';
    if(restore){const current=await port.call('list_windows',{pid});const after=current.windows?.find(w=>w.window_id===windowId);report.final_window={minimized:after?.minimized??'unobserved',is_on_screen:after?.is_on_screen??'unobserved'};}
    report.scope='Observation and, only if explicitly allowed and needed, window restoration. No model call, draft edit or send; not successful task execution.';
  }else{
    await port.close();port=null;
    const host=join(root,'host.json'),config={schema_version:1,project_id:'real-visual-native',caller_ref:'acceptance',account_ref:'local-owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'jev_llm',model_data_approved:true,sources:[],targets:[]}};
    writeFileSync(host,JSON.stringify(config));let loaded=loadHostConfig(host);
    // Copy only the caller-selected model settings into this isolated test host.
    const selected=JSON.parse(readFileSync(resolve(settings),'utf8'));
    if(selected.selection?.mode!=='subscription'||selected.selection?.jev!=='off')throw Error('SUBSCRIPTION_JEV_OFF_ACCEPTANCE_REQUIRED');
    mkdirSync(dirname(modelSettingsPath(loaded)),{recursive:true});writeFileSync(modelSettingsPath(loaded),JSON.stringify(selected));
    model=new ConfiguredStructuredModel(modelSettingsPath(loaded));
    // Only test-owned public app labels/proposals are recorded, never existing user windows.
    const auditedModel={calls:model.calls,async call(...args){const value=await model.call(...args);if(args[2]?.capabilities){report.design_attempts??=[];report.design_attempts.push({purpose:args[0],capabilities:args[2].capabilities,proposal:value});}else if(args[2]?.candidates){report.judgment_attempts??=[];report.judgment_attempts.push({purpose:args[0],state:args[2],answer:value});}return value;}};
    api=new RuntimeApi(loaded,{swarmModel:auditedModel});
    let at=performance.now();const work=await api.call('runtime_work_start',{request_id:'real-native-first',prompt,intake_mode:'quick'});
    stage('work-definition',at,{status:work.status,route:work.spec?.route});if(work.status!=='ready'||work.spec.route.kind!=='pack')throw Error('WORK_NOT_READY');
    api.close();await api.drain();
    config.windows_executor={...connection,kind:'cua-desktop',grants:[grant(work.work_id)]};
    writeFileSync(host,JSON.stringify(config));loaded=loadHostConfig(host);api=new RuntimeApi(loaded,{swarmModel:auditedModel});
    for(let attempt=0;attempt<2;attempt++){
      at=performance.now();const planned=await api.call('runtime_windows_design',{work_id:work.work_id,observation:args.includes('--supplement-visual')?'visual':'auto'});
      stage('design-'+(attempt+1),at,{status:planned.status,reused:planned.procedure_reused});
      if(planned.status!=='planned'||planned.workflow.steps.some(s=>s.effect!=='navigate'))throw Error('NAVIGATION_ONLY_PLAN_REQUIRED');
      if(args.includes('--require-visual')&&!planned.workflow.steps.some(s=>s.desktop?.target.role==='visual'))throw Error('VISUAL_TARGET_NOT_PLANNED');
      if(attempt===0)report.plan=planned.workflow;
      let run=await api.call('runtime_windows_start',{...planned.start_arguments,request_id:'real-native-'+attempt});
      for(let i=0;i<planned.workflow.steps.length;i++){
        at=performance.now();run=await api.call('runtime_windows_step',{run_id:run.run_id,expected_revision:run.revision});
        stage('step-'+(attempt+1)+'-'+(i+1),at,{status:run.status,reason:run.reason,decider:run.receipts.at(-1)?.decision?.decider});
        if(!['ready','completed'].includes(run.status))break;
      }
      report['run_'+attempt]=run;report['diagnostics_'+attempt]=(await api.call('runtime_windows_catalog',{})).executor_diagnostics;
      if(run.status!=='completed'){
        // Owned public test window only; read-only diagnosis does not retry input.
        try{report.after_failure=await api.windows.options.driver.planningSnapshot(work.work_id);}catch{report.after_failure='unavailable';}
        throw Error('REAL_NAVIGATION_NOT_VERIFIED');
      }
      if(attempt===1&&!planned.procedure_reused)throw Error('REPEAT_NOT_REUSED');
    }
    report.status='PASS';
  }
}catch(error){report.error=String(error);}
finally{
  report.models=model?.calls.map(({purpose,provider,model,status,elapsed_ms,input_tokens,output_tokens,failure_kind})=>({purpose,provider,model,status,elapsed_ms,failure_kind,input_tokens:input_tokens??'unobserved',output_tokens:output_tokens??'unobserved'}))??[];
  report.executor_timings=api?.windows.options.driver?.port?.timings??port?.timings??[];
  api?.close();await api?.drain();await driver?.shutdown();await port?.close();db?.close();
  if(cover?.pid&&cover.pid!==owned?.pid)try{const result=await launcher.callTool({name:'kill_app',arguments:{pid:cover.pid}},undefined,{timeout:10000});report.cover_cleanup=result.isError?'unverified':'closed';}catch{report.cover_cleanup='unverified';}
  if(owned?.pid)try{const result=await launcher.callTool({name:'kill_app',arguments:{pid:owned.pid}},undefined,{timeout:10000});report.owned_window_cleanup=result.isError?'unverified':'closed';}catch{report.owned_window_cleanup='unverified';}
  else report.owned_window_cleanup='not_owned_no_input';
  await launcher?.close();await transport?.close();report.total_ms=Math.round(performance.now()-started);
  const output=join(root,'report.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,output,error:report.error,diagnostics:report.diagnostics,models:report.models,cleanup:report.owned_window_cleanup}));
  if(report.status!=='PASS')process.exitCode=1;
}
