// Read-only verdict over a phase-112 audit snapshot. This never opens a browser,
// sends a request, or treats an Office TXT summary as proof of a Pack draft.
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value:{};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const words=value=>String(value??'').replace(/\s+/gu,' ').trim();
const literal=(prompt,key)=>{
  const match=String(prompt??'').match(new RegExp(`(?:^|[\\s,])${key}=(?:"([^"]+)"|([^,]+))`,'u'));
  return (match?.[1]??match?.[2]??null)?.trim()??null;
};
const browserValue=observation=>record(record(observation).receipt).value;
function observedPricing(text){
  const matches=[...text.matchAll(/\b(Free|Developer|Startup|Scale)\s+Plan\b/giu)];
  return matches.map((match,index)=>{
    const section=text.slice(match.index,matches[index+1]?.index??text.length);
    const capacity=section.match(/\b(\d+)\s*(\+)?\s*concurrent\s+browsers\b/iu);
    const header=section.slice(0,capacity?.index??0),price=header.match(/\$(\d+)\s*\/\s*mo\b/u);
    const custom=/\bCustom\b/u.test(header);
    return {name:match[1],concurrency:capacity?Number(capacity[1]):null,capacity_label:capacity?.[0]??null,price:price?Number(price[1]):custom?null:undefined,price_label:price?.[0]??(custom?'Custom':null)};
  });
}

/**
 * @param {object} item Phase-112 case input, including id/family/target_id/prompt.
 * @param {object} receipt Matrix audit record containing DB-scoped pack_runs and observations.
 * @param {object} config Host config or connection file; no credentials are inspected.
 * @returns {{status:'PASS'|'FAIL',checks:{name:string,pass:boolean,detail:string}[],limits:string[]}}
 */
export function validate(item,receipt,config){
  const checks=[],limits=[];
  const check=(name,pass,detail)=>checks.push({name,pass:Boolean(pass),detail});
  const wanted=record(item),audit=record(receipt),settings=record(config);
  const packs=record(settings.packs),targets=Array.isArray(packs.targets)?packs.targets:Array.isArray(settings.targets)?settings.targets:[];
  const target=targets.find(row=>record(row).id===wanted.target_id);
  const runs=Array.isArray(audit.pack_runs)?audit.pack_runs:[];
  const candidates=runs.filter(row=>record(row.recipe).family===wanted.family&&record(row.recipe).target===wanted.target_id);
  // The audit is ordered by durable run history. A recovered fresh draft must
  // not inherit a legacy draft's missing DOM observations, and a newer failure
  // must not be hidden by selecting an older successful candidate.
  const run=candidates.at(-1),recipe=record(record(run).recipe),result=record(record(run).result);
  const observations=Array.isArray(audit.observations)?audit.observations:[];

  check('case_identity',audit.id===wanted.id&&typeof audit.work_id==='string'&&audit.work_id.length>0,'Audit case and Work ID must match the case input.');
  check('registered_draft_target',Boolean(target&&target.family===wanted.family&&target.draft_only===true&&target.auth_required===false&&target.url==='https://www.browserbase.com/contact'),'Only the preconfigured public Browserbase draft target is eligible.');
  check('actual_pack_run',Boolean(run&&run.status==='draft_ready'&&recipe.family===wanted.family&&recipe.target===wanted.target_id),'A durable family_run in draft_ready is required; a report file alone is insufficient.');
  check('no_external_submit',result.external_submit===false&&result.approval_available===false&&wanted.external_submit_allowed===false,'Pack draft must report no submit and no approval capability.');
  check('capture_ref',typeof result.capture_ref==='string'&&result.capture_ref.length>0,'A pre-submit capture reference must be present.');
  const capture=record(record(run).capture_readback);
  check('capture_readback',capture.path===result.capture_ref&&Number.isInteger(capture.bytes)&&capture.bytes>0&&/^[a-f0-9]{64}$/u.test(String(capture.sha256??''))&&capture.matches===true&&capture.sha256===result.capture_sha256,'Independent audit must reread the capture and match both its durable stage digest and Pack receipt digest.');

  const values=record(recipe.values),returned=record(result.values),expected={};
  for(const field of ['firstName','lastName','email','jobTitle','companyName'])expected[field]=literal(wanted.prompt,field);
  expected.helpOption=literal(wanted.prompt,'helpOption');
  const fields=Object.keys(record(target?.fields));
  check('reviewed_fields',fields.length===7&&fields.every(field=>typeof values[field]==='string'&&values[field].trim().length>0)&&Object.keys(values).every(field=>fields.includes(field)),'All seven configured contact controls must have nonempty recipe values, with no extra field.');
  check('case_values',Object.entries(expected).every(([field,value])=>typeof value==='string'&&values[field]===value)&&expected.helpOption===wanted.expected_help_option&&typeof values.email==='string'&&values.email.endsWith('@domain.invalid'),'Literal case fields must match the unsent non-identifying prompt.');
  check('prepared_values',same(values,returned),'The Pack-prepared values must equal the requested recipe values.');
  check('dom_before_capture_readback',same(values,record(result.verified_values_before_capture)),'Actual DOM controls must match the requested values before capture; a legacy missing field is unobserved.');
  check('dom_after_capture_readback',result.readback_source==='browser_dom_controls_after_capture'&&same(values,record(result.verified_values_after_capture))&&same(result.verified_values_after_capture,result.verified_values),'Actual DOM controls must still match after capture, including the legacy after-readback field.');
  if(wanted.family==='form.draft-submit')check('form_project_text',values.project===literal(wanted.prompt,'project'),'The exact supplied project message must be staged.');

  const packReceipt=observations.find(row=>{
    const invocation=record(record(row).invocation),evidence=record(record(row).receipt),value=record(evidence.value);
    return invocation.tool_name==='runtime_pack_run'&&invocation.request_id===run?.request_id&&value.run_id===run?.id&&value.status==='draft_ready'&&evidence.status==='succeeded'&&evidence.effect_state==='verified';
  });
  check('verified_pack_receipt',Boolean(packReceipt),'A verified same-request runtime_pack_run observation must bind to the durable run.');
  const statusRead=observations.find(row=>{
    const invocation=record(record(row).invocation),evidence=record(record(row).receipt),value=record(evidence.value);
    return invocation.tool_name==='runtime_pack_status'&&record(invocation.arguments).run_id===run?.id&&value.run_id===run?.id&&value.status==='draft_ready'&&evidence.status==='succeeded';
  });
  check('pack_status_readback',Boolean(statusRead),'The same run must have a successful runtime_pack_status readback.');
  const officeArtifacts=Array.isArray(audit.office_artifacts)?audit.office_artifacts:[];
  check('office_result_present',officeArtifacts.length>0,'These matrix Works require a saved, independently reread Office result in addition to the browser draft.');
  for(const artifact of officeArtifacts){
    const readback=record(artifact.independent_readback);
    const pages=observations.filter(row=>{
      const invocation=record(record(row).invocation),evidence=record(record(row).receipt),value=record(evidence.value);
      return invocation.tool_name==='office_result_read'&&record(invocation.arguments).request_id===artifact.request_id&&evidence.status==='succeeded'&&value.request_id===artifact.request_id&&record(value.artifact).sha256===artifact.sha256;
    }).map(row=>record(record(row).receipt).value).sort((a,b)=>record(a.page).offset-record(b.page).offset);
    const uniquePages=new Map();let conflictingPage=false;
    for(const page of pages){
      const position=record(page.page),old=uniquePages.get(position.offset);
      if(old&&!same({page:old.page,text:old.text,artifact:old.artifact},{page:page.page,text:page.text,artifact:page.artifact}))conflictingPage=true;
      if(!old)uniquePages.set(position.offset,page);
    }
    const distinct=[...uniquePages.values()];let offset=0,text='';
    const complete=!conflictingPage&&distinct.length>0&&distinct.every(page=>{
      const position=record(page.page),body=page.text;
      if(position.offset!==offset||typeof body!=='string'||Buffer.byteLength(body,'utf8')!==position.returned_bytes||position.total_bytes!==artifact.bytes)return false;
      offset+=position.returned_bytes;text+=body;
      return position.has_more?(position.next_offset===offset):position.next_offset===null;
    })&&offset===artifact.bytes&&record(distinct.at(-1).page).has_more===false;
    check('office_result_file_readback',readback.matches===true&&complete&&text===readback.text,`Optional Office result ${artifact.request_id} must be independently hash-read and fully paged via office_result_read.`);
  }

  if(wanted.family==='choose.stage'){
    const source=observations.find(row=>{
      const invocation=record(record(row).invocation),evidence=record(record(row).receipt),value=record(evidence.value);
      return invocation.tool_name==='office_browser_read'&&value.url==='https://www.browserbase.com/pricing'&&value.provenance==='live_browser_dom'&&evidence.status==='succeeded'&&typeof value.text==='string'&&value.text.length>0;
    });
    const sourceText=words(record(browserValue(source)).text),projectText=words(values.project),needed=Number(wanted.required_concurrent_browsers);
    check('live_pricing_source',Boolean(source),'A successful observed official pricing-page DOM receipt is required.');
    check('capacity_in_draft',Number.isInteger(needed)&&needed>0&&new RegExp(`\\b${needed}\\b`,'u').test(projectText),'The staged question must state the required concurrency.');
    check('pricing_evidence_in_draft',/browserbase\.com\/pricing/iu.test(projectText)&&/\b(?:Free|Developer|Startup|Scale)\b/u.test(projectText)&&/\b(?:concurrent|concurrency|browsers?)\b/iu.test(projectText),'The draft must cite the official source, selected plan and observed capacity.');
    const plans=observedPricing(sourceText),known=new Set(plans.map(plan=>plan.name.toLowerCase()));
    check('pricing_observation_support',plans.length===4&&known.size===4&&plans.every(plan=>Number.isInteger(plan.concurrency)&&plan.concurrency>0&&plan.price!==undefined),'Parse four plan names, capacities and prices from the actual observed DOM text, not from case metadata.');
    const eligible=plans.filter(plan=>plan.concurrency>=needed).sort((a,b)=>(a.price??Infinity)-(b.price??Infinity)||a.concurrency-b.concurrency);
    const selected=eligible[0];
    const displayedPrice=selected?.price_label==='Custom'?/\bCustom\b/iu.test(projectText):selected?.price!==undefined&&selected?.price!==null&&projectText.includes(`$${selected.price}`);
    const selectedEvidence=Boolean(selected&&new RegExp(`\\b${selected.name}\\b`,'iu').test(projectText)&&new RegExp(`\\b${selected.concurrency}\\b`,'u').test(projectText)&&displayedPrice);
    check('lowest_eligible_plan',selectedEvidence,selected?`The draft must identify the cheapest observed eligible plan: ${selected.name}, capacity ${selected.concurrency}, displayed price ${selected.price_label}.`:'No eligible plan can be derived from the live DOM observation.');
  }
  check('work_succeeded',record(audit.supervisor).state==='succeeded'&&record(record(audit.supervisor).result).completion_verified===true,'The Office supervisor must have independently verified completion of this Work.');
  if(audit.detail)check('detail_succeeded',record(audit.detail).run_status==='succeeded'&&record(audit.detail).completion_verified===true,'The live Work detail, when supplied, must agree on independently verified success.');
  limits.push('A capture file proves a staged browser state only if its digest is compared with the host capture receipt; no external submit is inferred from an absence of POST logs here.');
  return {status:checks.every(row=>row.pass)?'PASS':'FAIL',checks,limits};
}
