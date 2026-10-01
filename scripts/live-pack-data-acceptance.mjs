/** Independent, read-only acceptance for the twelve public-data Phase 112 Works.
 * This deliberately does not import Pack parsers, filters, or execution helpers.
 */
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,relative,resolve,isAbsolute} from 'node:path';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sameIdentity=(observed,requested)=>observed===requested||
  typeof observed==='string'&&typeof requested==='number'&&Number.isSafeInteger(requested)&&observed===String(requested)||
  typeof observed==='number'&&typeof requested==='string'&&Number.isSafeInteger(observed)&&requested===String(observed);
const canonical=value=>JSON.stringify((function order(v){
  if(Array.isArray(v))return v.map(order);
  if(object(v))return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,order(x)]));
  if(typeof v==='number'&&!Number.isFinite(v))throw Error('nonfinite snapshot');
  return v;
})(value));
const snapshotHash=value=>sha(canonical(value));

function parseCsv(text){
  text=text.replace(/^\uFEFF/u,'');const records=[];let row=[],cell='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;continue;}
    if(ch==='"'){if(cell!==''||closed)throw Error('invalid CSV quote');quoted=true;}
    else if(ch===','||ch==='\r'||ch==='\n'){
      row.push(cell);cell='';closed=false;
      if(ch!==','){records.push(row);row=[];if(ch==='\r'&&text[i+1]==='\n')i++;}
    }else{if(closed)throw Error('invalid CSV trailing quote');cell+=ch;}
  }
  if(quoted)throw Error('unclosed CSV quote');
  if(cell!==''||row.length||closed){row.push(cell);records.push(row);}
  const columns=records.shift();
  if(!columns?.length||columns.some(x=>!x)||new Set(columns).size!==columns.length)throw Error('invalid CSV columns');
  return {columns,rows:records.map(values=>{
    if(values.length!==columns.length)throw Error('CSV width mismatch');
    return Object.fromEntries(columns.map((key,i)=>[key,values[i]]));
  })};
}

function safeBytes(path,root){
  if(typeof path!=='string'||!isAbsolute(path))throw Error('artifact path absent');
  const base=realpathSync(root),actual=realpathSync(path),rel=relative(base,actual);
  if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel)||actual!==resolve(path))throw Error('artifact outside owned root');
  const stat=statSync(actual);if(!stat.isFile()||stat.nlink!==1||stat.size>8*1024*1024)throw Error('artifact unsafe');
  return readFileSync(actual);
}

function checkArtifact(artifact,root){
  if(!object(artifact))throw Error('artifact metadata absent');
  const bytes=safeBytes(artifact.path,root),digest=sha(bytes);
  if(bytes.length!==artifact.bytes||digest!==artifact.sha256)throw Error('artifact bytes/hash mismatch');
  const readback=artifact.independent_readback;
  if(!object(readback)||readback.matches!==true||readback.bytes!==bytes.length||readback.sha256!==digest||readback.text!==bytes.toString('utf8'))throw Error('audit artifact readback mismatch');
  return bytes;
}

function selectedRows(recipe,checkpoint){
  const snapshots=checkpoint?.sources;if(!object(snapshots))throw Error('source checkpoints absent');
  const all=[];const evidences=[];
  for(const [index,requested] of recipe.sources.entries()){
    const saved=snapshots[String(index)];
    if(!object(saved)||!object(saved.result)||!Array.isArray(saved.result.rows)||!object(saved.result.evidence))throw Error('observed source rows absent');
    const evidence=saved.result.evidence;
    if(saved.digest!==snapshotHash(saved.result)||evidence.source_id!==requested.id||evidence.request_sha256!==snapshotHash({id:requested.id,parameters:requested.parameters})||evidence.rows!==saved.result.rows.length||!/^\d{4}-\d\d-\d\dT/u.test(String(evidence.observed_at)))throw Error('source evidence mismatch');
    all.push(...saved.result.rows);evidences.push(evidence);
  }
  if(!all.length)throw Error('no observed rows');
  return {rows:all,evidences};
}

function filterRows(rows,filters){
  return rows.filter(row=>filters.every(({field,op,value:threshold})=>{
    const value=row[field];
    if(op==='eq')return value===threshold;
    if(op==='contains')return typeof value==='string'&&typeof threshold==='string'&&value.toLocaleLowerCase().includes(threshold.toLocaleLowerCase());
    if(typeof value!=='number'||typeof threshold!=='number'||!Number.isFinite(value)||!Number.isFinite(threshold))throw Error('numeric filter not grounded');
    return op==='gte'?value>=threshold:op==='lte'?value<=threshold:false;
  }));
}
function dedup(rows,keys){
  if(!keys.length)return rows;
  const seen=new Map();return rows.filter(row=>{
    const values=keys.map(key=>{if(row[key]===undefined||row[key]===null)throw Error('dedup key absent');return row[key];});
    const key=canonical(values),body=canonical(row),old=seen.get(key);
    if(old!==undefined&&old!==body)throw Error('conflicting duplicate');
    seen.set(key,body);return old===undefined;
  });
}
function normalized(rows,columns){return rows.map(row=>{
  const copy={...row};for(const key of columns){const value=copy[key];
    if(typeof value!=='number'&&!(typeof value==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)))throw Error('non numeric field');
    const number=Number(value);if(!Number.isFinite(number))throw Error('nonfinite field');copy[key]=number;
  }return copy;
});}
function sorted(rows,sort){
  if(!sort)return rows;
  const copy=[...rows];if(copy.some(row=>row[sort.field]===undefined||row[sort.field]===null))throw Error('sort key absent');
  if(new Set(copy.map(row=>typeof row[sort.field])).size>1)throw Error('mixed sort types');
  return copy.sort((a,b)=>{const x=a[sort.field],y=b[sort.field],delta=typeof x==='number'?x-y:String(x).localeCompare(String(y));return sort.direction==='asc'?delta:-delta;});
}
function csvCell(value){let text=value===null?'':String(value);if(typeof value!=='number'&&/^[\s]*[=+@-]/u.test(text))text="'"+text;return text;}
function expectedCsv(rows,columns){return rows.map(row=>Object.fromEntries(columns.map(key=>[key,csvCell(row[key]??null)])));}
function officialPublicSource(source,evidence){
  if(source.kind!=='http'||evidence.executor!=='http_get'||evidence.source_id!==source.id||!/^https:\/\//u.test(source.url)||!/^[a-f0-9]{64}$/u.test(evidence.content_sha256))throw Error('HTTP source evidence incomplete');
  const expectedHost=source.id.startsWith('usgs')?'earthquake.usgs.gov':source.id.startsWith('nyc')?'data.cityofnewyork.us':null;
  if(!expectedHost||new URL(source.url).hostname!==expectedHost)throw Error('official public source host mismatch');
  if(source.json_fields&&!equal(evidence.projection_fields,source.json_fields))throw Error('HTTP projection evidence mismatch');
}
function verifyCopyOrigin(copy,config){
  if(!copy||!Array.isArray(copy.source_rows)||!Array.isArray(copy.selected_rows)||copy.rows!==copy.selected_rows.length||!object(copy.evidence))throw Error('copy origin evidence absent');
  const origin=config.packs.sources.find(source=>source.id===copy.source_id);
  if(!origin)throw Error('registered remote origin absent');
  officialPublicSource(origin,copy.evidence);
  if(copy.evidence.rows!==copy.source_rows.length||copy.evidence.request_sha256!==snapshotHash({id:origin.id,parameters:{}}))throw Error('remote origin row/request evidence mismatch');
  const available=new Map();for(const row of copy.source_rows){const key=canonical(row);available.set(key,(available.get(key)??0)+1);}
  for(const selected of copy.selected_rows){
    if(!object(selected))throw Error('selected source row malformed');
    const projected={...selected};
    for(const [field,value] of Object.entries(copy.local_fields??{})){
      if(!Object.hasOwn(projected,field)||!equal(projected[field],value))throw Error('local annotation origin mismatch');
      delete projected[field];
    }
    const key=canonical(projected),remaining=available.get(key)??0;
    if(remaining<1)throw Error('selected row not present in remote origin');
    available.set(key,remaining-1);
  }
}
function sourceProvenance(source,evidence,observed,provenance,config){
  if(source.kind==='http'){
    officialPublicSource(source,evidence);
    return;
  }
  if(source.kind!=='file'||evidence.executor!=='local_file')throw Error('wrong source executor');
  const copies=provenance.filter(entry=>entry.destination===source.path),original=copies[0];
  if(copies.length!==1||original.sha256!==evidence.content_sha256||original.format!==source.format)throw Error('file provenance mismatch');
  verifyCopyOrigin(original,config);
  const path=realpathSync(source.path),stat=statSync(path);
  if(path!==resolve(source.path)||!stat.isFile()||stat.nlink!==1||stat.size>8*1024*1024)throw Error('original path unsafe');
  const bytes=readFileSync(path);
  if(sha(bytes)!==original.sha256)throw Error('original file changed');
  const decoded=source.format==='json'?JSON.parse(bytes.toString('utf8')):parseCsv(bytes.toString('utf8')).rows;
  if(!equal(decoded,observed)||decoded.length!==original.rows)throw Error('observed rows differ from original file');
  if(source.format==='json'&&!equal(decoded,original.selected_rows))throw Error('JSON selection provenance mismatch');
  if(source.format==='csv'){
    const columns=[...new Set(original.selected_rows.flatMap(row=>Object.keys(row)))];
    if(!equal(decoded,expectedCsv(original.selected_rows,columns)))throw Error('CSV selection provenance mismatch');
  }
}

const decisionFor=(id,row)=>{
  if(id==='phase112-inbox-usgs')return Number(row.mag)>=4.5?'high':'routine';
  if(id==='phase112-inbox-311')return row.status==='In Progress'?'open':row.status==='Closed'?'closed':'unknown';
  if(id==='phase112-inbox-food')return row.critical_flag==='Critical'?'critical':row.critical_flag==='Not Critical'?'routine':'unknown';
  return 'unknown';
};

export function validate(item,audit,config,provenance){
  const checks=[];const limits=['Stored source checkpoints and isolated original copies are validated; current upstream data is not re-fetched.'];
  const check=(name,fn)=>{try{const detail=fn();checks.push({name,pass:true,detail:detail??'verified'});}
    catch(error){checks.push({name,pass:false,detail:error instanceof Error?error.message:'validation error'});}};
  const accepted=new Set(['portal.collect','file.pipeline','inbox.triage','record.update']);
  if(!accepted.has(item?.family))return {status:'FAIL',checks:[{name:'supported_family',pass:false,detail:'not one of the twelve data cases'}],limits};
  const exported=item.family==='portal.collect'||item.family==='file.pipeline'||item.family==='record.update';
  // Early session receipts predate the explicit columns field. The stated
  // USGS completion condition has always required a single id column.
  const desired=item.id==='phase112-portal-usgs'?{...item.expected_recipe,columns:['id']}:item.expected_recipe;
  let run=null,recipe=null,packInvocation=null,observed=null,artifactRows=null;
  check('bound_pack_run',()=>{
    const template=desired??item.recipe_template;
    const candidates=(audit?.pack_runs??[]).filter(candidate=>candidate.recipe?.family===item.family&&candidate.status===(item.family==='record.update'?'draft_ready':'succeeded')&&
      (item.family==='record.update'?candidate.recipe?.target===template?.target:candidate.recipe?.format===template?.format||item.family==='inbox.triage'));
    run=candidates.at(-1);if(!run||typeof run.id!=='string'||run.project_id!==config.project.id)throw Error('completed bound Pack run absent');
    if(item.work_id&&audit.work_id!==item.work_id)throw Error('Work audit identity mismatch');
    recipe=run.recipe;
    if(!template||recipe.version!==1||recipe.family!==template.family)throw Error('recipe family/version mismatch');
    if(item.family==='record.update'){
      const identityField=config.packs.local_records.find(row=>row.id===template.target)?.identity_field;
      if(recipe.target!==template.target||!identityField||!sameIdentity(recipe.values?.[identityField],template.values?.[identityField])||
        !equal(Object.fromEntries(Object.entries(recipe.values).filter(([key])=>key!==identityField)),Object.fromEntries(Object.entries(template.values).filter(([key])=>key!==identityField))))throw Error('target or user-specified values changed');
    }else if(!equal(recipe.sources,template.sources)||item.family!=='inbox.triage'&&recipe.format!==template.format)throw Error('source IDs or requested format changed');
    packInvocation=(audit.observations??[]).find(o=>o.invocation?.tool_name==='runtime_pack_run'&&o.invocation?.dispatched===true&&o.receipt?.status==='succeeded'&&o.receipt?.effect_state==='verified'&&o.receipt?.value?.run_id===run.id&&o.invocation?.request_id===run.request_id);
    if(!packInvocation)throw Error('verified Pack invocation absent');
    if(item.work_id&&packInvocation.invocation.arguments?.work_id!==item.work_id)throw Error('Pack invocation Work identity mismatch');
    if(!exported){
      const status=(audit.observations??[]).find(o=>o.invocation?.tool_name==='runtime_pack_status'&&o.invocation?.dispatched===true&&o.receipt?.status==='succeeded'&&o.receipt?.value?.run_id===run.id);
      if(!status)throw Error('Pack status reread absent');
    }
    if(run.task_id!==null&&item.family==='record.update')throw Error('local record gained approval task');
    return `${run.id}: ${run.status}`;
  });
  check('work_completed_and_office_readback',()=>{
    if(audit?.supervisor?.state!=='succeeded'||audit.supervisor.result?.completion_verified!==true)throw Error('Work completion not verified');
    if(exported){
      if(!run||!packInvocation)throw Error('verified Pack receipt absent');
      const artifact=run.result?.artifact,bytes=checkArtifact(artifact,join(dirname(config.dbPath),'pack-artifacts'));
      const reads=(audit.observations??[]).filter(o=>o.invocation?.tool_name==='office_result_read'&&o.invocation?.dispatched===true&&o.receipt?.status==='succeeded'&&o.receipt?.value?.source_tool==='runtime_pack_run'&&o.receipt?.value?.source_run_id===run.id&&o.receipt?.value?.request_id===packInvocation.invocation.request_id&&o.receipt?.value?.verified_by==='independent_sha256_and_bytes_readback').sort((a,b)=>a.receipt.value.page?.offset-b.receipt.value.page?.offset);
      if(!reads.length)throw Error('Pack artifact readback absent');
      // A Work may reread the same verified page after a retry. Count an
      // identical receipt once, but never choose between contradictory reads.
      const unique=new Map();
      for(const read of reads){
        const value=read.receipt.value,page=value.page,part=Buffer.from(value.text??'','utf8');
        if(item.work_id&&value.work_id!==item.work_id)throw Error('Pack readback Work identity mismatch');
        if(!object(page)||!Number.isSafeInteger(page.offset)||page.offset<0||typeof page.has_more!=='boolean'||page.returned_bytes!==part.length||page.total_bytes!==bytes.length||value.artifact?.sha256!==artifact.sha256||value.artifact?.bytes!==artifact.bytes||page.has_more!==(page.offset+part.length<bytes.length)||page.next_offset!==(page.has_more?page.offset+part.length:null))throw Error('Pack artifact page mismatch');
        const prior=unique.get(page.offset);
        if(prior){if(!equal(prior.value,value))throw Error('Contradictory duplicate Pack readback');continue;}
        unique.set(page.offset,{value,part});
      }
      let offset=0;const pages=[],ordered=[...unique].sort(([a],[b])=>a-b);
      for(const [position,{part}] of ordered){
        if(position!==offset)throw Error('Pack artifact page gap');
        offset+=part.length;pages.push(part);
      }
      if(offset!==bytes.length||!Buffer.concat(pages).equals(bytes)||ordered.at(-1)?.[1].value.page?.has_more!==false)throw Error('Pack artifact was not fully read');
      return `full Pack artifact readback: ${bytes.length} bytes`;
    }
    const drafts=(audit.observations??[]).filter(o=>o.invocation?.tool_name==='office_result_draft'&&o.invocation?.dispatched===true&&o.receipt?.status==='succeeded'&&o.receipt?.effect_state==='verified');
    const saved=drafts.find(o=>(audit.office_artifacts??[]).some(a=>a.request_id===o.invocation.request_id));
    if(!saved)throw Error('verified Office draft absent');
    const artifact=audit.office_artifacts.find(a=>a.request_id===saved.invocation.request_id);
    checkArtifact(artifact,join(dirname(config.dbPath),'work-artifacts'));
    const read=(audit.observations??[]).find(o=>o.invocation?.tool_name==='office_result_read'&&o.invocation?.dispatched===true&&o.receipt?.status==='succeeded'&&o.receipt?.value?.source_tool==='office_result_draft'&&o.receipt?.value?.request_id===saved.invocation.request_id&&o.receipt?.value?.verified_by==='independent_sha256_and_bytes_readback');
    if(!read||read.receipt.value.artifact?.sha256!==artifact.sha256||read.receipt.value.artifact?.bytes!==artifact.bytes)throw Error('Office result readback absent or mismatched');
    return 'verified result file and bounded read receipt';
  });
  if(item.family==='record.update'){
    check('original_and_exact_identity',()=>{
      if(!run||!recipe)throw Error('Pack run absent');
      const target=config.packs.local_records.find(row=>row.id===recipe.target);
      if(!target)throw Error('local target not configured');
      const copies=provenance.filter(entry=>entry.destination===target.path),original=copies[0];
      if(copies.length!==1||original.format!=='json')throw Error('local original provenance absent');
      verifyCopyOrigin(original,config);
      const path=realpathSync(target.path),stat=statSync(path);
      if(path!==resolve(target.path)||!stat.isFile()||stat.nlink!==1||stat.size>8*1024*1024)throw Error('local original unsafe');
      const bytes=readFileSync(path);if(sha(bytes)!==original.sha256)throw Error('local original changed');
      const rows=JSON.parse(bytes.toString('utf8'));if(!equal(rows,original.selected_rows))throw Error('original rows changed');
      const identity=recipe.values[target.identity_field],matches=rows.map((row,index)=>sameIdentity(row[target.identity_field],identity)?index:-1).filter(i=>i>=0);
      if(matches.length!==1)throw Error('identity does not uniquely resolve');
      observed={target,original,rows,index:matches[0],before:rows[matches[0]]};
      const inspected=(audit.observations??[]).find(o=>o.invocation?.tool_name==='runtime_pack_local_record_inspect'&&o.invocation?.dispatched===true&&o.receipt?.status==='succeeded'&&o.receipt?.value?.target===target.id&&sameIdentity(o.receipt?.value?.identity,identity));
      if(!inspected||inspected.receipt.value.before_sha256!==snapshotHash(observed.before)||inspected.receipt.value.source_sha256!==original.sha256||recipe.expected_before_sha256!==inspected.receipt.value.before_sha256)throw Error('bound before inspect/hash absent');
      return `one matching ${target.identity_field}; source SHA unchanged`;
    });
    check('draft_only_exact_change',()=>{
      if(!run||!observed)throw Error('source proof absent');
      const result=run.result;
      if(result.external_submit!==false||result.originals_modified!==false||result.local_record_draft!==true||result.approval_available!==false||run.task_id!==null)throw Error('not a local-only draft');
      const bytes=checkArtifact(result.artifact,join(dirname(config.dbPath),'pack-artifacts'));
      const draft=JSON.parse(bytes.toString('utf8'));
      if(!Array.isArray(draft)||draft.length!==observed.rows.length)throw Error('draft array length differs');
      const {target,index,before,rows}=observed,after=draft[index];
      if(!object(after)||!equal(after[target.identity_field],before[target.identity_field]))throw Error('draft identity differs');
      if(draft.some((row,i)=>i!==index&&!equal(row,rows[i])))throw Error('non-target row changed');
      const changes=Object.keys(recipe.values).filter(key=>key!==target.identity_field);
      if(changes.length!==1||!changes.every(key=>target.fields.includes(key)&&after[key]===recipe.values[key]))throw Error('unapproved field change');
      if(Object.keys(before).some(key=>!changes.includes(key)&&!equal(before[key],after[key]))||Object.keys(after).some(key=>!Object.hasOwn(before,key)&&!changes.includes(key)))throw Error('non-target field changed');
      if(equal(after,before)||result.before_sha256!==snapshotHash(before)||result.after_sha256!==snapshotHash(after)||result.source_sha256!==observed.original.sha256)throw Error('draft hashes disagree');
      if(result.artifact.rows!==draft.length||result.artifact.format!=='json')throw Error('draft artifact row metadata mismatch');
      return `only ${changes[0]} changed in one public-data row`;
    });
  }else{
    check('observed_source_provenance',()=>{
      if(!run||!recipe)throw Error('Pack run absent');
      observed=selectedRows(recipe,run.execution_checkpoint);
      if(!equal(run.result.evidence,observed.evidences)||run.result.collected_rows!==observed.rows.length)throw Error('Pack result source counts/evidence differ');
      recipe.sources.forEach((request,index)=>{
        const source=config.packs.sources.find(entry=>entry.id===request.id);if(!source)throw Error('registered source absent');
        const checkpoint=run.execution_checkpoint.sources[String(index)].result;
        sourceProvenance(source,observed.evidences[index],checkpoint.rows,provenance,config);
      });
      return `${observed.rows.length} observed rows from ${recipe.sources.length} registered source(s)`;
    });
    if(item.family==='inbox.triage'){
      check('independent_raw_field_labels',()=>{
        if(!observed)throw Error('source proof absent');
        const expected=dedup(filterRows(observed.rows,desired.filters),desired.deduplicate_by),items=run.result.items;
        if(expected.length!==4||!Array.isArray(items)||items.length!==expected.length||run.result.unknown_count!==0||run.result.external_messages_sent!==0)throw Error('triage count/unknown/send mismatch');
        for(let i=0;i<expected.length;i++){
          const actual=items[i],label=decisionFor(item.id,expected[i]);
          if(label==='unknown'||!equal(actual.record,expected[i])||actual.label!==label||!['jev','llm'].includes(actual.decider)||actual.sent!==false||typeof actual.draft!=='string'||!actual.draft.trim())throw Error(`unverified label/draft at row ${i}`);
        }
        if(run.result.matched_rows!==expected.length)throw Error('matched count mismatch');
        return 'four independently classified records, no external messages';
      });
    }else check('independent_export_rows',()=>{
      if(!observed)throw Error('source proof absent');
      let rows=observed.rows;
      if(item.family==='file.pipeline')rows=normalized(rows,desired.numeric_columns);
      rows=dedup(filterRows(rows,desired.filters),desired.deduplicate_by);
      if(run.result.matched_rows!==rows.length)throw Error('matched row metadata mismatch');
      if(item.family==='portal.collect'&&desired.columns){
        rows=rows.map(row=>{
          if(desired.columns.some(key=>!Object.hasOwn(row,key)))throw Error('portal selected column missing');
          return Object.fromEntries(desired.columns.map(key=>[key,row[key]]));
        });
      }
      if(item.family==='file.pipeline'){
        rows=sorted(rows,desired.sort).map(row=>{
          if(desired.columns.some(key=>!Object.hasOwn(row,key)))throw Error('projected column missing');
          return Object.fromEntries(desired.columns.map(key=>[key,row[key]]));
        });
      }
      const artifact=run.result.artifact,bytes=checkArtifact(artifact,join(dirname(config.dbPath),'pack-artifacts'));
      if(artifact.format!==recipe.format||artifact.rows!==rows.length||artifact.originals_modified!==false)throw Error('artifact metadata mismatch');
      if(recipe.format==='json'){
        artifactRows=JSON.parse(bytes.toString('utf8'));
        if(!Array.isArray(artifactRows)||!equal(artifactRows,rows))throw Error('JSON rows differ from observed recipe calculation');
      }else{
        const parsed=parseCsv(bytes.toString('utf8'));
        const columns=desired.columns??[...new Set(rows.flatMap(row=>Object.keys(row)))];
        if(!equal(parsed.columns,columns)||!equal(parsed.rows,expectedCsv(rows,columns)))throw Error('CSV rows differ from observed recipe calculation');
        artifactRows=parsed.rows;
      }
      return `${artifactRows.length} independently reparsed ${recipe.format.toUpperCase()} rows`;
    });
  }
  return {status:checks.every(row=>row.pass)?'PASS':'FAIL',checks,limits};
}
