import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {downloadVerifiedVmImage,inspectUbuntuBrowserVm,launchUbuntuBrowserVm,provisionUbuntuBrowserVm,ubuntuBrowserCloudInit,ubuntuBrowserNetworkConfig,ubuntuBrowserVmDevtoolsBridgePort,ubuntuBrowserVmLaunchArgs,ubuntuBrowserVmPaths,validateUbuntuBrowserVmSpec} from '../dist/isolation/ubuntu-browser-vm.js';
import {OwnedVmCdpPage} from '../dist/taskpack/owned-playwright.js';

const readyHost={platform:'linux',async canUseKvm(){return true;}};
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'agent-driver-vm-')),base=join(root,'ubuntu-base.qcow2');await writeFile(base,'verified synthetic base image');
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  return {root,base,sha:createHash('sha256').update(await readFile(base)).digest('hex')};
}
function spec(x,overrides={}){return {id:'sample-browser',storage_root:join(x.root,'vms'),base_image:x.base,base_image_sha256:x.sha,memory_mib:2048,cpus:2,disk_gib:20,ssh_port:2222,devtools_port:9222,vnc_port:5901,guest_user:'agentdriver',...overrides};}
function fakeRunner(calls){return {async run(command,args){
  calls.push({command,args:[...args]});
  if(command==='qemu-img'&&args[0]==='create')await writeFile(args.at(-2),'overlay');
  if(command==='cloud-localds'&&args[0]==='--network-config')await writeFile(args[2],'seed');
  return {code:0,stdout:'ok',stderr:''};
}};}

test('runtime contract browser VM doctor never reports ready when its KVM/QEMU prerequisites are absent',async()=>{
  const absent={async run(){return {code:127,stdout:'',stderr:'not found'};}};
  const doctor=await inspectUbuntuBrowserVm(absent,{platform:'linux',async canUseKvm(){return false;}});
  assert.equal(doctor.ready,false);assert.deepEqual(doctor.missing,['read_write_/dev/kvm','qemu-system-x86_64','qemu-img','cloud-localds']);
});
test('runtime contract browser VM uses a verified base image and creates only agent-owned VM artifacts',async t=>{
  const x=await setup(t),calls=[],s=spec(x),result=await provisionUbuntuBrowserVm(s,fakeRunner(calls),readyHost),paths=ubuntuBrowserVmPaths(s);
  assert.equal(result.manifest.isolation,'qemu_kvm_no_shared_folders_loopback_forwards');assert.equal(calls.filter(call=>call.command==='qemu-img'&&call.args[0]==='create').length,1);assert.equal(calls.filter(call=>call.command==='cloud-localds'&&call.args[0]==='--network-config').length,1);
  assert.equal((await readFile(paths.manifest,'utf8')).includes(x.sha),true);assert.equal((await readFile(paths.user_data,'utf8')).includes('lock_passwd: true'),true);assert.equal((await readFile(paths.user_data,'utf8')).includes('password'),false);
  const launched=await launchUbuntuBrowserVm(s,{async spawn(command,args){assert.equal(command,'qemu-system-x86_64');assert.equal(args.includes('-enable-kvm'),true);return {pid:77,async stop(){}};}});assert.equal(launched.pid,77);
  await assert.rejects(provisionUbuntuBrowserVm(spec(x,{base_image_sha256:'0'.repeat(64)}),fakeRunner([]),readyHost),/VM_BASE_IMAGE_HASH_MISMATCH/);
});
test('runtime contract browser VM launch plan has no shared folders or public management port',async t=>{
  const x=await setup(t),s=spec(x),args=ubuntuBrowserVmLaunchArgs(s,ubuntuBrowserVmPaths(s)),text=args.join(' ');
  assert.equal(text.includes('hostfwd=tcp:127.0.0.1:2222-:22'),true);assert.equal(text.includes('hostfwd=tcp:127.0.0.1:9222-:9223'),true);assert.equal(text.includes('hostfwd=tcp:127.0.0.1:5901-:5901'),true);assert.equal(text.includes('0.0.0.0'),false);assert.equal(text.includes('-virtfs'),false);assert.equal(text.includes('-fsdev'),false);assert.equal(text.includes('-enable-kvm'),true);assert.equal(text.includes('-display none'),true);assert.equal(text.includes(`file:${ubuntuBrowserVmPaths(s).serial_log}`),true);
  assert.equal(ubuntuBrowserCloudInit(s).includes('credential_storage'),true);assert.equal(ubuntuBrowserCloudInit(s).includes('--remote-debugging-address=0.0.0.0'),true);
});
test('runtime contract browser VM bootstraps dependencies after guest DNS is explicit and never redirects a non-root browser service to serial',()=>{
  const source=ubuntuBrowserCloudInit(spec({root:'/tmp/agent-driver-vm-test',base:'/tmp/agent-driver-vm-test/ubuntu-base.qcow2',sha:'a'.repeat(64)}));
  assert.equal(source.includes('systemctl disable --now agent-driver-browser.service'),true);assert.equal(source.includes('apt-get -o Acquire::Retries=1 update'),true);assert.equal(source.includes('test "$attempt" -ge 12 && exit 31'),true);assert.equal(source.includes('apt-get -o Acquire::Retries=2 install --yes chromium-browser dbus-user-session socat xvfb x11vnc openbox fonts-noto-cjk fonts-nanum fonts-unfonts-core'),true);assert.equal(source.includes('/etc/fonts/local.conf'),true);assert.equal(source.includes('<family>Malgun Gothic</family>'),true);assert.equal(source.includes('<family>맑은 고딕</family>'),true);assert.equal(source.includes('fc-cache --force'),true);assert.equal(source.includes('socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9222'),true);assert.equal(source.includes('chown -R agentdriver:agentdriver /home/agentdriver/snap/chromium/common/agent-driver-browser-profile'),true);assert.equal(source.includes('browser_profile":"/home/agentdriver/snap/chromium/common/agent-driver-browser-profile"'),true);assert.equal(source.includes('SingletonLock'),true);assert.equal(source.includes('SingletonCookie'),true);assert.equal(source.includes('SingletonSocket'),true);assert.equal(source.includes('loginctl enable-linger agentdriver'),true);assert.equal(source.includes('systemctl --user enable --now agent-driver-browser.service'),true);assert.equal(source.includes('systemctl --user is-active --quiet agent-driver-browser.service'),true);assert.equal(source.includes('journalctl --user --unit agent-driver-browser.service'),true);assert.equal(source.includes('exec snap run chromium'),true);assert.equal(source.includes('exec >>/dev/ttyS0'),false);
  const network=ubuntuBrowserNetworkConfig();assert.equal(network.includes('name: "en*"'),true);assert.equal(network.includes('use-dns: false'),true);assert.equal(network.includes('1.1.1.1'),true);assert.equal(network.includes('8.8.8.8'),true);
});
test('runtime contract browser VM rejects QEMU option injection through its owned paths',async t=>{
  const x=await setup(t);assert.throws(()=>validateUbuntuBrowserVmSpec(spec(x,{storage_root:join(x.root,'vms,bad')})),/VM_QEMU_PATH_UNSAFE/);assert.throws(()=>validateUbuntuBrowserVmSpec(spec(x,{id:'../escape'})),/INVALID_VM_ID/);assert.equal(ubuntuBrowserVmDevtoolsBridgePort(spec(x)),9223);assert.throws(()=>validateUbuntuBrowserVmSpec(spec(x,{devtools_port:5900})),/INVALID_VM_DEVTOOLS_BRIDGE_PORT/);
});
test('runtime contract VM image download publishes a default only after its pinned hash verifies',async t=>{
  const x=await setup(t),bytes=Buffer.from('pinned official image bytes'),image={filename:'ubuntu.img',url:'https://images.example/ubuntu.img',sha256:createHash('sha256').update(bytes).digest('hex')};let calls=0;
  const fetched=await downloadVerifiedVmImage(x.root,image,{async fetch(){calls+=1;return new Response(bytes);}});assert.equal(fetched.downloaded,true);assert.equal(calls,1);assert.equal((await readFile(fetched.path)).equals(bytes),true);
  const reused=await downloadVerifiedVmImage(x.root,image,{async fetch(){throw Error('must not refetch verified image');}});assert.equal(reused.downloaded,false);
  let curlCalls=0;const curlImage={...image,filename:'curl.img'},fallback=await downloadVerifiedVmImage(x.root,curlImage,{async fetch(){throw Error('proxy required');}},{async run(command,args){curlCalls+=1;assert.equal(command,'curl');await writeFile(args[args.indexOf('--output')+1],bytes);return {code:0,stdout:'',stderr:''};}});assert.equal(fallback.downloaded,true);assert.equal(curlCalls,1);
  await assert.rejects(downloadVerifiedVmImage(x.root,{...image,filename:'bad.img',sha256:'0'.repeat(64)},{async fetch(){return new Response(bytes);}}),/VM_BASE_IMAGE_HASH_MISMATCH/);
});
test('runtime contract VM Playwright bridge permits only an explicit loopback-forwarded endpoint',()=>{
  const bridge=new OwnedVmCdpPage('sample-browser',9222,join(tmpdir(),'agent-driver-captures'));
  assert.equal(bridge.endpoint,'http://127.0.0.1:9222');assert.throws(()=>new OwnedVmCdpPage('bad/id',9222,'/tmp/captures'),/INVALID_VM_ID/);assert.throws(()=>new OwnedVmCdpPage('sample-browser',80,'/tmp/captures'),/INVALID_VM_DEVTOOLS_PORT/);
});
test('runtime contract VM signal inspection validates its bounded read-only surface before connecting',async()=>{
  const bridge=new OwnedVmCdpPage('sample-browser',9222,join(tmpdir(),'agent-driver-captures'));
  await assert.rejects(bridge.ownedPageSignalSnapshot('https://example.test','/main',[{id:'Bad-id',selector:'#login'}]),/INVALID_VM_SIGNAL_ID/);
  await assert.rejects(bridge.ownedPageSignalSnapshot('https://example.test','/main',[]),/INVALID_VM_SIGNAL_COUNT/);
  await assert.rejects(bridge.ownedPageSignalSnapshot('https://example.test','/main',[{id:'login',selector:'\n'}]),/INVALID_VM_SIGNAL_SELECTOR/);
});
