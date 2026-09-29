import {type PackStore} from '../packs/store.js';
import {workImportDraftSchema,validateWorkImportDraft} from './import-draft.js';
import {type WorkProposal} from './contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';

/** A copied definition is not an attached bot. Neither its reported evidence
 * nor this classification grants execution, scheduling or delivery consent. */
export function workImportExecutionOwner(store:PackStore,project:string,workId:string):'office'|'original_runtime'|null{
  const table=(name:string)=>Boolean(store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name));
  if(table('office_work_adoption')&&store.hermesState.prepare('SELECT 1 FROM office_work_adoption WHERE project_id=? AND work_id=?').get(project,workId))return 'original_runtime';
  if(table('office_remote_work')&&store.hermesState.prepare('SELECT 1 FROM office_remote_work WHERE project_id=? AND work_id=?').get(project,workId))return 'original_runtime';
  if(table('hermes_work')){const original=store.hermesState.prepare('SELECT import_key FROM hermes_work WHERE project_id=? AND work_id=?').get(project,workId);if(original&&!String(original.import_key).startsWith('intake:'))return 'original_runtime';}
  const record=store.workImportForWork(project,workId);if(!record)return null;
  if(record.kind!=='pasted'||record.status!=='accepted')return 'original_runtime';
  const work=store.intakeWorkOptional(project,workId),plan=(work?.spec as WorkProposal|null)?.plan;
  if(!work||!plan||plan.source!=='pasted_import'||plan.source_id!==record.id||plan.source_digest!==record.source_digest||plan.provenance!=='unverified_external')return 'original_runtime';
  if(plan.import_mode!==undefined&&plan.import_mode!=='migrate')return 'original_runtime';
  const parsed=workImportDraftSchema.safeParse(record.body);if(!parsed.success)return 'original_runtime';
  if(snapshotHash(parsed.data)!==record.source_digest)return 'original_runtime';
  // Valid older accepted drafts have no import_mode; their persisted, bounded
  // migration payload remains sufficient. Unclassified legacy records stay
  // passive instead of guessing that a real bot may be executed a second time.
  const {provenance:_provenance,status:_status,authority:_authority,...payload}=parsed.data;
  try{validateWorkImportDraft(payload);}catch{return 'original_runtime';}
  return 'office';
}
