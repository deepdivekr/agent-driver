import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWorkImportDraft,validateWorkImportDraft,UNIVERSAL_WORK_MIGRATION_PROMPT,WORK_IMPORT_DRAFT_MAX_BYTES} from '../dist/work/import-draft.js';

function reported(){
  return {
    format:1,
    source:{platform:'chatgpt_work',name:'Daily AI briefing',reference:null},
    title:{value:'Daily AI briefing',evidence_ids:['e1']},
    goal:{value:'Send an AI news digest each morning',evidence_ids:['e1']},
    trigger:{kind:'schedule',rule:'Every day at 08:00',timezone:null,evidence_ids:['e2']},
    steps:[{id:'collect',goal:'Collect relevant news',depends_on:[],tool_hints:['web'],effect:'read_only',evidence_ids:['e1']},{id:'summarize',goal:'Write a digest',depends_on:['collect'],tool_hints:[],effect:'draft_only',evidence_ids:['e1']}],
    completion:[{id:'delivered',result:'Digest delivered',proof:'delivery receipt',evidence_ids:['e1']}],
    delivery:{channel:'chat',target:null,evidence_ids:['e1']},
    dependencies:[],
    approval_boundary:{value:null,evidence_ids:[]},
    unknowns:[],
    evidence:[{id:'e1',source_ref:'automation instructions',quote:'Send an AI news digest each morning.'},{id:'e2',source_ref:'schedule settings',quote:'Every day at 08:00'}],
  };
}

test('copyable migration prompt asks for observations, unknowns and no credentials or execution',()=>{
  assert.match(UNIVERSAL_WORK_MIGRATION_PROMPT,/실행·수정·중지는 하지 마세요/u);
  assert.match(UNIVERSAL_WORK_MIGRATION_PROMPT,/추측하지 말고 null 또는 unknown/u);
  assert.match(UNIVERSAL_WORK_MIGRATION_PROMPT,/API 키·비밀번호·쿠키·토큰/u);
  assert.match(UNIVERSAL_WORK_MIGRATION_PROMPT,/evidence_ids/u);
  const match=UNIVERSAL_WORK_MIGRATION_PROMPT.match(/\n(\{\n[\s\S]*?\n\})\n/u);
  assert.ok(match);
  assert.equal(parseWorkImportDraft(match[1]).goal.value,null);
});

test('pasted fenced JSON becomes a grounded, inactive Work draft with unknowns preserved',()=>{
  const draft=parseWorkImportDraft('External explanation ignored.\n```json\n'+JSON.stringify(reported())+'\n```\nDo not activate.');
  assert.equal(draft.provenance.kind,'pasted_external_ai');
  assert.equal(draft.provenance.independently_verified,false);
  assert.equal(draft.status,'draft');
  assert.deepEqual(draft.authority,{execution:false,activation:false});
  assert.equal(draft.steps[1].depends_on[0],'collect');
  assert.ok(draft.unknowns.some(item=>item.field==='trigger.timezone'));
  assert.ok(draft.unknowns.some(item=>item.field==='approval_boundary'));
  assert.equal(draft.evidence[0].source_ref,'automation instructions');
});

test('unknown content stays unknown instead of becoming a guessed schedule or delivery',()=>{
  const empty=reported();
  empty.title={value:null,evidence_ids:[]};empty.goal={value:null,evidence_ids:[]};
  empty.trigger={kind:'unknown',rule:null,timezone:null,evidence_ids:[]};
  empty.steps=[];empty.completion=[];empty.delivery={channel:'unknown',target:null,evidence_ids:[]};empty.evidence=[];
  const draft=validateWorkImportDraft(empty);
  assert.equal(draft.goal.value,null);
  assert.equal(draft.trigger.kind,'unknown');
  assert.ok(draft.unknowns.some(item=>item.field==='completion'));
  assert.ok(draft.unknowns.some(item=>item.field==='delivery.channel'));
});

test('ungrounded values, invented references and cyclic steps cannot enter a draft',()=>{
  const ungrounded=reported();ungrounded.goal.evidence_ids=[];
  assert.throws(()=>validateWorkImportDraft(ungrounded),/WORK_IMPORT_EVIDENCE_MISSING/u);
  const invented=reported();invented.goal.evidence_ids=['missing'];
  assert.throws(()=>validateWorkImportDraft(invented),/WORK_IMPORT_EVIDENCE_REFERENCE_INVALID/u);
  const cyclic=reported();cyclic.steps[0].depends_on=['summarize'];
  assert.throws(()=>validateWorkImportDraft(cyclic),/WORK_IMPORT_STEP_CYCLE/u);
});

test('actual-looking credentials and multiple JSON blocks are rejected without echoing the value',()=>{
  const raw=JSON.stringify(reported());
  const key='sk-'+'x'.repeat(32);
  assert.throws(()=>parseWorkImportDraft(raw+'\n'+key),error=>error.message==='WORK_IMPORT_SECRET_REJECTED'&&!error.message.includes(key));
  const botToken='123456789:'+'A'.repeat(35);
  assert.throws(()=>parseWorkImportDraft(raw+'\n'+botToken),/WORK_IMPORT_SECRET_REJECTED/u);
  const fenced='```json\n'+raw+'\n```';
  assert.throws(()=>parseWorkImportDraft(fenced+'\n'+fenced),/WORK_IMPORT_MULTIPLE_JSON_BLOCKS/u);
  assert.throws(()=>parseWorkImportDraft('x'.repeat(WORK_IMPORT_DRAFT_MAX_BYTES+1)),/WORK_IMPORT_TEXT_SIZE_INVALID/u);
});

test('external claims cannot grant execution or activation authority',()=>{
  const forged={...reported(),authority:{execution:true,activation:true}};
  assert.throws(()=>validateWorkImportDraft(forged));
  const draft=validateWorkImportDraft(reported());
  assert.equal('activated_at' in draft,false);
});
