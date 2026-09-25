import {type ApiProvider} from './model-provider.js';

/** Small, fast models that still pass structured agentic work. Refresh re-ranks live lists so a newer tier replaces these. */
export const FAST_MODEL_DEFAULTS:Readonly<Record<ApiProvider,string>>=Object.freeze({openai:'gpt-6-luna',anthropic:'claude-haiku-4-5',openrouter:'openai/gpt-6-luna',openai_compatible:''});

const version=(value:string)=>value.split(/[.-]/u).map(Number);
const newer=(a:number[],b:number[])=>{for(let i=0;i<Math.max(a.length,b.length);i++){const x=a[i]??0,y=b[i]??0;if(x!==y)return x>y;}return false;};
function best(ids:readonly string[],pattern:RegExp,alias:(id:string)=>boolean=()=>true){
  let chosen:string|null=null,rank:number[]=[];
  for(const id of ids){const match=pattern.exec(id);if(!match)continue;const current=version(match[1]!);
    if(!chosen||newer(current,rank)||(!newer(rank,current)&&alias(id)&&!alias(chosen))){chosen=id;rank=current;}}
  return chosen;
}
const openAiFast=(ids:readonly string[],prefix='')=>best(ids,new RegExp(`^${prefix}gpt-(\\d+(?:\\.\\d+)?)-luna$`,'u'))??best(ids,new RegExp(`^${prefix}gpt-(\\d+(?:\\.\\d+)?)-mini$`,'u'));
const anthropicFast=(ids:readonly string[],prefix='')=>best(ids,new RegExp(`^${prefix}claude-haiku-(\\d+(?:[.-]\\d+)?)(?:-\\d{8})?$`,'u'),id=>!/-\d{8}$/u.test(id));

/** Picks the newest luna-class model a live catalog offers; never invents an unavailable model. */
export function preferredFastModel(provider:ApiProvider,ids:readonly string[]):string{
  const picked=provider==='openai'?openAiFast(ids):provider==='anthropic'?anthropicFast(ids):provider==='openrouter'?openAiFast(ids,'openai/')??anthropicFast(ids,'anthropic/'):null;
  if(picked)return picked;
  const fallback=FAST_MODEL_DEFAULTS[provider];
  return ids.length===0||ids.includes(fallback)?fallback:'';
}
/** A saved choice is deliberate; catalog refresh only recommends a fast model before one is chosen. */
export function selectedFastModel(provider:ApiProvider,ids:readonly string[],current:string){
  if(ids.length>0&&current===FAST_MODEL_DEFAULTS[provider]&&!ids.includes(current))return preferredFastModel(provider,ids);
  return current||preferredFastModel(provider,ids);
}
