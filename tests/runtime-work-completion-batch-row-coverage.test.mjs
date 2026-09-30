import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkCompletionVerifier} from '../dist/work/completion.js';

const sourceRows=Array.from({length:90},(_,index)=>({id:`source-${index}`,title:`Observed title ${index}`,value:index}));
const filteredRows=()=>Array.from({length:8},(_,index)=>({unique_key:`request-${index}`,status:'In Progress',agency:'311'}));
const observed=(request_id,value,evidence_id,tool_name='runtime_pack_run')=>({
  invocation:{request_id,turn:Number(request_id.slice(-1)),stage_id:'collect',tool_name,arguments:{},effect:'read_only',dispatched:true},
  receipt:{status:'succeeded',value,evidence_ids:[evidence_id],effect_state:'none',retry_safe:true},
  observed_at:'2026-09-30T00:00:00.000Z',
});
const checks=[
  {id:'source_collection',result:'Collect actual source rows.',evidence:'Observed source rows.'},
  {id:'status_filter',result:'All eight saved rows have exact status In Progress.',evidence:'Every saved row and its path.'},
  {id:'unique_keys',result:'All eight saved rows have distinct unique_key values.',evidence:'Every saved row and its path.'},
];
const claim={action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Not evidence.',wait_reason:null,completed_checks:[
  {id:'source_collection',evidence_ids:['source-0','source-1']},
  {id:'status_filter',evidence_ids:['readback-2']},
  {id:'unique_keys',evidence_ids:['readback-2']},
]};
function fixture(kind='valid',textOnly=false){
  const rows=filteredRows();
  if(kind==='missing_row')rows.pop();
  if(kind==='duplicate_key')rows[7].unique_key=rows[0].unique_key;
  if(kind==='wrong_status')rows[7].status='Closed';
  const savedRows=textOnly?rows.map(row=>({...row,details:'Observed saved record '+'.'.repeat(140)})):rows;
  const text=JSON.stringify(savedRows);
  const readback=textOnly?{text,page:{offset:0,total_bytes:text.length,returned_bytes:text.length,has_more:false,next_offset:null}}:{rows,text,page:{offset:0,total_bytes:text.length,has_more:false}};
  const observations=[observed('request0',{rows:sourceRows},'source-0'),observed('request1',{rows:sourceRows},'source-1'),observed('request2',readback,'readback-2','office_result_read')];
  const inputs=[],audits=[];
  const model={calls:[],async call(purpose,_instructions,input){
    inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});
    if(input.eligible_pairs)return {findings:input.eligible_pairs.map(pair=>{
      const manifest=input.literal_leaf_manifest.find(item=>item.record_id===pair.record_id);
      const paths=manifest.leaf_paths.map(([ref,base,segment])=>({ref,path:`${manifest.base_paths[base]}/${segment}`}));
      const source=pair.check_id==='source_collection';
      const target=source?paths.filter(item=>item.path.endsWith('/title')).slice(0,1):textOnly?paths.filter(item=>item.path==='$/text'):paths.filter(item=>item.path.startsWith('$/rows/')&&item.path.endsWith(pair.check_id==='status_filter'?'/status':'/unique_key'));
      const selected=textOnly&&!source?Array.from({length:manifest.leaf_paths.find(row=>row[0]===target[0].ref)[3]},(_,part)=>({quote_ref:target[0].ref,part})):target.map(item=>({quote_ref:item.ref,part:0}));
      const contradiction=kind==='wrong_status'&&pair.check_id==='status_filter'||kind==='duplicate_key'&&pair.check_id==='unique_keys';
      const unresolved=kind==='missing_row'&&!source;
      return {...pair,relation:contradiction?'contradicts':unresolved?'unresolved_material':'supports',quote_refs:unresolved?[]:selected,reason:contradiction?'A saved row violates the requested condition.':unresolved?'One requested row is absent.':'Original row-path values observed.'};
    })};
    assert.equal(input.projection,'host_validated_leaf_findings');
    return {checks:input.checks.map(check=>{
      const findings=input.observations.flatMap(record=>record.findings.filter(finding=>finding.check_id===check.id&&finding.relation==='supports').flatMap(finding=>finding.quote_refs.map((quote_ref,index)=>({evidence_id:record.evidence_ids[0],quote_ref,path:finding.quote_paths[index],part:finding.quote_parts[index],quote:finding.quotes[index]}))));
      if(check.id!=='source_collection'){
        if(textOnly){
          assert.ok(findings.length>4,'A complete eight-row JSON readback needs more than the old four-part cap.');
          assert.deepEqual(findings.map(item=>item.part),findings.map((_,index)=>index),'All text chunks remain contiguous and ordered.');
          assert.deepEqual([...new Set(findings.map(item=>item.path))],['$/text']);
          assert.deepEqual(JSON.parse(findings.map(item=>item.quote).join('')),savedRows);
        }else{
          assert.equal(findings.length,8,'All eight original row paths survive projection.');
          assert.equal(new Set(findings.map(item=>item.path)).size,8);
        }
        assert.equal(new Set(findings.map(item=>item.quote_ref)).size,findings.length,'Equal text at distinct paths or parts has distinct refs.');
      }
      return {id:check.id,verdict:'supported',evidence_ids:[...new Set(findings.map(item=>item.evidence_id))],evidence_quote_refs:findings.map(({evidence_id,quote_ref})=>({evidence_id,quote_ref})),reason:'Every required original row path and exact value is present.'};
    })};
  }};
  return {rows,observations,inputs,audits,model,verify:createWorkCompletionVerifier(model,{literalRefMode:true,audit:event=>audits.push(event)})};
}

test('runtime fixture: eight saved rows preserve distinct exact paths and refs across literal evidence batches',async()=>{
  const scenario=fixture();
  assert.equal(await scenario.verify(checks,scenario.observations,claim),true,JSON.stringify(scenario.audits.map(event=>({code:event.code,issue:event.issue}))));
  const batches=scenario.inputs.filter(input=>input.eligible_pairs);
  assert.ok(batches.length>=2);assert.ok(batches.some(input=>input.eligible_pairs.some(pair=>pair.check_id==='status_filter')));
  assert.equal(scenario.inputs.at(-1).projection,'host_validated_leaf_findings');
  assert.ok(scenario.audits.some(event=>event.code==='WORK_COMPLETION_BATCH_INSPECTED'&&event.batch_findings?.some(finding=>finding.check_id==='status_filter'&&finding.quote_refs.length===8)));
});

test('runtime fixture: complete eight-row text-only readback retains every ordered literal chunk beyond four refs',async()=>{
  const scenario=fixture('valid',true);
  assert.equal(await scenario.verify(checks,scenario.observations,claim),true);
  const readback=scenario.inputs.at(-1).observations.find(record=>record.evidence_ids.includes('readback-2'));
  assert.ok(readback.findings.filter(finding=>finding.relation==='supports').every(finding=>finding.quote_parts.length>4));
});

for(const kind of ['missing_row','duplicate_key','wrong_status'])test(`runtime fixture: ${kind} cannot be promoted to verified completion by a later batch`,async()=>{
  const scenario=fixture(kind);
  assert.equal(await scenario.verify(checks,scenario.observations,claim),false);
  assert.equal(scenario.inputs.some(input=>input.projection),false);
  assert.ok(scenario.audits.some(event=>event.code===('missing_row'===kind?'WORK_COMPLETION_BATCH_UNRESOLVED_MATERIAL':'WORK_COMPLETION_BATCH_CONTRADICTS')),JSON.stringify(scenario.audits.map(event=>({code:event.code,issue:event.issue}))));
});
