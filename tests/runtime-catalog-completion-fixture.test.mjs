import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogCompletionFixture} from './helpers/catalog-completion-fixture.mjs';

const checks=[
  {id:'catalog',result:'Find research.search in the host catalog.',allowed_evidence_ids:['e1']},
  {id:'original_user_request',result:'Preserve the full original task.',allowed_evidence_ids:['e1']},
];
const source={record_id:'record_0',tool_name:'runtime_pack_catalog',evidence_ids:['e1'],value:{families:[{id:'research.search'}]}};
const base={original_user_request:{prompt:'Report the registered research.search family.',completion_condition:null},checks,observations:[source]};

test('runtime unit catalog fixture cites original leaf values for both user and generated checks in direct and compact modes',()=>{
  const direct=catalogCompletionFixture(base,{properties:{checks:{}}});
  assert.deepEqual(direct.checks.map(check=>check.id),checks.map(check=>check.id));
  assert.ok(direct.checks.every(check=>check.evidence_quotes[0].quote==='research.search'));
  const literal=catalogCompletionFixture({...base,projection:'host_literal_leaf_refs',literal_leaf_manifest:[{record_id:'record_0',evidence_ids:['e1'],leaf_refs:[['q_direct','$/families/0/id',0]]}]},{properties:{checks:{}}});
  assert.ok(literal.checks.every(check=>check.evidence_quote_refs[0].quote_ref==='q_direct'));
  const batch=catalogCompletionFixture({...base,eligible_pairs:checks.map(check=>({check_id:check.id,record_id:'record_0'})),literal_leaf_manifest:[{record_id:'record_0',evidence_ids:['e1'],base_paths:['$/families/0'],leaf_paths:[['q_batch',0,'id',1]]}]},{properties:{findings:{}}});
  assert.ok(batch.findings.every(finding=>finding.relation==='supports'&&finding.quote_refs[0].quote_ref==='q_batch'&&finding.quote_refs[0].part===0));
  const projected=catalogCompletionFixture({...base,projection:'host_validated_leaf_findings',observations:[{...source,findings:checks.map(check=>({check_id:check.id,relation:'supports',quotes:['research.search'],quote_refs:['q_projected']}))}]},{properties:{checks:{}}});
  assert.ok(projected.checks.every(check=>check.evidence_quote_refs[0].quote_ref==='q_projected'));
});

test('runtime unit catalog fixture cannot support absent original catalog leaf or an extra user condition',()=>{
  assert.throws(()=>catalogCompletionFixture({...base,observations:[{...source,value:{families:[{id:'other.family'}]}}]},{properties:{checks:{}}}),/No original catalog leaf/u);
  assert.throws(()=>catalogCompletionFixture({...base,original_user_request:{...base.original_user_request,completion_condition:'Send a message.'}},{properties:{checks:{}}}),/cannot invent fulfillment/u);
});
