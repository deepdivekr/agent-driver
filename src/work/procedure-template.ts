import {type WorkClientCheckpoint} from './client-executor.js';
import {type JevSystemOneTransport} from '../taskpack/typesafe-jev.js';
import {judgeRow} from '../packs/judgment.js';

/** Plan B2/B4, the owner's original idea for Jev: the first run of a task is set up by the model. Its verified result
 * is kept as a template whose values are bound to where they stood in the pages that were read (the calibration:
 * the text just before each value and the value's shape). A repeat reads the same pages, takes the values from the
 * same places in code, and Jev confirms every value that changed is still the same field. Only then does the host
 * save the result without a model turn. Anything it cannot place or confirm goes back to the model, and the new
 * result is verified on its own like any other. */
type Observation=WorkClientCheckpoint['observations'][number];
export type TemplateSlot={start:number;end:number;value:string}&({kind:'page';read:number;left:string}|{kind:'observed_at';read:number}|{kind:'read_url';read:number}|{kind:'now'});
export interface ProcedureTemplate {version:1;format:'txt'|'json';label:string|null;text:string;reads:Array<{tool:string;url:string}>;slots:TemplateSlot[];}

const READ='office_browser_read',DRAFT='office_result_draft';
const record=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const isoTime=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/u;
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
/** The shape of a value: runs of digits and of letters may change length, everything else is literal. */
export function valueShape(value:string):RegExp{
  let pattern='';
  for(const run of value.match(/\d+|[A-Za-z]+|[^\dA-Za-z]+/gu)??[])pattern+=/^\d/u.test(run)?'\\d+':/^[A-Za-z]/u.test(run)?'[A-Za-z]+':escape(run);
  return new RegExp(pattern,'uy');
}

/** Builds the template of a verified run, or null when its result cannot be reproduced from the pages alone. */
export function buildProcedureTemplate(request:string,observations:readonly Observation[]):ProcedureTemplate|null{
  const succeeded=observations.filter(item=>item.invocation.dispatched&&item.receipt.status==='succeeded');
  const draftIndex=succeeded.map(item=>item.invocation.tool_name).lastIndexOf(DRAFT);if(draftIndex<0)return null;
  const draft=succeeded[draftIndex]!,args=draft.invocation.arguments,format=args.format===undefined?'txt':args.format;
  if(typeof args.text!=='string'||args.text.length>6000||format!=='txt'&&format!=='json')return null;
  const pages=succeeded.slice(0,draftIndex).filter(item=>item.invocation.tool_name===READ&&!Number(item.invocation.arguments.offset??0)).flatMap(item=>{
    const value=record(item.receipt.value),url=item.invocation.arguments.url;
    return typeof value.text==='string'&&typeof url==='string'?[{url,text:value.text,observed_at:typeof value.observed_at==='string'?value.observed_at:''}]:[];
  });
  if(!pages.length||pages.length>8)return null;
  const text=args.text,slots:TemplateSlot[]=[];
  for(const match of text.matchAll(/[A-Za-z0-9][A-Za-z0-9.:+\-_/%?=&#@~]*/gu)){
    const value=match[0].replace(/[.:,;]+$/u,''),start=match.index;
    if(!/\d/u.test(value)||request.includes(value))continue;
    const base={start,end:start+value.length,value};
    // A time the page itself shows is a page value; otherwise it is when a read happened, or when the result was written.
    if(isoTime.test(value)&&!pages.some(page=>page.text.includes(value))){const read=pages.findIndex(page=>page.observed_at===value);slots.push(read>=0?{...base,kind:'observed_at',read}:{...base,kind:'now'});continue;}
    const sameUrl=pages.findIndex(page=>page.url===value);if(sameUrl>=0){slots.push({...base,kind:'read_url',read:sameUrl});continue;}
    const read=pages.findIndex(page=>page.text.includes(value));
    // A number the pages do not show was computed or invented by the model: no template.
    if(read<0)return null;
    const at=pages[read]!.text.indexOf(value);slots.push({...base,kind:'page',read,left:pages[read]!.text.slice(Math.max(0,at-40),at)});
  }
  if(!slots.some(slot=>slot.kind==='page')||slots.length>60)return null;
  return {version:1,format,label:typeof args.label==='string'?args.label:null,text,reads:pages.map(page=>({tool:READ,url:page.url})),slots};
}

/** The value now standing where the saved one stood: after the longest part of the saved lead-in the page still has. */
export function extractSlot(slot:Extract<TemplateSlot,{kind:'page'}>,page:string):{value:string;context:string}|null{
  const shape=valueShape(slot.value);
  for(let length=slot.left.length;length>=6;length-=2){
    const anchor=slot.left.slice(-length);let from=0;
    for(let found=page.indexOf(anchor,from),tries=0;found>=0&&tries<20;found=page.indexOf(anchor,from),tries++){
      shape.lastIndex=found+anchor.length;const match=shape.exec(page);
      if(match)return {value:match[0],context:page.slice(Math.max(0,found+anchor.length-60),found+anchor.length+match[0].length+40)};
      from=found+1;
    }
  }
  return null;
}
/** A later read whose address contained an earlier value (a version in a release URL) follows the new value. */
export function templatedUrl(template:ProcedureTemplate,readIndex:number,values:ReadonlyMap<string,string>):string{
  let url=template.reads[readIndex]!.url;
  for(const slot of template.slots)if(slot.kind==='page'&&slot.read<readIndex&&slot.value.length>=3&&values.has(slot.value)&&url.includes(slot.value))url=url.split(slot.value).join(values.get(slot.value)!);
  return url;
}
export function fillTemplate(template:ProcedureTemplate,values:ReadonlyMap<string,string>,readUrls:readonly string[],observedAt:readonly string[],now:string):string{
  let out='',cursor=0;
  for(const slot of [...template.slots].sort((a,b)=>a.start-b.start)){
    out+=template.text.slice(cursor,slot.start);cursor=slot.end;
    out+=slot.kind==='page'?values.get(slot.value)??slot.value:slot.kind==='observed_at'?observedAt[slot.read]||now:slot.kind==='read_url'?readUrls[slot.read]??slot.value:now;
  }
  return out+template.text.slice(cursor);
}

export interface ScriptStep {tool:string;arguments:Record<string,unknown>;summary:string;advance?:boolean;}
/** Drives one repeat of a templated procedure. Stateless about evidence: it only reads what the run observed. */
export class ProcedureScript {
  private readonly attempted=new Set<number>();private readonly values=new Map<string,string>();
  private readonly contexts=new Map<string,string>();private abandoned=false;private drafted=false;
  constructor(private readonly template:ProcedureTemplate,private readonly jev:JevSystemOneTransport|undefined,private readonly onPaidJudgment:(calls:number)=>void=()=>{},private readonly note:(summary:string)=>void=()=>{}){}
  private stop(reason:string):null{this.abandoned=true;this.note(reason);return null;}
  async next(checkpoint:WorkClientCheckpoint):Promise<ScriptStep|null>{
    if(this.abandoned||this.drafted)return null;
    if(checkpoint.observations.some(item=>item.invocation.tool_name===DRAFT&&item.invocation.dispatched))return this.stop('A result was already saved in this run; the saved template is not applied.');
    const urls:string[]=[],observedAt:string[]=[];
    for(let index=0;index<this.template.reads.length;index++){
      const url=templatedUrl(this.template,index,this.values);urls.push(url);
      const seen=checkpoint.observations.find(item=>item.invocation.dispatched&&item.invocation.tool_name===READ&&item.invocation.arguments.url===url&&!Number(item.invocation.arguments.offset??0));
      if(!seen){
        if(this.attempted.has(index))return this.stop('A read of the saved procedure was not dispatched; the AI continues.');
        this.attempted.add(index);return {tool:READ,arguments:{url},summary:'Repeating a read from the verified procedure of this task.'};
      }
      const value=record(seen.receipt.value);
      if(seen.receipt.status!=='succeeded'||typeof value.text!=='string')return this.stop('A read of the saved procedure did not succeed; the AI continues.');
      observedAt.push(typeof value.observed_at==='string'?value.observed_at:'');
      for(const slot of this.template.slots)if(slot.kind==='page'&&slot.read===index&&!this.values.has(slot.value)){
        const found=extractSlot(slot,value.text);
        if(!found)return this.stop('A saved value could not be found at its place in the page; the AI continues.');
        this.values.set(slot.value,found.value);this.contexts.set(slot.value,found.context);
      }
    }
    // Jev confirms every value that changed is still the same field. An unchanged page needs no judgment.
    const changed=[...this.values].filter(([before,after])=>before!==after);
    if(changed.length){
      if(!this.jev)return this.stop('Values on the page changed and no fast judgment is configured; the AI continues.');
      for(const [before,after] of changed){
        const slot=this.template.slots.find(item=>item.kind==='page'&&item.value===before) as Extract<TemplateSlot,{kind:'page'}>;
        const decision=await judgeRow({text_before_the_value:slot.left,previous_value:before,new_value:after,new_surrounding_text:this.contexts.get(before)??''},
          'A page was read again. previous_value stood right after text_before_the_value last time; new_value stands at the same place now. Is new_value the same field with a possibly updated value?',
          {same_field:'The same kind of value in the same place and role: an updated version, date, number or name of the same thing.',different:'Another kind of content, a different item, an error or placeholder text, or the place no longer holds that field.'},0.9,this.jev);
        this.onPaidJudgment(1);
        if(decision.decider!=='jev'||decision.label!=='same_field')return this.stop('The fast judgment did not confirm a changed value; the AI continues.');
      }
    }
    this.drafted=true;const now=new Date().toISOString();
    return {tool:DRAFT,arguments:{format:this.template.format,text:fillTemplate(this.template,this.values,urls,observedAt,now),...(this.template.label?{label:this.template.label}:{})},
      summary:changed.length?`Saving the result from the verified template; ${changed.length} changed value${changed.length===1?'':'s'} confirmed by the fast judgment.`:'Saving the result from the verified template; the pages show the same values.',advance:true};
  }
}
