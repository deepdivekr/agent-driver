import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {OwnedPersistentPage} from '../dist/taskpack/owned-playwright.js';
import {AdaptiveBrowser} from '../dist/taskpack/adaptive-browser.js';
import {modelObservation} from '../dist/taskpack/adaptive-decision.js';
import {adaptiveLlmFromHostEnvironment,hashJson} from '../dist/taskpack/adaptive-spec.js';
import {typeSafeTransportFromHostEnvironment} from '../dist/taskpack/typesafe-jev.js';
import {runAdaptivePack} from '../dist/taskpack/adaptive-runner.js';
import {ADAPTIVE_TRAVEL_TARGETS,adaptiveTravelTask,verifyAdaptiveTravel} from '../dist/taskpacks/adaptive-travel.js';
import {startModelConnectionScreen} from '../dist/onboarding/model-screen.js';

const args=process.argv.slice(2),get=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const source=get('--source')??'both',repeat=Number(get('--repeat')??1),probe=args.includes('--probe-only'),headed=args.includes('--headed');
if(!['both','google_flights','booking'].includes(source)||!Number.isInteger(repeat)||repeat<1||repeat>3)throw Error('Usage: --source both|google_flights|booking --repeat 1..3 [--probe-only] [--headed] [--credential-file PATH]');
const output=resolve('artifacts/demos/adaptive-travel',new Date().toISOString().replaceAll(':','-').replaceAll('.','-'));
await mkdir(output,{recursive:true,mode:0o700});
const environment={...process.env};
if(get('--credential-file')){
  const file=resolve(get('--credential-file')),info=await stat(file);
  if(!info.isFile()||(process.platform!=='win32'&&(info.mode&0o077)!==0))throw Error('PRIVATE_CREDENTIAL_FILE_REQUIRED');
  const credentials=JSON.parse(await readFile(file,'utf8'));
  for(const key of ['TYPESAFE_API_KEY','OPENAI_API_KEY'])if(typeof credentials[key]==='string')environment[key]=credentials[key];
}
if(get('--openai-env-file')){
  // Reuse only the requested credential, without importing unrelated app settings.
  const values=parseEnv(await readFile(resolve(get('--openai-env-file')),'utf8'));
  const key=get('--openai-env-key')??'OPENAI_API_KEY';
  if(!['OPENAI_API_KEY','PROMPT_API_KEY'].includes(key))throw Error('UNSUPPORTED_OPENAI_ENV_KEY');
  if(values[key])environment.OPENAI_API_KEY=values[key];
}
if(args.includes('--connect-models')&&!probe&&(!environment.TYPESAFE_API_KEY||!environment.OPENAI_API_KEY)){
  const screen=await startModelConnectionScreen();
  await writeFile(join(output,'waiting.json'),JSON.stringify({status:'waiting_for_local_model_connection',pid:process.pid,started_at:new Date().toISOString(),url:screen.url,output},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:'waiting_for_local_model_connection',url:screen.url,output,pid:process.pid}));
  try {Object.assign(environment,await screen.connected);}finally{await screen.close();}
}
const missing=['TYPESAFE_API_KEY','OPENAI_API_KEY'].filter(key=>!environment[key]);
const receipts=[];
if(missing.length&&!probe){
  const receipt={status:'BLOCKED_ENV',reason:'MODEL_CREDENTIALS_UNAVAILABLE',missing,model_calls:0,browser_actions:0};
  await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({output,...receipt}));process.exitCode=2;
} else {
  const llm=probe?null:adaptiveLlmFromHostEnvironment(environment),jev=probe?null:typeSafeTransportFromHostEnvironment(environment);
  for(const target of ADAPTIVE_TRAVEL_TARGETS.filter(target=>source==='both'||target.source===source))for(let index=0;index<repeat;index++){
    const task=adaptiveTravelTask(target),root=join(output,`${target.source}-${index+1}`);
    const owned=new OwnedPersistentPage(join(root,'profile'),join(root,'captures'),!headed,{recordVideoDir:join(root,'video'),recordVideoSize:{width:1280,height:720}});
    await mkdir(root,{recursive:true,mode:0o700});const started=performance.now();let result,navigation;
    try {
      navigation=await owned.open(target.target_id,{url:task.start_url,allowed_origins:task.allowed_origins,logged_in:'body',authentication_request:'#driver-unused-auth',known_popups:[],unknown_dialog:'#driver-unused-dialog',requires_logged_in:false,navigation_timeout_ms:30000,allow_capture_failure:true});
      // Scope follows only this owned context, including any popup created by it.
      await owned.page.context().route('**/*',async route=>{
        const request=route.request();
        if(request.isNavigationRequest()&&!task.allowed_origins.includes(new URL(request.url()).origin)){await route.abort();return;}
        await route.continue();
      });
      const browser=new AdaptiveBrowser(owned.page,task);
      if(probe){
        await owned.page.waitForFunction(()=>document.querySelector('[data-testid="property-card"]')||/₩[\d,]+|verify you are human|unusual traffic|security check|access denied/iu.test(document.body.innerText),undefined,{timeout:12000}).catch(()=>undefined);
        const snapshot=await browser.observe();
        result={status:'NOT_RUN',kind:'source_probe_only',reason:'NO_MODEL_OR_ACTION_LOOP_EXECUTED',navigation,snapshot_sha256:hashJson(snapshot),title:snapshot.title,visible_text_characters:snapshot.text.length,observed_controls:snapshot.elements.length,security_gate_visible:/verify you are human|unusual traffic|security check|access denied/iu.test(snapshot.text),independent_readback:await verifyAdaptiveTravel(owned.page,target)};
      } else result=await runAdaptivePack({task,browser,jev,llm,maxCorrections:8,cacheDir:resolve('artifacts/adaptive-pack-cache'),outputDir:root,verify:()=>verifyAdaptiveTravel(owned.page,target)});
      await writeFile(join(root,'final-observation.json'),JSON.stringify(modelObservation(await browser.observe()),null,2)+'\n',{mode:0o600});
      await owned.page.screenshot({path:join(root,'final.png'),fullPage:false,timeout:8000}).catch(()=>undefined);
    } catch(error){result={status:'unobserved',reason:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'SOURCE_OR_BROWSER_UNAVAILABLE'};}
    finally {await owned.close().catch(()=>undefined);}
    const receipt={target,task,headed,probe,navigation:navigation??'unobserved',elapsed_ms:Math.round(performance.now()-started),result,video:owned.videoPath??null};receipts.push(receipt);
    await writeFile(join(root,'source-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({source:target.source,iteration:index+1,status:result.status,reason:result.reason,elapsed_ms:receipt.elapsed_ms,root}));
  }
  await writeFile(join(output,'summary.json'),JSON.stringify({format:1,receipts},null,2)+'\n',{mode:0o600});console.log(JSON.stringify({output}));
}
delete environment.TYPESAFE_API_KEY;delete environment.OPENAI_API_KEY;
