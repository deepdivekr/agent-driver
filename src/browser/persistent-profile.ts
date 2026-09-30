import {chmod,lstat,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {type BrowserContext} from 'playwright';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {type BrowserTarget} from './executor-contracts.js';

export const isPersistentProfile=(target:BrowserTarget)=>target.engine==='playwright'&&target.environment==='owned_headless'&&target.session_mode==='persistent';
/** Display configuration is a prerequisite, not evidence that a window opened. */
export function hasHeadedDisplay(environment:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform){return platform!=='linux'||!!(environment.DISPLAY?.trim()||environment.WAYLAND_DISPLAY?.trim());}
export function persistentProfilePath(config:HostConfig,target:BrowserTarget){
  requireCondition(isPersistentProfile(target),'AUTH_PERSISTENT_PROFILE_REQUIRED');
  requireCondition([target.id,target.profile_ref].every(value=>/^[a-z][a-z0-9_-]{0,63}$/u.test(value)),'BROWSER_PROFILE_ID_INVALID');
  // Separate from legacy work/source profiles. Opt-in never imports cookies.
  return join(config.project.profileRef,'saved-browser-profiles',target.id,target.profile_ref);
}
export function ownedProfileAuthKey(config:HostConfig,target:BrowserTarget){return createHash('sha256').update(JSON.stringify({project_id:config.project.id,target_id:target.id,engine:target.engine,environment:target.environment,platform:target.platform,profile_ref:target.profile_ref,session_mode:target.session_mode??'isolated'})).digest('hex');}
/** Read-only persisted handoff check also fences a fresh process after a broker crash. */
export function assertPersistentProfileAutomationAllowed(config:HostConfig,target:BrowserTarget){
  if(!isPersistentProfile(target)||!existsSync(config.dbPath))return;
  const db=new DatabaseSync(config.dbPath,{readOnly:true});
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_auth'").get())return;
    requireCondition(!db.prepare('SELECT 1 FROM browser_auth WHERE project_id=? AND profile=? AND handoff=1 LIMIT 1').get(config.project.id,ownedProfileAuthKey(config,target)),'PACK_WAITING_AUTH');
  }finally{db.close();}
}
async function prepareProfileDirectory(config:HostConfig,target:BrowserTarget,path:string){
  const root=config.project.profileRef;
  for(const directory of [root,join(root,'saved-browser-profiles'),join(root,'saved-browser-profiles',target.id),path]){
    await mkdir(directory,{recursive:true,mode:0o700});const entry=await lstat(directory);
    requireCondition(entry.isDirectory()&&!entry.isSymbolicLink()&&(!process.getuid||entry.uid===process.getuid()),'BROWSER_PROFILE_PATH_UNSAFE');
    await chmod(directory,0o700);
  }
  requireCondition(await realpath(path)===join(await realpath(root),'saved-browser-profiles',target.id,target.profile_ref),'BROWSER_PROFILE_PATH_UNSAFE');
  const marker=join(path,'.agent-office-profile.json'),binding=JSON.stringify({format:1,project_id:config.project.id,target_id:target.id,profile_ref:target.profile_ref});
  if(!existsSync(marker)){
    requireCondition((await readdir(path)).length===0,'BROWSER_PROFILE_BINDING_INVALID');
    try{await writeFile(marker,binding,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  }
  const entry=await lstat(marker);requireCondition(entry.isFile()&&!entry.isSymbolicLink()&&entry.nlink===1&&entry.size<1000&&(!process.getuid||entry.uid===process.getuid()),'BROWSER_PROFILE_BINDING_INVALID');
  requireCondition(await readFile(marker,'utf8')===binding,'BROWSER_PROFILE_BINDING_INVALID');
  await chmod(marker,0o600);
}
export function persistentProfileError(error:unknown):never{
  // Chromium often prefixes contention with the generic "browser closed" error.
  // Resolve it before transport fallback; never unlink another owner's locks.
  if(error instanceof Error&&/ProcessSingleton|SingletonLock|profile directory.*in use/iu.test(error.message))throw Error('PACK_BROWSER_PROFILE_BUSY',{cause:error});
  throw error;
}
type Mode='automation'|'human';
interface PoolEntry {mode:Mode;refs:number;context:Promise<BrowserContext>;closing?:Promise<void>;}
export interface PersistentProfileLease {context:BrowserContext;release():Promise<void>;}
const profiles=new Map<string,PoolEntry>();
const MAX_PROFILES=8,MAX_READERS=8;
/** One browser owner per saved profile, bounded pages, and exclusive human use.
 * Last release flushes Chromium's own profile and frees memory; no storage export. */
export async function acquirePersistentProfile(config:HostConfig,target:BrowserTarget,mode:Mode):Promise<PersistentProfileLease>{
  const path=persistentProfilePath(config,target);requireCondition(target.platform===process.platform,'BROWSER_HOST_PLATFORM_MISMATCH');
  if(mode==='human')requireCondition(hasHeadedDisplay(),'AUTH_HEADED_DISPLAY_UNAVAILABLE');
  else assertPersistentProfileAutomationAllowed(config,target);
  let entry=profiles.get(path);
  if(entry?.closing){await entry.closing;entry=profiles.get(path);}
  if(entry){
    requireCondition(mode!=='human','AUTH_WAIT_FOR_ACTIVE_WORKERS');
    requireCondition(entry.mode!=='human','PACK_WAITING_AUTH');
    requireCondition(entry.refs<MAX_READERS,'BROWSER_PROFILE_CAPACITY_EXCEEDED');entry.refs++;
  }else{
    requireCondition(profiles.size<MAX_PROFILES,'BROWSER_PROFILE_CAPACITY_EXCEEDED');
    entry={mode,refs:1,context:(async()=>{
      await prepareProfileDirectory(config,target,path);
      try{return await (await import('playwright')).chromium.launchPersistentContext(path,{headless:mode==='automation',acceptDownloads:false,serviceWorkers:'block',timeout:15000});}
      catch(error){persistentProfileError(error);}
    })()};
    profiles.set(path,entry);
  }
  const owned=entry;let released=false;
  const release=async()=>{
    if(released)return;released=true;owned.refs--;
    if(owned.refs===0){
      owned.closing=(async()=>{try{const context=await owned.context.catch(()=>null);if(context)await context.close();}finally{if(profiles.get(path)===owned)profiles.delete(path);}})();
      await owned.closing;
    }
  };
  try{const context=await owned.context;if(mode==='automation')assertPersistentProfileAutomationAllowed(config,target);return {context,release};}catch(error){await release();throw error;}
}
