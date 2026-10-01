// Pure Phase 112 acceptance checks. No filesystem, network, model, timer or
// production helper imports. The caller supplies saved audit/readback objects.
import {createHash} from 'node:crypto';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value:null;
const hash=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(object(value))return '{'+Object.keys(value).sort((a,b)=>a.localeCompare(b)).map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  throw Error('UNOBSERVED_OR_NONFINITE_VALUE');
}
const digest=value=>hash(canonical(value));
const same=(a,b)=>{try{return canonical(a)===canonical(b);}catch{return false;}};
const time=value=>typeof value==='string'?Date.parse(value):NaN;
function rowsAfterRecipe(rows,recipe){
  if(!Array.isArray(rows)||!rows.every(object))throw Error('RAW_ROWS_UNOBSERVED');
  let selected=rows;
  for(const filter of recipe.filters??[]){
    selected=selected.filter(row=>{
      const current=row[filter.field],wanted=filter.value;
      if(filter.op==='eq')return current===wanted;
      if(filter.op==='contains')return typeof current==='string'&&typeof wanted==='string'&&current.toLocaleLowerCase().includes(wanted.toLocaleLowerCase());
      if(!['gte','lte'].includes(filter.op)||typeof current!=='number'||typeof wanted!=='number'||!Number.isFinite(current)||!Number.isFinite(wanted))throw Error('FILTER_TYPE_UNSUPPORTED');
      return filter.op==='gte'?current>=wanted:current<=wanted;
    });
  }
  const keys=recipe.deduplicate_by??[],seen=new Map();
  if(keys.length)selected=selected.filter(row=>{
    if(keys.some(key=>row[key]===null||row[key]===undefined))throw Error('DEDUPLICATION_KEY_MISSING');
    const key=digest(keys.map(field=>row[field])),value=digest(row),old=seen.get(key);
    if(old!==undefined&&old!==value)throw Error('DUPLICATE_KEY_CONFLICT');
    seen.set(key,value);return old===undefined;
  });
  return selected;
}
function searchRows(rows,recipe){
  if(recipe.relevance!==null&&recipe.relevance!==undefined)throw Error('SEMANTIC_RELEVANCE_NOT_INDEPENDENTLY_AUDITED');
  const tokens=recipe.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  let found=rowsAfterRecipe(rows,recipe).filter(row=>tokens.every(token=>recipe.search_fields.some(field=>String(row[field]??'').toLocaleLowerCase().includes(token))));
  if(recipe.sort){
    const {field,direction}=recipe.sort;if(!found.every(row=>row[field]!==null&&row[field]!==undefined))throw Error('SORT_FIELD_MISSING');
    found=[...found].sort((a,b)=>{const left=a[field],right=b[field];if(typeof left!==typeof right)throw Error('SORT_TYPE_MISMATCH');const delta=typeof left==='number'?left-right:String(left).localeCompare(String(right));return direction==='asc'?delta:-delta;});
  }
  return found.slice(0,recipe.limit);
}
function watchProjection(rows,recipe){
  const selected=rowsAfterRecipe(rows,recipe);
  if(!selected.length)throw Error('WATCH_NO_OBSERVATIONS');
  const keys=[...recipe.comparison_fields,...(recipe.value_field?[recipe.value_field]:[])];
  if(selected.some(row=>recipe.comparison_fields.some(key=>row[key]===null||row[key]===undefined)))throw Error('WATCH_COMPARISON_FIELD_MISSING');
  const minima={};
  if(recipe.mode==='minimum_decreases'){
    if(!recipe.value_field||recipe.comparison_fields.includes(recipe.value_field))throw Error('WATCH_PRICE_GROUP_REQUIRED');
    for(const row of selected){
      const value=row[recipe.value_field];if(typeof value!=='number'||!Number.isFinite(value))throw Error('WATCH_NUMERIC_PRICE_REQUIRED');
      const group=digest(recipe.comparison_fields.map(key=>row[key]));minima[group]=Math.min(minima[group]??Infinity,value);
    }
  }
  const projected=selected.map(row=>Object.fromEntries(keys.map(key=>[key,row[key]])));
  return {digest:digest(projected.map(digest).sort()),minima,error:null};
}
const check=(checks,name,pass,detail)=>checks.push({name,pass:pass===true,detail:pass===true?detail:'unknown_or_mismatch: '+detail});
function sourceRows(run,config,checks){
  const checkpoint=object(run.execution_checkpoint),sources=object(checkpoint?.sources),recipe=object(run.recipe);
  const requests=Array.isArray(recipe?.sources)?recipe.sources:[];
  const all=[];
  check(checks,'source_checkpoint',Boolean(sources&&requests.length),'Raw source checkpoint and recipe source requests present');
  for(const [index,request] of requests.entries()){
    const entry=object(sources?.[String(index)]),result=object(entry?.result),rows=result?.rows,evidence=object(result?.evidence);
    const source=config?.packs?.sources?.find(source=>source.id===request.id);
    const bound=Boolean(source&&Array.isArray(rows)&&rows.length>0&&evidence?.source_id===request.id&&evidence.rows===rows.length&&evidence.request_sha256===digest({id:request.id,parameters:request.parameters??{}})&&hex(evidence.content_sha256)&&Number.isFinite(time(evidence.observed_at)));
    check(checks,`source_${index}_bound`,bound,`Configured source ${request.id}, raw rows, request hash, timestamp and content hash agree`);
    if(bound){
      if(source.kind==='browser')check(checks,`source_${index}_browser_hash`,digest(rows)===evidence.content_sha256,'Browser row content hash recomputed independently');
      all.push(...rows);
    }
  }
  return {rows:all,baselineEvidence:requests.map((_,index)=>object(object(sources?.[String(index)])?.result)?.evidence).filter(Boolean)};
}
function officeResult(audit,checks){
  const observations=Array.isArray(audit?.observations)?audit.observations:[];
  const drafts=observations.filter(row=>row?.invocation?.tool_name==='office_result_draft'&&row?.receipt?.status==='succeeded'&&row.receipt.effect_state==='verified');
  const artifacts=Array.isArray(audit?.office_artifacts)?audit.office_artifacts:[];
  let valid=false,verifiedText=null;
  for(const draft of drafts.slice(-1)){
    const id=draft.invocation.request_id,artifact=object(draft.receipt.value?.artifact),saved=artifacts.find(row=>row.request_id===id),independent=object(saved?.independent_readback);
    const read=observations.find(row=>row?.invocation?.tool_name==='office_result_read'&&row.invocation.arguments?.request_id===id&&row.receipt?.status==='succeeded'&&row.receipt.effect_state==='none');
    const text=draft.receipt.value?.text;
    if(typeof text!=='string'||!artifact||!saved||!independent||!read)continue;
    const bytes=Buffer.from(text+'\n','utf8');
    const page=object(read.receipt.value?.page);
    if(artifact.path!==saved.path||artifact.sha256!==hash(bytes)||artifact.bytes!==bytes.length||independent.matches!==true||independent.sha256!==artifact.sha256||independent.bytes!==artifact.bytes||independent.text!==text+'\n'||read.receipt.value?.text!==text+'\n'||read.receipt.value?.source_tool!=='office_result_draft'||read.receipt.value?.verified_by!=='independent_sha256_and_bytes_readback'||page?.offset!==0||page?.has_more!==false||page?.total_bytes!==bytes.length)continue;
    valid=true;verifiedText=text;break;
  }
  check(checks,'office_result_readback',valid,'Office draft, independent disk bytes/SHA-256 and same-request office_result_read text agree');
  return verifiedText;
}
function answerInResult(item,rows,text){
  if(typeof text!=='string'||!Array.isArray(rows)||rows.length===0)return false;
  if(item.id==='research-show-hn')return rows.some(row=>typeof row.title==='string'&&row.title.length>0&&text.includes(row.title));
  if(item.id==='research-node-v22'){
    const row=rows.find(value=>value.version==='v22');
    return Boolean(row&&['version','first_released','codename','status'].every(field=>typeof row[field]==='string'&&text.includes(row[field])));
  }
  if(item.id==='research-ethereum-market-row'){
    const row=rows.find(value=>value.id==='ethereum');
    if(!row||typeof row.current_price!=='number'||!Number.isFinite(row.current_price))return false;
    const price=String(row.current_price),grouped=row.current_price.toLocaleString('en-US',{maximumFractionDigits:20});
    return typeof row.last_updated==='string'&&text.toLocaleLowerCase().includes('ethereum')&&(text.includes(price)||text.includes(grouped))&&text.includes(row.last_updated);
  }
  return rows.some(row=>Object.values(row).some(value=>typeof value==='string'&&value.length>=4&&text.includes(value)));
}
function researchGoal(item,rawRows,selected){
  if(!Array.isArray(selected)||selected.length===0)return false;
  if(item.id==='research-show-hn'){
    const matching=rawRows.filter(row=>typeof row.title==='string'&&row.title.toLocaleLowerCase().includes('show hn'));
    return matching.length>0&&matching.length<=30&&selected.length===matching.length&&same(selected.map(digest).sort(),matching.map(digest).sort());
  }
  if(item.id==='research-node-v22'){
    const matching=rawRows.filter(row=>row.version==='v22');
    return matching.length===1&&same(selected,matching)&&['first_released','codename','status'].every(field=>typeof matching[0][field]==='string'&&matching[0][field].length>0);
  }
  if(item.id==='research-ethereum-market-row'){
    const ids=rawRows.map(row=>row.id);
    return rawRows.length===2&&new Set(ids).size===2&&ids.includes('bitcoin')&&ids.includes('ethereum')&&selected.length===1&&selected[0].id==='ethereum'&&typeof selected[0].current_price==='number'&&Number.isFinite(selected[0].current_price)&&typeof selected[0].last_updated==='string';
  }
  return false;
}
function watchGoal(item,rawRows,recipe){
  let selected;try{selected=rowsAfterRecipe(rawRows,recipe);}catch{return false;}
  if(selected.length!==rawRows.length||selected.length===0)return false;
  if(item.id==='watch-hn-newest-change')return recipe.mode==='any_change'&&recipe.value_field===null&&same(recipe.comparison_fields,['title'])&&selected.every(row=>typeof row.title==='string'&&row.title.length>0);
  if(item.id==='watch-node-history-stability')return recipe.mode==='any_change'&&recipe.value_field===null&&same([...recipe.comparison_fields].sort(),['version','first_released'])&&selected.every(row=>typeof row.version==='string'&&typeof row.first_released==='string');
  if(item.id==='watch-two-market-decreases')return recipe.mode==='minimum_decreases'&&recipe.value_field==='current_price'&&same(recipe.comparison_fields,['id'])&&selected.length===2&&new Set(selected.map(row=>row.id)).size===2&&selected.some(row=>row.id==='bitcoin')&&selected.some(row=>row.id==='ethereum')&&selected.every(row=>typeof row.current_price==='number'&&Number.isFinite(row.current_price));
  return false;
}
function completion(audit,checks){
  const supervisor=object(audit?.supervisor),result=object(supervisor?.result);
  check(checks,'work_completion_verified',supervisor?.state==='succeeded'&&result?.completion_verified===true,'Same Work supervisor has independently verified completion, not merely admission or a Pack baseline');
  const observations=Array.isArray(audit?.observations)?audit.observations:[];
  check(checks,'no_external_dispatch',!observations.some(row=>row?.invocation?.dispatched===true&&row.invocation.effect==='external_write'),'No external-write capability dispatched in this Work trace');
}

/** Deterministic review of one saved Phase 112 research.search or monitor.watch audit. */
export function validate(item,audit,config,provenance){
  const checks=[],limits=[];
  try{
    const family=item?.family,expected=object(item?.recipe),runs=Array.isArray(audit?.pack_runs)?audit.pack_runs:[];
    check(checks,'supported_family',family==='research.search'||family==='monitor.watch','Only research.search and monitor.watch are covered');
    const candidates=runs.filter(run=>run?.recipe?.family===family);
    const finished=candidates.filter(run=>family==='research.search'?run.status==='succeeded':run.status==='watching'&&object(run.execution_checkpoint)?.watch_tick);
    const run=finished.at(-1)??null;
    if(candidates.length>1)limits.push(`${candidates.length-1} prior or superseded ${family} Pack attempt(s) remain visible in the audit; selected final run ${run?.id??'none'}.`);
    check(checks,'bound_final_pack_run',Boolean(run&&run.project_id&&run.id&&audit?.work_id),'A final successful or two-observation watch Pack run is bound to this Work');
    if(!run||!expected)return {status:'FAIL',checks,limits:['missing_or_ambiguous_pack_run_or_recipe']};
    const recipe=run.recipe,sourceContract=same(recipe.sources,expected.sources),familyContract=family==='research.search'?recipe.relevance===null&&Number.isInteger(recipe.limit)&&recipe.limit>0:recipe.interval_seconds>=60;
    check(checks,'source_and_safety_contract',sourceContract&&familyContract,'Actual recipe uses only the exact public source requests and independently auditable literal search or 60-second watch');
    const observations=Array.isArray(audit?.observations)?audit.observations:[];
    check(checks,'work_pack_dispatch',observations.some(row=>row?.invocation?.tool_name==='runtime_pack_run'&&row.invocation.dispatched===true&&row.receipt?.status==='succeeded'&&row.receipt.effect_state==='verified'&&row.receipt.value?.run_id===run.id),'Same Work dispatched and received a verified Pack run receipt');
    const sources=sourceRows(run,config,checks);
    check(checks,'baseline_source_evidence',same(sources.baselineEvidence,run.result?.evidence),'Pack result source evidence exactly matches persisted raw-source checkpoint evidence');
    if(recipe.sources.some(request=>config?.packs?.sources?.find(source=>source.id===request.id)?.kind==='http'))limits.push('HTTP raw response bytes are not retained by the Pack checkpoint; recorded response SHA-256 is checked for presence/binding, while raw scalar rows and watch projections are checked independently.');
    if(provenance===undefined||provenance===null)limits.push('No separate preflight provenance was supplied; live Pack source checkpoint remains the source observation.');
    if(family==='research.search'){
      check(checks,'pack_status',run.status==='succeeded'&&run.result?.coverage==='observed_configured_sources_only'&&run.result?.global_minimum_verified===false,'Bounded search succeeded without a global-web claim');
      let expectedRows=null;try{expectedRows=searchRows(sources.rows,recipe);}catch(error){limits.push(`Independent search could not be calculated: ${error instanceof Error?error.message:'unknown'}`);}
      check(checks,'raw_search_matches',Array.isArray(expectedRows)&&expectedRows.length>0&&same(expectedRows,run.result?.rows)&&run.result?.matched_rows===expectedRows.length,'Exact selected rows recomputed from checkpoint raw records, filters and literal query');
      check(checks,'research_goal_from_raw',researchGoal(item,sources.rows,expectedRows),'Actual selected records meet the case goal even if the model used a different valid literal query or filter');
      const resultText=officeResult(audit,checks);
      check(checks,'filtered_answer_in_result',answerInResult(item,expectedRows,resultText),'Case-specific selected values appear in the independently reread Office result');
    }else{
      const checkpoint=object(run.execution_checkpoint),tick=object(checkpoint?.watch_tick),watch=object(run.watch_state),events=Array.isArray(run.events)?run.events:[];
      check(checks,'watch_baseline',run.status==='watching'&&run.result?.scheduler==='while_mcp_connected_or_explicit_tick'&&run.result?.external_notifications_sent===0,'Actual watch baseline is registered with local-only delivery');
      check(checks,'watch_tick_raw',Boolean(tick&&tick.cycle===1&&Array.isArray(tick.rows)&&tick.rows.length>0&&Array.isArray(tick.evidence)&&tick.evidence.length===recipe.sources.length&&Number.isFinite(time(tick.observed_at))),'One due tick has persisted raw records, evidence, cycle and observed time');
      check(checks,'watch_goal_from_raw',watchGoal(item,sources.rows,recipe)&&Boolean(tick&&watchGoal(item,tick.rows,recipe)),'Both complete raw observations contain the requested title, release-date or two-market price watch fields');
      check(checks,'work_scoped_tick_receipt',observations.some(row=>row?.invocation?.tool_name==='runtime_pack_watch_tick'&&row.invocation.dispatched===true&&row.invocation.arguments?.run_id===run.id&&row.receipt?.status==='succeeded'&&row.receipt.effect_state==='verified'&&row.receipt.value?.run_id===run.id&&row.receipt.value?.pending===false&&row.receipt.value?.watch?.cycle===1),'Same Work received a verified due tick receipt rather than an operator-only or early-pending tick');
      check(checks,'work_scoped_event_receipt',observations.some(row=>row?.invocation?.tool_name==='runtime_pack_events'&&row.invocation.arguments?.run_id===run.id&&row.receipt?.status==='succeeded'&&row.receipt.value?.run_id===run.id&&Array.isArray(row.receipt.value?.events)&&events.every(event=>row.receipt.value.events.some(seen=>seen.id===event.id&&same(seen.body,event.body)))),'Same Work inspected the local events for this watch run');
      check(checks,'work_scoped_pause_receipt',observations.some(row=>row?.invocation?.tool_name==='runtime_pack_watch_pause'&&row.invocation.dispatched===true&&row.invocation.arguments?.run_id===run.id&&row.invocation.arguments?.paused===true&&row.receipt?.status==='succeeded'&&row.receipt.effect_state==='verified'&&row.receipt.value?.run_id===run.id&&row.receipt.value?.paused===true),'Same Work verified pausing only this watch run');
      let before=null,after=null,changed=null;
      try{before=watchProjection(sources.rows,recipe);if(tick)after=watchProjection(tick.rows,recipe);if(before&&after)changed=recipe.mode==='any_change'?before.digest!==after.digest:Object.entries(after.minima).some(([group,value])=>before.minima[group]!==undefined&&value<before.minima[group]);}
      catch(error){limits.push(`Independent watch comparison unavailable: ${error instanceof Error?error.message:'unknown'}`);}
      check(checks,'watch_projection',Boolean(before&&after&&same(before,run.result?.baseline)&&same(before,tick?.before)&&same(after,tick?.after)&&same(after,watch?.baseline)),'Independent baseline/tick digest and numeric minima match durable Pack/watch checkpoint');
      const baselineAt=Math.max(...sources.baselineEvidence.map(evidence=>time(evidence.observed_at)));
      const tickAt=time(tick?.observed_at);
      check(checks,'native_elapsed_interval',Number.isFinite(baselineAt)&&Number.isFinite(tickAt)&&tickAt-baselineAt>=recipe.interval_seconds*1000&&recipe.interval_seconds>=60,'Real source observation timestamps are separated by the configured interval of at least 60 seconds');
      const tickEvidence=tick?.evidence??[];
      for(const [index,request] of recipe.sources.entries()){
        const evidence=object(tickEvidence[index]),source=config?.packs?.sources?.find(source=>source.id===request.id);
        const bound=Boolean(evidence&&source&&evidence.source_id===request.id&&evidence.rows===tick.rows.length&&evidence.request_sha256===digest({id:request.id,parameters:request.parameters??{}})&&hex(evidence.content_sha256)&&Number.isFinite(time(evidence.observed_at)));
        check(checks,`tick_source_${index}_bound`,bound,'Tick raw rows and live source evidence are bound to the configured request');
        if(bound&&source.kind==='browser')check(checks,`tick_source_${index}_browser_hash`,digest(tick.rows)===evidence.content_sha256,'Tick browser row content hash recomputed independently');
      }
      const changedEvents=events.filter(event=>event.kind==='changed'),unavailable=events.filter(event=>event.kind==='unavailable');
      const eventCorrect=changed===true?changedEvents.length===1&&unavailable.length===0&&same(changedEvents[0].body?.before,before)&&same(changedEvents[0].body?.after,after)&&changedEvents[0].body?.external_notifications_sent===0:changed===false&&changedEvents.length===0&&unavailable.length===0;
      check(checks,'local_event_condition',eventCorrect,'One local changed event iff digest/minimum-decrease rule is true; unchanged creates none; unavailable is separate');
      check(checks,'bounded_pause',watch?.run_id===run.id&&watch?.cycle===1&&watch?.paused===true,'Only this test watch reached cycle 1 and is now paused');
      check(checks,'no_external_notification',run.result?.external_notifications_sent===0&&events.every(event=>event.body?.external_notifications_sent===undefined||event.body.external_notifications_sent===0),'Pack and local events report zero external notifications');
    }
    if(family==='monitor.watch')officeResult(audit,checks);
    completion(audit,checks);
  }catch(error){check(checks,'acceptance_input',false,error instanceof Error?error.message:'unknown');}
  return {status:checks.length>0&&checks.every(item=>item.pass)?'PASS':'FAIL',checks,limits};
}
