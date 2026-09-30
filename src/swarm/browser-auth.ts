import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

import {loginVmSpec,ownedLoginVmRunning,prepareLoginVm} from './login-vm.js';
import {type Browser,type Page} from 'playwright';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {type PackStore} from '../packs/store.js';
import {assertAutomatedBrowserAllowed} from './account-browser-policy.js';
import {browserTargetSchema,browserHostCompatible,type BrowserTarget,type BrowserPreference} from '../browser/executor-contracts.js';
import {McpBrowserExecutor} from '../browser/mcp-executor.js';
import {acquirePersistentProfile,hasHeadedDisplay,isPersistentProfile,ownedProfileAuthKey,type PersistentProfileLease} from '../browser/persistent-profile.js';
export {hasHeadedDisplay} from '../browser/persistent-profile.js';

export type AuthState='unchecked'|'needs_login'|'login_limited'|'challenge'|'ready'|'unknown'|'retry_requested'|'policy_blocked';
export interface SiteAuth {site:string;state:AuthState;handoff:boolean;updated_at:string;}
const authRestrictionRank=(state:AuthState|undefined)=>state==='login_limited'?3:state==='policy_blocked'?2:state==='challenge'?1:0;
export const knownLoginSites={
  'x.com':{label:'X',login:'https://x.com/i/flow/login',signed_in:'[data-testid="SideNav_AccountSwitcher_Button"]'},
  'reddit.com':{label:'Reddit',login:'https://www.reddit.com/login/',signed_in:'[data-testid="user-drawer-content"] a[href*="/user/"], shreddit-user-menu button[aria-label*="profile" i]'},
  'stocktwits.com':{label:'Stocktwits',login:'https://stocktwits.com/signin',signed_in:'a[href="/settings"], a[href="/settings/profile"], button[aria-label="Profile"]'},
} as const;
export function authSite(value:string){const url=new URL(value);requireCondition(url.protocol==='https:'&&!url.username&&!url.password,'AUTH_URL_INVALID');return url.hostname.toLowerCase().replace(/^www\./u,'');}
/** Keep the existing VM profile key stable; other browsers never inherit its sign-in observation. */
export function authProfile(config:HostConfig,target?:BrowserTarget){
  if(target?.environment==='owned_headless')return ownedProfileAuthKey(config,target);
  const vm=config.swarm?.visual.owned_vm;
  const identity=!target||target.environment==='ubuntu_vm'&&vm?vm??{policy_only:true,project_id:config.project.id}:{project_id:config.project.id,target_id:target.id,engine:target.engine,environment:target.environment,platform:target.platform,profile_ref:target.profile_ref};
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
export function authSites(store:PackStore,config:HostConfig,target?:BrowserTarget):SiteAuth[]{return store.browserAuthEntries(config.project.id,authProfile(config,target)).map(row=>({...row,handoff:!!row.handoff})) as unknown as SiteAuth[];}
export function setSiteAuth(store:PackStore,config:HostConfig,site:string,state:AuthState,handoff=false,target?:BrowserTarget){
  const profile=authProfile(config,target);requireCondition(site===authSite(`https://${site}`)&&/^[a-z0-9.-]+$/u.test(site),'AUTH_SITE_INVALID');
  requireCondition(['unchecked','needs_login','login_limited','challenge','ready','unknown','retry_requested','policy_blocked'].includes(state),'AUTH_STATE_INVALID');
  store.setBrowserAuth(config.project.id,profile!,site,state,handoff);
}
/** A user mode change never grants sign-in or drops an existing restriction.
 * An actual ready observation in the source mode can retire an older restriction
 * for this same profile, but the destination still requires fresh verification. */
export function migrateOwnedProfileAuthMode(store:PackStore,config:HostConfig,before:BrowserTarget,after:BrowserTarget){
  requireCondition(before.id===after.id&&before.profile_ref===after.profile_ref&&before.platform===after.platform&&before.engine==='playwright'&&after.engine==='playwright'&&before.environment==='owned_headless'&&after.environment==='owned_headless','AUTH_PROFILE_MODE_MISMATCH');
  if(authProfile(config,before)===authProfile(config,after))return {migrated_sites:0};
  const source=authSites(store,config,before),destination=authSites(store,config,after);
  requireCondition(![...source,...destination].some(row=>row.handoff),'AUTH_LOGIN_IN_PROGRESS');
  const sites=[...new Set([...source,...destination].map(row=>row.site))];
  for(const site of sites){
    const previous=source.find(row=>row.site===site),next=destination.find(row=>row.site===site);
    const restriction=authRestrictionRank(previous?.state)>=authRestrictionRank(next?.state)?previous:next;
    const freshReady=previous?.state==='ready'&&(!next||Date.parse(previous.updated_at)>=Date.parse(next.updated_at));
    const state:AuthState=!freshReady&&authRestrictionRank(restriction?.state)?restriction!.state:'unknown';
    if(previous?.state==='ready')setSiteAuth(store,config,site,'unknown',false,before);
    setSiteAuth(store,config,site,state,false,after);
  }
  return {migrated_sites:sites.length};
}
/** Only configured browser transports are offered for a human login. */
export function siteLoginTargets(config:HostConfig):BrowserTarget[]{
  const registered=config.browserExecutors?.targets??[browserTargetSchema.parse({id:'playwright',engine:'playwright',environment:'owned_headless',platform:process.platform,profile_ref:'default'})];
  if(registered.some(target=>target.environment==='ubuntu_vm'&&target.engine==='playwright')||!config.swarm?.visual.owned_vm)return registered;
  return [...registered,browserTargetSchema.parse({id:'login-owned-ubuntu-vm',engine:'playwright',environment:'ubuntu_vm',platform:'linux',profile_ref:config.swarm.visual.owned_vm.id})];
}
export function siteLoginTarget(config:HostConfig,id:string){const target=siteLoginTargets(config).find(item=>item.id===id);requireCondition(target,'AUTH_BROWSER_NOT_CONFIGURED');return target!;}
function configuredAuthSites(store:PackStore,config:HostConfig):SiteAuth[]{
  const profiles=new Map<string,SiteAuth[]>([[authProfile(config),authSites(store,config)]]);
  for(const target of siteLoginTargets(config))profiles.set(authProfile(config,target),authSites(store,config,target));
  return [...profiles.values()].flat();
}
const restrictedAuth=(row:SiteAuth)=>row.state==='login_limited'||row.state==='challenge';
const defaultSocialPreference=(preference?:BrowserPreference)=>!preference||preference.environment==='owned_headless'&&!preference.preferred_engine;
const matchesAuthPreference=(target:BrowserTarget,preference?:BrowserPreference)=>defaultSocialPreference(preference)||target.environment===preference!.environment&&(!preference!.preferred_engine||target.engine===preference!.preferred_engine);
/** Historical verification, scoped to one browser profile. Callers still recheck live pages. */
export function readyAuthTargets(store:PackStore,config:HostConfig,site:string){
  const observations=configuredAuthSites(store,config);
  if(observations.some(row=>row.handoff||row.site===site&&restrictedAuth(row)))return [];
  return siteLoginTargets(config).filter(target=>(isPersistentProfile(target)||target.environment==='ubuntu_vm'&&target.engine==='playwright'&&!!config.swarm?.visual.owned_vm||target.environment==='host_foreground'&&target.engine!=='playwright')&&authSites(store,config,target).some(row=>row.site===site&&row.state==='ready'))
    .sort((a,b)=>Number(b.engine==='aside'&&b.environment==='host_foreground')-Number(a.engine==='aside'&&a.environment==='host_foreground')||b.priority-a.priority||a.id.localeCompare(b.id));
}
export function requireSiteAuth(store:PackStore,config:HostConfig,urls:string[]){
  const current=new Map(authSites(store,config).map(site=>[site.site,site]));
  for(const value of urls){let site:string;try{site=authSite(value);}catch{continue;}if(!Object.hasOwn(knownLoginSites,site))continue;const existing=current.get(site);if(existing?.state==='policy_blocked'){setSiteAuth(store,config,site,'unchecked');current.set(site,{...existing,state:'unchecked'});}else if(!existing){setSiteAuth(store,config,site,'unchecked');current.set(site,{site,state:'unchecked',handoff:false,updated_at:new Date().toISOString()});}}
  return authSites(store,config).filter(item=>urls.some(url=>{try{return authSite(url)===item.site;}catch{return false;}}));
}
export function blockedAuthSites(store:PackStore,config:HostConfig,urls:string[],preference?:BrowserPreference):SiteAuth[]{
  const observations=configuredAuthSites(store,config),handoffs=observations.filter(site=>site.handoff);
  // A human owns the shared profile during login; no worker may race that interaction.
  if(handoffs.length&&urls.length)return handoffs;
  const requested=[...new Set(urls.flatMap(url=>{try{return [authSite(url)];}catch{return [];}}))];
  const social=requested.filter(site=>Object.hasOwn(knownLoginSites,site));
  const socialTargets=social.map(site=>readyAuthTargets(store,config,site));
  const sharedTargets=(socialTargets[0]??[]).filter(target=>browserHostCompatible(target)&&matchesAuthPreference(target,preference)&&socialTargets.every(targets=>targets.some(candidate=>candidate.id===target.id)));
  // A previous sign-in permits another access attempt, not a claim of permanent
  // authentication. Every actual navigation still checks for an auth gate.
  return requested.flatMap(site=>{
    const restricted=observations.find(row=>row.site===site&&restrictedAuth(row));if(restricted)return [restricted];
    if(Object.hasOwn(knownLoginSites,site)?sharedTargets.length:readyAuthTargets(store,config,site).some(target=>browserHostCompatible(target)&&matchesAuthPreference(target,preference)))return [];
    const useLegacy=defaultSocialPreference(preference)||preference?.environment==='ubuntu_vm'&&(!preference.preferred_engine||preference.preferred_engine==='playwright');
    const sites=useLegacy?authSites(store,config):siteLoginTargets(config).filter(target=>browserHostCompatible(target)&&matchesAuthPreference(target,preference)&&target.environment==='host_foreground'&&target.engine!=='playwright').flatMap(target=>authSites(store,config,target));
    const row=sites.find(item=>item.site===site);
    if(row?.state==='ready'&&!useLegacy&&social.includes(site))return [{...row,state:'unchecked' as const}];
    if(row?.state==='policy_blocked'){if(useLegacy)setSiteAuth(store,config,site,'unchecked');return [{...row,state:'unchecked' as const}];}
    return row?[row]:Object.hasOwn(knownLoginSites,site)?[{site,state:'unchecked' as const,handoff:false,updated_at:new Date(0).toISOString()}]:[];
  }).filter(site=>!['ready','retry_requested'].includes(site.state));
}
export function detectAuthGate(url:string,title:string,text:string,hasPassword=false):Exclude<AuthState,'unchecked'|'retry_requested'|'ready'>|null{
  if(/prove your humanity|verify you are human|security verification|checking your browser|just a moment|사람인지 확인/iu.test(`${title}\n${text.slice(0,6000)}`))return 'challenge';
  const path=new URL(url).pathname;
  if((hasPassword||/\/(?:i\/flow\/login|login|signin|sign-in)(?:\/|$)/iu.test(path))&&/temporarily limited your login|too many (?:failed )?login attempts|로그인(?:이|을)? 일시적으로 제한/iu.test(text.slice(0,6000)))return 'login_limited';
  if(hasPassword||/\/(?:i\/flow\/login|login|signin|sign-in)(?:\/|$)/iu.test(path))return 'needs_login';
  return null;
}

/** Verify the configured QEMU owner, never attach to a discovered personal Chrome. */
export async function connectOwnedBrowser(config:HostConfig):Promise<Browser>{
  const spec=await loginVmSpec(config);requireCondition(await ownedLoginVmRunning(spec),'AUTH_OWNED_VM_NOT_RUNNING');
  return (await import('playwright')).chromium.connectOverCDP(`http://127.0.0.1:${spec.devtools_port}`,{timeout:10_000});
}

function publicLoginAddress(address:string){
  if(isIP(address)===6)return /^[23][0-9a-f]{3}:/iu.test(address)&&!/^2001:db8:/iu.test(address);
  const [a,b]=address.split('.').map(Number);return isIP(address)===4&&a!==0&&a!==10&&a!==127&&!(a===169&&b===254)&&!(a===172&&b!>=16&&b!<=31)&&!(a===192&&b===168)&&!(a===100&&b!>=64&&b!<=127)&&!(a===198&&(b===18||b===19))&&a!<224;
}
async function registeredLoginSite(config:HostConfig,input:string){
  requireCondition(input.length<=2048,'AUTH_SITE_INVALID');const url=new URL(input.includes('://')?input:`https://${input}`);
  requireCondition(url.protocol==='https:'&&!url.username&&!url.password&&!url.port,'AUTH_URL_INVALID');
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/gu,'');
  const fixture=config.environment==='fixture'&&!!config.fixtureUrl&&new URL(config.fixtureUrl).hostname===host;
  if(!fixture){
    requireCondition(host.includes('.')&&!/(?:^|\.)(?:localhost|local|internal|localdomain|home|lan)$/u.test(host),'AUTH_SITE_PUBLIC_REQUIRED');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const addresses=isIP(host)?[{address:host}]:await Promise.race([lookup(host,{all:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('AUTH_SITE_PUBLIC_REQUIRED')),5000);timer.unref();})]);
      requireCondition(addresses.length>0&&addresses.every(item=>publicLoginAddress(item.address)),'AUTH_SITE_PUBLIC_REQUIRED');
    }catch{throw Error('AUTH_SITE_PUBLIC_REQUIRED');}finally{if(timer)clearTimeout(timer);}
  }
  return authSite(url.href);
}

export class BrowserLoginBroker {
  private browser:Promise<Browser>|null=null;
  private pages=new Map<string,Page>();
  private remote=new Map<string,McpBrowserExecutor>();
  private owned=new Map<string,{lease:PersistentProfileLease;page:Page}>();
  private claims=new Map<string,{site:string;target:BrowserTarget|undefined;updated_at:string}>();
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly prepare=prepareLoginVm){}
  private connect(){return this.browser??=connectOwnedBrowser(this.config).catch(error=>{this.browser=null;throw error;});}
  async register(input:string,targetId?:string){
    const target=targetId?siteLoginTarget(this.config,targetId):undefined,site=await registeredLoginSite(this.config,input);
    if(!authSites(this.store,this.config).some(row=>row.site===site))setSiteAuth(this.store,this.config,site,'unchecked');
    if(target&&!authSites(this.store,this.config,target).some(row=>row.site===site))setSiteAuth(this.store,this.config,site,'unchecked',false,target);
    return {site,target_id:target?.id??null,state:this.site(site,target).state,verified:false,registered:true};
  }
  private key(site:string,target?:BrowserTarget){return `${target?.id??'legacy-vm'}:${site}`;}
  private rememberClaim(site:string,target?:BrowserTarget){const row=this.site(site,target);if(row.handoff)this.claims.set(this.key(site,target),{site,target,updated_at:row.updated_at});}
  private releaseClaim(site:string,target?:BrowserTarget){
    const key=this.key(site,target),claim=this.claims.get(key),row=this.site(site,target);
    if(claim&&row.handoff&&row.updated_at===claim.updated_at)this.clearSavedClaim(site,target,claim.updated_at);
    this.claims.delete(key);
  }
  private clearSavedClaim(site:string,target:BrowserTarget|undefined,updatedAt:string){
    this.store.releaseBrowserHandoff(this.config.project.id,authProfile(this.config,target),site,updatedAt);
  }
  private site(site:string,target?:BrowserTarget){
    requireCondition(authSites(this.store,this.config).some(item=>item.site===site),'AUTH_SITE_NOT_REQUESTED');
    let row=authSites(this.store,this.config,target).find(item=>item.site===site);
    if(!row&&target){setSiteAuth(this.store,this.config,site,'unchecked',false,target);row=authSites(this.store,this.config,target).find(item=>item.site===site);}
    requireCondition(row,'AUTH_SITE_NOT_REQUESTED');return row!;
  }
  private loginLimited(site:string){return [undefined,...siteLoginTargets(this.config)].some(target=>authSites(this.store,this.config,target).some(row=>row.site===site&&row.state==='login_limited'));}
  private async page(site:string,create=true){
    const existing=this.pages.get(site);if(existing&&!existing.isClosed())return existing;
    const browser=await this.connect(),context=browser.contexts()[0];requireCondition(context,'AUTH_PROFILE_MISSING');
    let page=context!.pages().find(p=>{try{return authSite(p.url())===site;}catch{return false;}});
    requireCondition(page||create,'AUTH_LOGIN_PAGE_NOT_OPEN');
    page??=await context!.newPage();this.pages.set(site,page);return page;
  }
  async open(site:string,targetId?:string,options:{recheck_restricted?:boolean}={}){
    const target=targetId?siteLoginTarget(this.config,targetId):undefined,prior=this.site(site,target);
    requireCondition(!this.loginLimited(site)||options.recheck_restricted===true&&prior.state==='login_limited','AUTH_LOGIN_LIMITED');
    if(options.recheck_restricted)requireCondition(prior.state==='login_limited','AUTH_RECHECK_REQUIRES_SAME_LIMITED_PROFILE');
    requireCondition(!target||target.environment==='owned_headless'&&target.engine==='playwright'||target.environment==='ubuntu_vm'&&target.engine==='playwright'||target.environment==='host_foreground'&&target.engine!=='playwright','AUTH_BROWSER_TRANSPORT_UNAVAILABLE');
    if(target?.environment==='owned_headless'){requireCondition(isPersistentProfile(target),'AUTH_PERSISTENT_PROFILE_REQUIRED');requireCondition(hasHeadedDisplay(),'AUTH_HEADED_DISPLAY_UNAVAILABLE');}
    assertAutomatedBrowserAllowed(`https://${site}/`);
    const key=this.key(site,target);
    if(this.owned.get(key)?.page.isClosed())await this.finish(site,targetId);
    if(this.owned.has(key)){await this.owned.get(key)!.page.bringToFront();return {site,target_id:target!.id,environment:target!.environment,vnc:null,state:'human_login',profile_preserved:true,session_mode:'persistent',login_mode:'headed'};}
    // Acquire Chromium's profile lock before claiming a saved-profile handoff.
    // A failed cross-process launch must not overwrite another human's claim.
    let prepared:PersistentProfileLease|null=null;
    if(target?.environment==='owned_headless')prepared=await acquirePersistentProfile(this.config,target,'human');
    try{
      this.store.claimBrowserHandoff(this.config.project.id,authProfile(this.config,target),site);
      if(['login_limited','challenge','policy_blocked'].includes(prior.state))setSiteAuth(this.store,this.config,site,prior.state,true,target);
      this.rememberClaim(site,target);
      const known=knownLoginSites[site as keyof typeof knownLoginSites];
      if(prepared){
        const page=await prepared.context.newPage();this.owned.set(key,{lease:prepared,page});prepared=null;
        await page.goto(known?.login??`https://${site}/`,{waitUntil:'domcontentloaded',timeout:20000});await page.bringToFront();
        return {site,target_id:target!.id,environment:target!.environment,vnc:null,state:'human_login',profile_preserved:true,session_mode:'persistent',login_mode:'headed'};
      }
      if(target?.environment==='host_foreground'){
        const key=`${target.id}:${site}`;let port=this.remote.get(key);
        if(!port){port=new McpBrowserExecutor(target);try{await port.open(known?.login??`https://${site}/`);this.remote.set(key,port);}catch(error){await port.close().catch(()=>{});throw error;}}
        return {site,target_id:target.id,environment:target.environment,vnc:null,state:'human_login',profile_preserved:true,login_mode:'connected'};
      }
      await this.prepare(this.config);
      const page=await this.page(site);
      if(page.url()==='about:blank')await page.goto(known?.login??`https://${site}/`,{waitUntil:'domcontentloaded',timeout:20_000});
      await page.bringToFront();return {site,target_id:target?.id??null,environment:'ubuntu_vm',vnc:`127.0.0.1:${this.config.swarm!.visual.owned_vm!.vnc_port}`,state:'human_login',profile_preserved:true,login_mode:'vm'};
    }catch(error){
      await prepared?.release().catch(()=>{});const owned=this.owned.get(key);if(owned){this.owned.delete(key);await owned.page.close().catch(()=>{});await owned.lease.release().catch(()=>{});}
      const claim=this.claims.get(key);if(claim&&this.site(site,target).updated_at===claim.updated_at)setSiteAuth(this.store,this.config,site,prior.state,prior.handoff,target);this.claims.delete(key);throw error;
    }
  }
  recheck(site:string,targetId?:string){return this.open(site,targetId,{recheck_restricted:true});}
  async check(site:string,targetId?:string){
    const target=targetId?siteLoginTarget(this.config,targetId):undefined,prior=this.site(site,target),known=knownLoginSites[site as keyof typeof knownLoginSites];
    let url:string,title:string,text:string,signedIn=false,hasPassword=false;
    if(target?.environment==='owned_headless'){
      const session=this.owned.get(this.key(site,target));requireCondition(session,'AUTH_LOGIN_PAGE_NOT_OPEN');const page=session.page;
      signedIn=known?await page.locator(known.signed_in).first().isVisible().catch(()=>false):false;
      hasPassword=await page.locator('input[type="password"]').first().isVisible().catch(()=>false);
      url=page.url();title=await page.title();text=await page.locator('body').innerText({timeout:5000}).catch(()=>'');
    }else if(target?.environment==='host_foreground'){
      const port=this.remote.get(`${target.id}:${site}`);requireCondition(port,'AUTH_LOGIN_PAGE_NOT_OPEN');
      const observed=await port!.observe();({url,title,text}=observed);
      if(known&&!detectAuthGate(url,title,text)) signedIn=await port!.extract({ready:known.signed_in,auth_gate:'input[type="password"]',auth_required:false,account_selector:'',account_text:'',rows:known.signed_in,columns:{},max_rows:100}).then(rows=>rows.length>0).catch(()=>false);
    }else{
      requireCondition(!target||target.environment==='ubuntu_vm'&&target.engine==='playwright','AUTH_BROWSER_TRANSPORT_UNAVAILABLE');
      const page=await this.page(site,false);
    // Never read password values, cookies, storage, screenshots, or account names.
      signedIn=known?await page.locator(known.signed_in).first().isVisible().catch(()=>false):false;
      hasPassword=await page.locator('input[type="password"]').first().isVisible().catch(()=>false);
      url=page.url();title=await page.title();text=await page.locator('body').innerText({timeout:5000}).catch(()=>'');
    }
    const gate=detectAuthGate(url!,title!,text!,hasPassword);
    let sameSite=false;try{sameSite=authSite(url!)===site;}catch{}
    const observed:AuthState=sameSite?(gate??(signedIn?'ready':'unknown')):'unknown';
    // An unrelated/ambiguous page or a weaker login gate cannot clear a saved
    // restriction. Only an actual same-site signed-in observation may do so.
    const state:AuthState=observed==='ready'?observed:authRestrictionRank(prior.state)>authRestrictionRank(observed)?prior.state:observed;
    setSiteAuth(this.store,this.config,site,state,prior.handoff&&state!=='ready',target);
    if(prior.handoff&&state!=='ready')this.rememberClaim(site,target);
    if(target?.environment==='owned_headless'&&state==='ready')await this.finish(site,targetId);
    return {site,target_id:target?.id??null,state,verified:state==='ready'};
  }
  async finish(site:string,targetId?:string,options:{explicit_release?:boolean}={}){
    const target=targetId?siteLoginTarget(this.config,targetId):undefined,key=this.key(site,target),before=this.site(site,target);
    // An explicit finish after a broker crash needs fresh exclusive ownership.
    // A still-live Chromium owner rejects this without touching its lock files.
    if(options.explicit_release&&target&&isPersistentProfile(target)&&before.handoff&&!this.owned.has(key)&&!this.claims.has(key)){
      const lease=await acquirePersistentProfile(this.config,target,'human');await lease.release();
      this.clearSavedClaim(site,target,before.updated_at);
    }
    const owned=this.owned.get(key);if(owned){await owned.page.close().catch(()=>{});await owned.lease.release();this.owned.delete(key);}
    const remote=this.remote.get(key);if(remote){await remote.close();this.remote.delete(key);}
    // VM login pages predate this broker and may belong to the user; leave them.
    this.releaseClaim(site,target);
    // Only the explicit human endpoint may release a saved remote/VM hold after
    // a broker restart. It does not close foreign tabs or create a ready state.
    if(options.explicit_release&&(!target||!isPersistentProfile(target)))this.clearSavedClaim(site,target,before.updated_at);
    const row=this.site(site,target);
    return {site,target_id:target?.id??null,state:row.state,verified:row.state==='ready',profile_preserved:true,handoff:row.handoff};
  }
  retry(site:string,targetId?:string){const target=targetId?siteLoginTarget(this.config,targetId):undefined,row=this.site(site,target);requireCondition(!row.handoff,'AUTH_LOGIN_IN_PROGRESS');requireCondition(!this.loginLimited(site),'AUTH_LOGIN_LIMITED');requireCondition(!['challenge','policy_blocked'].includes(row.state),'AUTH_USER_VERIFICATION_REQUIRED');setSiteAuth(this.store,this.config,site,'retry_requested',false,target);return {site,target_id:target?.id??null,state:'retry_requested',verified:false};}
  async close(){
    await Promise.allSettled([...this.claims.values()].map(claim=>this.finish(claim.site,claim.target?.id)));
    if(this.browser)await (await this.browser.catch(()=>null))?.close().catch(()=>{});this.browser=null;
    await Promise.allSettled([...this.remote.values()].map(port=>port.close()));this.remote.clear();
  }
}
