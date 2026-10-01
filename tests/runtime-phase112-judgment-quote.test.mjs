import test from 'node:test';
import assert from 'node:assert/strict';
import {judgeRow} from '../dist/packs/judgment.js';

const record={unique_key:'70565782',status:'Closed'};
const labels={closed:'Officially closed',open:'In progress'};
const question='Classify only the observed status: Closed means closed; In Progress means open.';
const model=answers=>({calls:[],async call(purpose,instructions,input,schema){this.calls.push({purpose,instructions,input,schema});return answers.shift();}});

test('an exact observed quote accepts the original label without another model call',async()=>{
  const llm=model([{label:'closed',evidence_quote:'Closed'}]);
  const result=await judgeRow(record,question,labels,.9,undefined,llm);
  assert.equal(result.label,'closed');assert.equal(result.decider,'llm');assert.equal(llm.calls.length,1);
});

test('one bounded quote-only correction fixes a field-prefixed quote without changing label',async()=>{
  const llm=model([{label:'closed',evidence_quote:'status: Closed'},{evidence_quote:'Closed'}]);
  const result=await judgeRow(record,question,labels,.9,undefined,llm);
  assert.equal(result.label,'closed');assert.equal(result.decider,'llm');assert.equal(llm.calls.length,2);
  assert.deepEqual(Object.keys(llm.calls[1].schema.properties),['evidence_quote']);
  assert.equal(llm.calls[1].input.fixed_label,'closed');
});

test('unknown classification never triggers quote repair',async()=>{
  const llm=model([{label:'unknown',evidence_quote:'status: Closed'}]);
  const result=await judgeRow(record,question,labels,.9,undefined,llm);
  assert.equal(result.label,'unknown');assert.equal(llm.calls.length,1);
});

test('a second malformed quote or attempted label change remains unknown after one correction',async()=>{
  for(const repaired of [{evidence_quote:'status: Closed'},{label:'open',evidence_quote:'Closed'},{evidence_quote:'fabricated'}]){
    const llm=model([{label:'closed',evidence_quote:'status: Closed'},repaired]);
    const result=await judgeRow(record,question,labels,.9,undefined,llm);
    assert.equal(result.label,'unknown');assert.equal(result.decider,'unknown');assert.equal(result.failure_reason,'semantic_uncertainty');assert.equal(llm.calls.length,2);
  }
});
