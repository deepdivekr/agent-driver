import {randomUUID} from 'node:crypto';
import {type SystemOneRequest} from '@typesafe-ai/sdk';
import {type JevSystemOneTransport} from '../taskpack/typesafe-jev.js';
import {assertProfileForCatalog,catalogHash,decisionBindingSchema,decisionCalibrationProfileSchema,decisionCatalogSchema,decisionHash,type DecisionBinding,type DecisionCalibrationProfile,type DecisionCatalog,type DecisionEvent,type DecisionJudgment,type DecisionProviderTrace,type DecisionShadowSummary} from './contracts.js';
import {type DecisionJournal} from './journal.js';

export interface DecisionProvider {id:string;systemOne:JevSystemOneTransport['systemOne'];}
export interface DecisionPlaneOptions {catalog:DecisionCatalog;profile:DecisionCalibrationProfile;primary:DecisionProvider;shadow?:DecisionProvider;journal?:DecisionJournal;shadow_sample_rate?:number;timeout_ms?:number;}
export interface DecisionBatchContext {context_id:string;bindings:DecisionBinding[];force_shadow?:boolean;}
export interface DecisionBatchResult {event:DecisionEvent;raw:unknown;judgments:DecisionJudgment[];}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
function distribution(raw:unknown,keys:string[]){
  if(typeof raw!=='object'||raw===null||Array.isArray(raw))throw Error('DECISION_DISTRIBUTION_INVALID');const record=raw as Record<string,unknown>;
  if(Object.keys(record).length!==keys.length||keys.some(key=>!finite(record[key])))throw Error('DECISION_DISTRIBUTION_INVALID');
  const values=keys.map(key=>record[key] as number);if(Math.abs(values.reduce((a,b)=>a+b,0)-1)>=.03)throw Error('DECISION_DISTRIBUTION_INVALID');return record as Record<string,number>;
}
function criteriaKeys(question:Record<string,unknown>){
  const criteria=question.criteria;if(Array.isArray(criteria))return criteria.map((_,index)=>String(index));
  if(typeof criteria==='object'&&criteria!==null)return Object.keys(criteria);return [];
}
function decode(raw:unknown,question:Record<string,unknown>,definition:DecisionCatalog['judgments'][number],profile:DecisionCalibrationProfile):DecisionJudgment{
  const base={question_id:'',decision_id:definition.id,primitive:definition.primitive,threshold:{confidence:profile.rules[definition.id]!.min_confidence,selected_probability:profile.rules[definition.id]!.min_selected_probability,noul_review_low:profile.rules[definition.id]!.noul_review_low,noul_review_high:profile.rules[definition.id]!.noul_review_high},fallback:definition.fallback,risk:definition.risk};
  const rule=profile.rules[definition.id]!;
  try{
    if(typeof raw!=='object'||raw===null||Array.isArray(raw))throw Error('answer');const answer=raw as Record<string,unknown>;
    if(definition.primitive==='noul'){
      if(answer.type!=='noul'||!finite(answer.noul))throw Error('noul');const value=answer.noul as number,status=rule.execution==='shadow_only'?'shadow_only':value>rule.noul_review_low&&value<rule.noul_review_high?'review':'accepted';
      return {...base,status,value,confidence:null,selected_probability:value,reason:status==='review'?'NOUL_AMBIGUOUS':status==='shadow_only'?'PROFILE_SHADOW_ONLY':null};
    }
    const keys=criteriaKeys(question),kind=definition.primitive==='choice'?'choice':'score';if(answer.type!==kind||!finite(answer.confidence))throw Error(kind);
    const probs=distribution(answer.probabilities,keys);let value:string|number,selectedProbability:number;
    if(kind==='choice'){
      if(typeof answer.choice!=='string'||!keys.includes(answer.choice))throw Error('choice');value=answer.choice;selectedProbability=probs[answer.choice]!;
      if(selectedProbability<Math.max(...Object.values(probs))-1e-6)throw Error('choice peak');
    }else{
      if(typeof answer.score!=='number'||!Number.isFinite(answer.score))throw Error('score');value=answer.score;selectedProbability=Math.max(...Object.values(probs));
    }
    const confidence=answer.confidence as number,noMatch=kind==='choice'&&definition.no_match_values.includes(String(value));
    const status=noMatch?'no_match':rule.execution==='shadow_only'?'shadow_only':confidence<rule.min_confidence||selectedProbability<rule.min_selected_probability?'review':'accepted';
    return {...base,status,value,confidence,selected_probability:selectedProbability,reason:noMatch?'EXPLICIT_NO_MATCH':status==='review'?'BELOW_CALIBRATED_THRESHOLD':status==='shadow_only'?'PROFILE_SHADOW_ONLY':null};
  }catch{return {...base,status:'invalid',value:null,confidence:null,selected_probability:null,reason:'INVALID_TYPED_ANSWER'};}
}
function unavailable(questionId:string,definition:DecisionCatalog['judgments'][number],profile:DecisionCalibrationProfile):DecisionJudgment{
  const rule=profile.rules[definition.id]!;return {question_id:questionId,decision_id:definition.id,primitive:definition.primitive,status:'unavailable',value:null,confidence:null,selected_probability:null,threshold:{confidence:rule.min_confidence,selected_probability:rule.min_selected_probability,noul_review_low:rule.noul_review_low,noul_review_high:rule.noul_review_high},fallback:definition.fallback,risk:definition.risk,reason:'PROVIDER_UNAVAILABLE'};
}
function shouldSample(hash:string,rate:number){if(rate<=0)return false;if(rate>=1)return true;return Number.parseInt(hash.slice(0,8),16)/0xffffffff<rate;}
async function call(provider:DecisionProvider,request:SystemOneRequest,inputHash:string,timeout:number){const started=performance.now();try{const raw=await provider.systemOne(request,{timeout,retry:{maxRetries:0}}),record=raw as {model?:unknown};return {raw,trace:{provider:provider.id,model:typeof record?.model==='string'?record.model:'unobserved',elapsed_ms:Math.round(performance.now()-started),input_sha256:inputHash,status:'accepted'} satisfies DecisionProviderTrace};}catch{return {raw:null,trace:{provider:provider.id,model:'unobserved',elapsed_ms:Math.round(performance.now()-started),input_sha256:inputHash,status:'unavailable'} satisfies DecisionProviderTrace};}}

export class DecisionPlane {
  readonly catalog:DecisionCatalog;readonly profile:DecisionCalibrationProfile;readonly catalogSha:string;readonly profileSha:string;readonly rate:number;
  constructor(readonly options:DecisionPlaneOptions){
    this.catalog=decisionCatalogSchema.parse(options.catalog);this.profile=assertProfileForCatalog(decisionCalibrationProfileSchema.parse(options.profile),this.catalog);this.catalogSha=catalogHash(this.catalog);this.profileSha=decisionHash(this.profile);this.rate=options.shadow_sample_rate??0;
    if(!(Number.isFinite(this.rate)&&this.rate>=0&&this.rate<=1))throw Error('INVALID_SHADOW_SAMPLE_RATE');
    if(options.timeout_ms!==undefined&&!(Number.isInteger(options.timeout_ms)&&options.timeout_ms>=100&&options.timeout_ms<=30000))throw Error('INVALID_DECISION_TIMEOUT');
  }
  async evaluate(request:SystemOneRequest,context:DecisionBatchContext):Promise<DecisionBatchResult>{
    if(!context.context_id||context.context_id.length>160)throw Error('INVALID_DECISION_CONTEXT');const bindings=context.bindings.map(item=>decisionBindingSchema.parse(item));
    if(new Set(bindings.map(item=>item.question_id)).size!==bindings.length||new Set(bindings.map(item=>item.decision_id)).size>this.catalog.judgments.length)throw Error('INVALID_DECISION_BINDINGS');
    const definitions=new Map(this.catalog.judgments.map(item=>[item.id,item]));for(const binding of bindings){if(!definitions.has(binding.decision_id)||!Object.hasOwn(request.questions,binding.question_id))throw Error('DECISION_BINDING_UNKNOWN');const question=request.questions[binding.question_id] as unknown as {type?:unknown};if(question.type!==definitions.get(binding.decision_id)!.primitive)throw Error('DECISION_PRIMITIVE_MISMATCH');}
    const inputHash=decisionHash(request),sampleHash=decisionHash({context:context.context_id,input:inputHash,profile:this.profileSha}),sample=Boolean(this.options.shadow)&&(context.force_shadow===true||shouldSample(sampleHash,this.rate));
    const timeout=this.options.timeout_ms??15000,[primary,shadow]=await Promise.all([call(this.options.primary,request,inputHash,timeout),sample?call(this.options.shadow!,request,inputHash,timeout):Promise.resolve(null)]);
    const build=(raw:unknown,available:boolean)=>bindings.map(binding=>{const definition=definitions.get(binding.decision_id)!;if(!available)return unavailable(binding.question_id,definition,this.profile);const answer=(raw as {answers?:Record<string,unknown>})?.answers?.[binding.question_id],value=decode(answer,request.questions[binding.question_id] as unknown as Record<string,unknown>,definition,this.profile);return {...value,question_id:binding.question_id};});
    const judgments=build(primary.raw,primary.trace.status==='accepted'),shadowJudgments=shadow?build(shadow.raw,shadow.trace.status==='accepted'):[];
    const disagreements=shadow?judgments.filter((item,index)=>item.value!==shadowJudgments[index]?.value||item.status!==shadowJudgments[index]?.status).map(item=>item.question_id):[];
    const shadowSummary:DecisionShadowSummary={sampled:sample,provider:shadow?.trace.provider??null,trace:shadow?.trace??null,disagreements,judgments:shadowJudgments};
    const event:DecisionEvent={format:1,event_id:randomUUID(),occurred_at:new Date().toISOString(),catalog_id:this.catalog.id,catalog_version:this.catalog.version,catalog_sha256:this.catalogSha,profile_id:this.profile.id,profile_version:this.profile.version,profile_sha256:this.profileSha,profile_model:this.profile.model,context_id:context.context_id,state_sha256:decisionHash(request.state),request_sha256:inputHash,primary:primary.trace,judgments,shadow:shadowSummary,execution_authority:false,approval_granted:false};
    await this.options.journal?.append(event);return {event,raw:primary.raw,judgments};
  }
  async label(eventId:string,label:{question_id:string;decision_id:string;correct:boolean;expected?:string|number|boolean|null;source:'readback'|'human'|'fixture';evidence_level:'fixture'|'user_environment';split?:'unassigned'|'train'|'holdout'|'audit'}){await this.options.journal?.label(eventId,label);}
}
