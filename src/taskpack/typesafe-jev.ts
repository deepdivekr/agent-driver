import {createHash} from 'node:crypto';
import {choice,noul,TypeSafeClient,type SystemOneRequest} from '@typesafe-ai/sdk';
import {requireCondition} from '../core/contracts.js';
import {canonicalJson} from './contracts.js';

const unsupported='UNSUPPORTED',clarify='CLARIFY',notStated='NOT_STATED',notInCandidates='NOT_IN_CANDIDATES';
const safeId=/^[a-z][a-z0-9_]{0,63}$/u;

export interface JevRouteCandidate {id:string;description:string;}
export interface JevFieldCandidate {id:string;description:string;}
export interface JevField {
  id:string;route_id:string;description:string;required:boolean;candidates:readonly JevFieldCandidate[];
}
/** Code-derived state only. Callers must omit credentials, cookies, and page text not needed for the judgment. */
export interface OneLineJevInput {
  request:string;routes:readonly JevRouteCandidate[];fields:readonly JevField[];
  observed_state?:Record<string,unknown>;policy_version:string;
}
export interface JevAcceptancePolicy {
  min_route_confidence:number;min_field_confidence:number;min_supplied_probability:number;
}
export const conservativeJevAcceptancePolicy:Readonly<JevAcceptancePolicy>=Object.freeze({
  min_route_confidence:0.8,min_field_confidence:0.8,min_supplied_probability:0.8,
});
export interface JevSystemOneTransport {
  systemOne(request:SystemOneRequest,options:{timeout:number;retry:{maxRetries:number}}):Promise<unknown>;
}
export interface JevDecisionTrace {
  provider:'typesafe';model:string;input_sha256:string;elapsed_ms:number;
  input_tokens:number|'unobserved';output_tokens:number|'unobserved';status:'accepted'|'rejected'|'unavailable';
}
export type OneLineJevDecision=
 | {status:'PROPOSED';route_id:string;fields:Record<string,string>;trace:JevDecisionTrace}
 | {status:'NEEDS_EXTRACTION';route_id:string;field_ids:readonly string[];trace:JevDecisionTrace}
 | {status:'NEEDS_CLARIFICATION';route_id?:string;field_ids:readonly string[];trace:JevDecisionTrace;reason:'LOW_ROUTE_CONFIDENCE'|'LOW_FIELD_CONFIDENCE'|'REQUIRED_INPUT_MISSING'|'MODEL_CLARIFY'}
 | {status:'UNSUPPORTED';trace:JevDecisionTrace}
 | {status:'JEV_UNAVAILABLE';trace:JevDecisionTrace};
export interface OneLineJevDecider {
  decide(input:OneLineJevInput,policy?:JevAcceptancePolicy):Promise<OneLineJevDecision>;
}
export interface SourceAnchoredFieldValue {value:string;start:number;end:number;}
export interface TargetedLlmExtractionRequest {
  request:string;route_id:string;fields:readonly {id:string;description:string}[];
}
export interface TargetedLlmExtractor {
  extract(request:TargetedLlmExtractionRequest):Promise<unknown>;
}
export interface OpenAiTargetedLlmOptions {
  /** Preserves the evaluated fast correction model unless a deployer explicitly pins another one. */
  model?:string;
  timeout_ms?:number;
  /** Test seam only; production leaves this as the platform fetch implementation. */
  fetcher?:typeof fetch;
}
export interface LlmExtractionTrace {
  provider:'llm';model:string;input_sha256:string;elapsed_ms:number;status:'accepted'|'rejected'|'unavailable';
}
export type TargetedLlmExtraction=
  | {status:'EXTRACTED';route_id:string;values:Readonly<Record<string,SourceAnchoredFieldValue>>;trace:LlmExtractionTrace}
  | {status:'LLM_UNAVAILABLE'|'LLM_REJECTED';route_id:string;field_ids:readonly string[];trace:LlmExtractionTrace};

interface CompiledOneLineJevRequest {
  request:SystemOneRequest;routeOptions:ReadonlySet<string>;fieldOptions:ReadonlyMap<string,ReadonlySet<string>>;
}
function finiteProbability(value:unknown){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;}
function assertInput(input:OneLineJevInput){
  requireCondition(typeof input.request==='string'&&input.request.trim().length>0&&input.request.length<=8_000&&!/[\r\n]/u.test(input.request),'INVALID_ONE_LINE_REQUEST');
  requireCondition(!/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(input.request),'CREDENTIAL_LIKE_INPUT_REJECTED');
  requireCondition(safeId.test(input.policy_version),'INVALID_JEV_POLICY_VERSION');
  requireCondition(input.routes.length>0&&input.routes.length<=64,'INVALID_JEV_ROUTE_COUNT');
  requireCondition(input.fields.length<=64,'INVALID_JEV_FIELD_COUNT');
  const routes=new Set<string>(),fields=new Set<string>();
  for(const route of input.routes){
    requireCondition(safeId.test(route.id)&&route.id!==unsupported&&route.id!==clarify&&!routes.has(route.id),'INVALID_JEV_ROUTE');
    requireCondition(route.description.trim().length>0&&route.description.length<=1_000,'INVALID_JEV_ROUTE_DESCRIPTION');routes.add(route.id);
  }
  for(const field of input.fields){
    requireCondition(safeId.test(field.id)&&!fields.has(field.id),'INVALID_JEV_FIELD');
    requireCondition(routes.has(field.route_id),'JEV_FIELD_ROUTE_UNKNOWN');
    requireCondition(field.description.trim().length>0&&field.description.length<=1_000,'INVALID_JEV_FIELD_DESCRIPTION');
    requireCondition(field.candidates.length<=64,'INVALID_JEV_FIELD_CANDIDATE_COUNT');fields.add(field.id);
    const candidates=new Set<string>();
    for(const candidate of field.candidates){
      requireCondition(safeId.test(candidate.id)&&candidate.id!==notStated&&candidate.id!==notInCandidates&&!candidates.has(candidate.id),'INVALID_JEV_FIELD_CANDIDATE');
      requireCondition(candidate.description.trim().length>0&&candidate.description.length<=1_000,'INVALID_JEV_FIELD_CANDIDATE_DESCRIPTION');candidates.add(candidate.id);
    }
  }
  if(input.observed_state!==undefined)canonicalJson(input.observed_state);
}
function assertPolicy(policy:JevAcceptancePolicy){
  for(const threshold of [policy.min_route_confidence,policy.min_field_confidence,policy.min_supplied_probability])requireCondition(finiteProbability(threshold),'INVALID_JEV_ACCEPTANCE_POLICY');
}

/** Compiles a one-line request into one bounded System One batch. No model output can add a route or field value. */
export function compileOneLineJevRequest(input:OneLineJevInput):CompiledOneLineJevRequest {
  assertInput(input);
  const routeOptions=new Set(input.routes.map(route=>route.id)),fieldOptions=new Map<string,ReadonlySet<string>>();
  const routeCriteria=Object.fromEntries(input.routes.map(route=>[route.id,route.description]));
  Object.assign(routeCriteria,{[unsupported]:'The request is explicit but outside all supplied task routes. Do not execute a partial route.',[clarify]:'The request is ambiguous, refers to missing context, or selects more than one supplied route.'});
  const questions:Record<string,ReturnType<typeof choice>|ReturnType<typeof noul>>={
    route:choice('Which one supplied task route best matches request.text? This is intent classification only and never authorizes execution.',routeCriteria),
  };
  for(const field of input.fields){
    const criteria=Object.fromEntries(field.candidates.map(candidate=>[candidate.id,candidate.description]));
    Object.assign(criteria,{[notStated]:'The user did not provide a concrete value for this field.',[notInCandidates]:'The user did provide a value, but it is not represented by the code-supplied candidates. Extraction is needed; do not invent a value.'});
    const prefix=`field.${field.id}`;
    questions[`${prefix}.candidate`]=choice(`For field ${field.id}: ${field.description} Choose only a supplied candidate or one explicit fallback.`,criteria);
    questions[`${prefix}.supplied`]=noul(`Does request.text provide a concrete value for field ${field.id}: ${field.description}? Answer true even when the value is absent from candidates.`,{true:'A concrete user-supplied value is present.',false:'No concrete user-supplied value is present.'});
    fieldOptions.set(field.id,new Set(Object.keys(criteria)));
  }
  const state={
    request:{text:input.request},
    candidates:{
      routes:input.routes.map(route=>({id:route.id,description:route.description})),
      fields:input.fields.map(field=>({id:field.id,route_id:field.route_id,description:field.description,required:field.required,candidates:field.candidates.map(candidate=>({id:candidate.id,description:candidate.description}))})),
    },
    observed_state:input.observed_state===undefined?null:JSON.parse(canonicalJson(input.observed_state)),
    policy:{version:input.policy_version,execution_authority:false},
  };
  return {request:{model:'jev-latest',state,questions},routeOptions,fieldOptions};
}
function answerRecord(raw:unknown){
  requireCondition(typeof raw==='object'&&raw!==null&&!Array.isArray(raw),'JEV_RESPONSE_INVALID');
  const answers=(raw as {answers?:unknown}).answers;requireCondition(typeof answers==='object'&&answers!==null&&!Array.isArray(answers),'JEV_RESPONSE_INVALID');return answers as Record<string,unknown>;
}
function choiceAnswer(raw:unknown,options:ReadonlySet<string>){
  requireCondition(typeof raw==='object'&&raw!==null&&!Array.isArray(raw),'JEV_RESPONSE_INVALID');
  const answer=raw as {type?:unknown;choice?:unknown;confidence?:unknown;probabilities?:unknown};
  requireCondition(answer.type==='choice'&&typeof answer.choice==='string'&&options.has(answer.choice)&&finiteProbability(answer.confidence),'JEV_RESPONSE_INVALID');
  requireCondition(typeof answer.probabilities==='object'&&answer.probabilities!==null&&!Array.isArray(answer.probabilities),'JEV_RESPONSE_INVALID');
  for(const option of options)requireCondition(finiteProbability((answer.probabilities as Record<string,unknown>)[option]),'JEV_RESPONSE_INVALID');
  return {choice:answer.choice,confidence:answer.confidence as number};
}
function noulAnswer(raw:unknown){
  requireCondition(typeof raw==='object'&&raw!==null&&!Array.isArray(raw),'JEV_RESPONSE_INVALID');
  const answer=raw as {type?:unknown;noul?:unknown};requireCondition(answer.type==='noul'&&finiteProbability(answer.noul),'JEV_RESPONSE_INVALID');return answer.noul as number;
}
function trace(input:CompiledOneLineJevRequest,started:number,status:JevDecisionTrace['status'],raw?:unknown):JevDecisionTrace {
  const record=raw!==null&&typeof raw==='object'&&!Array.isArray(raw)?raw as {model?:unknown;usage?:unknown}:{};
  const usage=record.usage!==null&&typeof record.usage==='object'&&!Array.isArray(record.usage)?record.usage as {input_tokens?:unknown;output_tokens?:unknown}:{};
  return {provider:'typesafe',model:typeof record.model==='string'?record.model:'unobserved',input_sha256:createHash('sha256').update(canonicalJson(input.request)).digest('hex'),elapsed_ms:Math.round(performance.now()-started),input_tokens:typeof usage.input_tokens==='number'&&Number.isFinite(usage.input_tokens)?usage.input_tokens:'unobserved',output_tokens:typeof usage.output_tokens==='number'&&Number.isFinite(usage.output_tokens)?usage.output_tokens:'unobserved',status};
}

/**
 * Jev has semantic selection authority only.  Code validates the response,
 * applies calibrated thresholds, and leaves dispatch/approval/readback outside
 * this layer.  Provider failures intentionally reveal no transport details.
 */
export class TypeSafeJevDecisionLayer {
  constructor(private readonly transport:JevSystemOneTransport,private readonly timeoutMs=1_500){requireCondition(Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=30_000,'INVALID_JEV_TIMEOUT');}
  async decide(input:OneLineJevInput,policy:JevAcceptancePolicy=conservativeJevAcceptancePolicy):Promise<OneLineJevDecision>{
    assertPolicy(policy);const compiled=compileOneLineJevRequest(input),started=performance.now();let raw:unknown;
    try {raw=await this.transport.systemOne(compiled.request,{timeout:this.timeoutMs,retry:{maxRetries:0}});}
    catch{return {status:'JEV_UNAVAILABLE',trace:trace(compiled,started,'unavailable')};}
    try {
      const answers=answerRecord(raw),route=choiceAnswer(answers.route,new Set([...compiled.routeOptions,unsupported,clarify])),decisionTrace=trace(compiled,started,'accepted',raw);
      if(route.choice===unsupported)return {status:'UNSUPPORTED',trace:decisionTrace};
      if(route.choice===clarify)return {status:'NEEDS_CLARIFICATION',field_ids:[],reason:'MODEL_CLARIFY',trace:decisionTrace};
      if(route.confidence<policy.min_route_confidence)return {status:'NEEDS_CLARIFICATION',route_id:route.choice,field_ids:[],reason:'LOW_ROUTE_CONFIDENCE',trace:decisionTrace};
      const fields=input.fields.filter(field=>field.route_id===route.choice),selected:Record<string,string>={},extract:string[]=[],missing:string[]=[],lowConfidence:string[]=[];
      for(const field of fields){
        const selectedCandidate=choiceAnswer(answers[`field.${field.id}.candidate`],compiled.fieldOptions.get(field.id)!);
        const supplied=noulAnswer(answers[`field.${field.id}.supplied`]);
        if(selectedCandidate.confidence<policy.min_field_confidence){lowConfidence.push(field.id);continue;}
        if(selectedCandidate.choice===notInCandidates||(selectedCandidate.choice===notStated&&supplied>=policy.min_supplied_probability)){extract.push(field.id);continue;}
        if(selectedCandidate.choice===notStated){if(field.required)missing.push(field.id);continue;}
        selected[field.id]=selectedCandidate.choice;
      }
      if(lowConfidence.length>0)return {status:'NEEDS_CLARIFICATION',route_id:route.choice,field_ids:lowConfidence,reason:'LOW_FIELD_CONFIDENCE',trace:decisionTrace};
      if(extract.length>0)return {status:'NEEDS_EXTRACTION',route_id:route.choice,field_ids:extract,trace:decisionTrace};
      if(missing.length>0)return {status:'NEEDS_CLARIFICATION',route_id:route.choice,field_ids:missing,reason:'REQUIRED_INPUT_MISSING',trace:decisionTrace};
      return {status:'PROPOSED',route_id:route.choice,fields:selected,trace:decisionTrace};
    }catch{return {status:'JEV_UNAVAILABLE',trace:trace(compiled,started,'rejected',raw)};}
  }
}

function llmTrace(request:TargetedLlmExtractionRequest,started:number,status:LlmExtractionTrace['status'],raw?:unknown):LlmExtractionTrace {
  const record=raw!==null&&typeof raw==='object'&&!Array.isArray(raw)?raw as {model?:unknown}:{};
  return {provider:'llm',model:typeof record.model==='string'?record.model:'unobserved',input_sha256:createHash('sha256').update(canonicalJson(request)).digest('hex'),elapsed_ms:Math.round(performance.now()-started),status};
}
/**
 * LLM correction is deliberately narrower than the old prompt-and-parse path:
 * Jev has already selected the route, only its missing candidate fields enter,
 * and every returned value must be an exact source span from the one-line input.
 */
export async function resolveTargetedLlmExtraction(input:OneLineJevInput,decision:Extract<OneLineJevDecision,{status:'NEEDS_EXTRACTION'}>,extractor:TargetedLlmExtractor):Promise<TargetedLlmExtraction> {
  assertInput(input);const fields=input.fields.filter(field=>field.route_id===decision.route_id&&decision.field_ids.includes(field.id)).map(field=>({id:field.id,description:field.description}));
  requireCondition(fields.length===decision.field_ids.length,'JEV_EXTRACTION_FIELD_UNKNOWN');
  const request:TargetedLlmExtractionRequest={request:input.request,route_id:decision.route_id,fields},started=performance.now();let raw:unknown;
  try {raw=await extractor.extract(request);}catch{return {status:'LLM_UNAVAILABLE',route_id:decision.route_id,field_ids:decision.field_ids,trace:llmTrace(request,started,'unavailable')};}
  try {
    requireCondition(typeof raw==='object'&&raw!==null&&!Array.isArray(raw),'LLM_EXTRACTION_INVALID');
    const values=(raw as {values?:unknown}).values;requireCondition(typeof values==='object'&&values!==null&&!Array.isArray(values),'LLM_EXTRACTION_INVALID');
    const entries=Object.entries(values as Record<string,unknown>);requireCondition(entries.length===fields.length&&entries.every(([id])=>decision.field_ids.includes(id)),'LLM_EXTRACTION_FIELD_MISMATCH');
    const anchored:Record<string,SourceAnchoredFieldValue>={};
    for(const [id,value] of entries){
      requireCondition(typeof value==='object'&&value!==null&&!Array.isArray(value),'LLM_EXTRACTION_INVALID');const span=value as Partial<SourceAnchoredFieldValue>;
      if(!(typeof span.value==='string'&&span.value.length>0&&span.value.length<=8_000&&typeof span.start==='number'&&typeof span.end==='number'&&Number.isInteger(span.start)&&Number.isInteger(span.end)))throw Error('LLM_EXTRACTION_PROVENANCE_MISMATCH');
      const start=span.start,end=span.end;
      if(!(start>=0&&end>start&&end<=input.request.length&&input.request.slice(start,end)===span.value))throw Error('LLM_EXTRACTION_PROVENANCE_MISMATCH');
      anchored[id]={value:span.value,start,end};
    }
    return {status:'EXTRACTED',route_id:decision.route_id,values:anchored,trace:llmTrace(request,started,'accepted',raw)};
  }catch{return {status:'LLM_REJECTED',route_id:decision.route_id,field_ids:decision.field_ids,trace:llmTrace(request,started,'rejected',raw)};}
}

const openAiResponsesEndpoint='https://api.openai.com/v1/responses';
const defaultCorrectionModel='gpt-5.6-luna';
function assertOpenAiOptions(options:OpenAiTargetedLlmOptions){
  if(options.model!==undefined)requireCondition(/^[A-Za-z0-9._-]{1,128}$/u.test(options.model),'INVALID_LLM_MODEL');
  if(options.timeout_ms!==undefined)requireCondition(Number.isInteger(options.timeout_ms)&&options.timeout_ms>=100&&options.timeout_ms<=120_000,'INVALID_LLM_TIMEOUT');
}
/**
 * This is deliberately an extraction-only call: it receives the original one-line
 * request plus code-owned field names, has no tools, stores no response state, and
 * must return literal spans rather than a synthesized answer.
 */
export function openAiTargetedLlmRequest(request:TargetedLlmExtractionRequest,model=defaultCorrectionModel){
  requireCondition(/^[A-Za-z0-9._-]{1,128}$/u.test(model),'INVALID_LLM_MODEL');
  const properties=Object.fromEntries(request.fields.map(field=>[field.id,{
    type:'object',additionalProperties:false,required:['value','start','end'],properties:{
      value:{type:'string',minLength:1,maxLength:8_000},start:{type:'integer',minimum:0},end:{type:'integer',minimum:1},
    },
  }]));
  return {
    model,reasoning:{effort:'low'},store:false,stream:false,tools:[],max_output_tokens:1_024,
    instructions:'Extract only the requested fields. For each value, return the exact contiguous substring from request.text and its zero-based start and exclusive end offsets. Do not infer, normalize, translate, add a field, select a browser action, or provide explanation.',
    input:JSON.stringify({request:{text:request.request},route_id:request.route_id,fields:request.fields}),
    text:{format:{type:'json_schema',name:'source_anchored_task_fields',strict:true,schema:{
      type:'object',additionalProperties:false,required:['values'],properties:{values:{type:'object',additionalProperties:false,required:request.fields.map(field=>field.id),properties}},
    }}},
  };
}
function decodeOpenAiExtractionResponse(raw:unknown):unknown {
  requireCondition(typeof raw==='object'&&raw!==null&&!Array.isArray(raw),'LLM_RESPONSE_INVALID');
  const response=raw as {status?:unknown;model?:unknown;output?:unknown};
  requireCondition(response.status==='completed'&&Array.isArray(response.output),'LLM_RESPONSE_INVALID');
  const message=response.output.filter((item):item is {type:unknown;content?:unknown}=>typeof item==='object'&&item!==null&&!Array.isArray(item)&&'type' in item&&(item as {type:unknown}).type==='message');
  requireCondition(response.output.every(item=>typeof item==='object'&&item!==null&&!Array.isArray(item)&&['reasoning','message'].includes((item as {type?:unknown}).type as string)),'LLM_RESPONSE_INVALID');
  const content=message.flatMap(item=>Array.isArray(item.content)?item.content:[]);
  requireCondition(content.length>0&&content.every(item=>typeof item==='object'&&item!==null&&!Array.isArray(item)&&(item as {type?:unknown}).type==='output_text'&&typeof (item as {text?:unknown}).text==='string'),'LLM_RESPONSE_INVALID');
  const values=JSON.parse(content.map(item=>(item as {text:string}).text).join(''));
  return {model:typeof response.model==='string'?response.model:'unobserved',...values};
}
/**
 * Constructs the remote correction adapter from the host secret.  It has exactly
 * one HTTP attempt per extraction and never exposes error payloads, keys, or text
 * in returned errors.  Callers still decide whether remote LLM use is permitted.
 */
export function openAiTargetedLlmExtractorFromHostEnvironment(environment:NodeJS.ProcessEnv=process.env,options:OpenAiTargetedLlmOptions={}):TargetedLlmExtractor {
  assertOpenAiOptions(options);const apiKey=environment.OPENAI_API_KEY;
  requireCondition(typeof apiKey==='string'&&apiKey.trim().length>=16,'OPENAI_CREDENTIAL_UNAVAILABLE');
  const fetcher=options.fetcher??fetch,model=options.model??defaultCorrectionModel,timeoutMs=options.timeout_ms??30_000;
  return {async extract(request:TargetedLlmExtractionRequest){
    const response=await fetcher(openAiResponsesEndpoint,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json'},body:JSON.stringify(openAiTargetedLlmRequest(request,model)),signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok)throw Error('OPENAI_CORRECTION_UNAVAILABLE');
    return decodeOpenAiExtractionResponse(await response.json());
  }};
}

/** Creates the only production transport. It reads a host secret at construction, never serializes it, and disables SDK retries. */
export function typeSafeTransportFromHostEnvironment(environment:NodeJS.ProcessEnv=process.env):JevSystemOneTransport {
  const apiKey=environment.TYPESAFE_API_KEY;requireCondition(typeof apiKey==='string'&&apiKey.trim().length>=16,'TYPESAFE_CREDENTIAL_UNAVAILABLE');
  const client=new TypeSafeClient({apiKey,logLevel:'off',retry:{maxRetries:0},timeout:1_500});
  return {systemOne:async(request,options)=>client.systemOne(request,options)};
}
