import assert from 'node:assert/strict';

function leafAtPath(value,path){
  if(typeof path!=='string'||!path.startsWith('$/'))return undefined;
  return path.slice(2).split('/').reduce((current,segment)=>current?.[segment.replaceAll('~1','/').replaceAll('~0','~')],value);
}

/** Fixture verifier: cite only host-indexed leaves of actual successful receipts. */
export function observedCompletionFixture(input,{prompt,needle,accept=()=>true,assertResult=()=>{}}){
  assert.ok(prompt.test(input.original_user_request?.prompt??''),'The saved user request must match the fixture task.');
  assertResult(input);
  assert.equal(input.projection,'host_literal_leaf_refs');
  return {checks:input.checks.map(check=>{
    const citations=input.literal_leaf_manifest.flatMap(manifest=>{
      const record=input.observations.find(item=>item.evidence_ids.some(id=>manifest.evidence_ids.includes(id)));
      if(!record||!accept(record,check))return [];
      const entry=manifest.leaf_refs.find(([,path,part])=>{
        const leaf=leafAtPath(record.value,path);
        return ['string','number','boolean'].includes(typeof leaf)&&Array.from(String(leaf)).slice(part*400,(part+1)*400).join('').includes(needle);
      });
      return entry?manifest.evidence_ids.filter(id=>check.allowed_evidence_ids.includes(id)).map(evidence_id=>({evidence_id,quote_ref:entry[0]})):[];
    });
    assert.ok(citations.length>0,`No observed ${needle} leaf is allowed for ${check.id}`);
    return {id:check.id,verdict:'supported',evidence_use:'observed_result',evidence_ids:[...new Set(citations.map(item=>item.evidence_id))],evidence_quote_refs:citations,reason:`The actual receipt contains ${needle}.`};
  })};
}
