import {backup,DatabaseSync} from 'node:sqlite';
import {constants,openSync,closeSync,lstatSync,fstatSync,realpathSync,mkdirSync,chmodSync,readSync,writeSync,fsyncSync,renameSync,readFileSync,statfsSync,readdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {inspectSnapshot} from './snapshot.js';
import {MIGRATION_7} from '../store/migration.js';
import {withArtifactDirectory,type ArtifactManifest,fileIdentity} from './artifacts.js';

const MiB=1048576,defaultBudget=128*MiB,maxBudget=512*MiB,flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema=z.object({path:z.string().max(240),bytes:z.number().int().nonnegative().max(maxBudget),sha256:sha}).strict();
const summarySchema=z.object({
 schema_version:z.union([z.literal(6),z.literal(7)]),schema_sha256:sha,instance_id:z.string().max(100),mode:z.string().max(40),
 projects:z.number().int().nonnegative(),tasks:z.number().int().nonnegative(),events:z.number().int().nonnegative(),max_event_id:z.number().int().nonnegative(),
 turns:z.number().int().nonnegative(),intents:z.number().int().nonnegative(),file_intents:z.number().int().nonnegative(),cursors:z.number().int().nonnegative(),
 task_states:z.array(z.object({status:z.string().max(100),count:z.number().int().nonnegative()}).strict()).max(100),
 effect_states:z.array(z.object({effect_state:z.string().max(100),count:z.number().int().nonnegative()}).strict()).max(100),
}).strict();
const manifestSchema=z.object({
 format:z.literal(1),id:z.string().uuid(),kind:z.enum(['backup','quarantined_restore']),created_at:z.string().max(50),budget_bytes:z.number().int().min(MiB).max(maxBudget),
 source_backup_sha256:sha.nullable(),source_snapshot:summarySchema,snapshot:summarySchema,entries:z.array(entrySchema).min(1).max(10001),
 excluded:z.array(z.string()).max(20),post_snapshot_effects:z.literal('unknown'),automatic_execution:z.literal(false),
}).strict();
type Entry=z.infer<typeof entrySchema>;
type Manifest=z.infer<typeof manifestSchema>;
type Cut=(point:string)=>void|Promise<void>;
const noCut:Cut=()=>{};
function budget(value:number){requireCondition(Number.isSafeInteger(value)&&value>=MiB&&value<=maxBudget,'BACKUP_INVALID_BUDGET');return value;}
function safeFile(path:string,limit=maxBudget) {
 const st=lstatSync(path);requireCondition(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=limit,'BACKUP_UNSAFE_FILE');return st;
}
function sourcePath(path:string) {
 requireCondition(process.platform==='linux','BACKUP_PLATFORM_UNVERIFIED');
 const p=resolve(path);requireCondition(realpathSync(dirname(p))===dirname(p),'BACKUP_PARENT_REDIRECTED');
 safeFile(p);
 for(const suffix of ['-wal','-shm','-journal'])try{safeFile(p+suffix);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 return p;
}
function sqlite(path:string,readOnly=true) {return new DatabaseSync(path,{readOnly,allowExtension:false,enableForeignKeyConstraints:true,timeout:2000});}
function checkSourceUnchanged(path:string,identity:string){requireCondition(fileIdentity(lstatSync(path,{bigint:true}))===identity,'BACKUP_SOURCE_CHANGED');}
function openRoot(path:string) {
 const root=resolve(path);requireCondition(realpathSync(root)===root,'BACKUP_PARENT_REDIRECTED');
 const fd=openSync(root,flags),identity=fileIdentity(fstatSync(fd,{bigint:true}));
 return {root,fd,identity};
}
function assertRoot(root:ReturnType<typeof openRoot>){requireCondition(fileIdentity(lstatSync(root.root,{bigint:true}))===root.identity,'BACKUP_ROOT_CHANGED');}
function createRoot(path:string) {
 const destination=resolve(path),parent=dirname(destination);requireCondition(realpathSync(parent)===parent&&destination!==parent,'BACKUP_PARENT_REDIRECTED');
 // mkdir without recursive/overwrite makes an existing destination an error.
 mkdirSync(destination,{mode:0o700});const root=openRoot(destination);
 const fd=openSync(parent,flags);try{fsyncSync(fd);}finally{closeSync(fd);}
 return root;
}
function parts(path:string) {
 if(path==='runtime.sqlite')return {folder:null,name:path};
 const match=/^(terminal-spool|terminal-handoffs)\/([a-zA-Z0-9][a-zA-Z0-9.-]{0,200})$/.exec(path);
 requireCondition(match,'BACKUP_INVALID_PATH');return {folder:match[1]!,name:match[2]!};
}
function inFolder<T>(root:number,path:string,create:boolean,fn:(fd:number,name:string)=>T):T {
 const {folder,name}=parts(path);
 if(!folder)return fn(root,name);
 const anchored='/proc/self/fd/'+root+'/'+folder;
 if(create)try{mkdirSync(anchored,{mode:0o700});fsyncSync(root);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 const fd=openSync(anchored,flags);try{return fn(fd,name);}finally{closeSync(fd);}
}
function fileHash(root:number,path:string,limit:number):Entry {
 return inFolder(root,path,false,(folder,name)=>{
  const fd=openSync('/proc/self/fd/'+folder+'/'+name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const before=fstatSync(fd,{bigint:true});requireCondition(before.isFile()&&before.nlink===1n&&before.size<=BigInt(limit),'BACKUP_UNSAFE_FILE');
   const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let position=0;
   for(;;){const n=readSync(fd,buffer,0,buffer.length,position);if(!n)break;position+=n;requireCondition(position<=limit,'BACKUP_BUDGET_EXCEEDED');digest.update(buffer.subarray(0,n));}
   const after=fstatSync(fd,{bigint:true});requireCondition(before.size===after.size&&before.mtimeNs===after.mtimeNs&&before.ctimeNs===after.ctimeNs&&position===Number(before.size),'BACKUP_FILE_CHANGED');
   return {path,bytes:position,sha256:digest.digest('hex')};
  }finally{closeSync(fd);}
 });
}
function copyFd(source:number,destRoot:number,path:string,length:number,expected:string) {
 requireCondition(Number.isSafeInteger(length)&&length>=0&&length<=maxBudget,'BACKUP_BUDGET_EXCEEDED');
 return inFolder(destRoot,path,true,(folder,name)=>{
  const fd=openSync('/proc/self/fd/'+folder+'/'+name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let position=0;
  try{
   while(position<length){const n=readSync(source,buffer,0,Math.min(buffer.length,length-position),position);requireCondition(n>0,'BACKUP_ARTIFACT_TRUNCATED');digest.update(buffer.subarray(0,n));let written=0;while(written<n){const w=writeSync(fd,buffer,written,n-written);requireCondition(w>0,'BACKUP_WRITE_FAILED');written+=w;}position+=n;}
   requireCondition(digest.digest('hex')===expected,'BACKUP_HASH_MISMATCH');fsyncSync(fd);
  }finally{closeSync(fd);}
  fsyncSync(folder);return {path,bytes:length,sha256:expected};
 });
}
function writeJson(root:number,name:string,value:unknown) {
 requireCondition(['.agent-driver-maintenance.json','manifest.pending','manifest.json'].includes(name),'BACKUP_INVALID_PATH');
 const fd=openSync('/proc/self/fd/'+root+'/'+name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600),bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
 try{let offset=0;while(offset<bytes.length){const n=writeSync(fd,bytes,offset);requireCondition(n>0,'BACKUP_WRITE_FAILED');offset+=n;}fsyncSync(fd);}finally{closeSync(fd);}fsyncSync(root);return hash(bytes);
}
async function publish(root:ReturnType<typeof openRoot>,manifest:Manifest,cut:Cut) {
 manifestSchema.parse(manifest);
 const length=Buffer.byteLength(JSON.stringify(manifest,null,2)+'\n');
 requireCondition(length<=8*MiB&&length+manifest.entries.reduce((n,e)=>n+e.bytes,0)+safeFile('/proc/self/fd/'+root.fd+'/.agent-driver-maintenance.json').size<=manifest.budget_bytes,'BACKUP_BUDGET_EXCEEDED');
 const sha256=writeJson(root.fd,'manifest.pending',manifest);
 await cut('before_publish');assertRoot(root);
 renameSync('/proc/self/fd/'+root.fd+'/manifest.pending','/proc/self/fd/'+root.fd+'/manifest.json');fsyncSync(root.fd);
 await cut('published');return {id:manifest.id,directory:root.root,kind:manifest.kind,manifest_sha256:sha256,snapshot:manifest.snapshot,entries:manifest.entries.length,automatic_execution:false};
}
function sourceArtifacts(db:DatabaseSync) {
 const segments=db.prepare("SELECT * FROM terminal_spool_segment WHERE state!='pruned' ORDER BY session_id,start_offset LIMIT 10001").all();
 const rows=db.prepare("SELECT * FROM storage_artifact WHERE state!='pruned' ORDER BY id LIMIT 10001").all();
 requireCondition(segments.length<=10000&&rows.length<=10000,'BACKUP_ARTIFACT_LIMIT');
 requireCondition(rows.every(r=>r.state==='retained')&&segments.every(s=>s.state==='open'||s.state==='sealed'),'BACKUP_ARTIFACT_PRUNING');
 const artifacts=rows.map(row=>{
  const m=JSON.parse(String(row.manifest_json)) as ArtifactManifest;parts(m.directory+'/'+m.filename);
  requireCondition(['spool','handoff'].includes(String(row.kind))&&m.directory===(row.kind==='spool'?'terminal-spool':'terminal-handoffs')&&Number.isSafeInteger(m.bytes)&&m.bytes>=0&&m.bytes<=16*MiB&&/^[a-f0-9]{64}$/.test(m.sha256),'BACKUP_INVALID_ARTIFACT');
  if(row.kind==='spool')requireCondition(segments.some(s=>s.session_id===row.session_id&&s.filename===m.filename&&s.bytes===m.bytes),'BACKUP_ARTIFACT_BINDING');
  return m;
 });
 for(const s of segments)requireCondition(artifacts.some(m=>m.directory==='terminal-spool'&&m.filename===s.filename&&m.bytes===s.bytes),'BACKUP_UNVERIFIED_LEGACY_SPOOL');
 requireCondition(new Set(artifacts.map(m=>m.directory+'/'+m.filename)).size===artifacts.length,'BACKUP_DUPLICATE_ARTIFACT');
 return artifacts;
}
export async function createBackup(database:string,destination:string,options:{maxBytes?:number;cut?:Cut;rate?:number;onProgress?:()=>void}={}) {
 const limit=budget(options.maxBytes??defaultBudget),path=sourcePath(database),sourceIdentity=fileIdentity(lstatSync(path,{bigint:true})),source=sqlite(path);
 let root:ReturnType<typeof openRoot>|null=null;
 const cut=options.cut??noCut,start=performance.now();
 try{
  source.exec('BEGIN;'); // Pin one WAL read snapshot across metadata and online backup.
  const initial=inspectSnapshot(source);requireCondition(initial.mode!=='quarantined','BACKUP_SOURCE_QUARANTINED');
  const pageSize=Number(source.prepare('PRAGMA page_size').get()!.page_size),size=Number(source.prepare('PRAGMA page_count').get()!.page_count)*pageSize;
  requireCondition(size<limit,'BACKUP_BUDGET_EXCEEDED');
  const free=statfsSync(dirname(resolve(destination)));requireCondition(free.bavail*free.bsize>=limit+16*MiB,'BACKUP_LOW_SPACE');
  root=createRoot(destination);const id=randomUUID();writeJson(root.fd,'.agent-driver-maintenance.json',{format:1,id,kind:'backup',automatic_execution:false});
  const target=join(root.root,'runtime.sqlite'),empty=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600),targetIdentity=fileIdentity(fstatSync(empty,{bigint:true}));closeSync(empty);
  await cut('before_database');
  assertRoot(root);safeFile(target);checkSourceUnchanged(target,targetIdentity);
  requireCondition(Number.isSafeInteger(options.rate??64)&&(options.rate??64)>0&&(options.rate??64)<=1024,'BACKUP_INVALID_RATE');
  await backup(source,target,{rate:options.rate??64,progress:({totalPages})=>{requireCondition(totalPages*pageSize<=limit,'BACKUP_BUDGET_EXCEEDED');requireCondition(performance.now()-start<120000,'BACKUP_DEADLINE');options.onProgress?.();}});
  source.exec('ROLLBACK;');
  checkSourceUnchanged(path,sourceIdentity);assertRoot(root);safeFile(target);checkSourceUnchanged(target,targetIdentity);
  const snapshot=sqlite(target,false);let observed:ReturnType<typeof inspectSnapshot>,artifacts:ArtifactManifest[];
  try{
   requireCondition(JSON.stringify(inspectSnapshot(snapshot))===JSON.stringify(initial),'BACKUP_SNAPSHOT_MISMATCH');artifacts=sourceArtifacts(snapshot);
   snapshot.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
   if(initial.schema_version===6)snapshot.exec(MIGRATION_7);
   snapshot.prepare("UPDATE runtime_identity SET instance_id=?,mode='quarantined',provenance_json=? WHERE singleton=1").run(randomUUID(),JSON.stringify({backup_id:id,source_instance:initial.instance_id,post_snapshot_effects:'unknown'}));
   snapshot.exec('COMMIT;');observed=inspectSnapshot(snapshot);
  }finally{snapshot.close();}
  chmodSync(target,0o600);const f=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(f);}finally{closeSync(f);}fsyncSync(root.fd);
  await cut('database_copied');
  const entries=[fileHash(root.fd,'runtime.sqlite',limit)];let used=entries[0]!.bytes;
  for(const artifact of artifacts){
   used+=artifact.bytes;requireCondition(used+65536<=limit,'BACKUP_BUDGET_EXCEEDED');
   const entry=withArtifactDirectory(path,artifact.directory,(dir,rootIdentity,directoryIdentity)=>{
    requireCondition(rootIdentity===artifact.root_identity&&directoryIdentity===artifact.directory_identity,'BACKUP_ARTIFACT_OWNER_CHANGED');
    const fd=openSync('/proc/self/fd/'+dir+'/'+artifact.filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
     const st=fstatSync(fd,{bigint:true});requireCondition(st.isFile()&&st.nlink===1n&&fileIdentity(st)===artifact.file_identity&&st.size>=BigInt(artifact.bytes),'BACKUP_ARTIFACT_OWNER_CHANGED');
     // A live spool may have appended since the DB snapshot; only its exact
     // committed prefix, verified against the snapshot hash, belongs here.
     return copyFd(fd,root!.fd,artifact.directory+'/'+artifact.filename,artifact.bytes,artifact.sha256);
    }finally{closeSync(fd);}
   });entries.push(entry);
  }
  checkSourceUnchanged(path,sourceIdentity);await cut('artifacts_copied');
  const manifest:Manifest={format:1,id,kind:'backup',created_at:new Date().toISOString(),budget_bytes:limit,source_backup_sha256:null,source_snapshot:initial,snapshot:observed,entries,
   excluded:['user_worktree','login_auth','browser_profiles','CLI_private_cache','unregistered_artifacts','verifier_snapshots','staging'],post_snapshot_effects:'unknown',automatic_execution:false};
  return await publish(root,manifest,cut);
 }finally{source.close();if(root)closeSync(root.fd);}
}
function inspectBundleAt(root:ReturnType<typeof openRoot>,expectedHash?:string) {
 if(expectedHash!==undefined)requireCondition(/^[a-f0-9]{64}$/.test(expectedHash),'BACKUP_INVALID_DIGEST');
 const path='/proc/self/fd/'+root.fd+'/manifest.json';safeFile(path,8*MiB);
 const bytes=readFileSync(path),digest=hash(bytes);if(expectedHash)requireCondition(digest===expectedHash,'BACKUP_MANIFEST_MISMATCH');
 const manifest=manifestSchema.parse(JSON.parse(bytes.toString('utf8'))),names=manifest.entries.map(e=>e.path);
 requireCondition(names.filter(p=>p==='runtime.sqlite').length===1&&new Set(names).size===names.length,'BACKUP_DUPLICATE_ARTIFACT');
 const markerBytes=safeFile('/proc/self/fd/'+root.fd+'/.agent-driver-maintenance.json',4096).size;
 // No journal/WAL companions or unlisted payloads may affect an otherwise
 // hash-verified database. Reject before SQLite has a chance to read them.
 const expectedNames=new Set(['manifest.json','.agent-driver-maintenance.json',...names.map(p=>{parts(p);return p.split('/')[0]!;})]);
 for(const name of readdirSync('/proc/self/fd/'+root.fd))requireCondition(expectedNames.has(name),'BACKUP_UNEXPECTED_FILE');
 for(const folder of ['terminal-spool','terminal-handoffs'])if(expectedNames.has(folder)){
  const fd=openSync('/proc/self/fd/'+root.fd+'/'+folder,flags);try{for(const name of readdirSync('/proc/self/fd/'+fd))requireCondition(names.includes(folder+'/'+name),'BACKUP_UNEXPECTED_FILE');}finally{closeSync(fd);}
 }
 let used=bytes.length+markerBytes;
 for(const entry of manifest.entries){parts(entry.path);used+=entry.bytes;requireCondition(used<=manifest.budget_bytes,'BACKUP_BUDGET_EXCEEDED');requireCondition(JSON.stringify(fileHash(root.fd,entry.path,manifest.budget_bytes))===JSON.stringify(entry),'BACKUP_HASH_MISMATCH');}
 const db=sqlite('/proc/self/fd/'+root.fd+'/runtime.sqlite');let observed:ReturnType<typeof inspectSnapshot>;
 try{
  observed=inspectSnapshot(db);requireCondition(JSON.stringify(observed)===JSON.stringify(manifest.snapshot),'BACKUP_SNAPSHOT_MISMATCH');requireCondition(observed.mode==='quarantined','RESTORE_QUARANTINE_MISSING');
  const inventory=sourceArtifacts(db).map(m=>({path:m.directory+'/'+m.filename,bytes:m.bytes,sha256:m.sha256}));
  requireCondition(inventory.length+1===manifest.entries.length&&inventory.every(item=>manifest.entries.some(e=>e.path===item.path&&e.bytes===item.bytes&&e.sha256===item.sha256)),'BACKUP_ARTIFACT_BINDING');
 }finally{db.close();}
 assertRoot(root);return {manifest,sha256:digest,bytes:used};
}
export function inspectBundle(directory:string,expectedHash?:string) {
 const root=openRoot(directory);try{const result=inspectBundleAt(root,expectedHash);return {id:result.manifest.id,kind:result.manifest.kind,manifest_sha256:result.sha256,snapshot:result.manifest.snapshot,entries:result.manifest.entries.length,bytes:result.bytes,automatic_execution:false,post_snapshot_effects:'unknown',next_action:result.manifest.kind==='backup'?'restore_to_new_quarantined_directory':'reconcile_external_effects_before_any_new_runtime',user_files_restored:false,login_restored:false};}finally{closeSync(root.fd);}
}
export async function restoreBackup(directory:string,destination:string,options:{expectedHash?:string;cut?:Cut}={}) {
 const source=openRoot(directory);let target:ReturnType<typeof openRoot>|null=null;const cut=options.cut??noCut;
 try{
  const verified=inspectBundleAt(source,options.expectedHash),old=verified.manifest;requireCondition(old.kind==='backup','RESTORE_REQUIRES_BACKUP');
  const free=statfsSync(dirname(resolve(destination)));requireCondition(free.bavail*free.bsize>=old.budget_bytes+16*MiB,'BACKUP_LOW_SPACE');
  target=createRoot(destination);const id=randomUUID();writeJson(target.fd,'.agent-driver-maintenance.json',{format:1,id,kind:'restore',automatic_execution:false});
  const entries:Entry[]=[];
  for(const entry of old.entries)entries.push(inFolder(source.fd,entry.path,false,(dir,name)=>{
   const fd=openSync('/proc/self/fd/'+dir+'/'+name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{return copyFd(fd,target!.fd,entry.path,entry.bytes,entry.sha256);}finally{closeSync(fd);}
  }));
  await cut('restore_copied');
  assertRoot(target);
  for(const entry of entries)requireCondition(JSON.stringify(fileHash(target.fd,entry.path,old.budget_bytes))===JSON.stringify(entry),'BACKUP_HASH_MISMATCH');
  const dbPath=join(target.root,'runtime.sqlite'),db=sqlite(dbPath,false);let snapshot:ReturnType<typeof inspectSnapshot>;
  try{
   db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
   try{
    requireCondition(old.snapshot.schema_version===7&&old.snapshot.mode==='quarantined','RESTORE_QUARANTINE_MISSING');
    db.prepare("UPDATE runtime_identity SET instance_id=?,mode='quarantined',provenance_json=? WHERE singleton=1").run(randomUUID(),JSON.stringify({backup_id:old.id,backup_sha256:verified.sha256,source_instance:old.source_snapshot.instance_id,max_event_id:old.snapshot.max_event_id,post_snapshot_effects:'unknown'}));
    db.exec('COMMIT');
   }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
   snapshot=inspectSnapshot(db);requireCondition(snapshot.mode==='quarantined','RESTORE_QUARANTINE_MISSING');
  }finally{db.close();}
  const fd=openSync(dbPath,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}fsyncSync(target.fd);
  entries[entries.findIndex(e=>e.path==='runtime.sqlite')]=fileHash(target.fd,'runtime.sqlite',old.budget_bytes);
  await cut('restore_quarantined');assertRoot(source);
  const manifest:Manifest={...old,id,kind:'quarantined_restore',created_at:new Date().toISOString(),source_backup_sha256:verified.sha256,snapshot,entries};
  return await publish(target,manifest,cut);
 }finally{closeSync(source.fd);if(target)closeSync(target.fd);}
}
export function checkpointDatabase(database:string) {
 const path=sourcePath(database),db=sqlite(path,false);
 try{
  db.exec('BEGIN;');let snapshot:ReturnType<typeof inspectSnapshot>;
  try{snapshot=inspectSnapshot(db);}finally{db.exec('ROLLBACK;');}
  requireCondition(snapshot.mode!=='quarantined','RESTORE_RECONCILIATION_REQUIRED');
  requireCondition(db.prepare('PRAGMA journal_mode').get()?.journal_mode==='wal','CHECKPOINT_REQUIRES_WAL');
  const row=db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()!;
  return {mode:'PASSIVE',busy:Number(row.busy),log_frames:Number(row.log),checkpointed_frames:Number(row.checkpointed),fully_checkpointed:Number(row.busy)===0&&Number(row.log)>=0&&Number(row.checkpointed)===Number(row.log),automatic_truncate:false,automatic_execution:false};
 }finally{db.close();}
}
