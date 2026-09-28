import {z} from 'zod';
import {readFileSync} from 'node:fs';

export const browserEngine=z.enum(['playwright','neo','aside']);
export const browserEnvironment=z.enum(['owned_headless','host_foreground','ubuntu_vm','windows_vm']);
const id=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const loopback=z.string().url().refine(value=>{const u=new URL(value);return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!!u.port&&!u.username&&!u.password&&!u.search&&!u.hash;},'Loopback MCP endpoint required');
export const browserTargetSchema=z.object({
  id,engine:browserEngine,environment:browserEnvironment,
  profile_ref:id,platform:z.enum(['win32','linux','darwin']),
  endpoint:loopback.optional(),executable:z.string().min(1).max(1000).optional(),
  priority:z.number().int().min(0).max(100).default(50),
}).strict().superRefine((t,c)=>{
  if(t.engine==='neo'&&(!t.endpoint||t.executable))c.addIssue({code:'custom',message:'Neo requires endpoint only'});
  if(t.engine==='aside'&&(!t.executable||t.endpoint))c.addIssue({code:'custom',message:'Aside requires local official CLI only'});
  if(t.engine==='playwright'&&(t.endpoint||t.executable))c.addIssue({code:'custom',message:'Playwright uses runtime-owned profile or verified VM configuration'});
  if(t.engine!=='playwright'&&t.environment==='owned_headless')c.addIssue({code:'custom',message:'Connected desktop browsers are not verified headless executors'});
});
export type BrowserTarget=z.infer<typeof browserTargetSchema>;
export const browserExecutorsSchema=z.object({targets:z.array(browserTargetSchema).min(1).max(16)}).strict().refine(v=>new Set(v.targets.map(t=>t.id)).size===v.targets.length,'Duplicate browser target');
export type BrowserExecutors=z.infer<typeof browserExecutorsSchema>;
/** An LLM preference is not a foreground grant. Only host-registered targets may run. */
export const browserPreferenceSchema=z.object({environment:browserEnvironment,preferred_engine:browserEngine.optional()}).strict();
export type BrowserPreference=z.infer<typeof browserPreferenceSchema>;
/** WSL can invoke an explicitly registered Windows CLI; this remains HOST foreground, never a Linux guest. */
export function browserHostCompatible(target:BrowserTarget){
  if(target.platform===process.platform)return true;
  if(process.platform!=='linux'||target.platform!=='win32'||target.environment!=='host_foreground')return false;
  let wsl=false;try{wsl=/microsoft/iu.test(readFileSync('/proc/sys/kernel/osrelease','utf8'));}catch{}
  return wsl&&(target.engine==='neo'||target.engine==='aside'&&/^\/mnt\/[a-z]\/.+\/aside\.exe$/iu.test(target.executable??''));
}
export interface BrowserCheckpoint {version:1;entry_url:string;url:string;target_id:string|null;environment:string;completed_steps:string[];effect_state:'none'|'uncertain';binding:string;observation_sha256:string|null;}
export interface BrowserObservation {url:string;title:string;text:string;links:Array<{text:string;url:string}>;observed_at:string;}
export interface BrowserExtraction {ready:string;auth_gate:string;auth_required:boolean;account_selector:string;account_text:string;rows:string;columns:Record<string,string>;max_rows:number;}
export interface BrowserPort {
  readonly target:BrowserTarget;
  probe():Promise<void>;
  open(url:string):Promise<void>;
  navigate(url:string):Promise<void>;
  observe():Promise<BrowserObservation>;
  extract(spec:BrowserExtraction):Promise<Array<Record<string,string>>>;
  scroll(direction:'up'|'down'):Promise<void>;
  close():Promise<void>;
}
export const browserObservationSchema=z.object({url:z.string().url().max(4096),title:z.string().max(500),text:z.string().max(24000),links:z.array(z.object({text:z.string().max(160),url:z.string().max(4096)}).strict()).max(120),observed_at:z.string().datetime()}).strict();
/** Shared DOM reads only. No evaluation string supplied by a model reaches an adapter. */
export function observationScript(){return `() => ({url:location.href,title:document.title.slice(0,500),text:(document.body?.innerText??'').slice(0,24000),links:Array.from(document.querySelectorAll('a[href]')).map(a=>({text:(a.textContent??'').trim().slice(0,160),url:a.href})).filter(a=>a.text&&/^https?:/.test(a.url)&&a.url.length<=4096).slice(0,120),observed_at:new Date().toISOString()})`;}
export function extractionScript(spec:BrowserExtraction){return `() => {
  const s=${JSON.stringify(spec)};
  const visible=e=>!!e&&!!(e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden';
  if(Array.from(document.querySelectorAll(s.auth_gate)).some(visible))throw Error('PACK_WAITING_AUTH');
  if(Array.from(document.querySelectorAll('[role="dialog"],dialog[open]')).some(visible))throw Error('PACK_UNKNOWN_DIALOG');
  if(!Array.from(document.querySelectorAll(s.ready)).some(visible))throw Error('BROWSER_NOT_READY');
  if(s.auth_required){const accounts=document.querySelectorAll(s.account_selector);if(accounts.length!==1||accounts[0].innerText.trim()!==s.account_text)throw Error('PACK_ACCOUNT_MISMATCH');}
  const nodes=Array.from(document.querySelectorAll(s.rows));if(nodes.length>s.max_rows)throw Error('SOURCE_TOO_MANY_ROWS');
  return nodes.map(node=>{const row={};for(const [key,selector] of Object.entries(s.columns)){const cells=node.querySelectorAll(selector);if(cells.length!==1)throw Error('SOURCE_FIELD_AMBIGUOUS');row[key]=cells[0].innerText.trim();}return row;});
}`;}
