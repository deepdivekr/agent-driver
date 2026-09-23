import {createHash,randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,type Browser,type BrowserContext,type Page} from 'playwright';
import {requireCondition} from '../core/contracts.js';
import {type BrowserGate} from './protocol.js';
import {dismissHumanConfirmedJavaScriptDialogOverLoopbackRfb,focusSavedPasswordFieldOverLoopbackRfb,hoverSavedPasswordSuggestionOverLoopbackRfb,loopbackRfbDisplayGeometry,loopbackRfbObservationFingerprint,savedPasswordFieldTarget,savedPasswordSuggestionProbeTarget,savedPasswordSuggestionTarget,selectFirstSavedPasswordSuggestionOverLoopbackRfb,type BrowserFieldBox,type BrowserWindowMetrics,type SavedPasswordSuggestionPolicy} from './vm-visual-auth.js';

export interface KnownPopup {id:string;dialog:string;dismiss:string;}
export type OwnedCapturePolicy='always'|'on_state_change_or_hold';
export interface PreviousOwnedState {gate:BrowserGate;fingerprint:string;}
export interface OwnedNavigationPlan {
  url:string; allowed_origins:readonly string[]; logged_in:string; authentication_request:string;
  known_popups:readonly KnownPopup[]; unknown_dialog:string;
  /** Public-source Packs may explicitly opt out of the usual signed-in gate. */
  requires_logged_in?:boolean;
  /** Explicit bounded navigation budget for a reviewed source; never a retry loop. */
  navigation_timeout_ms?:number;
  /** The default keeps existing approval evidence intact; polling passes a prior state. */
  capture_policy?:OwnedCapturePolicy; previous_state?:PreviousOwnedState;
  /** Public read-only collection may retain its observation if an optional evidence capture times out. */
  allow_capture_failure?:boolean;
}
export interface OwnedNavigationTiming {attach_or_launch_ms:number;navigation_ms:number;popup_policy_ms:number;capture_ms:number;state_probe_ms:number;total_ms:number;}
export interface OwnedNavigationResult {gate:BrowserGate;closed_popups:readonly string[];url:string;capture_ref?:string;capture_sha256?:string;capture_disposition:'captured'|'skipped_stable'|'capture_failed_optional';state_fingerprint:string;timing:OwnedNavigationTiming;}
export interface OwnedVmPageSignal {id:string;selector:string;}
export interface OwnedVmVisibleLinkPlan {label:string;allowed_origins:readonly string[];expected_path_prefix?:string;}
/** Pack-owned, reviewable policy for the one browser-chrome action we allow. */
export interface OwnedVmSavedPasswordLoginPlan {
  password_selector:string;login_selector:string;suggestion:SavedPasswordSuggestionPolicy;
}
/** Optional recording is for owned, local fixture demonstrations only. */
export interface OwnedPersistentPageOptions {
  /** Host-reviewed fill-only run: reject form submissions and non-read HTTP requests. */
  draftOnly?:boolean;
  recordVideoDir?:string;
  recordVideoSize?:{width:number;height:number};
}

function stateFingerprint(gate:BrowserGate,url:string,closedPopups:readonly string[],authVisible:boolean,loggedIn:boolean){
  return createHash('sha256').update(JSON.stringify({gate,url,closed_popups:closedPopups,auth_visible:authVisible,logged_in:loggedIn})).digest('hex');
}
function shouldCapture(plan:OwnedNavigationPlan,gate:BrowserGate,fingerprint:string){
  if((plan.capture_policy??'always')==='always')return true;
  if(gate==='waiting_orchestrator')return true;
  return plan.previous_state?.gate!==gate||plan.previous_state.fingerprint!==fingerprint;
}
function assertVmSavedPasswordLoginPlan(plan:OwnedVmSavedPasswordLoginPlan){
  for(const selector of [plan.password_selector,plan.login_selector])requireCondition(typeof selector==='string'&&selector.length>0&&selector.length<=500&&!/[\r\n]/u.test(selector),'INVALID_VM_SAVED_PASSWORD_SELECTOR');
}
function assertVmVisibleLinkPlan(plan:OwnedVmVisibleLinkPlan){
  requireCondition(typeof plan.label==='string'&&plan.label.length>0&&plan.label.length<=80&&!/[\r\n]/u.test(plan.label),'INVALID_VM_LINK_LABEL');
  requireCondition(Array.isArray(plan.allowed_origins)&&plan.allowed_origins.length>0&&plan.allowed_origins.length<=8&&plan.allowed_origins.every(origin=>{
    try {return new URL(origin).origin===origin;}catch{return false;}
  }),'INVALID_VM_LINK_ORIGINS');
  requireCondition(plan.expected_path_prefix===undefined||(typeof plan.expected_path_prefix==='string'&&/^\/[A-Za-z0-9._/-]{1,200}$/u.test(plan.expected_path_prefix)),'INVALID_VM_LINK_PATH_PREFIX');
}

type RawCdpResponse={id?:number;result?:unknown;error?:{message?:string};};
type RawCdpTarget={targetId?:string;type?:string;url?:string;};

/**
 * Playwright's attach handshake can wait behind a page-modal JavaScript dialog.
 * This deliberately tiny browser-protocol client is therefore used only to
 * decline the Pack-approved dialog.  It offers no page evaluation, DOM access,
 * credential access, or general CDP command surface to callers.
 */
async function declineExactJavaScriptDialogOverCdp(endpoint:string,origin:string,pathname:string){
  const version=await (await fetch(new URL('/json/version',endpoint))).json() as {webSocketDebuggerUrl?:unknown};
  requireCondition(typeof version.webSocketDebuggerUrl==='string','VM_CDP_BROWSER_ENDPOINT_UNAVAILABLE');
  const socket=new WebSocket(version.webSocketDebuggerUrl);
  const opened=await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('VM_CDP_DIALOG_CONNECT_TIMEOUT')),5_000);
    socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('VM_CDP_DIALOG_CONNECT_FAILED'));},{once:true});
  });
  void opened;
  let sequence=0;
  const invoke=<T>(method:string,params?:Record<string,unknown>,sessionId?:string)=>new Promise<T>((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>finish(Error(`VM_CDP_DIALOG_${method}_TIMEOUT`)),5_000);
    const onMessage=(event:MessageEvent)=>{
      let response:RawCdpResponse;
      try {response=JSON.parse(String(event.data)) as RawCdpResponse;}catch{return;}
      if(response.id!==id)return;
      finish(response.error?Error(response.error.message??`VM_CDP_DIALOG_${method}_FAILED`):undefined,response.result as T);
    };
    const finish=(error?:Error,result?:T)=>{
      clearTimeout(timer);socket.removeEventListener('message',onMessage);
      if(error)reject(error);else resolve(result as T);
    };
    socket.addEventListener('message',onMessage);
    try {socket.send(JSON.stringify({id,method,...(params?{params}:{}),...(sessionId?{sessionId}:{})}));}
    catch(error){finish(error instanceof Error?error:Error('VM_CDP_DIALOG_SEND_FAILED'));}
  });
  let attachedSessionId:string|undefined;
  try {
    const targets=await invoke<{targetInfos?:RawCdpTarget[]}>('Target.getTargets');
    const matches=(targets.targetInfos??[]).filter(target=>{
      if(target.type!=='page'||typeof target.targetId!=='string'||typeof target.url!=='string')return false;
      try {const current=new URL(target.url);return current.origin===origin&&current.pathname===pathname;}catch{return false;}
    });
    requireCondition(matches.length===1,'VM_HUMAN_AUTH_PAGE_AMBIGUOUS');
    const attached=await invoke<{sessionId?:string}>('Target.attachToTarget',{targetId:matches[0]!.targetId!,flatten:true});
    requireCondition(typeof attached.sessionId==='string'&&attached.sessionId.length>0,'VM_CDP_DIALOG_ATTACH_FAILED');
    attachedSessionId=attached.sessionId;
    await invoke('Page.handleJavaScriptDialog',{accept:false},attachedSessionId);
  } finally {
    if(attachedSessionId)await invoke('Target.detachFromTarget',{sessionId:attachedSessionId}).catch(()=>undefined);
    socket.close();
  }
}

/**
 * A minimal, pack-driven Playwright boundary.  It launches only the supplied
 * agent profile, never attaches to a user context, and has no raw CDP/eval API.
 * Page-specific selectors arrive from a reviewed Task Pack adapter.
 */
export class OwnedPersistentPage {
  #context:BrowserContext|undefined;
  #page:Page|undefined;
  #videoPath:string|undefined;
  constructor(readonly profileDir:string,readonly captureRoot:string,readonly headless=true,readonly options:OwnedPersistentPageOptions={}){}
  async open(taskId:string,plan:OwnedNavigationPlan):Promise<OwnedNavigationResult>{
    const target=new URL(plan.url);requireCondition(plan.allowed_origins.includes(target.origin),'ORIGIN_NOT_DELEGATED');
    requireCondition(plan.navigation_timeout_ms===undefined||(Number.isInteger(plan.navigation_timeout_ms)&&plan.navigation_timeout_ms>=5_000&&plan.navigation_timeout_ms<=30_000),'INVALID_NAVIGATION_TIMEOUT');
    const started=performance.now();
    await mkdir(this.profileDir,{recursive:true,mode:0o700});await mkdir(this.captureRoot,{recursive:true,mode:0o700});
    if(this.options.recordVideoDir!==undefined)await mkdir(this.options.recordVideoDir,{recursive:true,mode:0o700});
    const recording=this.options.recordVideoDir===undefined?{}:{recordVideo:{dir:this.options.recordVideoDir,...(this.options.recordVideoSize===undefined?{}:{size:this.options.recordVideoSize})}};
    this.#context=await chromium.launchPersistentContext(this.profileDir,{headless:this.headless,...recording,...(this.options.draftOnly?{serviceWorkers:'block' as const}:{})});
    if(this.options.draftOnly){
      await this.#context.route('**/*',route=>['GET','HEAD','OPTIONS'].includes(route.request().method())?route.continue():route.abort('blockedbyclient'));
      await this.#context.routeWebSocket('**/*',socket=>socket.close());
      await this.#context.addInitScript(()=>{
        document.addEventListener('submit',event=>{event.preventDefault();event.stopImmediatePropagation();},true);
        HTMLFormElement.prototype.submit=function(){throw new Error('DRAFT_ONLY_SUBMISSION_BLOCKED');};
        HTMLFormElement.prototype.requestSubmit=function(){throw new Error('DRAFT_ONLY_SUBMISSION_BLOCKED');};
      });
    }
    this.#page=this.#context.pages()[0]??await this.#context.newPage();this.#page.setDefaultTimeout(5_000);
    const attached=performance.now(),navigationStarted=performance.now();
    await this.#page.goto(plan.url,{waitUntil:'domcontentloaded',timeout:plan.navigation_timeout_ms??5_000});
    requireCondition(new URL(this.#page.url()).origin===target.origin,'TARGET_URL_CHANGED');
    const navigated=performance.now(),popupStarted=performance.now();
    const closed:string[]=[];
    for(const popup of plan.known_popups){
      const dialog=this.#page.locator(popup.dialog);
      if(await dialog.isVisible().catch(()=>false)){
        const dismiss=dialog.locator(popup.dismiss);requireCondition(await dismiss.isVisible().catch(()=>false),'KNOWN_POPUP_DISMISS_UNAVAILABLE');
        await dismiss.click();await dialog.waitFor({state:'hidden'});closed.push(popup.id);
      }
    }
    const popupDone=performance.now(),stateStarted=performance.now();
    const unknownVisible=await this.#page.locator(plan.unknown_dialog).isVisible().catch(()=>false);
    const authVisible=await this.#page.locator(plan.authentication_request).isVisible().catch(()=>false);
    const loggedIn=await this.#page.locator(plan.logged_in).isVisible().catch(()=>false);
    const stateDone=performance.now(),gate:BrowserGate=unknownVisible?'waiting_orchestrator':(plan.requires_logged_in??true)&&(authVisible||!loggedIn)?'waiting_auth':'ready',fingerprint=stateFingerprint(gate,this.#page.url(),closed,authVisible,loggedIn);
    const captureStarted=performance.now();let captured:Awaited<ReturnType<OwnedPersistentPage['capture']>>|undefined,captureFailed=false;
    if(shouldCapture(plan,gate,fingerprint)){try {captured=await this.capture(taskId);} catch {requireCondition(plan.allow_capture_failure===true,'OWNED_CAPTURE_REQUIRED');captureFailed=true;}}
    const captureDone=performance.now();
    const timing=()=>({attach_or_launch_ms:Math.round(attached-started),navigation_ms:Math.round(navigated-navigationStarted),popup_policy_ms:Math.round(popupDone-popupStarted),capture_ms:Math.round(captureDone-captureStarted),state_probe_ms:Math.round(stateDone-stateStarted),total_ms:Math.round(performance.now()-started)});
    // No authentication prompt is a normal optional branch.  Only an observed
    // logged-in state allows navigation to progress.
    return {gate,closed_popups:closed,url:this.#page.url(),...(captured??{}),capture_disposition:captured?'captured':captureFailed?'capture_failed_optional':'skipped_stable',state_fingerprint:fingerprint,timing:timing()};
  }
  get page(){requireCondition(this.#page,'OWNED_PAGE_NOT_OPEN');return this.#page;}
  get videoPath(){return this.#videoPath;}
  async capture(taskId:string){
    const captureDir=join(this.captureRoot,taskId);await mkdir(captureDir,{recursive:true,mode:0o700});
    const captureRef=resolve(captureDir,`pre-submit-${randomUUID()}.png`);await this.page.screenshot({path:captureRef,fullPage:true});
    const bytes=await (await import('node:fs/promises')).readFile(captureRef),capture_sha256=createHash('sha256').update(bytes).digest('hex');
    return {capture_ref:captureRef,capture_sha256};
  }
  async close(){
    const video=this.#page?.video()??undefined;
    try{await this.#context?.close();if(video!==undefined)this.#videoPath=await video.path();}
    finally{this.#context=undefined;this.#page=undefined;}
  }
}

/**
 * The VM variant connects only to the QEMU loopback-forwarded debug port. It
 * never discovers a Chrome instance or attaches to a user browser. The agent
 * page is newly created for each task; a person may have authenticated in a
 * different page of the same guest-owned persistent profile.
 */
export class OwnedVmCdpPage {
  #browser:Browser|undefined;
  #page:Page|undefined;
  readonly endpoint:string;
  constructor(readonly vmId:string,devtoolsPort:number,readonly captureRoot:string){
    requireCondition(/^[a-z][a-z0-9-]{0,62}$/u.test(vmId),'INVALID_VM_ID');requireCondition(Number.isInteger(devtoolsPort)&&devtoolsPort>=1024&&devtoolsPort<=65535,'INVALID_VM_DEVTOOLS_PORT');
    this.endpoint=`http://127.0.0.1:${devtoolsPort}`;
  }
  async open(taskId:string,plan:OwnedNavigationPlan):Promise<OwnedNavigationResult>{
    const target=new URL(plan.url);requireCondition(plan.allowed_origins.includes(target.origin),'ORIGIN_NOT_DELEGATED');
    const started=performance.now();
    await mkdir(this.captureRoot,{recursive:true,mode:0o700});
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    const contexts=this.#browser.contexts();requireCondition(contexts.length===1,'VM_BROWSER_CONTEXT_AMBIGUOUS');
    const context=contexts[0]!;this.#page=await context.newPage();this.#page.setDefaultTimeout(5_000);
    const attached=performance.now(),navigationStarted=performance.now();await this.#page.goto(plan.url,{waitUntil:'domcontentloaded'});requireCondition(new URL(this.#page.url()).origin===target.origin,'TARGET_URL_CHANGED');
    const navigated=performance.now(),popupStarted=performance.now();
    const closed:string[]=[];
    for(const popup of plan.known_popups){
      const dialog=this.#page.locator(popup.dialog);
      if(await dialog.isVisible().catch(()=>false)){
        const dismiss=dialog.locator(popup.dismiss);requireCondition(await dismiss.isVisible().catch(()=>false),'KNOWN_POPUP_DISMISS_UNAVAILABLE');await dismiss.click();await dialog.waitFor({state:'hidden'});closed.push(popup.id);
      }
    }
    const popupDone=performance.now(),stateStarted=performance.now();
    const unknownVisible=await this.#page.locator(plan.unknown_dialog).isVisible().catch(()=>false);
    const authVisible=await this.#page.locator(plan.authentication_request).isVisible().catch(()=>false),loggedIn=await this.#page.locator(plan.logged_in).isVisible().catch(()=>false);
    const stateDone=performance.now(),gate:BrowserGate=unknownVisible?'waiting_orchestrator':(plan.requires_logged_in??true)&&(authVisible||!loggedIn)?'waiting_auth':'ready',fingerprint=stateFingerprint(gate,this.#page.url(),closed,authVisible,loggedIn);
    const captureStarted=performance.now();let captured:Awaited<ReturnType<OwnedVmCdpPage['capture']>>|undefined,captureFailed=false;
    if(shouldCapture(plan,gate,fingerprint)){try {captured=await this.capture(taskId);} catch {requireCondition(plan.allow_capture_failure===true,'OWNED_CAPTURE_REQUIRED');captureFailed=true;}}
    const captureDone=performance.now();
    const timing=()=>({attach_or_launch_ms:Math.round(attached-started),navigation_ms:Math.round(navigated-navigationStarted),popup_policy_ms:Math.round(popupDone-popupStarted),capture_ms:Math.round(captureDone-captureStarted),state_probe_ms:Math.round(stateDone-stateStarted),total_ms:Math.round(performance.now()-started)});
    return {gate,closed_popups:closed,url:this.#page.url(),...(captured??{}),capture_disposition:captured?'captured':captureFailed?'capture_failed_optional':'skipped_stable',state_fingerprint:fingerprint,timing:timing()};
  }
  get page(){requireCondition(this.#page,'OWNED_VM_PAGE_NOT_OPEN');return this.#page;}
  async capture(taskId:string){
    const captureDir=join(this.captureRoot,taskId);await mkdir(captureDir,{recursive:true,mode:0o700});const captureRef=resolve(captureDir,`pre-submit-${randomUUID()}.png`);await this.page.screenshot({path:captureRef,fullPage:true});
    const bytes=await (await import('node:fs/promises')).readFile(captureRef),capture_sha256=createHash('sha256').update(bytes).digest('hex');return {capture_ref:captureRef,capture_sha256};
  }
  async close(){
    try {await this.#page?.close();} finally {try {await this.#browser?.close();} finally {this.#browser=undefined;this.#page=undefined;}}
  }
  /** Leave an agent-owned guest page visible for the human authentication step. */
  async detach(){
    try {await this.#browser?.close();} finally {this.#browser=undefined;this.#page=undefined;}
  }
  /**
   * Browser-native JavaScript confirmations are outside the DOM, so the
   * adapter exposes one narrow policy action rather than raw CDP to callers.
   * It can dismiss only an exactly-one, agent-owned VM page at the approved
   * origin and path; it never reads a credential field or dialog message.
   */
  async dismissKnownJavaScriptDialog(origin:string,pathname:string,humanVisualConfirmation?:{vnc_port:number}){
    const expected=new URL(origin);requireCondition(expected.origin===origin&&pathname.startsWith('/'),'INVALID_DIALOG_POLICY');
    try {
      await declineExactJavaScriptDialogOverCdp(this.endpoint,origin,pathname);
      return {origin,pathname,action:'dismiss' as const,via:'cdp' as const};
    } catch(error) {
      // Chromium can render a JavaScript dialog in the guest while withholding
      // it from a newly attached CDP session.  Fall back only after the human
      // has seen this exact approved dialog, and only to Escape/Cancel.
      requireCondition(error instanceof Error&&error.message==='No dialog is showing'&&humanVisualConfirmation!==undefined,'VM_JAVASCRIPT_DIALOG_UNOBSERVED');
      await dismissHumanConfirmedJavaScriptDialogOverLoopbackRfb(humanVisualConfirmation.vnc_port);
      return {origin,pathname,action:'dismiss' as const,via:'human_confirmed_vnc_escape' as const};
    }
  }
  /** Diagnostic inventory is limited to origins and paths; it never exposes page text, queries, or credentials. */
  async ownedRouteInventory(){
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    try {
      const routes=this.#browser.contexts().flatMap(context=>context.pages()).map(page=>{
        try {const url=new URL(page.url());return {origin:url.origin,pathname:url.pathname};}
        catch {return {origin:'invalid',pathname:'invalid'};}
      });
      return {page_count:routes.length,routes};
    } finally {await this.detach();}
  }
  /**
   * Read only reviewed visibility signals from exactly one agent-owned VM page.
   * This deliberately returns booleans only: no text, attributes, form values,
   * cookies, screenshots, or generic JavaScript evaluation escape the boundary.
   */
  async ownedPageSignalSnapshot(origin:string,pathname:string,signals:readonly OwnedVmPageSignal[]){
    const expected=new URL(origin);requireCondition(expected.origin===origin&&pathname.startsWith('/'),'INVALID_VM_SIGNAL_TARGET');
    requireCondition(signals.length>0&&signals.length<=16,'INVALID_VM_SIGNAL_COUNT');
    for(const signal of signals){
      requireCondition(/^[a-z][a-z0-9_]{0,63}$/u.test(signal.id),'INVALID_VM_SIGNAL_ID');
      requireCondition(signal.selector.length>0&&signal.selector.length<=500&&!/[\r\n]/u.test(signal.selector),'INVALID_VM_SIGNAL_SELECTOR');
    }
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    try {
      const matches=this.#browser.contexts().flatMap(context=>context.pages()).filter(page=>{
        try {const current=new URL(page.url());return current.origin===origin&&current.pathname===pathname;}catch{return false;}
      });
      requireCondition(matches.length===1,'VM_HUMAN_AUTH_PAGE_AMBIGUOUS');
      const page=matches[0]!,observed:Record<string,boolean>={};
      for(const signal of signals)observed[signal.id]=await page.locator(signal.selector).isVisible().catch(()=>false);
      return {origin,pathname,signals:observed};
    } finally {await this.detach();}
  }
  /**
   * Discovery is constrained to visible same-origin navigation labels and
   * pathnames.  It intentionally strips queries, attributes, page text,
   * account data, form values, and every cross-origin destination.
   */
  async ownedPageNavigationInventory(origin:string,pathname:string){
    const expected=new URL(origin);requireCondition(expected.origin===origin&&pathname.startsWith('/'),'INVALID_VM_NAVIGATION_TARGET');
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    try {
      const matches=this.#browser.contexts().flatMap(context=>context.pages()).filter(page=>{
        try {const current=new URL(page.url());return current.origin===origin&&current.pathname===pathname;}catch{return false;}
      });
      requireCondition(matches.length===1,'VM_HUMAN_AUTH_PAGE_AMBIGUOUS');
      const links=await matches[0]!.locator('a:visible').evaluateAll(anchors=>{
        const seen=new Set<string>(),items:{label:string;pathname:string}[]=[];
        for(const anchor of anchors){
          const label=(anchor.textContent??'').replace(/\s+/gu,' ').trim(),href=(anchor as HTMLAnchorElement).href;
          if(!label||!href)continue;
          try {
            const target=new URL(href,location.href);if(target.origin!==location.origin)continue;
            const key=`${label}\u0000${target.pathname}`;if(seen.has(key))continue;seen.add(key);
            items.push({label:label.slice(0,80),pathname:target.pathname});if(items.length===96)break;
          }catch{continue;}
        }
        return items;
      });
      return {origin,pathname,links};
    } finally {await this.detach();}
  }
  /** Like navigation inventory, but also reports visible button/tile labels without exposing handler code or triggering them. */
  async ownedPageInteractiveInventory(origin:string,pathname:string){
    const expected=new URL(origin);requireCondition(expected.origin===origin&&pathname.startsWith('/'),'INVALID_VM_INTERACTIVE_TARGET');
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    try {
      const matches=this.#browser.contexts().flatMap(context=>context.pages()).filter(page=>{
        try {const current=new URL(page.url());return current.origin===origin&&current.pathname===pathname;}catch{return false;}
      });
      requireCondition(matches.length===1,'VM_HUMAN_AUTH_PAGE_AMBIGUOUS');
      const controls=await matches[0]!.locator('a,button,[role="button"],[onclick]').evaluateAll(elements=>{
        const seen=new Set<string>(),items:{kind:'link'|'button'|'tile';label:string;pathname?:string}[]=[];
        for(const element of elements){
          const style=getComputedStyle(element),label=(element.textContent??'').replace(/\s+/gu,' ').trim();
          if(!label||style.display==='none'||style.visibility==='hidden'||element.getClientRects().length===0)continue;
          const anchor=element instanceof HTMLAnchorElement?element:undefined;
          let pathname:string|undefined;
          if(anchor?.href)try {const target=new URL(anchor.href,location.href);if(target.origin===location.origin)pathname=target.pathname;}catch{continue;}
          const kind:typeof items[number]['kind']=anchor?'link':element instanceof HTMLButtonElement?'button':'tile';
          const key=`${kind}\u0000${label}\u0000${pathname??''}`;if(seen.has(key))continue;seen.add(key);
          items.push({kind,label:label.slice(0,80),...(pathname?{pathname}:{})});if(items.length===128)break;
        }
        return items;
      });
      return {origin,pathname,controls};
    } finally {await this.detach();}
  }
  /** Reports only the origin and pathname of frames in the exact agent-owned page. */
  async ownedPageFrameInventory(origin:string,pathname:string){
    const expected=new URL(origin);requireCondition(expected.origin===origin&&pathname.startsWith('/'),'INVALID_VM_FRAME_TARGET');
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    try {
      const matches=this.#browser.contexts().flatMap(context=>context.pages()).filter(page=>{
        try {const current=new URL(page.url());return current.origin===origin&&current.pathname===pathname;}catch{return false;}
      });
      requireCondition(matches.length===1,'VM_HUMAN_AUTH_PAGE_AMBIGUOUS');
      const frames=matches[0]!.frames().map(frame=>{
        try {const current=new URL(frame.url());return {origin:current.origin,pathname:current.pathname};}
        catch{return {origin:'invalid',pathname:'invalid'};}
      });
      return {origin,pathname,frames};
    } finally {await this.detach();}
  }
  /** Activates one Pack-reviewed, visible same-origin portal link and returns only its resulting route. */
  async activateReviewedVisibleLink(origin:string,pathname:string,plan:OwnedVmVisibleLinkPlan){
    const expected=new URL(origin);requireCondition(expected.origin===origin&&pathname.startsWith('/'),'INVALID_VM_LINK_TARGET');assertVmVisibleLinkPlan(plan);
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    try {
      const matches=this.#browser.contexts().flatMap(context=>context.pages()).filter(page=>{
        try {const current=new URL(page.url());return current.origin===origin&&current.pathname===pathname;}catch{return false;}
      });
      requireCondition(matches.length===1,'VM_HUMAN_AUTH_PAGE_AMBIGUOUS');
      const page=matches[0]!,link=page.locator('a:visible').filter({hasText:plan.label});
      requireCondition(await link.count()===1,'VM_REVIEWED_LINK_UNAVAILABLE');
      const context=page.context(),before=new Set(context.pages());
      await link.click();await delay(750);
      const candidates=context.pages().filter(candidate=>{
        try {const current=new URL(candidate.url());return plan.allowed_origins.includes(current.origin)&&(plan.expected_path_prefix===undefined||current.pathname.startsWith(plan.expected_path_prefix));}catch{return false;}
      });
      const activated=candidates.find(candidate=>!before.has(candidate))??candidates.find(candidate=>candidate!==page)??page;
      const current=new URL(activated.url());requireCondition(plan.allowed_origins.includes(current.origin)&&(plan.expected_path_prefix===undefined||current.pathname.startsWith(plan.expected_path_prefix)),'VM_REVIEWED_LINK_TARGET_UNAVAILABLE');
      return {origin:current.origin,pathname:current.pathname,opened_new_page:activated!==page};
    } finally {await this.detach();}
  }
  /**
   * A no-credential diagnostic for a reviewed saved-password flow. Focusing a
   * password field is intentional: it asks Chromium to render its own saved
   * credential suggestion, but returns only geometry and visibility facts.
   */
  async savedPasswordLoginSurface(origin:string,pathname:string,plan:OwnedVmSavedPasswordLoginPlan){
    const expected=new URL(origin);requireCondition(expected.origin===origin&&pathname.startsWith('/'),'INVALID_VM_SAVED_PASSWORD_TARGET');assertVmSavedPasswordLoginPlan(plan);
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    try {
      const matches=this.#browser.contexts().flatMap(context=>context.pages()).filter(page=>{
        try {const current=new URL(page.url());return current.origin===origin&&current.pathname===pathname;}catch{return false;}
      });
      requireCondition(matches.length===1,'VM_HUMAN_AUTH_PAGE_AMBIGUOUS');const page=matches[0]!,password=page.locator(plan.password_selector),login=page.locator(plan.login_selector);
      requireCondition(await password.count()===1&&await password.isVisible().catch(()=>false),'VM_PASSWORD_FIELD_UNAVAILABLE');
      requireCondition(await login.count()===1&&await login.isVisible().catch(()=>false)&&await login.isEnabled().catch(()=>false),'VM_LOGIN_ACTION_UNAVAILABLE');
      await password.focus();const box=await password.boundingBox();requireCondition(box!==null,'VM_PASSWORD_FIELD_BOX_UNAVAILABLE');
      const metrics=await page.evaluate(()=>({screen_x:window.screenX,screen_y:window.screenY,outer_width:window.outerWidth,outer_height:window.outerHeight,inner_width:window.innerWidth,inner_height:window.innerHeight,screen_width:window.screen.width,screen_height:window.screen.height,device_pixel_ratio:window.devicePixelRatio})) as BrowserWindowMetrics;
      return {origin,pathname,password_field_visible:true,login_action_visible:true,password_field_box:{x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)},target:savedPasswordSuggestionTarget(metrics,box as BrowserFieldBox,plan.suggestion),window:{screen_x:metrics.screen_x,screen_y:metrics.screen_y,outer_width:metrics.outer_width,outer_height:metrics.outer_height,inner_width:metrics.inner_width,inner_height:metrics.inner_height,screen_width:metrics.screen_width,screen_height:metrics.screen_height,device_pixel_ratio:metrics.device_pixel_ratio}};
    } finally {await this.detach();}
  }
  /**
   * A non-submitting browser-chrome probe. It may focus the reviewed password
   * field and move the guest pointer across Pack-listed rows, but never sends
   * a mouse press, key event, or DOM login click. Pixel data is reduced in
   * memory to boolean row-hover changes before this method returns.
   */
  async probeSavedPasswordSuggestionRows(origin:string,pathname:string,plan:OwnedVmSavedPasswordLoginPlan,vncPort:number){
    const expected=new URL(origin);requireCondition(expected.origin===origin&&pathname.startsWith('/'),'INVALID_VM_SAVED_PASSWORD_TARGET');assertVmSavedPasswordLoginPlan(plan);
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    try {
      const matches=this.#browser.contexts().flatMap(context=>context.pages()).filter(page=>{
        try {const current=new URL(page.url());return current.origin===origin&&current.pathname===pathname;}catch{return false;}
      });
      requireCondition(matches.length===1,'VM_HUMAN_AUTH_PAGE_AMBIGUOUS');const page=matches[0]!,password=page.locator(plan.password_selector),login=page.locator(plan.login_selector);
      requireCondition(await password.count()===1&&await password.isVisible().catch(()=>false),'VM_PASSWORD_FIELD_UNAVAILABLE');
      requireCondition(await login.count()===1&&await login.isVisible().catch(()=>false)&&await login.isEnabled().catch(()=>false),'VM_LOGIN_ACTION_UNAVAILABLE');
      await login.focus();const box=await password.boundingBox();requireCondition(box!==null,'VM_PASSWORD_FIELD_BOX_UNAVAILABLE');
      const metrics=await page.evaluate(()=>({screen_x:window.screenX,screen_y:window.screenY,outer_width:window.outerWidth,outer_height:window.outerHeight,inner_width:window.innerWidth,inner_height:window.innerHeight,screen_width:window.screen.width,screen_height:window.screen.height,device_pixel_ratio:window.devicePixelRatio})) as BrowserWindowMetrics;
      const framebuffer=await loopbackRfbDisplayGeometry(vncPort),target=savedPasswordSuggestionTarget(metrics,box as BrowserFieldBox,plan.suggestion,framebuffer),observation={x:target.x-12,y:target.y-12,width:24,height:24};
      const beforeSuggestion=await loopbackRfbObservationFingerprint(vncPort,observation);await focusSavedPasswordFieldOverLoopbackRfb(vncPort,savedPasswordFieldTarget(metrics,box as BrowserFieldBox,framebuffer));
      await delay(plan.suggestion.popover_wait_ms);const afterSuggestion=await loopbackRfbObservationFingerprint(vncPort,observation),popup_opened=beforeSuggestion!==afterSuggestion,field_focused_by_guest_input=await password.evaluate(input=>document.activeElement===input);
      const hover_changed_offsets:number[]=[];
      if(popup_opened)for(const offset of plan.suggestion.hover_probe_offsets_y_css_px){
        const candidate=savedPasswordSuggestionProbeTarget(metrics,box as BrowserFieldBox,plan.suggestion,offset,framebuffer),candidateObservation={x:candidate.x+16,y:candidate.y-12,width:24,height:24};
        const beforeHover=await loopbackRfbObservationFingerprint(vncPort,candidateObservation);await hoverSavedPasswordSuggestionOverLoopbackRfb(vncPort,candidate);
        await delay(plan.suggestion.popover_wait_ms);const afterHover=await loopbackRfbObservationFingerprint(vncPort,candidateObservation);
        if(beforeHover!==afterHover)hover_changed_offsets.push(offset);
      }
      return {origin,pathname,popup_opened,field_focused_by_guest_input,hover_changed_offsets};
    } finally {await this.detach();}
  }
  /**
   * Completes the local half of a known guest-password-manager flow. It first
   * binds a single page, a single visible password input, and a single visible
   * DOM login action. The only visual input is one VNC click derived from the
   * focused field; password characters never cross this API or its return
   * value. The resulting login remains an authentication boundary, not proof
   * of a signed-in site session.
   */
  async selectSavedPasswordAndSubmit(origin:string,pathname:string,plan:OwnedVmSavedPasswordLoginPlan,vncPort:number){
    const expected=new URL(origin);requireCondition(expected.origin===origin&&pathname.startsWith('/'),'INVALID_VM_SAVED_PASSWORD_TARGET');assertVmSavedPasswordLoginPlan(plan);
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    try {
      const matches=this.#browser.contexts().flatMap(context=>context.pages()).filter(page=>{
        try {const current=new URL(page.url());return current.origin===origin&&current.pathname===pathname;}catch{return false;}
      });
      requireCondition(matches.length===1,'VM_HUMAN_AUTH_PAGE_AMBIGUOUS');const page=matches[0]!,password=page.locator(plan.password_selector),login=page.locator(plan.login_selector);
      requireCondition(await password.count()===1&&await password.isVisible().catch(()=>false),'VM_PASSWORD_FIELD_UNAVAILABLE');
      requireCondition(await login.count()===1&&await login.isVisible().catch(()=>false)&&await login.isEnabled().catch(()=>false),'VM_LOGIN_ACTION_UNAVAILABLE');
      // Renderer focus alone cannot open Chromium's password-manager popup.
      // Move focus to the reviewed DOM login action first, then let the one
      // guest-local physical field click create the native browser focus event.
      await login.focus();const box=await password.boundingBox();requireCondition(box!==null,'VM_PASSWORD_FIELD_BOX_UNAVAILABLE');
      const metrics=await page.evaluate(()=>({screen_x:window.screenX,screen_y:window.screenY,outer_width:window.outerWidth,outer_height:window.outerHeight,inner_width:window.innerWidth,inner_height:window.innerHeight,screen_width:window.screen.width,screen_height:window.screen.height,device_pixel_ratio:window.devicePixelRatio})) as BrowserWindowMetrics;
      const framebuffer=await loopbackRfbDisplayGeometry(vncPort),target=savedPasswordSuggestionTarget(metrics,box as BrowserFieldBox,plan.suggestion,framebuffer);
      const observation={x:target.x-12,y:target.y-12,width:24,height:24};
      const beforeSuggestion=await loopbackRfbObservationFingerprint(vncPort,observation);await focusSavedPasswordFieldOverLoopbackRfb(vncPort,savedPasswordFieldTarget(metrics,box as BrowserFieldBox,framebuffer));
      await delay(plan.suggestion.popover_wait_ms);const afterSuggestion=await loopbackRfbObservationFingerprint(vncPort,observation);
      requireCondition(beforeSuggestion!==afterSuggestion,'VM_SAVED_PASSWORD_POPUP_UNOBSERVED');await selectFirstSavedPasswordSuggestionOverLoopbackRfb(vncPort);
      // Pack selectors use Playwright extensions such as `:visible`; never
      // pass them to DOM querySelector. Read only the boolean non-empty state
      // through the already-reviewed locator, never the credential value.
      const saved=await password.evaluate(field=>field instanceof HTMLInputElement&&field.value.length>0).catch(()=>false);
      requireCondition(saved,'VM_SAVED_PASSWORD_SELECTION_UNOBSERVED');
      await login.click();return {origin,pathname,action:'saved_password_then_login_submit' as const,password_present:true,guest_input_actions:3};
    } finally {await this.detach();}
  }
  /**
   * The submit half is deliberately separable from browser-chrome selection:
   * it acts only when the reviewed password locator is already non-empty and
   * exposes no credential data while making that decision.
   */
  async submitLoginWithSavedPassword(origin:string,pathname:string,plan:OwnedVmSavedPasswordLoginPlan){
    const expected=new URL(origin);requireCondition(expected.origin===origin&&pathname.startsWith('/'),'INVALID_VM_SAVED_PASSWORD_TARGET');assertVmSavedPasswordLoginPlan(plan);
    this.#browser=await chromium.connectOverCDP(this.endpoint);
    try {
      const matches=this.#browser.contexts().flatMap(context=>context.pages()).filter(page=>{
        try {const current=new URL(page.url());return current.origin===origin&&current.pathname===pathname;}catch{return false;}
      });
      requireCondition(matches.length===1,'VM_HUMAN_AUTH_PAGE_AMBIGUOUS');const page=matches[0]!,password=page.locator(plan.password_selector),login=page.locator(plan.login_selector);
      requireCondition(await password.count()===1&&await password.isVisible().catch(()=>false),'VM_PASSWORD_FIELD_UNAVAILABLE');
      requireCondition(await login.count()===1&&await login.isVisible().catch(()=>false)&&await login.isEnabled().catch(()=>false),'VM_LOGIN_ACTION_UNAVAILABLE');
      requireCondition(await password.evaluate(field=>field instanceof HTMLInputElement&&field.value.length>0).catch(()=>false),'VM_SAVED_PASSWORD_SELECTION_UNOBSERVED');
      await login.click();return {origin,pathname,action:'login_submit_with_saved_password' as const,password_present:true};
    } finally {await this.detach();}
  }
}
