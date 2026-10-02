import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProcedureTemplate,extractSlot,fillTemplate,templatedUrl,valueShape,ProcedureScript} from '../dist/work/procedure-template.js';

// The owner's idea for Jev: the model sets a task up once; a repeat takes the values from the same places in the
// pages in code, and Jev confirms the ones that changed. Anything unplaceable or unconfirmed goes back to the model.
const request='Node.js 공식 사이트에서 현재 LTS 버전과 출시일을 확인해 한 줄 요약을 Office 결과 파일로 저장해줘';
const home=version=>`Node.js® is a JavaScript runtime. Download Node.js (LTS) ${version} Downloads Node.js with long-term support.`;
const release=(version,date)=>`Blog / Release ${date}, Version ${version.slice(1)} 'Krypton' (LTS) Notable changes`;
const read=(turn,url,text,observed)=>({invocation:{request_id:`r-${turn}`,turn,stage_id:'s',tool_name:'office_browser_read',arguments:{url},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{url,text,observed_at:observed},evidence_ids:[`e-${turn}`],effect_state:'none',retry_safe:true},observed_at:observed});
const draft=(turn,text)=>({invocation:{request_id:`r-${turn}`,turn,stage_id:'s',tool_name:'office_result_draft',arguments:{text,label:'LTS 요약'},effect:'local_write',dispatched:true},receipt:{status:'succeeded',value:{},evidence_ids:[`e-${turn}`],effect_state:'verified',retry_safe:false},observed_at:'2026-10-01T00:00:09.000Z'});
const firstRun=[read(0,'https://nodejs.org/en',home('v24.21.0'),'2026-10-01T00:00:01.000Z'),read(1,'https://nodejs.org/en/blog/release/v24.21.0',release('v24.21.0','2026-09-08'),'2026-10-01T00:00:05.000Z'),
  draft(2,'2026-10-01T00:00:01.000Z 조회 기준 Node.js 현재 LTS는 v24.21.0이며 출시일은 2026-09-08이다(출처: https://nodejs.org/en/blog/release/v24.21.0).')];
const checkpoint=observations=>({format:1,work_id:'w',run_id:'r',binding:'b',turn:observations.length,pending:null,observations,summary:''});
const jevSaying=(choice,log=[])=>({async systemOne(request){log.push(request.state?.record??request);const other=choice==='same_field'?'different':'same_field';return {answers:{label:{type:'choice',choice,confidence:.97,probabilities:{[choice]:.97,[other]:.01,unknown:.02}}}};}});

test('a verified run becomes a template bound to where its values stood; computed numbers and tables do not',()=>{
  const template=buildProcedureTemplate(request,firstRun);
  assert.deepEqual(template.reads.map(item=>item.url),['https://nodejs.org/en','https://nodejs.org/en/blog/release/v24.21.0']);
  assert.deepEqual(template.slots.map(slot=>[slot.kind,slot.value]),[['observed_at','2026-10-01T00:00:01.000Z'],['page','v24.21.0'],['page','2026-09-08'],['read_url','https://nodejs.org/en/blog/release/v24.21.0']]);
  assert.equal(template.slots[1].left.endsWith('Download Node.js (LTS) '),true,'The calibration is the text just before the value.');
  assert.equal(buildProcedureTemplate(request,[firstRun[0],firstRun[1],draft(2,'현재 LTS는 v24.21.0이고 다음 버전은 v99.0.0으로 예상된다.')]),null,'A number the pages do not show was not read from them.');
  assert.equal(buildProcedureTemplate(request,[firstRun[0],{...draft(1,'a,b\n1,2'),invocation:{...draft(1,'a,b\n1,2').invocation,arguments:{text:'a,b\n1,2',format:'csv'}}}]),null,'Row collections are not templates.');
  assert.ok(valueShape('v24.21.0').test('v25.1.12'));assert.equal(valueShape('2026-09-08').exec('September 8')?.[0],undefined);
});

test('a repeat extracts changed values at the saved places, follows them into a later address, and fills the result',()=>{
  const template=buildProcedureTemplate(request,firstRun),values=new Map();
  const version=extractSlot(template.slots[1],home('v24.22.1'));assert.equal(version.value,'v24.22.1');values.set('v24.21.0',version.value);
  assert.equal(templatedUrl(template,1,values),'https://nodejs.org/en/blog/release/v24.22.1','The release page of the new version is read, not the old one.');
  values.set('2026-09-08',extractSlot(template.slots[2],release('v24.22.1','2026-10-20')).value);
  assert.equal(fillTemplate(template,values,['https://nodejs.org/en','https://nodejs.org/en/blog/release/v24.22.1'],['2026-11-01T09:00:00.000Z',''],'2026-11-01T09:00:03.000Z'),
    '2026-11-01T09:00:00.000Z 조회 기준 Node.js 현재 LTS는 v24.22.1이며 출시일은 2026-10-20이다(출처: https://nodejs.org/en/blog/release/v24.22.1).');
  assert.equal(extractSlot(template.slots[1],'The site was redesigned. Get Node.js here.'),null,'A value that is no longer at its place is not guessed.');
});

test('the script reads, lets Jev confirm changed values and saves; without confirmation or a place it hands over to the model',async()=>{
  const template=buildProcedureTemplate(request,firstRun);
  const run=async({jev,homeText=home('v24.22.1'),releaseText=release('v24.22.1','2026-10-20')})=>{
    const notes=[],paid=[],script=new ProcedureScript(template,jev,calls=>paid.push(calls),note=>notes.push(note)),observations=[],steps=[];
    for(let i=0;i<6;i++){
      const step=await script.next(checkpoint(observations));if(!step)break;steps.push(step);
      if(step.tool==='office_browser_read')observations.push(read(i,step.arguments.url,step.arguments.url.includes('/blog/')?releaseText:homeText,'2026-11-01T09:00:00.000Z'));
      else observations.push(draft(i,step.arguments.text));
    }
    return {steps,notes,paid};
  };
  const asked=[],confirmed=await run({jev:jevSaying('same_field',asked)});
  assert.deepEqual(confirmed.steps.map(step=>[step.tool,step.arguments.url??null]),[['office_browser_read','https://nodejs.org/en'],['office_browser_read','https://nodejs.org/en/blog/release/v24.22.1'],['office_result_draft',null]]);
  assert.match(confirmed.steps[2].arguments.text,/LTS는 v24\.22\.1이며 출시일은 2026-10-20이다/u);assert.equal(confirmed.steps[2].advance,true);assert.equal(confirmed.steps[2].arguments.label,'LTS 요약');
  assert.equal(confirmed.paid.length,2,'One fast judgment per changed value.');assert.deepEqual(asked.map(item=>[item.previous_value,item.new_value]),[['v24.21.0','v24.22.1'],['2026-09-08','2026-10-20']]);
  const unchanged=await run({jev:undefined,homeText:home('v24.21.0'),releaseText:release('v24.21.0','2026-09-08')});
  assert.equal(unchanged.steps.at(-1).tool,'office_result_draft','Unchanged pages need no judgment at all.');assert.equal(unchanged.paid.length,0);
  for(const [name,options,note] of [['Jev says different',{jev:jevSaying('different')},/did not confirm/u],['no Jev configured',{jev:undefined},/no fast judgment/u],['page redesigned',{jev:jevSaying('same_field'),homeText:'Redesigned.'},/could not be found/u]]){
    const handed=await run(options);assert.equal(handed.steps.some(step=>step.tool==='office_result_draft'),false,name);assert.match(handed.notes[0],note,name);
  }
});

// Live: "1 USD = 1355.838011 KRW" was rebuilt as "1790812951 USD" because the 1 was found inside a timestamp and the
// shape allowed any length; verification caught it, but the template must not produce it.
test('wording digits are not readings, values match whole tokens only, and a copied title follows its neighbours',async()=>{
  const rate=unix=>`{"result":"success","time_last_update_unix":${unix},"time_last_update_utc":"Thu, 01 Oct 2026 00:02:31 +0000","rates":{"USD":1,"KRW":1355.838011,"JPY":151.2}}`;
  const run=[read(0,'https://open.er-api.com/v6/latest/USD',rate(1790812951),'2026-10-01T18:00:00.000Z'),draft(1,'1 USD = 1355.838011 KRW | 환율 기준 시각: Thu, 01 Oct 2026 00:02:31 +0000')];
  const template=buildProcedureTemplate('open.er-api.com 에서 원화 환율과 기준 시각을 확인해 저장해줘',run);
  assert.ok(!template.slots.some(slot=>slot.value==='1'),'The 1 of "1 USD" is wording.');
  const krw=template.slots.find(slot=>slot.value==='1355.838011');assert.equal(extractSlot(krw,rate(1790899351).replace('1355.838011','1361.2')).value,'1361.2');
  assert.equal(valueShape('1').test('1790812951'),false);assert.equal(valueShape('24').test('2499999'),false);assert.ok(valueShape('9').test('10'));
  assert.equal(buildProcedureTemplate('합을 계산해줘',[read(0,'https://example.org/v','Latest release 3.14.8 and build 261000',''),draft(1,'버전 3.14.8, 합계 29')]),null,'29 inside 261000 is not a reading of 29.');
  const front=(title,points)=>`1. ${title} (example.com) ${points} points by someone 3 hours ago | hide | 81 comments 2. Another story (other.org) 150 points`;
  const hn=buildProcedureTemplate('news.ycombinator.com 1위 글의 제목과 점수를 JSON으로 저장해줘',[read(0,'https://news.ycombinator.com/',front('Clef: Open-source decision models',203),''),{...draft(1,''),invocation:{...draft(1,'').invocation,arguments:{format:'json',text:'{\n  "title": "Clef: Open-source decision models",\n  "score": 203\n}'}}}]);
  const title=hn.slots.find(slot=>slot.right!==undefined);assert.equal(title.value,'Clef: Open-source decision models');
  const page=front('A "new" top story',512),values=new Map([[title.value,extractSlot(title,page).value],['203',extractSlot(hn.slots.find(slot=>slot.value==='203'),page).value]]);
  assert.deepEqual(JSON.parse(fillTemplate(hn,values,['https://news.ycombinator.com/'],[''],'2026-10-02T00:00:00.000Z')),{title:'A "new" top story',score:512},'The copied title is replaced, and stays valid JSON.');
});
