import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bindTaskToPersonalAgentComputer,createPersonalAgentComputer,personalAgentComputerFromUbuntuBrowserVm,personalAgentComputerLeaseResource} from '../dist/isolation/personal-agent-computer.js';
import {RuntimeStore} from '../dist/store/runtime-store.js';

const personal=()=>createPersonalAgentComputer({
  id:'personal-agent',guest_os:'linux',available_surfaces:['browser','terminal'],owner_scope:'single_user',lifecycle:'persistent',guest_state:'shared_across_owner_tasks',host_desktop_access:'none',host_file_bridge:'explicit_transfer_only',
});

test('runtime contract personal Agent Computer persists one guest workspace across task leases without sharing the host desktop',()=>{
  const computer=personal(),first=bindTaskToPersonalAgentComputer(computer,'task-a',['browser']),second=bindTaskToPersonalAgentComputer(computer,'task-b',['terminal']);
  assert.equal(computer.lifecycle,'persistent');assert.equal(computer.guest_state,'shared_across_owner_tasks');assert.equal(computer.host_desktop_access,'none');assert.equal(computer.host_file_bridge,'explicit_transfer_only');
  assert.equal(first.resource,second.resource);assert.notEqual(first.task_id,second.task_id);assert.equal(first.shared_guest_state,true);assert.equal(first.exclusive_interactive_control,true);
  assert.equal(first.resource,personalAgentComputerLeaseResource('personal-agent'));
});

test('runtime contract personal Agent Computer refuses host sharing, unimplemented surfaces, and invalid task bindings',()=>{
  assert.throws(()=>createPersonalAgentComputer({...personal(),host_desktop_access:'shared'}),/HOST_DESKTOP_SHARING_FORBIDDEN/);
  assert.throws(()=>createPersonalAgentComputer({...personal(),host_file_bridge:'shared_folder'}),/IMPLICIT_HOST_FILE_BRIDGE_FORBIDDEN/);
  assert.throws(()=>bindTaskToPersonalAgentComputer(personal(),'task-a',['desktop']),/AGENT_COMPUTER_SURFACE_UNAVAILABLE/);
  assert.throws(()=>bindTaskToPersonalAgentComputer(personal(),'bad task',['browser']),/INVALID_AGENT_COMPUTER_TASK_ID/);
});

test('runtime contract existing Ubuntu browser VM is a personal browser computer, not a claim of host or desktop-app access',()=>{
  const computer=personalAgentComputerFromUbuntuBrowserVm({id:'sample-browser'});
  assert.equal(computer.guest_os,'linux');assert.deepEqual(computer.available_surfaces,['browser']);assert.equal(computer.host_desktop_access,'none');
  assert.throws(()=>bindTaskToPersonalAgentComputer(computer,'task-a',['desktop']),/AGENT_COMPUTER_SURFACE_UNAVAILABLE/);
});

test('runtime integration one durable RuntimeStore resource serializes interactive tasks on the shared personal computer',async t=>{
  const root=await mkdtemp(join(tmpdir(),'agent-driver-personal-computer-')),db=join(root,'runtime.sqlite');
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  const store=new RuntimeStore(db),project={id:'personal-project',callerRef:'owner',worktree:root,profileRef:join(root,'profile'),accountRef:'account-a',allowedOrigins:['https://example.test'],capabilities:['browser.task']};
  try {
    store.registerProject(project);const firstTask=store.createTask(project.id,'browser.task'),secondTask=store.createTask(project.id,'browser.task');
    const computer=personal(),first=bindTaskToPersonalAgentComputer(computer,firstTask.id,['browser']),second=bindTaskToPersonalAgentComputer(computer,secondTask.id,['browser']);
    const lease=store.acquire(first.task_id,first.resource,'owned-target:first');
    assert.throws(()=>store.acquire(second.task_id,second.resource,'owned-target:second'),/RESOURCE_BUSY/);
    store.release(lease);const resumed=store.acquire(second.task_id,second.resource,'owned-target:second');
    assert.equal(resumed.resource,first.resource);assert.equal(resumed.generation,lease.generation+1);
  } finally {store.close();}
});
