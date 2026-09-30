import assert from 'node:assert/strict';

const catalogFamily='research.search';
const hasObservedLeaf=(value,needle)=>{
  if(typeof value==='string')return value.includes(needle);
  if(Array.isArray(value))return value.some(item=>hasObservedLeaf(item,needle));
  if(value&&typeof value==='object')return Object.values(value).some(item=>hasObservedLeaf(item,needle));
  return false;
};
const leafAtPath=(value,path)=>{
  if(typeof path!=='string'||!path.startsWith('$/'))return undefined;
  return path.slice(2).split('/').reduce((current,key)=>current?.[key.replaceAll('~1','/').replaceAll('~0','~')],value);
};
const catalogLeafPart=(value,path)=>{
  const leaf=leafAtPath(value,path);
  if(typeof leaf!=='string')return -1;
  const units=Array.from(leaf);
  for(let part=0;part*400<units.length;part++)if(units.slice(part*400,(part+1)*400).join('').includes(catalogFamily))return part;
  return -1;
};

/** Fixture-model output grounded in the host's real catalog receipt, including bounded inspection. */
export function catalogCompletionFixture(input,schema){
  assert.match(input.original_user_request?.prompt??input.checks[0]?.result??'',/research\.search/u);
  assert.equal(input.original_user_request?.completion_condition??null,null,'Catalog fixture cannot invent fulfillment of a separate user condition');
  if(schema.properties?.findings){
    return {findings:input.eligible_pairs.map(({check_id,record_id})=>{
      const record=input.observations.find(item=>item.record_id===record_id);
      assert.ok(record,`Missing original catalog receipt ${record_id}`);
      const supports=record.tool_name==='runtime_pack_catalog'&&hasObservedLeaf(record.value,catalogFamily);
      if(input.literal_leaf_manifest){
        const manifest=input.literal_leaf_manifest.find(item=>item.record_id===record_id);
        const pathOf=entry=>Array.isArray(manifest?.base_paths)?`${manifest.base_paths[entry[1]]}/${entry[2]}`:entry[1];
        const partsOf=entry=>Array.isArray(manifest?.base_paths)?entry[3]:entry[2];
        const selected=supports?manifest?.leaf_paths.find(entry=>{const part=catalogLeafPart(record.value,pathOf(entry));return part>=0&&part<partsOf(entry);}):undefined;
        assert.ok(!supports||selected,`No host-literal catalog path for ${record_id}`);
        return {check_id,record_id,relation:supports?'supports':'irrelevant',quote_refs:supports?[{quote_ref:selected[0],part:catalogLeafPart(record.value,pathOf(selected))}]:[],reason:supports?'Observed catalog family ID.':'No catalog family ID in this receipt.'};
      }
      return {check_id,record_id,relation:supports?'supports':'irrelevant',quotes:supports?[catalogFamily]:[],reason:supports?'Observed catalog family ID.':'No catalog family ID in this receipt.'};
    })};
  }
  assert.ok(schema.properties?.checks,'Expected completion-verification schema');
  return {checks:input.checks.map(check=>{
    assert.ok(check.id==='original_user_request'||/research\.search/u.test(check.result),`Unexpected completion check ${check.id}`);
    if(input.projection==='host_literal_leaf_refs'){
      const citations=input.literal_leaf_manifest.flatMap(manifest=>{
        const record=input.observations.find(item=>item.evidence_ids.some(id=>manifest.evidence_ids.includes(id))&&item.tool_name==='runtime_pack_catalog'&&hasObservedLeaf(item.value,catalogFamily));
        if(!record)return [];
        const ref=manifest.leaf_refs.find(([,path,part])=>catalogLeafPart(record.value,path)===part)?.[0];
        return ref?manifest.evidence_ids.filter(id=>check.allowed_evidence_ids.includes(id)).map(evidence_id=>({evidence_id,quote_ref:ref})):[];
      });
      assert.ok(citations.length>0,`No host-literal catalog leaf reference for ${check.id}`);
      return {id:check.id,verdict:'supported',evidence_use:'observed_result',evidence_ids:[...new Set(citations.map(item=>item.evidence_id))],evidence_quote_refs:citations,reason:'The original catalog receipt identifies research.search.'};
    }
    if(input.projection==='host_validated_leaf_findings'){
      const citations=input.observations.flatMap(record=>record.findings.filter(finding=>finding.check_id===check.id&&finding.relation==='supports'&&finding.quotes.includes(catalogFamily)).flatMap(finding=>record.evidence_ids.filter(id=>check.allowed_evidence_ids.includes(id)).map(evidence_id=>({evidence_id,quote_ref:finding.quote_refs[finding.quotes.indexOf(catalogFamily)]}))));
      assert.ok(citations.length>0,`No projected host-validated catalog quote for ${check.id}`);
      return {id:check.id,verdict:'supported',evidence_use:'observed_result',evidence_ids:[...new Set(citations.map(item=>item.evidence_id))],evidence_quote_refs:citations,reason:'The original catalog receipt identifies research.search.'};
    }
    const evidence=input.observations.filter(record=>record.tool_name==='runtime_pack_catalog'&&hasObservedLeaf(record.value,catalogFamily)).flatMap(record=>record.evidence_ids).filter(id=>check.allowed_evidence_ids.includes(id));
    assert.ok(evidence.length>0,`No original catalog leaf for ${check.id}`);
    return {id:check.id,verdict:'supported',evidence_use:'observed_result',evidence_ids:evidence,evidence_quotes:evidence.map(evidence_id=>({evidence_id,quote:catalogFamily})),reason:'The original catalog receipt identifies research.search.'};
  })};
}
