import {type NaturalLanguageCandidate,validateCandidate} from './contracts.js';

export interface StructuredDecider {
  readonly id:'jev'|'llm';
  decide(prompt:string):Promise<unknown>;
}
export interface DecisionTrace {executor:'jev'|'llm';elapsed_ms:number;status:'accepted'|'rejected'|'error';reason?:string;}
export type ComplementaryDecision =
  | {status:'PROPOSED';selected_by:'jev'|'llm';candidate:NaturalLanguageCandidate;traces:DecisionTrace[]}
  | {status:'NEEDS_CLARIFICATION';traces:DecisionTrace[];reason:string};

function reason(error:unknown){return error instanceof Error&&/^[A-Z_]+$/u.test(error.message)?error.message:'DECIDER_INVALID_OUTPUT';}
async function attempt(decider:StructuredDecider,prompt:string,validate:(candidate:unknown)=>NaturalLanguageCandidate,traces:DecisionTrace[]) {
  const started=performance.now();
  try {const candidate=validate(await decider.decide(prompt));traces.push({executor:decider.id,elapsed_ms:performance.now()-started,status:'accepted'});return candidate;}
  catch(error){traces.push({executor:decider.id,elapsed_ms:performance.now()-started,status:'rejected',reason:reason(error)});return null;}
}

/** Jev gets the latency-first first pass; LLM runs only on a validated rejection. */
export async function decideWithFallback(prompt:string,jev:StructuredDecider,llm:StructuredDecider,normalizer:(normalized:Record<string,unknown>)=>unknown):Promise<ComplementaryDecision>{
  const traces:DecisionTrace[]=[];
  const validate=(raw:unknown)=>{
    const candidate=validateCandidate(prompt,raw) as NaturalLanguageCandidate;
    normalizer(candidate.normalized);
    return candidate;
  };
  const fast=await attempt(jev,prompt,validate,traces);
  if(fast)return {status:'PROPOSED',selected_by:'jev',candidate:fast,traces};
  const corrected=await attempt(llm,prompt,validate,traces);
  if(corrected)return {status:'PROPOSED',selected_by:'llm',candidate:corrected,traces};
  return {status:'NEEDS_CLARIFICATION',traces,reason:traces.at(-1)?.reason??'DECIDER_INVALID_OUTPUT'};
}
