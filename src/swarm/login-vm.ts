import {readFile,readdir,open,unlink} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {launchUbuntuBrowserVm,validateUbuntuBrowserVmSpec,type UbuntuBrowserVmSpec} from '../isolation/ubuntu-browser-vm.js';

export async function loginVmSpec(config:HostConfig):Promise<UbuntuBrowserVmSpec>{
  const vm=config.swarm?.visual.owned_vm;
  requireCondition(vm&&isAbsolute(vm.storage_root)&&/^[a-z][a-z0-9-]{0,62}$/u.test(vm.id),'AUTH_OWNED_VM_REQUIRED');
  const manifest=JSON.parse(await readFile(join(vm!.storage_root,vm!.id,'vm-manifest.json'),'utf8'));
  requireCondition(manifest.format===1&&manifest.id===vm!.id&&manifest.devtools_port===vm!.devtools_port&&manifest.vnc_port===vm!.vnc_port&&manifest.isolation==='qemu_kvm_no_shared_folders_loopback_forwards','AUTH_VM_MANIFEST_MISMATCH');
  const spec={...manifest,storage_root:vm!.storage_root} as UbuntuBrowserVmSpec;
  validateUbuntuBrowserVmSpec(spec);return spec;
}
export async function ownedLoginVmRunning(spec:UbuntuBrowserVmSpec){
  requireCondition(process.platform==='linux','AUTH_VM_HOST_UNSUPPORTED');
  for(const pid of (await readdir('/proc')).filter(name=>/^\d+$/u.test(name))){
    const parts=(await readFile(`/proc/${pid}/cmdline`,'utf8').catch(()=>'' )).split('\0');
    if(parts.includes('-name')&&parts[parts.indexOf('-name')+1]===`agent-driver-${spec.id}`&&parts.includes(`file=${join(spec.storage_root,spec.id,'browser.qcow2')},if=virtio,format=qcow2`)&&parts.some(part=>part.includes(`hostfwd=tcp:127.0.0.1:${spec.devtools_port}-:`)))return true;
  }
  return false;
}
const starts=new Map<string,Promise<void>>();
export interface LoginVmOperations {
  running(spec:UbuntuBrowserVmSpec):Promise<boolean>;
  launch(spec:UbuntuBrowserVmSpec):Promise<unknown>;
  ready(spec:UbuntuBrowserVmSpec):Promise<boolean>;
  wait():Promise<void>;
  attempts:number;
}
const operations:LoginVmOperations={running:ownedLoginVmRunning,launch:launchUbuntuBrowserVm,attempts:60,wait:async()=>{await delay(1000);},ready:async spec=>{
  try{const response=await fetch(`http://127.0.0.1:${spec.devtools_port}/json/version`,{signal:AbortSignal.timeout(800),redirect:'error'});const data=await response.json() as {Browser?:string;webSocketDebuggerUrl?:string};return response.ok&&typeof data.Browser==='string'&&typeof data.webSocketDebuggerUrl==='string';}catch{return false;}
}};
/** Explicit login or selected managed-guest execution only. Reuse the existing
 * disk/profile; never provision/reset it or boot during a catalog/status read. */
export async function prepareLoginVm(config:HostConfig,ops:LoginVmOperations=operations){
  const spec=await loginVmSpec(config),key=join(spec.storage_root,spec.id);
  const pending=starts.get(key);if(pending)return pending;
  const task=(async()=>{
    const lockPath=join(key,'.login-start.lock');
    const lock=await open(lockPath,'wx',0o600).catch(()=>{throw Error('AUTH_VM_START_IN_PROGRESS');});
    try{
      if(!await ops.running(spec))await ops.launch(spec);
      for(let attempt=0;attempt<ops.attempts;attempt++){
        if(await ops.running(spec)&&await ops.ready(spec))return;
        await ops.wait();
      }
      throw Error('AUTH_VM_BROWSER_NOT_READY');
    }finally{await lock.close();await unlink(lockPath);}
  })();
  starts.set(key,task);try{await task;}finally{starts.delete(key);}
}
export async function loginVmStatus(config:HostConfig){
  try{const spec=await loginVmSpec(config);return starts.has(join(spec.storage_root,spec.id))?'starting':await ownedLoginVmRunning(spec)?'running':'stopped';}
  catch{return 'unavailable';}
}
