import test from 'node:test';
import assert from 'node:assert/strict';
import {activeSwarmWorkerCount,workObservation} from '../dist/work/activity.js';
import {supervisorStatus} from '../dist/work/supervisor.js';

// Unit read-only store fixture: no database, worker process, model or execution.
const project='worker-liveness-unit',workId='fixture-work',atMs=1_900_000_000_000;
const worker=(overrides={})=>({status:'leased',lease_token:'owned-worker-token',lease_expires_at_ms:atMs+1000,...overrides});
function snapshot(status='running',workers={one:worker(),two:worker()}){return {status,workers};}
function readOnlyStore(savedSnapshot,overrides={},hasSupervisor=true){
  const checkpoint={kind:'swarm',run_id:'fixture-swarm',workers:Object.fromEntries(Object.keys(savedSnapshot.workers).map(id=>[id,{observations:[]}]))};
  const row={run_id:'fixture-supervisor',work_id:workId,work_revision:2,state:'running',owner:'owned-parent',lease_until_ms:atMs+1000,attempts:1,checkpoint:JSON.stringify(checkpoint),result:null,reason:null,current_run_only:1,updated_at:'2030-03-17T17:46:40.000Z',...overrides};
  const before={row:structuredClone(row),snapshot:structuredClone(savedSnapshot)},reads=[];
  const store={
    intakeWork(p,id){assert.equal(p,project);assert.equal(id,workId);return {spec:null};},
    hermesState:{exec(){assert.fail('observation must not execute or mutate SQL');},prepare(sql){
      assert.match(sql,/^SELECT /u);reads.push(sql);
      return {run(){assert.fail('observation must not write');},get(...parameters){
        if(sql.includes('FROM sqlite_master'))return sql.includes("name='office_supervisor'")&&hasSupervisor?{name:'office_supervisor'}:undefined;
        assert.deepEqual(parameters,[project,workId]);
        if(sql.includes('FROM office_supervisor'))return hasSupervisor?row:undefined;
        if(sql.includes('FROM office_intake'))return undefined;
        assert.fail('unexpected observation query: '+sql);
      }};
    }},
    officeRuns(p,id){assert.equal(p,project);assert.equal(id,workId);return [{source_kind:'swarm',source_id:'fixture-swarm'}];},
    swarmRun(p,id){assert.equal(p,project);assert.equal(id,'fixture-swarm');return {snapshot:savedSnapshot};},
  };
  return {store,row,reads,assertUnchanged(){assert.deepEqual(row,before.row);assert.deepEqual(savedSnapshot,before.snapshot);}};
}

test('runtime unit Swarm worker count accepts only running snapshots and owned unexpired finite leases without mutation',()=>{
  const saved=snapshot('running',{
    one:worker(),two:worker(),expired:worker({lease_expires_at_ms:atMs-1}),boundary:worker({lease_expires_at_ms:atMs}),
    missingToken:worker({lease_token:undefined}),nullToken:worker({lease_token:null}),emptyToken:worker({lease_token:''}),blankToken:worker({lease_token:' '}),
    missingExpiry:worker({lease_expires_at_ms:undefined}),nullExpiry:worker({lease_expires_at_ms:null}),infiniteExpiry:worker({lease_expires_at_ms:Infinity}),nanExpiry:worker({lease_expires_at_ms:NaN}),
    ready:worker({status:'ready'}),succeeded:worker({status:'succeeded'}),
  }),before=structuredClone(saved);
  assert.equal(activeSwarmWorkerCount(saved,atMs),2);
  assert.equal(activeSwarmWorkerCount(saved,atMs+1000),0);
  for(const state of ['needs_human','completed','failed','partial_evidence'])assert.equal(activeSwarmWorkerCount({...saved,status:state},atMs),0);
  assert.deepEqual(saved,before);
});

test('runtime unit supervisor sub-agent count requires a live parent plus a running snapshot and valid worker leases',t=>{
  t.mock.method(Date,'now',()=>atMs);
  const saved=snapshot('running',{one:worker(),two:worker(),expired:worker({lease_expires_at_ms:atMs}),missingToken:worker({lease_token:null})});
  const x=readOnlyStore(saved),status=supervisorStatus(x.store,project,workId);
  assert.equal(status.kind,'swarm');assert.equal(status.live,true);assert.equal(status.active_workers,2);x.assertUnchanged();
  const stopped=readOnlyStore(snapshot('failed')),stoppedStatus=supervisorStatus(stopped.store,project,workId);
  assert.equal(stoppedStatus.live,true);assert.equal(stoppedStatus.active_workers,0);stopped.assertUnchanged();
  const empty=readOnlyStore(snapshot('running',{}));assert.equal(supervisorStatus(empty.store,project,workId).active_workers,0);empty.assertUnchanged();
});

test('runtime unit supervisor stale expired ownerless or stopped parents never promote saved leases to active sub-agents',t=>{
  t.mock.method(Date,'now',()=>atMs);
  for(const overrides of [{lease_until_ms:atMs-1},{lease_until_ms:atMs},{owner:null},{owner:''},...['queued','paused','failed','succeeded','waiting_auth','reconciliation_required'].map(state=>({state}))]){
    const x=readOnlyStore(snapshot(),overrides),status=supervisorStatus(x.store,project,workId);
    assert.equal(status.live,false,JSON.stringify(overrides));assert.equal(status.active_workers,0,JSON.stringify(overrides));x.assertUnchanged();
  }
});

test('runtime unit legacy Swarm observation uses the same valid lease rule and never mutates stale snapshots',()=>{
  const running=readOnlyStore(snapshot('running',{one:worker(),two:worker(),missingToken:worker({lease_token:undefined}),expired:worker({lease_expires_at_ms:atMs})}),{},false);
  const observed=workObservation(running.store,project,workId,'running',atMs);
  assert.equal(observed.live,true);assert.equal(observed.active_workers,2);assert.equal(observed.basis,'swarm_worker_lease');assert.equal(observed.status,'running');running.assertUnchanged();
  const staleCases=[snapshot('running',{expired:worker({lease_expires_at_ms:atMs}),tokenless:worker({lease_token:null})}),...['needs_human','completed','failed','partial_evidence'].map(state=>snapshot(state))];
  for(const saved of staleCases){const x=readOnlyStore(saved,{},false),value=workObservation(x.store,project,workId,'running',atMs);assert.equal(value.live,false);assert.equal(value.active_workers,0);assert.equal(value.basis,'no_active_lease');assert.equal(value.status,'execution_unobserved');x.assertUnchanged();}
});
