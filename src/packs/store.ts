import {randomUUID} from 'node:crypto';
import {TerminalStore} from '../terminal/store.js';
import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type Recipe} from './contracts.js';

export interface PackRun {id:string;project_id:string;request_id:string;binding:string;recipe:Recipe;status:string;result:unknown;task_id:string|null;}
export class PackStore extends TerminalStore {
  constructor(path:string){super(path);this.connection.exec(`
    CREATE TABLE IF NOT EXISTS family_run(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL,binding TEXT NOT NULL,recipe TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL,task_id TEXT,UNIQUE(project_id,request_id));
    CREATE TABLE IF NOT EXISTS family_spec(project_id TEXT NOT NULL,prompt_hash TEXT NOT NULL,binding TEXT NOT NULL,recipe TEXT NOT NULL,PRIMARY KEY(project_id,prompt_hash));
    CREATE TABLE IF NOT EXISTS family_watch(run_id TEXT PRIMARY KEY,next_ms INTEGER NOT NULL,paused INTEGER NOT NULL DEFAULT 0,baseline TEXT NOT NULL,cycle INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS family_event(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,run_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
  `);}
  packRun(project:string,id:string):PackRun{
    const row=this.connection.prepare('SELECT * FROM family_run WHERE project_id=? AND id=?').get(project,id);requireCondition(row,'PACK_RUN_NOT_FOUND');
    return {...row,recipe:JSON.parse(String(row.recipe)),result:JSON.parse(String(row.result))} as unknown as PackRun;
  }
  beginPack(project:string,requestId:string,recipe:Recipe,fingerprint:string){
    const binding=snapshotHash({recipe,fingerprint});
    return this.transaction(()=>{
      const old=this.connection.prepare('SELECT id,binding FROM family_run WHERE project_id=? AND request_id=?').get(project,requestId);
      if(old){requireCondition(old.binding===binding,'PACK_REQUEST_ID_CONFLICT');return {run:this.packRun(project,String(old.id)),created:false};}
      const id=randomUUID();this.connection.prepare('INSERT INTO family_run VALUES (?,?,?,?,?,?,?,?)').run(id,project,requestId,binding,JSON.stringify(recipe),'running','null',null);
      return {run:this.packRun(project,id),created:true};
    });
  }
  finishPack(project:string,id:string,status:string,result:unknown,taskId:string|null=null){
    this.packRun(project,id);this.connection.prepare('UPDATE family_run SET status=?,result=?,task_id=COALESCE(?,task_id) WHERE id=? AND project_id=?').run(status,JSON.stringify(result),taskId,id,project);
    return this.packRun(project,id);
  }
  cachePack(project:string,recipe:Recipe,fingerprint:string){
    this.connection.prepare('INSERT INTO family_spec VALUES (?,?,?,?) ON CONFLICT(project_id,prompt_hash) DO UPDATE SET binding=excluded.binding,recipe=excluded.recipe').run(project,snapshotHash(recipe.request),fingerprint,JSON.stringify(recipe));
  }
  cachedPack(project:string,prompt:string,fingerprint:string):Recipe|null{
    const row=this.connection.prepare('SELECT * FROM family_spec WHERE project_id=? AND prompt_hash=? AND binding=?').get(project,snapshotHash(prompt),fingerprint);return row?JSON.parse(String(row.recipe)) as Recipe:null;
  }
  scheduleWatch(runId:string,interval:number,baseline:unknown,now=Date.now()){
    this.connection.prepare('INSERT INTO family_watch(run_id,next_ms,baseline) VALUES (?,?,?)').run(runId,now+interval,JSON.stringify(baseline));
  }
  pauseWatch(project:string,id:string,paused:boolean){
    this.packRun(project,id);const result=this.connection.prepare('UPDATE family_watch SET paused=? WHERE run_id=?').run(Number(paused),id);requireCondition(result.changes===1,'PACK_WATCH_NOT_FOUND');
  }
  dueWatches(project:string,now:number){return this.connection.prepare('SELECT w.run_id,w.baseline,w.cycle FROM family_watch w JOIN family_run r ON r.id=w.run_id WHERE r.project_id=? AND w.paused=0 AND w.next_ms<=? ORDER BY w.next_ms LIMIT 5').all(project,now);}
  claimWatch(id:string,cycle:number,now:number,interval:number){
    // Claim before I/O. Crash skips one interval, never replays a write or storms missed intervals.
    return this.connection.prepare('UPDATE family_watch SET next_ms=?,cycle=cycle+1 WHERE run_id=? AND cycle=? AND paused=0 AND next_ms<=?').run(now+interval,id,cycle,now).changes===1;
  }
  settleWatch(project:string,id:string,cycle:number,baseline:unknown,kind:string|null,body:unknown){
    return this.transaction(()=>{
      const row=this.connection.prepare('SELECT cycle,paused FROM family_watch WHERE run_id=?').get(id);if(row?.cycle!==cycle||row.paused!==0)return false;
      this.connection.prepare('UPDATE family_watch SET baseline=? WHERE run_id=?').run(JSON.stringify(baseline),id);
      if(kind)this.connection.prepare('INSERT INTO family_event(project_id,run_id,kind,body,created_at) VALUES (?,?,?,?,?)').run(project,id,kind,JSON.stringify(body),new Date().toISOString());return true;
    });
  }
  packEvents(project:string,after:number,limit:number){return this.connection.prepare('SELECT * FROM family_event WHERE project_id=? AND id>? ORDER BY id LIMIT ?').all(project,after,limit).map(row=>({...row,body:JSON.parse(String(row.body)) as unknown}));}
}
