import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {provisionUbuntuBrowserVm,launchUbuntuBrowserVm,inspectUbuntuBrowserVm,defaultUbuntu2404Amd64Image} from '../dist/isolation/ubuntu-browser-vm.js';
import {browserTargetSchema} from '../dist/browser/executor-contracts.js';
import {RoutedBrowser} from '../dist/browser/executor-routing.js';

const root=await mkdtemp(join(tmpdir(),'agent-driver-phase85-vm-')),report={at:new Date().toISOString(),root,status:'NOT_RUN',evidence_level:'user_environment',events:[]};let vm,browser;
try{
  report.doctor=await inspectUbuntuBrowserVm();if(!report.doctor.ready)throw Error('VM_BACKEND_UNAVAILABLE');
  const available=Number((await readFile('/proc/meminfo','utf8')).match(/MemAvailable:\s+(\d+)/)[1]);if(available<1500*1024)throw Error('VM_ACCEPTANCE_MEMORY_HEADROOM_REQUIRED');
  const spec={id:'phase85-browser-test',storage_root:root,base_image:process.env.AGENT_DRIVER_TEST_BASE_IMAGE,base_image_sha256:defaultUbuntu2404Amd64Image.sha256,memory_mib:1024,cpus:1,disk_gib:16,ssh_port:23285,devtools_port:19285,vnc_port:15985,guest_user:'agentdriver'};
  report.spec={...spec};await provisionUbuntuBrowserVm(spec);vm=await launchUbuntuBrowserVm(spec);report.pid=vm.pid;await writeFile(join(root,'run.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({stage:'booting_owned_clean_guest',pid:vm.pid,root,memory_mib:1024}));
  const started=Date.now();let ready=false;
  while(Date.now()-started<480000){
    try{const response=await fetch(`http://127.0.0.1:${spec.devtools_port}/json/version`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}
    try{process.kill(vm.pid,0);}catch{throw Error('VM_EXITED_BEFORE_BROWSER_READY');}
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
  if(!ready)throw Error('VM_BROWSER_BOOTSTRAP_TIMEOUT');report.bootstrap_ms=Date.now()-started;
  const target=browserTargetSchema.parse({id:'ubuntu-browser',engine:'playwright',environment:'ubuntu_vm',platform:'linux',profile_ref:'guest-test'}),config={environment:'production',fingerprint:'vm-acceptance',dbPath:join(root,'runtime.sqlite'),project:{id:'test',profileRef:join(root,'profiles')},browserExecutors:{targets:[target]},swarm:{visual:{owned_vm:{id:spec.id,storage_root:root,devtools_port:spec.devtools_port,vnc_port:spec.vnc_port}}}};
  browser=new RoutedBrowser(config,{context_id:'vm-acceptance',profile_key:'test',preference:{environment:'ubuntu_vm'},event:e=>report.events.push(e)},['https://example.com']);const runStart=Date.now();await browser.open('https://example.com/');const result=await browser.observe();if(result.title!=='Example Domain')throw Error('VM_READBACK_MISMATCH');report.elapsed_ms=Date.now()-runStart;report.title=result.title;report.status='PASS';
}catch(error){report.status=/BACKEND_UNAVAILABLE|MEMORY_HEADROOM/.test(error.message)?'BLOCKED_ENV':'FAIL';report.error=error.message;}
finally{
  if(browser)await browser.close().catch(error=>{report.cleanup_error=error.message;report.status='FAIL';});
  if(vm){try{await vm.stop();report.owned_vm_stopped=true;}catch(error){report.cleanup_error=error.message;report.status='FAIL';}}
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  if(report.status==='FAIL')process.exitCode=1;
}
