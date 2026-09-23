import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {chromium,type Browser,type Page} from 'playwright';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {type PackStore} from '../packs/store.js';
import {assertAutomatedBrowserAllowed} from './account-browser-policy.js';

export type AuthState='unchecked'|'needs_login'|'challenge'|'ready'|'unknown'|'retry_requested'|'policy_blocked';
export interface SiteAuth {site:string;state:AuthState;handoff:boolean;updated_at:string;}
export const knownLoginSites={
  'x.com':{label:'X',login:'https://x.com/i/flow/login',signed_in:'[data-testid="SideNav_AccountSwitcher_Button"]'},
  'reddit.com':{label:'Reddit',login:'https://www.reddit.com/login/',signed_in:'[data-testid="user-drawer-content"] a[href*="/user/"], shreddit-user-menu button[aria-label*="profile" i]'},
  'stocktwits.com':{label:'Stocktwits',login:'https://stocktwits.com/signin',signed_in:'a[href="/settings"], a[href="/settings/profile"], button[aria-label="Profile"]'},
} as const;
export function authSite(value:string){const url=new URL(value);requireCondition(url.protocol==='https:'&&!url.username&&!url.password,'AUTH_URL_INVALID');return url.hostname.toLowerCase().replace(/^www\./u,'');}
export function authProfile(config:HostConfig){const vm=config.swarm?.visual.owned_vm;return createHash('sha256').update(JSON.stringify(vm??{policy_only:true,project_id:config.project.id})).digest('hex');}
export function authSites(store:PackStore,config:HostConfig):SiteAuth[]{return store.browserAuthEntries(config.project.id,authProfile(config)).map(row=>({...row,handoff:!!row.handoff})) as unknown as SiteAuth[];}
export function setSiteAuth(store:PackStore,config:HostConfig,site:string,state:AuthState,handoff=false){
  const profile=authProfile(config);requireCondition(site===authSite(`https://${site}`)&&/^[a-z0-9.-]+$/u.test(site),'AUTH_SITE_INVALID');
  requireCondition(['unchecked','needs_login','challenge','ready','unknown','retry_requested','policy_blocked'].includes(state),'AUTH_STATE_INVALID');
  store.setBrowserAuth(config.project.id,profile!,site,state,handoff);
}
export function requireSiteAuth(store:PackStore,config:HostConfig,urls:string[]){
  const current=new Map(authSites(store,config).map(site=>[site.site,site]));
  for(const value of urls){let site:string;try{site=authSite(value);}catch{continue;}if(!Object.hasOwn(knownLoginSites,site))continue;const existing=current.get(site);if(existing?.state==='policy_blocked'){setSiteAuth(store,config,site,'unchecked');current.set(site,{...existing,state:'unchecked'});}else if(!existing){setSiteAuth(store,config,site,'unchecked');current.set(site,{site,state:'unchecked',handoff:false,updated_at:new Date().toISOString()});}}
  return authSites(store,config).filter(item=>urls.some(url=>{try{return authSite(url)===item.site;}catch{return false;}}));
}
export function blockedAuthSites(store:PackStore,config:HostConfig,urls:string[]):SiteAuth[]{
  const sites=authSites(store,config),handoffs=sites.filter(site=>site.handoff);
  // A human owns the shared profile during login; no worker may race that interaction.
  if(handoffs.length&&urls.length)return handoffs;
  const requested=[...new Set(urls.flatMap(url=>{try{return [authSite(url)];}catch{return [];}}))];
  // A previous sign-in permits another access attempt, not a claim of permanent
  // authentication. Every actual navigation still checks for an auth gate.
  return requested.flatMap(site=>{const row=sites.find(item=>item.site===site);if(row?.state==='policy_blocked'){setSiteAuth(store,config,site,'unchecked');return [{...row,state:'unchecked' as const}];}return row?[row]:Object.hasOwn(knownLoginSites,site)?[{site,state:'unchecked' as const,handoff:false,updated_at:new Date(0).toISOString()}]:[];}).filter(site=>!['ready','retry_requested'].includes(site.state));
}
export function detectAuthGate(url:string,title:string,text:string,hasPassword=false):Exclude<AuthState,'unchecked'|'retry_requested'|'ready'>|null{
  if(/prove your humanity|verify you are human|security verification|checking your browser|just a moment|사람인지 확인/iu.test(`${title}\n${text.slice(0,6000)}`))return 'challenge';
  const path=new URL(url).pathname;
  if(hasPassword||/\/(?:i\/flow\/login|login|signin|sign-in)(?:\/|$)/iu.test(path))return 'needs_login';
  return null;
}

/** Verify the configured QEMU owner, never attach to a discovered personal Chrome. */
export async function connectOwnedBrowser(config:HostConfig):Promise<Browser>{
  const vm=config.swarm?.visual.owned_vm;requireCondition(vm&&isAbsolute(vm.storage_root),'AUTH_OWNED_VM_REQUIRED');
  const root=join(vm!.storage_root,vm!.id),manifest=JSON.parse(await readFile(join(root,'vm-manifest.json'),'utf8')) as Record<string,unknown>;
  requireCondition(manifest.id===vm!.id&&manifest.devtools_port===vm!.devtools_port&&manifest.vnc_port===vm!.vnc_port&&manifest.isolation==='qemu_kvm_no_shared_folders_loopback_forwards','AUTH_VM_MANIFEST_MISMATCH');
  requireCondition(process.platform==='linux','AUTH_VM_HOST_UNSUPPORTED');
  const processes=await readdir('/proc');let owned=false;
  for(const pid of processes.filter(name=>/^\d+$/u.test(name))){
    const args=await readFile(`/proc/${pid}/cmdline`,'utf8').catch(()=>'');const parts=args.split('\0');
    if(parts[parts.indexOf('-name')+1]===`agent-driver-${vm!.id}`&&parts.includes(`file=${join(root,'browser.qcow2')},if=virtio,format=qcow2`)&&parts.some(part=>part.includes(`hostfwd=tcp:127.0.0.1:${vm!.devtools_port}-:`)))owned=true;
  }
  requireCondition(owned,'AUTH_OWNED_VM_NOT_RUNNING');
  return chromium.connectOverCDP(`http://127.0.0.1:${vm!.devtools_port}`,{timeout:10_000});
}

export class BrowserLoginBroker {
  private browser:Promise<Browser>|null=null;
  private pages=new Map<string,Page>();
  constructor(readonly store:PackStore,readonly config:HostConfig){}
  private connect(){return this.browser??=connectOwnedBrowser(this.config).catch(error=>{this.browser=null;throw error;});}
  private site(site:string){const row=authSites(this.store,this.config).find(item=>item.site===site);requireCondition(row,'AUTH_SITE_NOT_REQUESTED');return row!;}
  private async page(site:string){
    const existing=this.pages.get(site);if(existing&&!existing.isClosed())return existing;
    const browser=await this.connect(),context=browser.contexts()[0];requireCondition(context,'AUTH_PROFILE_MISSING');
    const page=context!.pages().find(p=>{try{return authSite(p.url())===site;}catch{return false;}})??await context!.newPage();this.pages.set(site,page);return page;
  }
  async open(site:string){
    this.site(site);
    assertAutomatedBrowserAllowed(`https://${site}/`);
    this.store.claimBrowserHandoff(this.config.project.id,authProfile(this.config)!,site);
    const page=await this.page(site),known=knownLoginSites[site as keyof typeof knownLoginSites];
    if(page.url()==='about:blank')await page.goto(known?.login??`https://${site}/`,{waitUntil:'domcontentloaded',timeout:20_000}).catch(()=>{});
    await page.bringToFront();return {site,vnc:`127.0.0.1:${this.config.swarm!.visual.owned_vm!.vnc_port}`,state:'human_login',profile_preserved:true};
  }
  async check(site:string){
    const prior=this.site(site);const page=await this.page(site),known=knownLoginSites[site as keyof typeof knownLoginSites];
    // Never read password values, cookies, storage, screenshots, or account names.
    const signedIn=known?await page.locator(known.signed_in).first().isVisible().catch(()=>false):false;
    const hasPassword=await page.locator('input[type="password"]').first().isVisible().catch(()=>false);
    const title=await page.title(),text=await page.locator('body').innerText({timeout:5000}).catch(()=>'');
    const gate=detectAuthGate(page.url(),title,text,hasPassword);
    let sameSite=false;try{sameSite=authSite(page.url())===site;}catch{}
    const state:AuthState=gate??(sameSite&&signedIn?'ready':'unknown');
    setSiteAuth(this.store,this.config,site,state,prior.handoff&&state!=='ready');
    return {site,state,verified:state==='ready'};
  }
  retry(site:string){this.site(site);setSiteAuth(this.store,this.config,site,'retry_requested');return {site,state:'retry_requested',verified:false};}
  async close(){if(this.browser)await (await this.browser.catch(()=>null))?.close().catch(()=>{});this.browser=null;}
}
