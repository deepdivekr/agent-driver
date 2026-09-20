import assert from 'node:assert/strict';
import {openSync,writeSync,fsyncSync,closeSync,unlinkSync,writeFileSync,readFileSync,statfsSync,ftruncateSync,statSync} from 'node:fs';
import {RuntimeStore} from './dist/store/runtime-store.js';
import {storageError} from './dist/storage/budget.js';
import {writeSpoolSegment} from './dist/terminal/spool.js';
const root='/work',path=root+'/runtime.sqlite';
let store=new RuntimeStore(path);
const project={id:'space',callerRef:'owned',worktree:root,profileRef:root+'/profile',accountRef:'synthetic',allowedOrigins:[],capabilities:['synthetic.effect']};
store.registerProject(project);
const task=store.createTask(project.id,'synthetic.effect'),lease=store.acquire(task.id,'owned-resource','owned-target');
const intent=store.begin(lease,'synthetic.effect','write_external',{synthetic:true},'owned-test');
writeFileSync(root+'/sentinel','unchanged');
const segment={session_id:'owned-test',start_offset:0,bytes:0,filename:'owned-test.jsonl',state:'open'},initial=Buffer.from('committed\n');
writeSpoolSegment(path,segment,initial,true);segment.bytes=initial.length;
const fs=statfsSync(root);assert.equal(fs.type,0x01021994,'only the private tmpfs may be filled');
assert.ok(fs.blocks*fs.bsize<=33554432);
const fd=openSync(root+'/finite-filler','wx'),block=Buffer.alloc(65536,0x51);let written=0,failure;
try {for(let n=0;n<520;n++)written+=writeSync(fd,block);fsyncSync(fd);}catch(e){failure=e;}finally{closeSync(fd);}
assert.equal(failure?.code,'ENOSPC');
let dbError;try{store.response(lease,intent,true);}catch(e){dbError=e;}
assert.equal(storageError(dbError),'STORAGE_FULL',String(dbError));
assert.equal(store.task(task.id).effect_state,'unknown');assert.equal(store.task(task.id).status,'running');
const reopened=new RuntimeStore(path);assert.equal(reopened.task(task.id).effect_state,'unknown');reopened.close();
assert.equal(readFileSync(root+'/sentinel','utf8'),'unchanged');
// Free only 32 KiB of the owned filler: a 128 KiB spool write must stop partway.
const shrink=openSync(root+'/finite-filler','r+');try{ftruncateSync(shrink,Math.max(0,written-32768));}finally{closeSync(shrink);}
let spoolError;try{writeSpoolSegment(path,segment,Buffer.alloc(131072,0x61),false);}catch(e){spoolError=e;}
assert.equal(spoolError?.code,'ENOSPC');
const partialBytes=statSync(root+'/terminal-spool/owned-test.jsonl').size;assert.ok(partialBytes>initial.length&&partialBytes<initial.length+131072);
assert.throws(()=>writeSpoolSegment(path,segment,Buffer.from('never append'),false),/CLI_SPOOL_DURABILITY_GAP/);
unlinkSync(root+'/finite-filler');
store.close();store=new RuntimeStore(path);
assert.equal(store.recoverTask(task.id).status,'reconciliation_required');
assert.equal(store.task(task.id).effect_state,'unknown');
assert.throws(()=>store.begin(lease,'synthetic.effect','write_external',{},'owned-test'));
store.close();
console.log(JSON.stringify({status:'PASS',filesystem:'private_tmpfs',filesystem_bytes:fs.blocks*fs.bsize,written_bytes:written,os_error:failure.code,sqlite_error_code:dbError.errcode,reopened_while_full:true,prior_intent_retained:true,spool_error:spoolError.code,spool_partial_bytes:partialBytes,spool_gap_append_blocked:true,automatic_replay:false,sentinel:'unchanged'}));
