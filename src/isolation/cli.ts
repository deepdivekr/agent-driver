import {join,resolve} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {defaultUbuntu2404Amd64Image,downloadDefaultUbuntu2404Amd64Image,inspectUbuntuBrowserVm,launchUbuntuBrowserVm,provisionUbuntuBrowserVm,ubuntuBrowserVmDefaults,type UbuntuBrowserVmSpec} from './ubuntu-browser-vm.js';

export const vmHelp='  vm doctor\n  vm image --storage-root PATH\n  vm provision --id ID --storage-root PATH [--base-image PATH --base-image-sha256 SHA256] [--memory-mib N --cpus N --disk-gib N --ssh-port N --devtools-port N --vnc-port N --guest-user NAME]\n  vm launch --id ID --storage-root PATH [--base-image PATH --base-image-sha256 SHA256] [same options]\n';

function optionsFrom(args:readonly string[]){
  requireCondition(args.length%2===0,'INVALID_VM_OPTIONS');const options=new Map<string,string>();
  for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];requireCondition(typeof key==='string'&&key.startsWith('--')&&typeof value==='string'&&value.length>0&&!value.startsWith('--')&&!options.has(key),'INVALID_VM_OPTIONS');options.set(key,value);}
  const allowed=['--id','--storage-root','--base-image','--base-image-sha256','--memory-mib','--cpus','--disk-gib','--ssh-port','--devtools-port','--vnc-port','--guest-user'];for(const key of options.keys())requireCondition(allowed.includes(key),'UNKNOWN_VM_OPTION');return options;
}
function positiveInteger(options:Map<string,string>,key:string,fallback:number){const value=options.get(key);if(value===undefined)return fallback;requireCondition(/^\d+$/u.test(value),'INVALID_VM_NUMBER');return Number(value);}
function required(options:Map<string,string>,key:string){const value=options.get(key);requireCondition(value,`MISSING_VM_${key.slice(2).replaceAll('-','_').toUpperCase()}`);return value;}
async function specFrom(options:Map<string,string>,downloadDefault:boolean):Promise<UbuntuBrowserVmSpec>{
  const storageRoot=resolve(required(options,'--storage-root')),requestedBase=options.get('--base-image'),requestedSha=options.get('--base-image-sha256');requireCondition((requestedBase===undefined)===(requestedSha===undefined),'VM_BASE_IMAGE_AND_HASH_MUST_PAIR');
  if(requestedBase===undefined&&downloadDefault)await downloadDefaultUbuntu2404Amd64Image(storageRoot);
  return {
  id:required(options,'--id'),storage_root:storageRoot,base_image:requestedBase===undefined?join(storageRoot,'.base-images',defaultUbuntu2404Amd64Image.filename):resolve(requestedBase),base_image_sha256:requestedSha===undefined?defaultUbuntu2404Amd64Image.sha256:requestedSha.toLowerCase(),
  memory_mib:positiveInteger(options,'--memory-mib',ubuntuBrowserVmDefaults.memory_mib),cpus:positiveInteger(options,'--cpus',ubuntuBrowserVmDefaults.cpus),disk_gib:positiveInteger(options,'--disk-gib',ubuntuBrowserVmDefaults.disk_gib),ssh_port:positiveInteger(options,'--ssh-port',ubuntuBrowserVmDefaults.ssh_port),devtools_port:positiveInteger(options,'--devtools-port',ubuntuBrowserVmDefaults.devtools_port),vnc_port:positiveInteger(options,'--vnc-port',ubuntuBrowserVmDefaults.vnc_port),guest_user:options.get('--guest-user')??ubuntuBrowserVmDefaults.guest_user,
};}

/** Explicit VM commands only.  There is intentionally no implicit host-browser fallback. */
export async function runVmCli(args:readonly string[]){
  if(args[0]!=='vm')return false;const action=args[1]??'help';
  if(action==='help'||action==='--help'){console.log(vmHelp);return true;}
  if(action==='doctor'){requireCondition(args.length===2,'INVALID_VM_OPTIONS');console.log(JSON.stringify(await inspectUbuntuBrowserVm(),null,2));return true;}
  const options=optionsFrom(args.slice(2));
  if(action==='image'){requireCondition(args.length===4&&options.has('--storage-root'),'INVALID_VM_OPTIONS');console.log(JSON.stringify(await downloadDefaultUbuntu2404Amd64Image(resolve(required(options,'--storage-root'))),null,2));return true;}
  if(action==='provision'){const doctor=await inspectUbuntuBrowserVm();requireCondition(doctor.ready,'VM_BACKEND_UNAVAILABLE');const spec=await specFrom(options,true);console.log(JSON.stringify(await provisionUbuntuBrowserVm(spec),null,2));return true;}
  const spec=await specFrom(options,false);
  if(action==='launch'){const process=await launchUbuntuBrowserVm(spec);console.log(JSON.stringify({id:spec.id,pid:process.pid,devtools_url:`http://127.0.0.1:${spec.devtools_port}`,vnc:`127.0.0.1:${spec.vnc_port}`},null,2));return true;}
  requireCondition(false,'UNKNOWN_VM_COMMAND');return true;
}
