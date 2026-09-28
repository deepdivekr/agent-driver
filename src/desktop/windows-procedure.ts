import {type DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {snapshotHash} from '../taskpack/contracts.js';
import {requireCondition} from '../core/contracts.js';

const digest=z.string().regex(/^[a-f0-9]{64}$/u);
export const WINDOWS_PROCEDURE_VERSION='windows-procedure-v1';
const TTL=7*24*60*60_000;
/** Reusable evidence, not permission. No pid, HWND, snapshot token, approval,
 * input value or previous model answer belongs in these specifications. */
export const focusedLocatorSchema=z.object({
  label:z.string().min(1).max(160),automation_id:z.string().max(256),class_name:z.string().max(256),
  role:z.literal('Edit'),value_encoding:z.enum(['exact','uia_single_line_document']),
}).strict();
export type FocusedLocator=z.infer<typeof focusedLocatorSchema>;
export const windowsJudgmentSpecSchema=z.object({
  ready_when:z.string().min(1).max(1200),target_when:z.string().min(1).max(1200),
  reobserve_when:z.string().min(1).max(1200),
}).strict();
export type WindowsJudgmentSpec=z.infer<typeof windowsJudgmentSpecSchema>;
export class WindowsProcedureStore {
  constructor(readonly db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS windows_procedure(
    scope TEXT NOT NULL,kind TEXT NOT NULL,version TEXT NOT NULL,body TEXT NOT NULL,body_sha TEXT NOT NULL,
    proof_sha TEXT NOT NULL,verified_ms INTEGER NOT NULL,expires_ms INTEGER NOT NULL,PRIMARY KEY(scope,kind));`);}
  read<T>(scope:string,kind:'locator'|'judgment',schema:z.ZodType<T>,now=Date.now()):T|null{
    digest.parse(scope);
    const row=this.db.prepare('SELECT * FROM windows_procedure WHERE scope=? AND kind=?').get(scope,kind);
    if(!row)return null;
    try{
      requireCondition(row.version===WINDOWS_PROCEDURE_VERSION&&Number(row.expires_ms)>now,'WINDOWS_PROCEDURE_EXPIRED');
      const body=JSON.parse(String(row.body));requireCondition(snapshotHash(body)===row.body_sha,'WINDOWS_PROCEDURE_CORRUPT');
      return schema.parse(body);
    }catch{this.invalidate(scope,kind);return null;}
  }
  verify(scope:string,kind:'locator'|'judgment',body:unknown,proofSha:string,now=Date.now()){
    digest.parse(scope);digest.parse(proofSha);
    const parsed=kind==='locator'?focusedLocatorSchema.parse(body):windowsJudgmentSpecSchema.parse(body);
    this.db.prepare(`INSERT INTO windows_procedure VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope,kind) DO UPDATE SET
      version=excluded.version,body=excluded.body,body_sha=excluded.body_sha,proof_sha=excluded.proof_sha,verified_ms=excluded.verified_ms,expires_ms=excluded.expires_ms`)
      .run(scope,kind,WINDOWS_PROCEDURE_VERSION,JSON.stringify(parsed),snapshotHash(parsed),proofSha,now,now+TTL);
    // Expiring, capped metadata, not an unbounded session-memory database.
    this.db.prepare('DELETE FROM windows_procedure WHERE expires_ms<=?').run(now);
    this.db.exec('DELETE FROM windows_procedure WHERE rowid IN (SELECT rowid FROM windows_procedure ORDER BY verified_ms DESC,rowid DESC LIMIT -1 OFFSET 512)');
  }
  invalidate(scope:string,kind:'locator'|'judgment'){this.db.prepare('DELETE FROM windows_procedure WHERE scope=? AND kind=?').run(scope,kind);}
}
