import {randomUUID} from 'node:crypto';
import {type Page} from 'playwright';
import {requireCondition} from '../core/contracts.js';
import {type AdaptiveAction,type AdaptiveElement,type AdaptiveSnapshot,validateAdaptiveAction} from './adaptive-decision.js';
import {type AdaptiveSpec,type AdaptiveTask,hashJson} from './adaptive-spec.js';

const disallowedControl=/\b(?:book now|reserve|reservation|purchase|pay now|confirm booking|buy now|sign in|log in|sign up|register|accept all|accept cookies|agree|subscribe)\b|예약\s*(?:확정|완료|하기)|결제|구매|회원가입|모두\s*동의/iu;
export function assertReadOnlyControl(element:AdaptiveElement,operation:string){
  requireCondition(!disallowedControl.test(element.label),'ADAPTIVE_EFFECT_NOT_DELEGATED');
  if(element.href){const url=new URL(element.href);requireCondition(!/\/(?:checkout|book(?:ing)?|reservation|payment|login|signup|register)(?:[/.]|$)/iu.test(url.pathname),'ADAPTIVE_EFFECT_NOT_DELEGATED');}
  requireCondition(!['password','credit-card','one-time-code'].includes(element.role),'ADAPTIVE_CREDENTIAL_CONTROL');
  requireCondition(operation==='CLICK'||operation==='FILL'||operation==='SELECT','ADAPTIVE_UNSUPPORTED_OPERATION');
}

/** This adapter controls only the explicitly supplied agent-owned page. No OS input or shared user profile. */
export class AdaptiveBrowser {
  #latest:AdaptiveSnapshot|undefined;
  constructor(readonly page:Page,readonly task:AdaptiveTask){}
  async observe():Promise<AdaptiveSnapshot>{
    for(let attempt=0;attempt<3;attempt++){
      try {return await this.observeOnce();}
      catch(error){
        const navigating=error instanceof Error&&/Execution context was destroyed|Cannot find context|most likely because of a navigation|reading 'innerText'/u.test(error.message);
        if(!navigating)throw error;
        if(attempt===2)throw Error('ADAPTIVE_OBSERVATION_NAVIGATING');
        await this.page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>undefined);
      }
    }
    throw Error('ADAPTIVE_OBSERVATION_UNAVAILABLE');
  }
  private async observeOnce():Promise<AdaptiveSnapshot>{
    requireCondition(this.task.allowed_origins.includes(new URL(this.page.url()).origin),'ADAPTIVE_ORIGIN_NOT_DELEGATED');
    const id=randomUUID(),raw=await this.page.evaluate(({prefix})=>{
      const compact=(value:string|null|undefined)=>String(value??'').replace(/\s+/gu,' ').trim();
      const label=(element:Element)=>{
        const labelled=element.getAttribute('aria-labelledby')?.split(/\s+/u).map(ref=>document.getElementById(ref)?.textContent??'').join(' ');
        const input=element as HTMLInputElement;
        const labelNode=input.labels?.[0]?.cloneNode(true) as Element|undefined;labelNode?.querySelectorAll('input,select,textarea,button').forEach(control=>control.remove());
        return compact(element.getAttribute('aria-label')||labelled||labelNode?.textContent||element.getAttribute('placeholder')||element.getAttribute('title')||(input.type==='submit'?input.value:'')||element.textContent||element.getAttribute('name')).slice(0,400);
      };
      const visible=(element:Element)=>{
        const style=getComputedStyle(element),box=element.getBoundingClientRect();
        return style.display!=='none'&&style.visibility!=='hidden'&&box.width>0&&box.height>0&&!element.closest('[inert],[aria-hidden="true"]');
      };
      const all=Array.from(document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="option"],[role="tab"],[role="combobox"],[contenteditable="true"],[tabindex="0"]')).filter(visible);
      // Modal controls first; then form controls. Preserve all candidates up to the documented Choice limit.
      all.sort((a,b)=>Number(Boolean(b.closest('[role="dialog"],[aria-modal="true"]')))-Number(Boolean(a.closest('[role="dialog"],[aria-modal="true"]'))));
      const elements:AdaptiveElement[]=[];let omitted=0;
      for(const node of all){
        const el=node as HTMLElement,input=node as HTMLInputElement,tag=node.tagName.toLowerCase();
        if(input.disabled||node.getAttribute('aria-disabled')==='true'||input.type==='hidden'||input.type==='password'||/cc-|one-time-code/u.test(node.getAttribute('autocomplete')??''))continue;
        const name=label(node);if(!name)continue;
        if(elements.length>=180){omitted++;continue;}
        const elementId=`e${elements.length+1}`,ref=`${prefix}_${elementId}`;
        node.setAttribute('data-agent-driver-ref',ref);
        const fill=(['input','textarea'].includes(tag)&&!input.readOnly&&!['checkbox','radio','button','submit','reset','file'].includes(input.type))||el.isContentEditable;
        const select=tag==='select';
        const operations:('CLICK'|'FILL'|'SELECT')[]=select?['SELECT']:fill?['CLICK','FILL']:['CLICK'];
        const value=fill||select?input.value??el.textContent??'':'';
        const options=select?Array.from((node as HTMLSelectElement).options).filter(option=>!option.disabled).slice(0,40).map((option,index)=>({id:`o${index+1}`,label:compact(option.label),value:option.value})):[];
        const role=node.getAttribute('role')||input.type||tag;
        const ariaState=node.getAttribute('aria-checked')??node.getAttribute('aria-selected')??node.getAttribute('aria-pressed');
        const checked=input.type==='checkbox'||input.type==='radio'?input.checked:ariaState===null?null:ariaState==='true';
        const href=tag==='a'?(node as HTMLAnchorElement).href:'';
        elements.push({id:elementId,label:name,role,tag,value:value.slice(0,500),href,operations,options,checked,signature:JSON.stringify({label:name,role,tag,value:value.slice(0,500),href,checked,options})});
      }
      return {url:location.href,title:document.title,text:document.body.innerText.slice(0,20000),elements,truncated:omitted>0};
    },{prefix:id});
    // Avoid offering controls whose ordinary meaning is an unapproved external effect.
    const elements=raw.elements.filter(element=>{
      try {assertReadOnlyControl(element,'CLICK');return !element.href||this.task.allowed_origins.includes(new URL(element.href).origin);}
      catch{return false;}
    });
    // Cap SELECT combinations, rather than silently overflowing TypeSafe's 255 choices.
    let optionCount=0;for(const element of elements){if(optionCount+element.options.length>240){element.operations=element.operations.filter(operation=>operation!=='SELECT');raw.truncated=true;}else optionCount+=element.options.length;}
    const snapshot:AdaptiveSnapshot={...raw,elements,id,observed_at:new Date().toISOString(),fingerprint:hashJson({url:raw.url,text:raw.text,elements:elements.map(({signature})=>signature)})};
    this.#latest=snapshot;return snapshot;
  }
  async execute(action:AdaptiveAction,spec:AdaptiveSpec,snapshot:AdaptiveSnapshot){
    requireCondition(this.#latest?.id===snapshot.id,'ADAPTIVE_STALE_SNAPSHOT');validateAdaptiveAction(action,spec,snapshot);
    requireCondition(this.page.url()===snapshot.url,'ADAPTIVE_STALE_PAGE');
    if(action.operation==='SCROLL_DOWN'||action.operation==='SCROLL_UP'){
      await this.page.evaluate(direction=>window.scrollBy(0,direction*Math.round(innerHeight*0.75)),action.operation==='SCROLL_DOWN'?1:-1);return;
    }
    if(action.operation==='WAIT'){
      await this.page.waitForFunction(oldText=>document.body.innerText.slice(0,20000)!==oldText,snapshot.text,{timeout:2000}).catch(()=>undefined);return;
    }
    requireCondition(['CLICK','FILL','SELECT'].includes(action.operation),'ADAPTIVE_NON_EXECUTABLE_OPERATION');
    const element=snapshot.elements.find(item=>item.id===action.target_id)!;assertReadOnlyControl(element,action.operation);
    const locator=this.page.locator(`[data-agent-driver-ref="${snapshot.id}_${element.id}"]`);
    requireCondition(await locator.count()===1,'ADAPTIVE_STALE_TARGET');const handle=await locator.elementHandle();requireCondition(handle,'ADAPTIVE_STALE_TARGET');
    try {
      const signature=await handle.evaluate(node=>{
        const compact=(v:string|null|undefined)=>String(v??'').replace(/\s+/gu,' ').trim(),input=node as HTMLInputElement,el=node as HTMLElement,tag=node.tagName.toLowerCase();
        if(!node.isConnected||input.disabled||node.getAttribute('aria-disabled')==='true')return null;
        const labelled=node.getAttribute('aria-labelledby')?.split(/\s+/u).map(ref=>document.getElementById(ref)?.textContent??'').join(' ');
        const labelNode=input.labels?.[0]?.cloneNode(true) as Element|undefined;labelNode?.querySelectorAll('input,select,textarea,button').forEach(control=>control.remove());
        const label=compact(node.getAttribute('aria-label')||labelled||labelNode?.textContent||node.getAttribute('placeholder')||node.getAttribute('title')||(input.type==='submit'?input.value:'')||node.textContent||node.getAttribute('name')).slice(0,400);
        const fill=(['input','textarea'].includes(tag)&&!input.readOnly&&!['checkbox','radio','button','submit','reset','file'].includes(input.type))||el.isContentEditable;
        const select=tag==='select',value=(fill||select?input.value??el.textContent??'':'').slice(0,500),role=node.getAttribute('role')||input.type||tag;
        const ariaState=node.getAttribute('aria-checked')??node.getAttribute('aria-selected')??node.getAttribute('aria-pressed');
        const checked=input.type==='checkbox'||input.type==='radio'?input.checked:ariaState===null?null:ariaState==='true';
        const href=tag==='a'?(node as HTMLAnchorElement).href:'';
        const options=select?Array.from((node as HTMLSelectElement).options).filter(option=>!option.disabled).slice(0,40).map((option,index)=>({id:`o${index+1}`,label:compact(option.label),value:option.value})):[];
        if(input.type==='submit'&&input.form&&!/search|find|조회|검색/iu.test(label))return null;
        return JSON.stringify({label,role,tag,value,href,checked,options});
      });
      requireCondition(signature===element.signature,'ADAPTIVE_STALE_TARGET');
      if(action.operation==='CLICK')await handle.click({timeout:5000});
      else if(action.operation==='FILL')await handle.fill(spec.values.find(value=>value.id===action.value_id)!.value,{timeout:5000});
      else await handle.selectOption({value:element.options.find(option=>option.id===action.value_id)!.value},{timeout:5000});
    } finally {await handle.dispose();}
  }
}
