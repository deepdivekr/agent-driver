import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersonalAgentComputer} from '../dist/isolation/personal-agent-computer.js';
import {inspectWindowsPersonalVm,windowsPersonalVmDiskPath,windowsPersonalVmLoopbackForwards,windowsPersonalVmUiaEndpoint} from '../dist/isolation/windows-personal-vm.js';
import {WindowsUiaGuestClient,parseWindowsUiaInventory} from '../dist/desktop/windows-uia.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'driver-windows-vm-')),iso=join(root,'owner-installer.iso'),firmware=join(root,'OVMF_CODE.fd');
  await writeFile(iso,'owner-provided-installer');await writeFile(firmware,'pinned-firmware');
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  return {root,iso,firmware,spec:{id:'windows-agent',storage_root:root,installer_iso:iso,installer_iso_sha256:digest('owner-provided-installer'),uefi_firmware:firmware,uefi_firmware_sha256:digest('pinned-firmware'),image_license_attestation:'owner_provided',memory_mib:4096,cpus:2,disk_gib:64,desktop_agent_port:17443,rdp_port:13389,host_desktop_access:'none',host_file_bridge:'explicit_transfer_only'}};
}
test('runtime Windows Personal Agent Computer accepts only verified owner image inputs and loopback bridges',async t=>{
  const x=await setup(t),runner={async run(){return {code:0,stdout:'ok',stderr:''};}},host={platform:'linux',async canUseKvm(){return true;}};
  const doctor=await inspectWindowsPersonalVm(x.spec,runner,host);
  assert.equal(doctor.ready,true);assert.deepEqual(doctor.artifacts,{installer_iso:'verified',uefi_firmware:'verified'});assert.equal(doctor.host_desktop_fallback,false);
  assert.deepEqual(windowsPersonalVmLoopbackForwards(x.spec),[{host:'127.0.0.1',host_port:17443,guest_port:7443,purpose:'guest_uia_agent'},{host:'127.0.0.1',host_port:13389,guest_port:3389,purpose:'owner_rdp'}]);
  assert.equal(windowsPersonalVmUiaEndpoint(x.spec),'http://127.0.0.1:17443');assert.equal(windowsPersonalVmDiskPath(x.spec),join(x.root,'windows-agent','windows.qcow2'));
  const mismatch=await inspectWindowsPersonalVm({...x.spec,installer_iso_sha256:'0'.repeat(64)},runner,host);assert.equal(mismatch.ready,false);assert.deepEqual(mismatch.artifacts.installer_iso,'hash_mismatch');
  assert.throws(()=>windowsPersonalVmLoopbackForwards({...x.spec,host_desktop_access:'shared'}),/WINDOWS_HOST_DESKTOP_FALLBACK_FORBIDDEN/);
  assert.throws(()=>windowsPersonalVmLoopbackForwards({...x.spec,image_license_attestation:'downloaded'}),/WINDOWS_VM_UNVERIFIED_IMAGE_LICENSE/);
});
test('runtime Windows UIA contract separates observed inventory from exact reviewed invoke',async t=>{
  const x=await setup(t),computer=createPersonalAgentComputer({id:'windows-agent',guest_os:'windows',available_surfaces:['desktop'],owner_scope:'single_user',lifecycle:'persistent',guest_state:'shared_across_owner_tasks',host_desktop_access:'none',host_file_bridge:'explicit_transfer_only'}),calls=[];
  const client=new WindowsUiaGuestClient(computer,x.spec,{
    async observe(endpoint,request){calls.push({kind:'observe',endpoint,request});return {...request,capture_id:'capture-1',controls:[{automation_id:'save-button',control_type:'button',name:'Save',enabled:true,visible:true},{automation_id:'password-edit',control_type:'edit',enabled:true,visible:true}]};},
    async invoke(endpoint,action){calls.push({kind:'invoke',endpoint,action});return {computer_id:action.computer_id,task_id:action.task_id,capture_id:action.capture_id,control_automation_id:action.control_automation_id,outcome:'invoked'};},
  });
  const request={computer_id:'windows-agent',task_id:'task-1',application_id:'sample-portal',window_automation_id:'main-window'},inventory=await client.observe(request);
  assert.equal(inventory.controls.length,2);const receipt=await client.invoke({computer_id:'windows-agent',task_id:'task-1',application_id:'sample-portal',window_automation_id:'main-window',capture_id:'capture-1',control_automation_id:'save-button',expected_control_type:'button',action:'invoke',review_id:'review-1',reviewed:true});
  assert.equal(receipt.outcome,'invoked');assert.deepEqual(calls.map(call=>call.endpoint),['http://127.0.0.1:17443','http://127.0.0.1:17443']);
  assert.throws(()=>parseWindowsUiaInventory({...request,capture_id:'capture-2',controls:[{automation_id:'secret-edit',control_type:'edit',enabled:true,visible:true,value:'must-not-leave-guest'}]}),/WINDOWS_UIA_VALUE_DISCLOSURE/);
  await assert.rejects(client.invoke({computer_id:'windows-agent',task_id:'task-1',application_id:'sample-portal',window_automation_id:'main-window',capture_id:'capture-1',control_automation_id:'save-button',expected_control_type:'button',action:'invoke',review_id:'review-1',reviewed:false}),/WINDOWS_UIA_UNREVIEWED_ACTION/);
});
