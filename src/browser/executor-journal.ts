import {type DatabaseSync} from 'node:sqlite';
import {type BrowserRouteEvent} from './executor-routing.js';
import {requireCondition} from '../core/contracts.js';
import {type BrowserCheckpoint} from './executor-contracts.js';

/** Same WAL/FULL database as Work. Events omit page text/URLs; checkpoints retain delegated non-secret URLs, never credentials or DOM refs. */
export class BrowserExecutorJournal {
  constructor(private readonly db:DatabaseSync){db.exec(`
    CREATE TABLE IF NOT EXISTS browser_executor_events(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,context_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS browser_executor_context ON browser_executor_events(project_id,context_id,id);
    CREATE TABLE IF NOT EXISTS browser_executor_memory(project_id TEXT NOT NULL,binding TEXT NOT NULL,target_id TEXT NOT NULL,verified_at_ms INTEGER NOT NULL,PRIMARY KEY(project_id,binding));
    CREATE TABLE IF NOT EXISTS browser_executor_checkpoints(project_id TEXT NOT NULL,context_id TEXT NOT NULL,body TEXT NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(project_id,context_id));
  `);}
  append(project:string,context:string,event:BrowserRouteEvent){this.db.prepare('INSERT INTO browser_executor_events(project_id,context_id,body,created_at) VALUES(?,?,?,?)').run(project,context,JSON.stringify(event),new Date().toISOString());}
  events(project:string,context:string){return this.db.prepare('SELECT body,created_at FROM browser_executor_events WHERE project_id=? AND context_id=? ORDER BY id DESC LIMIT 100').all(project,context).map(row=>({...JSON.parse(String(row.body)),created_at:row.created_at}));}
  remembered(project:string,binding:string){const row=this.db.prepare('SELECT target_id,verified_at_ms FROM browser_executor_memory WHERE project_id=? AND binding=?').get(project,binding);return row&&Date.now()-Number(row.verified_at_ms)>=0&&Date.now()-Number(row.verified_at_ms)<86_400_000?String(row.target_id):undefined;}
  success(project:string,binding:string,target:string){requireCondition(/^[a-f0-9]{64}$/u.test(binding)&&/^[a-z][a-z0-9_-]{0,63}$/u.test(target),'BROWSER_MEMORY_INVALID');this.db.prepare('INSERT INTO browser_executor_memory VALUES(?,?,?,?) ON CONFLICT(project_id,binding) DO UPDATE SET target_id=excluded.target_id,verified_at_ms=excluded.verified_at_ms').run(project,binding,target,Date.now());}
  invalidate(project:string,binding:string){this.db.prepare('DELETE FROM browser_executor_memory WHERE project_id=? AND binding=?').run(project,binding);}
  checkpoint(project:string,context:string):BrowserCheckpoint|null{const row=this.db.prepare('SELECT body FROM browser_executor_checkpoints WHERE project_id=? AND context_id=?').get(project,context);return row?JSON.parse(String(row.body)) as BrowserCheckpoint:null;}
  saveCheckpoint(project:string,context:string,value:BrowserCheckpoint){const body=JSON.stringify(value);requireCondition(body.length<64000,'BROWSER_CHECKPOINT_TOO_LARGE');this.db.prepare('INSERT INTO browser_executor_checkpoints VALUES(?,?,?,?) ON CONFLICT(project_id,context_id) DO UPDATE SET body=excluded.body,updated_at_ms=excluded.updated_at_ms').run(project,context,body,Date.now());}
}
