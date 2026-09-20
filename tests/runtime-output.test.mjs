import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {OutputPump,OUTPUT_SLICE} from '../dist/terminal/output-pump.js';
import {JsonLineDecoder,transportFromChild} from '../dist/terminal/claude.js';
import {runOutputLoad} from '../scripts/runtime/output-load.mjs';

function harness(receive=()=>{}){
 const input=new PassThrough({highWaterMark:65536}),errors=[];let finish;
 const done=new Promise(resolve=>finish=resolve);
 const pump=new OutputPump(input,new JsonLineDecoder(receive),code=>errors.push(code),()=>finish());
 return {input,pump,errors,done};
}
const line=i=>JSON.stringify({type:'assistant',uuid:String(i),text:'한국어🐈\r\n본문'})+'\n';
test('runtime contract output finite slices preserve every ordered frame through EOF and yield to control work',async()=>{
 const seen=[];const h=harness(e=>seen.push(Number(e.uuid)));
 h.input.end(Array.from({length:1200},(_,i)=>line(i)).join(''));
 let observedBeforeDone;setImmediate(()=>{observedBeforeDone=seen.length;});
 await h.done;assert.deepEqual(seen,Array.from({length:1200},(_,i)=>i));assert.deepEqual(h.errors,[]);
 assert.ok(observedBeforeDone>=0&&observedBeforeDone<=OUTPUT_SLICE.frames);
 const stats=h.pump.observations();assert.ok(stats.slices>=150);assert.ok(stats.bytes>65536);assert.ok(stats.max_retained_chunk_bytes<=65536);assert.ok(stats.max_readable_bytes<=131072);
});
test('runtime contract output abort inside a callback discards queued completion and resolves once',async()=>{
 const seen=[];const h=harness(e=>{seen.push(e.uuid);h.pump.abort();});
 h.input.end(line(1)+line(2));await h.done;h.pump.abort();await delay(5);assert.deepEqual(seen,['1']);assert.deepEqual(h.errors,[]);
});
test('runtime contract output oversized readable queue fails closed without accepting any frame',async()=>{
 const seen=[];const h=harness(e=>seen.push(e));h.input.end(Buffer.alloc(131073,32));await h.done;
 assert.deepEqual(h.errors,['CLI_OUTPUT_BUFFER_LIMIT']);assert.deepEqual(seen,[]);
});
for(const [name,wire,expected] of [['truncated','{"type":','CLI_TRUNCATED_FRAME'],['invalid','bad\n','CLI_PROTOCOL_ERROR'],['unknown-shape','{}\n','CLI_INVALID_FRAME']])test(`runtime contract output ${name} records failure before drained and never completes`,async()=>{
 const input=new PassThrough(),events=[];let finish;const done=new Promise(r=>finish=r);
 new OutputPump(input,new JsonLineDecoder(()=>events.push('frame')),code=>events.push(code),()=>{events.push('drained');finish();});
 input.end(wire);await done;assert.deepEqual(events,[expected,'drained']);
});
test('runtime contract output unterminated frame limit remains bounded across slices',async()=>{
 const h=harness();let closed=false;h.done.then(()=>closed=true);
 for(let i=0;i<18&&!closed;i++){h.input.write(Buffer.alloc(65536,120));await delay(1);}
 await h.done;assert.deepEqual(h.errors,['CLI_FRAME_TOO_LARGE']);assert.ok(h.pump.observations().max_retained_chunk_bytes<=65536);h.input.destroy();
});
test('runtime native output child close waits for all queued frames, with one final exit',async()=>{
 const seen=[],events=[];let finish;const done=new Promise(r=>finish=r);
 const child=spawn(process.execPath,['-e',`process.stdout.write(${JSON.stringify(Array.from({length:80},(_,i)=>line(i)).join(''))});`],{stdio:['pipe','pipe','pipe']});
 const transport=transportFromChild(child,{cli_session_id:'fixture'},{event:e=>seen.push(Number(e.uuid)),failure:c=>events.push(c),exit:()=>{events.push('exit');finish();}});
 await done;assert.deepEqual(seen,Array.from({length:80},(_,i)=>i));assert.deepEqual(events,['exit']);assert.equal(transport.writable(),false);await transport.stop();
});
test('runtime native output stopped child with blocked pipe exits without processing queued results',async()=>{
 const seen=[];let finish;const done=new Promise(r=>finish=r);
 const child=spawn(process.execPath,['-e',`const s=${JSON.stringify(line(1))};setInterval(()=>{for(let i=0;i<2000;i++)process.stdout.write(s);},1);`],{stdio:['pipe','pipe','pipe']});
 const transport=transportFromChild(child,{cli_session_id:'fixture'},{event:e=>{seen.push(e);void transport.stop();},failure:()=>{},exit:()=>finish()});
 await done;assert.equal(seen.length,1);assert.equal(transport.writable(),false);await transport.stop();
});
test('runtime fixture output independent host remains responsive, other session progresses, cancel has no false completion', {timeout:30000},async t=>{
 const observed=await runOutputLoad({durationMs:1500});
 t.diagnostic(JSON.stringify(observed));assert.equal(observed.status,'PASS',JSON.stringify(observed));
 assert.ok(observed.samples.length>=2);assert.ok(observed.final.spool_bytes>0);assert.deepEqual(observed.children,['dead','dead']);
});
