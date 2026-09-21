import {createHash} from 'node:crypto';
import {constants,createReadStream} from 'node:fs';
import {access,stat} from 'node:fs/promises';
import {relative,resolve,sep} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {localVmHostProbe,localVmRunner,type VmCommandRunner,type VmHostProbe} from './ubuntu-browser-vm.js';

export interface WindowsPersonalVmSpec {
  id:string;
  storage_root:string;
  installer_iso:string;
  installer_iso_sha256:string;
  uefi_firmware:string;
  uefi_firmware_sha256:string;
  /** The owner supplies a legitimately obtained ISO/key; this runtime never downloads either. */
  image_license_attestation:'owner_provided';
  memory_mib:number;
  cpus:number;
  disk_gib:number;
  /** Host loopback port forwarded to the guest-local UIA service on 7443. */
  desktop_agent_port:number;
  /** Host loopback port forwarded to guest RDP solely for an owner to view the VM. */
  rdp_port:number;
  host_desktop_access:'none';
  host_file_bridge:'explicit_transfer_only';
}

export interface WindowsPersonalVmForward {
  host:'127.0.0.1';
  host_port:number;
  guest_port:7443|3389;
  purpose:'guest_uia_agent'|'owner_rdp';
}

export interface WindowsPersonalVmDoctor {
  platform:NodeJS.Platform;
  kvm:{available:boolean;reason:string};
  commands:{qemu_system:boolean;qemu_img:boolean};
  artifacts:{installer_iso:'verified'|'missing'|'hash_mismatch';uefi_firmware:'verified'|'missing'|'hash_mismatch'};
  ready:boolean;
  missing:readonly string[];
  security_tier:'workload_isolation';
  host_desktop_fallback:false;
}

function safeId(value:string){return /^[a-z][a-z0-9-]{0,62}$/u.test(value);}
function validPort(value:number){return Number.isInteger(value)&&value>=1024&&value<=65535;}
function safeAbsolutePath(value:string){return resolve(value)===value&&resolve(value)!==sep&&!/[\r\n,]/u.test(value);}
function contained(root:string,path:string){const rel=relative(root,path);return rel!==''&&!rel.startsWith(`..${sep}`)&&rel!=='..'&&!rel.includes(`${sep}..${sep}`);}
function validDigest(value:string){return /^[a-f0-9]{64}$/u.test(value);}

/**
 * This is deliberately a preparation contract, not a downloader or a host
 * Windows adapter. A Windows native app is permitted only inside this guest.
 */
export function validateWindowsPersonalVmSpec(spec:WindowsPersonalVmSpec){
  requireCondition(safeId(spec.id),'INVALID_WINDOWS_VM_ID');
  requireCondition(safeAbsolutePath(spec.storage_root),'WINDOWS_VM_STORAGE_ROOT_TOO_BROAD');
  requireCondition(safeAbsolutePath(spec.installer_iso)&&safeAbsolutePath(spec.uefi_firmware),'WINDOWS_VM_IMAGE_MUST_BE_ABSOLUTE');
  requireCondition(validDigest(spec.installer_iso_sha256)&&validDigest(spec.uefi_firmware_sha256),'INVALID_WINDOWS_VM_IMAGE_SHA256');
  requireCondition(spec.image_license_attestation==='owner_provided','WINDOWS_VM_UNVERIFIED_IMAGE_LICENSE');
  requireCondition(Number.isInteger(spec.memory_mib)&&spec.memory_mib>=4096&&spec.memory_mib<=32768,'INVALID_WINDOWS_VM_MEMORY');
  requireCondition(Number.isInteger(spec.cpus)&&spec.cpus>=2&&spec.cpus<=16,'INVALID_WINDOWS_VM_CPUS');
  requireCondition(Number.isInteger(spec.disk_gib)&&spec.disk_gib>=64&&spec.disk_gib<=512,'INVALID_WINDOWS_VM_DISK');
  requireCondition(validPort(spec.desktop_agent_port)&&validPort(spec.rdp_port)&&spec.desktop_agent_port!==spec.rdp_port,'INVALID_WINDOWS_VM_PORTS');
  requireCondition(spec.host_desktop_access==='none','WINDOWS_HOST_DESKTOP_FALLBACK_FORBIDDEN');
  requireCondition(spec.host_file_bridge==='explicit_transfer_only','IMPLICIT_WINDOWS_HOST_FILE_BRIDGE_FORBIDDEN');
}

/** The future VM disk lives below its own root; the ISO and firmware are read-only inputs. */
export function windowsPersonalVmDiskPath(spec:WindowsPersonalVmSpec){
  validateWindowsPersonalVmSpec(spec);
  const root=resolve(spec.storage_root),disk=resolve(root,spec.id,'windows.qcow2');
  requireCondition(root!==sep&&contained(root,disk),'WINDOWS_VM_STORAGE_ESCAPE');
  return disk;
}

/** No 0.0.0.0 listener, host-folder share, host display, or host UI injection is part of this contract. */
export function windowsPersonalVmLoopbackForwards(spec:WindowsPersonalVmSpec):readonly WindowsPersonalVmForward[]{
  validateWindowsPersonalVmSpec(spec);
  return Object.freeze([
    Object.freeze({host:'127.0.0.1' as const,host_port:spec.desktop_agent_port,guest_port:7443 as const,purpose:'guest_uia_agent' as const}),
    Object.freeze({host:'127.0.0.1' as const,host_port:spec.rdp_port,guest_port:3389 as const,purpose:'owner_rdp' as const}),
  ]);
}

/** The runtime may talk only to this host-loopback bridge, which terminates in the guest-local agent. */
export function windowsPersonalVmUiaEndpoint(spec:WindowsPersonalVmSpec){
  validateWindowsPersonalVmSpec(spec);
  return `http://127.0.0.1:${spec.desktop_agent_port}` as const;
}

async function executable(runner:VmCommandRunner,command:string){return (await runner.run(command,['--version'])).code===0;}
async function isFile(path:string){try{return (await stat(path)).isFile();}catch{return false;}}
async function sha256File(path:string){
  const hash=createHash('sha256');
  await new Promise<void>((resolveHash,rejectHash)=>{
    const input=createReadStream(path);input.on('data',chunk=>hash.update(chunk));input.once('end',resolveHash);input.once('error',rejectHash);
  });
  return hash.digest('hex');
}
async function artifactStatus(path:string,digest:string):Promise<'verified'|'missing'|'hash_mismatch'>{
  if(!(await isFile(path)))return 'missing';
  return await sha256File(path)===digest?'verified':'hash_mismatch';
}

/**
 * Doctor records an absent or mismatched installer as unavailable. It never
 * substitutes the current Windows host, a downloaded ISO, or an unverified
 * image. A ready result only means the VM prerequisites are observed.
 */
export async function inspectWindowsPersonalVm(spec:WindowsPersonalVmSpec,runner:VmCommandRunner=localVmRunner,host:VmHostProbe=localVmHostProbe):Promise<WindowsPersonalVmDoctor>{
  validateWindowsPersonalVmSpec(spec);
  const [qemuSystem,qemuImg,kvm,installerIso,uefiFirmware]=await Promise.all([
    executable(runner,'qemu-system-x86_64'),executable(runner,'qemu-img'),host.canUseKvm(),artifactStatus(spec.installer_iso,spec.installer_iso_sha256),artifactStatus(spec.uefi_firmware,spec.uefi_firmware_sha256),
  ]);
  const missing:string[]=[];
  if(host.platform!=='linux')missing.push('linux_host');
  if(!kvm)missing.push('read_write_/dev/kvm');
  if(!qemuSystem)missing.push('qemu-system-x86_64');
  if(!qemuImg)missing.push('qemu-img');
  if(installerIso!=='verified')missing.push(`installer_iso_${installerIso}`);
  if(uefiFirmware!=='verified')missing.push(`uefi_firmware_${uefiFirmware}`);
  return Object.freeze({platform:host.platform,kvm:{available:kvm,reason:kvm?'observed':'/dev/kvm is unavailable or not writable'},commands:{qemu_system:qemuSystem,qemu_img:qemuImg},artifacts:{installer_iso:installerIso,uefi_firmware:uefiFirmware},ready:missing.length===0,missing:Object.freeze(missing),security_tier:'workload_isolation' as const,host_desktop_fallback:false as const});
}

/** Exposed only for tests and diagnostics; provisioning must use an explicit reviewed installer workflow later. */
export async function canReadWindowsPersonalVmStorage(spec:WindowsPersonalVmSpec){
  validateWindowsPersonalVmSpec(spec);
  try {await access(spec.storage_root,constants.R_OK|constants.W_OK);return true;} catch {return false;}
}
