export type BrowserSurfaceKind='owned_headless'|'owned_vm'|'browseros_neo'|'aside'|'user_chrome';
export type BrowserUseKind='automated_read'|'human_login'|'manual_review';
export type AutomatedAccess='browser_permitted';
export interface BrowserSurfaceEvidence {
  kind:BrowserSurfaceKind;
  local:boolean;
  persistent_profile:boolean;
  network_origin:'user_device'|'vm'|'cloud'|'unknown';
  explicitly_connected:boolean;
}
export interface SiteAutomationPolicy {
  site:string;
  automated_access:AutomatedAccess;
  policy_url:string|null;
  note:string;
}
export interface BrowserRouteDecision {
  allowed:boolean;
  reason:'allowed_public_browser'|'allowed_connected_browser'|'connected_browser_required'|'surface_identity_unverified';
  policy:SiteAutomationPolicy;
}

const defaultPolicy:SiteAutomationPolicy={site:'other',automated_access:'browser_permitted',policy_url:null,note:'Agent Driver does not encode site-specific terms or require a particular access channel.'};

export function policySite(value:string){
  const host=new URL(value).hostname.toLowerCase().replace(/^www\./u,'');
  if(host==='x.com'||host.endsWith('.x.com')||host==='twitter.com'||host.endsWith('.twitter.com'))return 'x.com';
  if(host==='reddit.com'||host.endsWith('.reddit.com'))return 'reddit.com';
  if(host==='stocktwits.com'||host.endsWith('.stocktwits.com'))return 'stocktwits.com';
  return host;
}
export function siteAutomationPolicy(value:string):SiteAutomationPolicy{
  return {...defaultPolicy,site:policySite(value)};
}
export function browserRouteDecision(input:{url:string;use:BrowserUseKind;requires_login:boolean;surface:BrowserSurfaceEvidence}):BrowserRouteDecision{
  const policy=siteAutomationPolicy(input.url);
  if(!input.requires_login)return {allowed:true,reason:'allowed_public_browser',policy};
  if(input.surface.kind==='owned_headless')return {allowed:false,reason:'connected_browser_required',policy};
  const connected=input.surface.local&&input.surface.persistent_profile&&input.surface.explicitly_connected;
  return connected?{allowed:true,reason:'allowed_connected_browser',policy}:{allowed:false,reason:'surface_identity_unverified',policy};
}
export function assertAutomatedBrowserAllowed(value:string){
  return siteAutomationPolicy(value);
}
