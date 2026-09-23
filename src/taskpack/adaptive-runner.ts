import {appendFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {type JevSystemOneTransport} from './typesafe-jev.js';
import {type AdaptiveTask,type StructuredModel,obtainAdaptiveSpec,promoteAdaptiveSpec,hashJson} from './adaptive-spec.js';
import {type AdaptiveAction,type AdaptiveHistory,type AdaptiveSnapshot,decideAdaptiveStep,correctAdaptiveStep,modelObservation} from './adaptive-decision.js';
import {type AdaptiveBrowser} from './adaptive-browser.js';
import {CompositeDecisionJournal,DecisionPlane,DecisionProfileRegistry,FileDecisionJournal,structuredModelShadowProvider,type DecisionCalibrationProfile,type DecisionJournal,type DecisionProfileScope,type DecisionProvider} from '../decision-plane/index.js';
import {ADAPTIVE_DECISION_CATALOG,adaptiveDecisionProfile} from './adaptive-decision.js';

export interface AdaptiveVerification {status:'MATCH'|'NOT_MATCH'|'UNKNOWN';reason:string;details:Record<string,unknown>;}
export interface AdaptiveStepRecord {step:number;snapshot_sha256:string;state:string;operation:string;target_label:string|null;decider:'jev'|'llm';observe_ms:number;jev_ms:number;llm_ms:number;action_ms:number;verify_ms:number;result:string;decision_event_id:string|null;shadow_disagreements:string[];}
export interface AdaptiveRunOptions {
  task:AdaptiveTask;browser:AdaptiveBrowser;jev?:JevSystemOneTransport;llm:StructuredModel;cacheDir:string;outputDir:string;
  verify:(snapshot:AdaptiveSnapshot)=>Promise<AdaptiveVerification>;
  maxSteps?:number;maxCorrections?:number;maxDurationMs?:number;minConfidence?:number;
  decisionPlane?:DecisionPlane;decisionProfile?:DecisionCalibrationProfile;
  shadowProvider?:DecisionProvider;shadowJev?:JevSystemOneTransport;shadowLlm?:StructuredModel;shadowSampleRate?:number;
  labelEvidenceLevel?:'fixture'|'user_environment';
  decisionJournal?:DecisionJournal;decisionRegistry?:DecisionProfileRegistry;decisionScope?:DecisionProfileScope;
}
function errorCode(error:unknown){return error instanceof Error&&/^[A-Z][A-Z_]{0,64}$/.test(error.message)?error.message:'ADAPTIVE_EXECUTION_ERROR';}
export async function runAdaptivePack(options:AdaptiveRunOptions){
  const {task,browser,jev,llm,cacheDir,outputDir,verify}=options,started=performance.now(),callsStart=llm.calls.length;
  await mkdir(outputDir,{recursive:true,mode:0o700});
  const shadow=options.shadowProvider??(options.shadowJev?{id:'shadow-system-one',systemOne:(request,settings)=>options.shadowJev!.systemOne(request,settings)}:options.shadowLlm?structuredModelShadowProvider(options.shadowLlm):undefined),fallback=options.decisionProfile??adaptiveDecisionProfile(options.minConfidence??.5),decisionRoot=join(dirname(cacheDir),'decisions'),registry=options.decisionRegistry??new DecisionProfileRegistry(join(decisionRoot,'registry')),profile=(await registry.resolve(ADAPTIVE_DECISION_CATALOG,options.decisionScope??(options.labelEvidenceLevel==='user_environment'?'production':'fixture'),fallback)).profile,fileJournal=new FileDecisionJournal(join(outputDir,'decisions.jsonl')),sharedJournal=options.decisionJournal??new FileDecisionJournal(join(decisionRoot,'adaptive.jsonl')),journal=new CompositeDecisionJournal([fileJournal,sharedJournal]);
  const plane=options.decisionPlane??(jev?new DecisionPlane({catalog:ADAPTIVE_DECISION_CATALOG,profile,primary:{id:'typesafe-jev',systemOne:(request,settings)=>jev.systemOne(request,settings)},...(shadow?{shadow}:{}),journal,shadow_sample_rate:options.shadowSampleRate??(shadow?0.1:0)}):null);
  const steps:AdaptiveStepRecord[]=[],history:AdaptiveHistory[]=[],jevCalls:Awaited<ReturnType<typeof decideAdaptiveStep>>['trace'][]=[];
  let status:'succeeded'|'blocked'|'unobserved'='unobserved',reason='ADAPTIVE_STEP_LIMIT',lastVerification:AdaptiveVerification={status:'UNKNOWN',reason:'not_run',details:{}},cacheHit=false,designMs=0,specHash:string|null=null;
  let corrections=0,repairs=0,feedback:string|null=null,prior:AdaptiveSnapshot|undefined,stagnation=0;
  try {
    const firstStarted=performance.now(),first=await browser.observe(),firstObserveMs=Math.round(performance.now()-firstStarted);
    const designStarted=performance.now(),designed=await obtainAdaptiveSpec(task,modelObservation(first),llm,cacheDir);let spec=designed.spec,specPath=designed.path;
    designMs=Math.round(performance.now()-designStarted);cacheHit=designed.cache_hit;specHash=hashJson(spec);
    for(let step=0;step<(options.maxSteps??35);step++){
      if(performance.now()-started>(options.maxDurationMs??240000)){reason='ADAPTIVE_TIME_LIMIT';break;}
      // Initial design may take seconds: its element IDs are never execution evidence.
      const observationStarted=performance.now(),snapshot=await browser.observe(),observeMs=Math.round(performance.now()-observationStarted)+(step===0?firstObserveMs:0);
      if(prior){const changed=prior.fingerprint!==snapshot.fingerprint;if(history.length)history[history.length-1]!.changed=changed;stagnation=changed?0:stagnation+1;}
      prior=snapshot;
      const decision=jev?await decideAdaptiveStep(jev,task,spec,snapshot,history,options.minConfidence??0.5,plane??undefined):null;
      if(decision)jevCalls.push(decision.trace);
      let action:AdaptiveAction|null=decision?.action??null,decider:'jev'|'llm'=decision?'jev':'llm',llmMs=0;
      const failure=feedback??(stagnation>=2?'ADAPTIVE_NO_PROGRESS':null)??decision?.trace.reason??(!jev?'JEV_SKIPPED_NOT_CONFIGURED':null)??(action?.operation==='BLOCKED'?'ADAPTIVE_BLOCKED':null);
      // A model may confuse an optional login link with a mandatory gate. Let the
      // bounded correction model review that classification; credentials/challenge
      // actions remain unavailable, and a confirmed human gate still stops below.
      if(failure){
        if(corrections>=(options.maxCorrections??4)){reason=failure;break;}
        const correctionStarted=performance.now();
        action=await correctAdaptiveStep(llm,task,spec,snapshot,history,failure);corrections++;decider='llm';
        // Extend conditions only when actual evidence disproves the current plan.
        if((stagnation>=2||feedback==='ADAPTIVE_COMPLETION_NOT_VERIFIED')&&repairs<1&&corrections<(options.maxCorrections??4)){
          const repaired=await obtainAdaptiveSpec(task,modelObservation(snapshot),llm,cacheDir,{force:true,feedback:{reason:failure,history,previous_spec:spec}});
          spec=repaired.spec;specPath=repaired.path;specHash=hashJson(spec);repairs++;action=await correctAdaptiveStep(llm,task,spec,snapshot,history,failure);corrections++;
        }
        llmMs=Math.round(performance.now()-correctionStarted);feedback=null;
      }
      if(!action){reason='ADAPTIVE_DECISION_UNAVAILABLE';break;}
      const record:AdaptiveStepRecord={step:step+1,snapshot_sha256:hashJson(snapshot),state:action.state,operation:action.operation,target_label:snapshot.elements.find(element=>element.id===action!.target_id)?.label??null,decider,observe_ms:observeMs,jev_ms:decision?.trace.elapsed_ms??0,llm_ms:llmMs,action_ms:0,verify_ms:0,result:'pending',decision_event_id:decision?.event_id??null,shadow_disagreements:decision?.shadow_disagreements??[]};
      if(action.operation==='DONE'){
        // The oracle reads current page independently, not the model's claimed success.
        const verifyStarted=performance.now();lastVerification=await verify(snapshot);record.verify_ms=Math.round(performance.now()-verifyStarted);record.result=lastVerification.status;
        if(lastVerification.status==='MATCH'){await promoteAdaptiveSpec(specPath,designed.binding,hashJson(spec));if(record.decision_event_id&&plane)await plane.label(record.decision_event_id,{question_id:'complete',decision_id:'adaptive.complete',correct:true,expected:true,source:'readback',evidence_level:options.labelEvidenceLevel??'fixture'});status='succeeded';reason='INDEPENDENT_READBACK_MATCH';}
        else {if(record.decision_event_id&&plane)await plane.label(record.decision_event_id,{question_id:'complete',decision_id:'adaptive.complete',correct:false,expected:false,source:'readback',evidence_level:options.labelEvidenceLevel??'fixture'});feedback='ADAPTIVE_COMPLETION_NOT_VERIFIED';}
      } else if(action.operation==='BLOCKED'){record.result='blocked';status='blocked';reason='ADAPTIVE_BLOCKED';}
      else {
        const actionStarted=performance.now();
        try {await browser.execute(action,spec,snapshot);record.result='executed';}
        catch(error){record.result=errorCode(error);feedback=['ADAPTIVE_STALE_TARGET','ADAPTIVE_STALE_PAGE'].includes(record.result)?null:record.result;}
        record.action_ms=Math.round(performance.now()-actionStarted);
      }
      history.push({operation:action.operation,target_label:record.target_label,state:record.state,changed:false,result:record.result});steps.push(record);
      await appendFile(join(outputDir,'journal.jsonl'),JSON.stringify(record)+'\n',{mode:0o600});
      if(status==='succeeded'||status==='blocked')break;
    }
  } catch(error){reason=errorCode(error);if(reason==='ADAPTIVE_HUMAN_GATE')status='blocked';}
  if(status!=='succeeded'){
    try {lastVerification=await verify(await browser.observe());}catch{ /* Preserve the prior observed verification, never invent a pass. */ }
  }
  const last=steps.at(-1),receipt={format:1,kind:'adaptive_readonly_pack',status,reason,task_sha256:hashJson(task),spec_sha256:specHash,cache_hit:cacheHit,design_ms:designMs,total_ms:Math.round(performance.now()-started),steps,jev:{status:jev?'configured':'skipped_not_configured'},jev_calls:jevCalls,llm_calls:llm.calls.slice(callsStart),verification:lastVerification,decision_plane:plane?{catalog:plane.catalog.id,catalog_version:plane.catalog.version,profile:plane.profile.id,profile_status:plane.profile.status,shadow_events:steps.filter(step=>step.shadow_disagreements.length>0).length}:{catalog:ADAPTIVE_DECISION_CATALOG.id,catalog_version:ADAPTIVE_DECISION_CATALOG.version,profile:'not_loaded',profile_status:'llm_direct',shadow_events:0},handoff:status==='succeeded'?null:{to:'llm_or_parent_agent',reason,last_state:last?.state??'unobserved',last_operation:last?.operation??null,decision_event_id:last?.decision_event_id??null},booking_or_payment_authorized:false};
  await writeFile(join(outputDir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});return receipt;
}
