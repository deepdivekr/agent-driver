import {randomUUID} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {type HostConfig,loadHostConfig} from '../interface/config.js';
import {type PackStore} from '../packs/store.js';
import {type SwarmRunSnapshot} from './contracts.js';
import {requireCondition} from '../core/contracts.js';
import {RoutedBrowser,publicBrowserRecovery,type BrowserRouteProviders} from '../browser/executor-routing.js';
import {browserPreferenceSchema,browserHostCompatible,type BrowserPreference,type BrowserTarget} from '../browser/executor-contracts.js';
import {type VisualCommand} from './visual-executor.js';
import {authSites,detectAuthGate,knownLoginSites,readyAuthTargets,setSiteAuth} from './browser-auth.js';
import {sanitizeSwarmEndpoint} from './dashboard.js';

interface Slot {id:string;browser:RoutedBrowser;lease:string;links:Set<string>;origins:string[];steps:number;busy:boolean;}
const key=(value:string)=>{const u=new URL(value);u.hash='';return u.href;};
function privateAddress(value:string){if(value.includes(':'))return !/^[23][0-9a-f]{3}:/iu.test(value);const [a,b]=value.split('.').map(Number);return a===0||a===10||a===127||a===169&&b===254||a===172&&b!>=16&&b!<=31||a===192&&b===168||a===100&&b!>=64&&b!<=127||a!>=224||a===198&&(b===18||b===19);}
/** Common, read-only executor routing for leased research workers. No screenshot stream or shared active tab. */
export class RoutedSwarmBrowser {
  private slots=new Map<string,Promise<Slot>>();private closed=false;private timer:ReturnType<typeof setInterval>;
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly providers:()=>BrowserRouteProviders=()=>({})){
    this.timer=setInterval(()=>{for(const [id,pending] of this.slots)void pending.then(slot=>{const [run,worker]=id.split(':');try{this.lease(run!,worker!,slot.lease);}catch{void this.release(run!,worker!);}}).catch(()=>{});},5000);this.timer.unref();
  }
  private lease(run:string,worker:string,token:string){
    requireCondition(!this.closed,'CONTROL_POOL_CLOSED');requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');
    const snapshot=this.store.swarmRun(this.config.project.id,run).snapshot as SwarmRunSnapshot,state=snapshot.workers[worker],definition=snapshot.plan.workers.find(w=>w.id===worker);
    requireCondition(['running','needs_human'].includes(snapshot.status)&&state?.status==='leased'&&state.lease_token===token&&(state.lease_expires_at_ms??0)>Date.now(),'STALE_SWARM_LEASE');
    requireCondition(definition?.effect==='read_only'&&['discovery','source_read','verification'].includes(definition.stage)&&definition.source_urls.length>0,'CONTROL_VISUAL_WORKER_UNSUPPORTED');return {snapshot,definition};
  }
  private async url(value:string){
    const u=new URL(value);requireCondition(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&value.length<=4096,'CONTROL_BROWSER_URL_INVALID');
    if(this.config.environment==='fixture'&&u.origin===new URL(this.config.fixtureUrl!).origin)return u;
    const host=u.hostname.replace(/^\[|\]$/gu,'');requireCondition(!u.port||['80','443'].includes(u.port),'CONTROL_BROWSER_PORT_FORBIDDEN');
    requireCondition(host.includes('.')&&!/\.(?:local|localhost)$/iu.test(host),'CONTROL_BROWSER_PRIVATE_ADDRESS');
    const addresses=isIP(host)?[{address:host}]:await lookup(host,{all:true});requireCondition(addresses.length>0&&addresses.every(a=>!privateAddress(a.address)),'CONTROL_BROWSER_PRIVATE_ADDRESS');return u;
  }
  async assign(run:string,worker:string,token:string){
    const {definition,snapshot}=this.lease(run,worker,token),id=`${run}:${worker}`,existing=this.slots.get(id);
    if(existing){const slot=await existing;requireCondition(slot.lease===token,'CONTROL_SURFACE_LEASE_CONFLICT');return {surface_id:slot.id,kind:'browser' as const};}
    requireCondition(this.slots.size<(this.config.swarm?.visual.max_contexts??4),'CONTROL_POOL_CAPACITY_EXCEEDED');
    const pending=(async()=>{
      const origins=[...new Set((await Promise.all(definition.source_urls.map(url=>this.url(url)))).map(u=>u.origin))];
      const office=this.store.officeWork(this.config.project.id,'swarm',run) as {id:string}|null,work=office?this.store.intakeWorkOptional(this.config.project.id,office.id):null;
      const workBrowser=browserPreferenceSchema.optional().parse((work?.spec as {browser?:unknown}|null)?.browser);
      requireCondition(!workBrowser||!definition.browser||workBrowser.environment===definition.browser.environment,'BROWSER_WORK_ENVIRONMENT_CONFLICT');
      const journal=this.store.browserExecutors(),saved=journal.checkpoint(this.config.project.id,id);
      let preference:BrowserPreference=workBrowser??definition.browser??{environment:'owned_headless'};
      const socialSites=[...new Set(definition.source_urls.map(value=>new URL(value).hostname.toLowerCase().replace(/^www\./u,'')).filter(site=>Object.hasOwn(knownLoginSites,site)))];
      let authTarget:BrowserTarget|undefined;
      if(socialSites.length){
        // The generic public/headless default does not select an account. A
        // real social read binds one previously verified profile for all sites.
        const explicit=preference.environment!=='owned_headless'||preference.preferred_engine?preference:undefined;
        const ready=socialSites.map(site=>readyAuthTargets(this.store,this.config,site));
        authTarget=ready[0]!.filter(target=>browserHostCompatible(target)&&ready.every(targets=>targets.some(candidate=>candidate.id===target.id))&&(!explicit||target.environment===explicit.environment&&(!explicit.preferred_engine||target.engine===explicit.preferred_engine)))
          .sort((a,b)=>Number(b.environment==='host_foreground'&&b.engine==='aside')-Number(a.environment==='host_foreground'&&a.engine==='aside')||b.priority-a.priority||a.id.localeCompare(b.id))[0];
        requireCondition(authTarget,'BROWSER_AUTH_REQUIRED');
        preference={environment:authTarget.environment,preferred_engine:authTarget.engine};
      }
      const fallback_preferences=socialSites.length?[]:publicBrowserRecovery(preference);
      const routingConfig=authTarget?{...this.config,browserExecutors:{targets:[authTarget]}}:this.config;
      const guard=()=>{this.lease(run,worker,token);if(authTarget){const states=authSites(this.store,this.config,authTarget);requireCondition(!states.some(site=>site.handoff)&&socialSites.every(site=>states.some(row=>row.site===site&&row.state==='ready')),'BROWSER_AUTH_REQUIRED');}};
      const configured=this.providers(),providers=work?.jev_enabled===false?{...configured,jev:undefined}:configured;
      if(saved){await this.url(saved.url);if(!origins.includes(new URL(saved.url).origin))origins.push(new URL(saved.url).origin);}
      const browser=new RoutedBrowser(routingConfig,{profile_key:`${run}-${worker}`,ephemeral:true,context_id:id,request:definition.objective,preference,fallback_preferences,providers,guard,checkpoint:{load:()=>journal.checkpoint(this.config.project.id,id),save:value=>journal.saveCheckpoint(this.config.project.id,id,value)},event:event=>{journal.append(this.config.project.id,id,event);}},origins);
      const slot:Slot={id:`browser-${randomUUID()}`,browser,lease:token,links:new Set(definition.source_urls.map(key)),origins,steps:0,busy:false};
      try{await browser.open(definition.source_urls[0]!);this.lease(run,worker,token);this.store.bindControlSurface(this.config.project.id,run,worker,token,slot.id,'');this.store.recordSwarmActivity(this.config.project.id,run,snapshot.revision,worker,'worker.activity',{activity_kind:'started',summary:`${browser.target!.engine} / ${browser.target!.environment}`,surface_id:slot.id,decision_layer:'code'});return slot;}catch(error){await browser.close().catch(()=>{});throw error;}
    })();this.slots.set(id,pending);
    try{const slot=await pending;return {surface_id:slot.id,kind:'browser' as const};}catch(error){this.slots.delete(id);throw error;}
  }
  async perform(run:string,worker:string,token:string,command:VisualCommand){
    const {definition}=this.lease(run,worker,token);await this.assign(run,worker,token);const slot=await this.slots.get(`${run}:${worker}`)!;
    requireCondition(!slot.busy&&slot.steps<definition.max_steps,'CONTROL_BROWSER_BUSY_OR_STEP_LIMIT');slot.busy=true;slot.steps++;
    try{
      if(command.action==='navigate'){const u=await this.url(command.url);requireCondition(slot.links.has(key(command.url)),'CONTROL_BROWSER_URL_NOT_OBSERVED');if(!slot.origins.includes(u.origin))slot.origins.push(u.origin);await slot.browser.navigate(key(command.url));}
      else if(command.action==='scroll')await slot.browser.scroll(command.direction);
      const observed=await slot.browser.observe();await this.url(observed.url);this.lease(run,worker,token);
      const authGate=detectAuthGate(observed.url,observed.title,observed.text,false);
      if(authGate){
        const site=new URL(observed.url).hostname.toLowerCase().replace(/^www\./u,'');
        if(Object.hasOwn(knownLoginSites,site))setSiteAuth(this.store,this.config,site,authGate,false,slot.browser.target!);
        throw Error('BROWSER_AUTH_REQUIRED');
      }
      const links=observed.links.filter(link=>{try{const u=new URL(link.url);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}});
      for(const link of links)slot.links.add(key(link.url));slot.links.add(key(observed.url));requireCondition(slot.links.size<=2000,'CONTROL_BROWSER_LINK_LIMIT');
      this.store.recordObservedUrl(this.config.project.id,run,worker,token,observed.url);
      const {snapshot}=this.lease(run,worker,token);this.store.recordSwarmActivity(this.config.project.id,run,snapshot.revision,worker,'worker.activity',{activity_kind:'observing',summary:`Read with ${slot.browser.target!.engine}`,endpoint:sanitizeSwarmEndpoint(observed.url),surface_id:slot.id,decision_layer:'code'});
      return {...observed,links,surface_id:slot.id,captured_at:observed.observed_at,executor:slot.browser.target!.engine,environment:slot.browser.target!.environment};
    }finally{slot.busy=false;}
  }
  async release(run:string,worker:string){const id=`${run}:${worker}`,pending=this.slots.get(id);if(!pending)return;this.slots.delete(id);const slot=await pending.catch(()=>null);if(slot){try{await slot.browser.close();}finally{this.store.endControlSurface(this.config.project.id,run,worker,'closed');}}}
  async close(){if(this.closed)return;clearInterval(this.timer);this.closed=true;await Promise.allSettled([...this.slots.keys()].map(id=>{const [run,worker]=id.split(':');return this.release(run!,worker!);}));}
}
