import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type LocalRecord,type Row} from './contracts.js';
import {parseData,readScopedFile,sha} from './data.js';

type Identity=string|number;
/** Read delegation is additive; legacy editable fields remain readable. */
export function readableLocalRecordFields(target:LocalRecord){return [...new Set([...target.fields,...(target.read_fields??[])])];}
/** A model may express an all-digit public ID as a number. Only a lossless,
 * canonical decimal spelling is equivalent; leading zeros and unsafe integers
 * retain their distinct identity rather than being guessed away. */
function sameIdentity(observed:unknown,requested:Identity){
  if(observed===requested)return true;
  if(typeof observed==='string'&&typeof requested==='number')return Number.isSafeInteger(requested)&&observed===String(requested);
  if(typeof observed==='number'&&typeof requested==='string')return Number.isSafeInteger(observed)&&requested===String(observed);
  return false;
}

async function snapshot(target:LocalRecord,identity:Identity){
  requireCondition(typeof identity!=='number'||!Number.isInteger(identity)||Number.isSafeInteger(identity),'PACK_LOCAL_RECORD_IDENTITY_UNSAFE_NUMBER');
  const bytes=await readScopedFile(target.path),rows=parseData(bytes.toString('utf8'),'json');
  requireCondition(!/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(JSON.stringify(rows)),'CREDENTIAL_LIKE_INPUT');
  requireCondition(rows.every(row=>Object.keys(row).every(key=>!/^(?:password|passwd|cookie|authorization|access_token|refresh_token|api_key)$/iu.test(key))),'SECRET_COLUMN_FORBIDDEN');
  const matches=rows.flatMap((row,index)=>sameIdentity(row[target.identity_field],identity)?[{row,index}]:[]);
  requireCondition(matches.length===1,'PACK_LOCAL_RECORD_IDENTITY_NOT_UNIQUE');
  return {rows,selected:matches[0]!,matched_rows:matches.length,source_sha256:sha(bytes)};
}

/** Return only fields explicitly granted in host policy; never expose a path or other rows. */
export async function inspectLocalRecord(target:LocalRecord,identity:Identity){
  const observed=await snapshot(target,identity),before=observed.selected.row,readable=readableLocalRecordFields(target);
  requireCondition((target.read_fields??[]).every(name=>Object.hasOwn(before,name)),'PACK_LOCAL_RECORD_READ_FIELD_MISSING');
  return {target:target.id,identity_field:target.identity_field,identity,
    allowed_fields:target.fields,
    readable_fields:readable,editable_fields:target.fields,
    values:Object.fromEntries(readable.map(name=>[name,before[name]??null])),
    before_sha256:snapshotHash(before),source_sha256:observed.source_sha256,
    source_rows:observed.rows.length,matched_rows:observed.matched_rows,observed_at:new Date().toISOString(),effect:'read_only' as const};
}

/** Build a separate complete-array draft. The registered source file is never written. */
export async function localRecordDraft(target:LocalRecord,values:Row,expectedBefore:string|null){
  requireCondition(expectedBefore!==null,'PACK_LOCAL_RECORD_BEFORE_HASH_REQUIRED');
  const identity=values[target.identity_field];
  requireCondition(typeof identity==='string'&&identity.length>0||typeof identity==='number'&&Number.isFinite(identity),'PACK_LOCAL_RECORD_IDENTITY_REQUIRED');
  const changes=Object.entries(values).filter(([name])=>name!==target.identity_field);
  requireCondition(changes.length>0&&changes.every(([name])=>target.fields.includes(name)),'PACK_LOCAL_RECORD_FIELD_NOT_ALLOWED');
  const observed=await snapshot(target,identity as Identity),before=observed.selected.row;
  requireCondition(snapshotHash(before)===expectedBefore,'PACK_LOCAL_RECORD_BEFORE_CHANGED');
  requireCondition((target.read_fields??[]).every(name=>Object.hasOwn(before,name)),'PACK_LOCAL_RECORD_READ_FIELD_MISSING');
  const after={...before,...Object.fromEntries(changes)};
  requireCondition(snapshotHash(after)!==snapshotHash(before),'PACK_LOCAL_RECORD_NO_CHANGE');
  const changedFields=new Set(changes.map(([name])=>name)),preservedFields=Object.keys(before).filter(name=>!changedFields.has(name));
  requireCondition(preservedFields.every(name=>Object.hasOwn(after,name)&&snapshotHash(after[name])===snapshotHash(before[name]))&&Object.keys(after).every(name=>Object.hasOwn(before,name)||changedFields.has(name)),'PACK_LOCAL_RECORD_FIELD_PRESERVATION_FAILED');
  const output=observed.rows.map((row,index)=>index===observed.selected.index?after:row);
  requireCondition(output.length===observed.rows.length&&output.every((row,index)=>index===observed.selected.index||snapshotHash(row)===snapshotHash(observed.rows[index]!)),'PACK_LOCAL_RECORD_PRESERVATION_FAILED');
  return {rows:output,receipt:{target:target.id,identity_field:target.identity_field,identity,
    before_sha256:snapshotHash(before),after_sha256:snapshotHash(after),source_sha256:observed.source_sha256,
    source_rows:observed.rows.length,matched_rows:observed.matched_rows,originals_modified:false as const,external_submit:false as const,
    non_target_rows_unchanged:true as const,non_target_fields_unchanged:true as const,
    before_values:Object.fromEntries(changes.map(([name])=>[name,before[name]??null])),
    after_values:Object.fromEntries(changes.map(([name])=>[name,after[name]??null])),
    readable_fields:readableLocalRecordFields(target),editable_fields:target.fields,
    observed_before_values:Object.fromEntries(readableLocalRecordFields(target).map(name=>[name,before[name]??null])),
    observed_after_values:Object.fromEntries(readableLocalRecordFields(target).map(name=>[name,after[name]??null])),
    preservation:{verified_by:'host_exact_row_and_field_comparison',non_target_rows:observed.rows.length-1,
      non_target_fields:preservedFields.length,before_rows_sha256:snapshotHash(observed.rows),after_rows_sha256:snapshotHash(output)}}};
}

export async function assertLocalRecordUnchanged(target:LocalRecord,sourceSha256:string){
  requireCondition(sha(await readScopedFile(target.path))===sourceSha256,'PACK_LOCAL_RECORD_SOURCE_CHANGED');
}
