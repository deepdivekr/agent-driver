import test from 'node:test';
import assert from 'node:assert/strict';
import {workActivity,withWorkActivityContext} from '../dist/work/activity.js';

test('parallel Work activity retains its own host stage, run and operation context',async()=>{
  const rows=[];
  const store={hermesState:{prepare:()=>({run:(...args)=>rows.push(args)})}};
  const emit=async(stage,delay)=>withWorkActivityContext({project_id:'p',work_id:'w',run_id:'run',stage_id:stage,operation_id:`op-${stage}`,stage_binding:'a'.repeat(64)},async()=>{
    await new Promise(resolve=>setTimeout(resolve,delay));
    workActivity(store,'p','w','source.started','Opening source',{stage_id:'untrusted',target_url:'https://example.com/source',status:'running'});
  });
  await Promise.all([emit('collect',15),emit('verify',1)]);
  assert.deepEqual(rows.map(row=>JSON.parse(row[5]).stage_id),['verify','collect']);
  for(const row of rows){const metadata=JSON.parse(row[5]);assert.equal(metadata.run_id,'run');assert.equal(metadata.operation_id,`op-${metadata.stage_id}`);assert.equal(metadata.source,undefined,'A navigation attempt must not become observed source evidence');}
  withWorkActivityContext({project_id:'p',work_id:'w',run_id:'run',stage_id:'collect'},()=>workActivity(store,'p','other','source.started','Other work'));
  assert.equal(rows.at(-1)[5],null,'Context cannot cross Work boundaries');
  workActivity(store,'p','w','source.started','Outside context');
  assert.equal(rows.at(-1)[5],null,'Context must not leak after a scoped operation');
});
