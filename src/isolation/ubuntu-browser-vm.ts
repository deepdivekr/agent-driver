import {createHash,randomUUID} from 'node:crypto';
import {constants,createReadStream,createWriteStream} from 'node:fs';
import {access,mkdir,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {requireCondition} from '../core/contracts.js';

export interface VmCommandResult {code:number;stdout:string;stderr:string;}
export interface VmCommandRunner {run(command:string,args:readonly string[]):Promise<VmCommandResult>;}
export interface VmCommandSpawner {spawn(command:string,args:readonly string[]):Promise<{pid:number;stop():Promise<void>}>;}
export interface VmHostProbe {platform:NodeJS.Platform;canUseKvm():Promise<boolean>;}

/** A shell-free runner. VM paths and image arguments are never interpolated into a command line. */
export const localVmRunner:VmCommandRunner={
  async run(command,args){
    return await new Promise(resolveResult=>{
      const child=spawn(command,[...args],{shell:false,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
      child.once('error',error=>resolveResult({code:127,stdout,stderr:error.message}));
      child.once('close',code=>resolveResult({code:code??1,stdout,stderr}));
    });
  },
};

export const localVmSpawner:VmCommandSpawner={
  async spawn(command,args){
    const child=spawn(command,[...args],{shell:false,stdio:'ignore',detached:true});
    await new Promise<void>((resolveSpawn,rejectSpawn)=>{child.once('spawn',resolveSpawn);child.once('error',rejectSpawn);});
    requireCondition(typeof child.pid==='number'&&child.pid>0,'VM_LAUNCH_PID_UNAVAILABLE');
    child.unref();
    return {pid:child.pid,async stop(){
      if(child.exitCode!==null)return;
      child.kill('SIGTERM');
      await new Promise<void>(resolveStop=>child.once('close',()=>resolveStop()));
    }};
  },
};

export interface UbuntuBrowserVmDoctor {
  platform:NodeJS.Platform;
  kvm:{available:boolean;reason:string};
  commands:{qemu_system:boolean;qemu_img:boolean;cloud_localds:boolean};
  ready:boolean;
  missing:readonly string[];
  security_tier:'workload_isolation';
}

async function executable(runner:VmCommandRunner,command:string,args:readonly string[]=['--version']){
  return (await runner.run(command,args)).code===0;
}
async function readableWritable(path:string){
  try {await access(path,constants.R_OK|constants.W_OK);return true;} catch {return false;}
}
export const localVmHostProbe:VmHostProbe={platform:process.platform,canUseKvm:async()=>await readableWritable('/dev/kvm')};

/**
 * This deliberately has no host-profile fallback.  A missing KVM/QEMU stack
 * is a blocked environment, not permission to run the task in a user's browser.
 */
export async function inspectUbuntuBrowserVm(runner:VmCommandRunner=localVmRunner,host:VmHostProbe=localVmHostProbe):Promise<UbuntuBrowserVmDoctor>{
  const [qemuSystem,qemuImg,cloudLocalds,kvm]=await Promise.all([
    executable(runner,'qemu-system-x86_64'),executable(runner,'qemu-img'),executable(runner,'cloud-localds',['--help']),host.canUseKvm(),
  ]);
  const missing:string[]=[];
  if(host.platform!=='linux')missing.push('linux_host');
  if(!kvm)missing.push('read_write_/dev/kvm');
  if(!qemuSystem)missing.push('qemu-system-x86_64');
  if(!qemuImg)missing.push('qemu-img');
  if(!cloudLocalds)missing.push('cloud-localds');
  return {platform:host.platform,kvm:{available:kvm,reason:kvm?'observed':'/dev/kvm is unavailable or not writable'},commands:{qemu_system:qemuSystem,qemu_img:qemuImg,cloud_localds:cloudLocalds},ready:missing.length===0,missing,security_tier:'workload_isolation'};
}

export interface UbuntuBrowserVmSpec {
  id:string;
  storage_root:string;
  base_image:string;
  base_image_sha256:string;
  memory_mib:number;
  cpus:number;
  disk_gib:number;
  ssh_port:number;
  devtools_port:number;
  vnc_port:number;
  guest_user:string;
}
export const ubuntuBrowserVmDefaults=Object.freeze({memory_mib:3072,cpus:2,disk_gib:30,ssh_port:2222,devtools_port:9222,vnc_port:5901,guest_user:'agentdriver'});
/** Pinned from Ubuntu's Noble current SHA256SUMS on 2026-09-21. Update only with a reviewed release change. */
export const defaultUbuntu2404Amd64Image=Object.freeze({
  filename:'noble-server-cloudimg-amd64.img',url:'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',sha256:'612b2c0cc1bc413a6cb8c38fd611794caf0f2b436c50013d8b3794db12ad7354',
});
export interface VerifiedVmImage {filename:string;url:string;sha256:string;}
export interface VmImageFetcher {fetch(url:string):Promise<Response>;}
export interface UbuntuBrowserVmPaths {root:string;overlay:string;seed:string;user_data:string;meta_data:string;network_config:string;serial_log:string;manifest:string;}
export interface UbuntuBrowserVmManifest {
  format:1;id:string;created_at:string;base_image:string;base_image_sha256:string;memory_mib:number;cpus:number;disk_gib:number;
  ssh_port:number;devtools_port:number;vnc_port:number;guest_user:string;isolation:'qemu_kvm_no_shared_folders_loopback_forwards';
}

function isSafeId(value:string){return /^[a-z][a-z0-9-]{0,62}$/u.test(value);}
function validPort(value:number){return Number.isInteger(value)&&value>=1024&&value<=65535;}
function contained(root:string,path:string){const rel=relative(root,path);return rel!==''&&!rel.startsWith(`..${sep}`)&&rel!=='..'&&!rel.includes(`${sep}..${sep}`);}

export function validateUbuntuBrowserVmSpec(spec:UbuntuBrowserVmSpec){
  requireCondition(isSafeId(spec.id),'INVALID_VM_ID');
  requireCondition(resolve(spec.storage_root)===spec.storage_root&&resolve(spec.storage_root)!==sep,'VM_STORAGE_ROOT_TOO_BROAD');
  requireCondition(resolve(spec.base_image)===spec.base_image,'VM_BASE_IMAGE_MUST_BE_ABSOLUTE');
  requireCondition(!/[\r\n,]/u.test(spec.storage_root)&&!/[\r\n,]/u.test(spec.base_image),'VM_QEMU_PATH_UNSAFE');
  requireCondition(/^[a-f0-9]{64}$/u.test(spec.base_image_sha256),'INVALID_VM_BASE_IMAGE_SHA256');
  requireCondition(Number.isInteger(spec.memory_mib)&&spec.memory_mib>=1024&&spec.memory_mib<=16384,'INVALID_VM_MEMORY');
  requireCondition(Number.isInteger(spec.cpus)&&spec.cpus>=1&&spec.cpus<=8,'INVALID_VM_CPUS');
  requireCondition(Number.isInteger(spec.disk_gib)&&spec.disk_gib>=16&&spec.disk_gib<=128,'INVALID_VM_DISK');
  requireCondition([spec.ssh_port,spec.devtools_port,spec.vnc_port].every(validPort)&&new Set([spec.ssh_port,spec.devtools_port,spec.vnc_port]).size===3,'INVALID_VM_PORTS');
  requireCondition(spec.devtools_port<65535&&spec.devtools_port+1!==5901,'INVALID_VM_DEVTOOLS_BRIDGE_PORT');
  requireCondition(/^[a-z_][a-z0-9_-]{0,31}$/u.test(spec.guest_user),'INVALID_VM_GUEST_USER');
}

/** QEMU reaches this guest-only bridge; Chromium itself remains on guest loopback. */
export function ubuntuBrowserVmDevtoolsBridgePort(spec:UbuntuBrowserVmSpec){validateUbuntuBrowserVmSpec(spec);return spec.devtools_port+1;}

export function ubuntuBrowserVmPaths(spec:UbuntuBrowserVmSpec):UbuntuBrowserVmPaths{
  validateUbuntuBrowserVmSpec(spec);const storage=resolve(spec.storage_root),root=resolve(storage,spec.id);requireCondition(contained(storage,root),'VM_STORAGE_ESCAPE');
  return {root,overlay:join(root,'browser.qcow2'),seed:join(root,'seed.img'),user_data:join(root,'user-data'),meta_data:join(root,'meta-data'),network_config:join(root,'network-config'),serial_log:join(root,'serial.log'),manifest:join(root,'vm-manifest.json')};
}
/** Stream image digests: VM overlays can exceed Node's 2 GiB readFile limit. */
async function sha256File(path:string){
  const hash=createHash('sha256');
  await new Promise<void>((resolveHash,rejectHash)=>{
    const input=createReadStream(path);input.on('data',chunk=>hash.update(chunk));input.once('end',resolveHash);input.once('error',rejectHash);
  });
  return hash.digest('hex');
}
async function isFile(path:string){try{return (await stat(path)).isFile();}catch{return false;}}

function imagePath(storageRoot:string,image:VerifiedVmImage){const root=resolve(storageRoot),path=resolve(root,'.base-images',image.filename);requireCondition(root!==sep&&contained(root,path),'VM_IMAGE_STORAGE_ESCAPE');return path;}
/**
 * Downloads only a caller-pinned image and atomically publishes it after a
 * digest check. An existing mismatched image is preserved and rejected.
 */
export async function downloadVerifiedVmImage(storageRoot:string,image:VerifiedVmImage,fetcher:VmImageFetcher={fetch:async url=>await fetch(url)},runner:VmCommandRunner=localVmRunner){
  requireCondition(/^https:\/\/[A-Za-z0-9.-]+\/.+/u.test(image.url)&&/^[a-zA-Z0-9._-]{1,160}$/u.test(image.filename)&&/^[a-f0-9]{64}$/u.test(image.sha256),'INVALID_VM_IMAGE_DESCRIPTOR');
  const destination=imagePath(storageRoot,image);if(await isFile(destination)){requireCondition(await sha256File(destination)===image.sha256,'VM_BASE_IMAGE_HASH_MISMATCH');return {path:destination,sha256:image.sha256,downloaded:false};}
  await mkdir(dirname(destination),{recursive:true,mode:0o700});const partial=join(dirname(destination),`.${image.filename}.${randomUUID()}.partial`);
  try {
    try {
      const response=await fetcher.fetch(image.url);requireCondition(response.ok&&response.body!==null,'VM_IMAGE_DOWNLOAD_FAILED');
      await pipeline(Readable.fromWeb(response.body as never),createWriteStream(partial,{flags:'wx',mode:0o600}));
    } catch {
      // Some managed networks expose HTTPS through the system curl proxy while
      // Node's fetch has no proxy dispatcher. This fixed, shell-free fallback
      // still accepts only the pinned URL and validates the same final digest.
      await rm(partial,{force:true});const curl=await runner.run('curl',['--fail','--silent','--show-error','--location','--output',partial,image.url]);requireCondition(curl.code===0,'VM_IMAGE_DOWNLOAD_FAILED');
    }
    requireCondition(await sha256File(partial)===image.sha256,'VM_BASE_IMAGE_HASH_MISMATCH');
    await rename(partial,destination);return {path:destination,sha256:image.sha256,downloaded:true};
  } catch(error) {await rm(partial,{force:true}).catch(()=>undefined);throw error;}
}
export async function downloadDefaultUbuntu2404Amd64Image(storageRoot:string,fetcher?:VmImageFetcher){return await downloadVerifiedVmImage(storageRoot,defaultUbuntu2404Amd64Image,fetcher);}

/** Cloud-init contains no OS password, site credential, cookie, or approval token. */
export function legacyUbuntuBrowserCloudInit(spec:UbuntuBrowserVmSpec){
  validateUbuntuBrowserVmSpec(spec);
  return `#cloud-config\nusers:\n  - default\n  - name: ${spec.guest_user}\n    lock_passwd: true\n    shell: /bin/bash\nssh_pwauth: false\npackage_update: true\npackages:\n  - chromium-browser\n  - xvfb\n  - x11vnc\n  - openbox\nwrite_files:\n  - path: /etc/agent-driver/browser-vm.json\n    permissions: '0644'\n    content: |\n      {"format":1,"devtools_port":${spec.devtools_port},"vnc_port":5901,"browser_profile":"/home/${spec.guest_user}/.agent-driver/browser-profile","credential_storage":"guest_only"}\n  - path: /usr/local/lib/agent-driver/browser-session\n    permissions: '0755'\n    content: |\n      #!/bin/sh\n      set -eu\n      export HOME=/home/${spec.guest_user}\n      export DISPLAY=:99\n      mkdir -p "$HOME/.agent-driver/browser-profile"\n      Xvfb :99 -screen 0 1440x1024x24 -nolisten tcp &\n      openbox &\n      x11vnc -display :99 -rfbport 5901 -forever -shared -nopw -listen 0.0.0.0 &\n      exec chromium-browser --no-first-run --disable-background-networking --remote-debugging-address=0.0.0.0 --remote-debugging-port=${spec.devtools_port} --user-data-dir="$HOME/.agent-driver/browser-profile" about:blank\n  - path: /etc/systemd/system/agent-driver-browser.service\n    permissions: '0644'\n    content: |\n      [Unit]\n      Description=agent-driver owned browser session\n      After=network-online.target\n      Wants=network-online.target\n      [Service]\n      Type=simple\n      User=${spec.guest_user}\n      ExecStart=/usr/local/lib/agent-driver/browser-session\n      Restart=on-failure\n      RestartSec=3\n      [Install]\n      WantedBy=multi-user.target\nruncmd:\n  - [ mkdir, -p, /etc/agent-driver ]\n  - [ mkdir, -p, /home/${spec.guest_user}/.agent-driver/browser-profile ]\n  - [ chown, -R, ${spec.guest_user}:${spec.guest_user}, /home/${spec.guest_user}/.agent-driver ]\n  - [ systemctl, daemon-reload ]\n  - [ systemctl, enable, --now, agent-driver-browser.service ]\n`;
}
/** The current guest bootstrap writes its own readiness/error messages to the VM-only serial log. */
export function ubuntuBrowserCloudInit(spec:UbuntuBrowserVmSpec){
  validateUbuntuBrowserVmSpec(spec);
  const bridgePort=ubuntuBrowserVmDevtoolsBridgePort(spec);
  return `#cloud-config
users:
  - default
  - name: ${spec.guest_user}
    lock_passwd: true
    shell: /bin/bash
ssh_pwauth: false
write_files:
  - path: /etc/agent-driver-browser-vm.json
    permissions: '0644'
    content: |
      {"format":1,"devtools_port":${spec.devtools_port},"vnc_port":5901,"browser_profile":"/home/${spec.guest_user}/snap/chromium/common/agent-driver-browser-profile","credential_storage":"guest_only"}
  - path: /etc/fonts/local.conf
    permissions: '0644'
    content: |
      <?xml version="1.0"?>
      <!DOCTYPE fontconfig SYSTEM "fonts.dtd">
      <fontconfig>
        <!-- Legacy Korean enterprise UIs often request Windows-only families. -->
        <alias><family>Malgun Gothic</family><prefer><family>NanumGothic</family><family>Noto Sans CJK KR</family></prefer></alias>
        <alias><family>맑은 고딕</family><prefer><family>NanumGothic</family><family>Noto Sans CJK KR</family></prefer></alias>
        <alias><family>Gulim</family><prefer><family>UnGungseo</family><family>NanumGothic</family><family>Noto Sans CJK KR</family></prefer></alias>
        <alias><family>굴림</family><prefer><family>UnGungseo</family><family>NanumGothic</family><family>Noto Sans CJK KR</family></prefer></alias>
        <alias><family>Dotum</family><prefer><family>UnDotum</family><family>NanumGothic</family><family>Noto Sans CJK KR</family></prefer></alias>
        <alias><family>돋움</family><prefer><family>UnDotum</family><family>NanumGothic</family><family>Noto Sans CJK KR</family></prefer></alias>
        <alias><family>Batang</family><prefer><family>UnBatang</family><family>Noto Serif CJK KR</family></prefer></alias>
        <alias><family>바탕</family><prefer><family>UnBatang</family><family>Noto Serif CJK KR</family></prefer></alias>
      </fontconfig>
  - path: /usr/local/lib/agent-driver/bootstrap-browser-vm
    permissions: '0755'
    content: |
      #!/bin/sh
      set -eu
      export DEBIAN_FRONTEND=noninteractive
      echo '[agent-driver] installing owned browser dependencies'
      systemctl disable --now agent-driver-browser.service >/dev/null 2>&1 || true
      rm -f /etc/systemd/system/agent-driver-browser.service
      systemctl daemon-reload
      attempt=1
      until apt-get -o Acquire::Retries=1 update; do
        test "$attempt" -ge 12 && exit 31
        attempt=$((attempt + 1))
        sleep 10
      done
      apt-get -o Acquire::Retries=2 install --yes chromium-browser dbus-user-session socat xvfb x11vnc openbox fonts-noto-cjk fonts-nanum fonts-unfonts-core
      fc-cache --force
      install -d -o ${spec.guest_user} -g ${spec.guest_user} /home/${spec.guest_user}/snap/chromium/common/agent-driver-browser-profile /home/${spec.guest_user}/.config/systemd/user
      chown -R ${spec.guest_user}:${spec.guest_user} /home/${spec.guest_user}/snap/chromium/common/agent-driver-browser-profile
      install -o ${spec.guest_user} -g ${spec.guest_user} -m 0644 /etc/agent-driver/agent-driver-browser.service /home/${spec.guest_user}/.config/systemd/user/agent-driver-browser.service
      loginctl enable-linger ${spec.guest_user}
      uid="$(id -u ${spec.guest_user})"
      attempt=1
      until test -S "/run/user/$uid/bus"; do
        test "$attempt" -ge 12 && exit 32
        attempt=$((attempt + 1))
        sleep 1
      done
      runuser -u ${spec.guest_user} -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user daemon-reload
      runuser -u ${spec.guest_user} -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user enable --now agent-driver-browser.service
      sleep 2
      if ! runuser -u ${spec.guest_user} -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" systemctl --user is-active --quiet agent-driver-browser.service; then
        echo '[agent-driver] browser user service failed'
        runuser -u ${spec.guest_user} -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" journalctl --user --unit agent-driver-browser.service --no-pager --lines 40
        exit 33
      fi
      echo '[agent-driver] owned browser dependencies installed'
  - path: /usr/local/lib/agent-driver/browser-session
    permissions: '0755'
    content: |
      #!/bin/sh
      set -eu
      export HOME=/home/${spec.guest_user}
      export DISPLAY=:99
      echo '[agent-driver] browser-session starting'
      mkdir -p "$HOME/snap/chromium/common/agent-driver-browser-profile"
      rm -f "$HOME/snap/chromium/common/agent-driver-browser-profile/SingletonLock" "$HOME/snap/chromium/common/agent-driver-browser-profile/SingletonCookie" "$HOME/snap/chromium/common/agent-driver-browser-profile/SingletonSocket"
      Xvfb :99 -screen 0 1440x1024x24 -nolisten tcp &
      for attempt in 1 2 3 4 5 6 7 8 9 10; do
        test -S /tmp/.X11-unix/X99 && break
        sleep 1
      done
      test -S /tmp/.X11-unix/X99
      openbox &
      x11vnc -display :99 -rfbport 5901 -forever -shared -nopw -listen 0.0.0.0 &
      socat TCP-LISTEN:${bridgePort},bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:${spec.devtools_port} &
      command -v snap
      echo '[agent-driver] chromium starting'
      exec snap run chromium --no-first-run --disable-background-networking --disable-gpu --remote-debugging-address=0.0.0.0 --remote-debugging-port=${spec.devtools_port} --user-data-dir="$HOME/snap/chromium/common/agent-driver-browser-profile" about:blank
  - path: /etc/agent-driver/agent-driver-browser.service
    permissions: '0644'
    content: |
      [Unit]
      Description=agent-driver owned browser session
      [Service]
      Type=simple
      ExecStart=/usr/local/lib/agent-driver/browser-session
      Restart=on-failure
      RestartSec=3
      [Install]
      WantedBy=default.target
runcmd:
  - [ /usr/local/lib/agent-driver/bootstrap-browser-vm ]
`;
}
/**
 * Q35 exposes the virtio NIC as enp0s1 (not the legacy eth0 name).  Match the
 * predictable-name family so this cloud image applies the DNS policy after
 * the kernel rename, and avoid DHCP replacing it with QEMU's host-only DNS.
 */
export function ubuntuBrowserNetworkConfig(){return 'version: 2\nethernets:\n  agentnet:\n    match:\n      name: "en*"\n    dhcp4: true\n    dhcp4-overrides:\n      use-dns: false\n    nameservers:\n      addresses: [1.1.1.1, 8.8.8.8]\n';}
function vmManifest(spec:UbuntuBrowserVmSpec):UbuntuBrowserVmManifest{return {format:1,id:spec.id,created_at:new Date().toISOString(),base_image:spec.base_image,base_image_sha256:spec.base_image_sha256,memory_mib:spec.memory_mib,cpus:spec.cpus,disk_gib:spec.disk_gib,ssh_port:spec.ssh_port,devtools_port:spec.devtools_port,vnc_port:spec.vnc_port,guest_user:spec.guest_user,isolation:'qemu_kvm_no_shared_folders_loopback_forwards'};}

export async function provisionUbuntuBrowserVm(spec:UbuntuBrowserVmSpec,runner:VmCommandRunner=localVmRunner,host:VmHostProbe=localVmHostProbe){
  validateUbuntuBrowserVmSpec(spec);const doctor=await inspectUbuntuBrowserVm(runner,host);requireCondition(doctor.ready,'VM_BACKEND_UNAVAILABLE');
  requireCondition(await isFile(spec.base_image),'VM_BASE_IMAGE_MISSING');requireCondition(await sha256File(spec.base_image)===spec.base_image_sha256,'VM_BASE_IMAGE_HASH_MISMATCH');
  const paths=ubuntuBrowserVmPaths(spec);requireCondition(!(await isFile(paths.overlay))&&!(await isFile(paths.seed))&&!(await isFile(paths.manifest)),'VM_ALREADY_PROVISIONED');
  await mkdir(paths.root,{recursive:true,mode:0o700});
  await Promise.all([
    writeFile(paths.user_data,ubuntuBrowserCloudInit(spec),{mode:0o600}),writeFile(paths.meta_data,`instance-id: ${spec.id}\nlocal-hostname: agent-driver-${spec.id}\n`,{mode:0o600}),writeFile(paths.network_config,ubuntuBrowserNetworkConfig(),{mode:0o600}),
  ]);
  const overlay=await runner.run('qemu-img',['create','-f','qcow2','-F','qcow2','-b',spec.base_image,paths.overlay,`${spec.disk_gib}G`]);requireCondition(overlay.code===0,'VM_OVERLAY_CREATE_FAILED');requireCondition(await isFile(paths.overlay),'VM_OVERLAY_NOT_OBSERVED');
  const seed=await runner.run('cloud-localds',['--network-config',paths.network_config,paths.seed,paths.user_data,paths.meta_data]);requireCondition(seed.code===0,'VM_SEED_CREATE_FAILED');requireCondition(await isFile(paths.seed),'VM_SEED_NOT_OBSERVED');
  const manifest=vmManifest(spec);await writeFile(paths.manifest,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});return {doctor,paths,manifest};
}

export function ubuntuBrowserVmLaunchArgs(spec:UbuntuBrowserVmSpec,paths:UbuntuBrowserVmPaths){
  validateUbuntuBrowserVmSpec(spec);requireCondition(resolve(paths.root)===resolve(spec.storage_root,spec.id),'VM_PATH_BINDING_MISMATCH');
  // The VNC service and browser debug endpoint run in the guest.  QEMU exposes
  // them only on the host loopback interface; no QEMU display is created.
  const forwards=`hostfwd=tcp:127.0.0.1:${spec.ssh_port}-:22,hostfwd=tcp:127.0.0.1:${spec.devtools_port}-:${ubuntuBrowserVmDevtoolsBridgePort(spec)},hostfwd=tcp:127.0.0.1:${spec.vnc_port}-:5901`;
  return ['-name',`agent-driver-${spec.id}`,'-machine','q35,accel=kvm','-enable-kvm','-cpu','host','-smp',String(spec.cpus),'-m',String(spec.memory_mib),'-drive',`file=${paths.overlay},if=virtio,format=qcow2`,'-drive',`file=${paths.seed},media=cdrom,readonly=on`,'-netdev',`user,id=agentnet,${forwards}`,'-device','virtio-net-pci,netdev=agentnet','-display','none','-serial',`file:${paths.serial_log}`,'-nodefaults','-no-reboot'];
}

export async function readUbuntuBrowserVmManifest(spec:UbuntuBrowserVmSpec){
  const paths=ubuntuBrowserVmPaths(spec),parsed=JSON.parse(await readFile(paths.manifest,'utf8')) as UbuntuBrowserVmManifest;
  requireCondition(parsed.format===1&&parsed.id===spec.id&&parsed.base_image_sha256===spec.base_image_sha256&&parsed.isolation==='qemu_kvm_no_shared_folders_loopback_forwards','VM_MANIFEST_INVALID');return parsed;
}
export async function launchUbuntuBrowserVm(spec:UbuntuBrowserVmSpec,spawner:VmCommandSpawner=localVmSpawner){
  await readUbuntuBrowserVmManifest(spec);return await spawner.spawn('qemu-system-x86_64',ubuntuBrowserVmLaunchArgs(spec,ubuntuBrowserVmPaths(spec)));
}
