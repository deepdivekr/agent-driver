import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {requireCondition} from '../core/contracts.js';
import {MIGRATION_1,MIGRATION_2,MIGRATION_3,MIGRATION_4,MIGRATION_5,MIGRATION_6,MIGRATION_7} from '../store/migration.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all();
const expected=new Map<number,string>();
export function schemaDigest(version:number) {
  requireCondition(version===6||version===7,'BACKUP_UNSUPPORTED_SCHEMA');
  if(!expected.has(version)){
    const db=new DatabaseSync(':memory:',{allowExtension:false});
    try{db.exec(MIGRATION_1);db.exec('INSERT INTO schema_version VALUES(1)');for(const migration of [MIGRATION_2,MIGRATION_3,MIGRATION_4,MIGRATION_5,MIGRATION_6,...(version===7?[MIGRATION_7]:[])])db.exec(migration);expected.set(version,digest(schema(db)));}finally{db.close();}
  }
  return expected.get(version)!;
}
export function inspectSnapshot(db:DatabaseSync) {
  db.exec('PRAGMA trusted_schema=OFF;');
  const actual=digest(schema(db));requireCondition(actual===schemaDigest(6)||actual===schemaDigest(7),'BACKUP_SCHEMA_MISMATCH');
  const rows=db.prepare('SELECT version FROM schema_version').all();requireCondition(rows.length===1,'BACKUP_UNSUPPORTED_SCHEMA');
  const version=Number(rows[0]!.version);requireCondition(version===6||version===7,'BACKUP_UNSUPPORTED_SCHEMA');requireCondition(actual===schemaDigest(version),'BACKUP_SCHEMA_MISMATCH');
  requireCondition(JSON.stringify(db.prepare('PRAGMA integrity_check').all())===JSON.stringify([{integrity_check:'ok'}]),'BACKUP_INTEGRITY_FAILED');
  requireCondition(db.prepare('PRAGMA foreign_key_check').all().length===0,'BACKUP_FOREIGN_KEY_FAILED');
  const identity=version===7?db.prepare('SELECT instance_id,mode FROM runtime_identity WHERE singleton=1').get():null;
  if(version===7)requireCondition(identity&&typeof identity.instance_id==='string'&&['active','quarantined'].includes(String(identity.mode)),'BACKUP_IDENTITY_INVALID');
  const count=(table:string)=>Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  requireCondition(count('event')===count('outbox'),'BACKUP_OUTBOX_GAP');
  return {schema_version:version as 6|7,schema_sha256:schemaDigest(version),instance_id:String(identity?.instance_id??'unobserved_legacy'),mode:String(identity?.mode??'unobserved_legacy'),
    projects:count('project'),tasks:count('task'),events:count('event'),max_event_id:Number(db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM event').get()!.n),
    turns:count('terminal_turn'),intents:count('command_intent'),file_intents:count('terminal_file_intent'),cursors:count('consumer_cursor'),
    task_states:db.prepare('SELECT status,COUNT(*) AS count FROM task GROUP BY status ORDER BY status').all().map(r=>({status:String(r.status),count:Number(r.count)})),
    effect_states:db.prepare('SELECT effect_state,COUNT(*) AS count FROM task GROUP BY effect_state ORDER BY effect_state').all().map(r=>({effect_state:String(r.effect_state),count:Number(r.count)}))};
}
