// Explicit opt-in, real-provider/public-source Work validation. Not a CI fixture.
// Keep session/capability paths private; never print authentication or capability URLs.
import {mkdtemp,readFile,writeFile,mkdir,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {loadHostConfig} from '../dist/interface/config.js';
import {modelSettingsPath,publicModelSettings,saveModelSettings} from '../dist/onboarding/model-settings.js';
import {codexModelCatalog} from '../dist/onboarding/model-catalog.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {collectSource} from '../dist/packs/sources.js';
import {encodeCsv} from '../dist/packs/data.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';
import {acceptStageClaims,currentStageReports,stageBinding} from '../dist/work/stages.js';

const receiptPath=resolve(process.env.OFFICE_MATRIX_RECEIPT??'tests/evidence/phase112-session.json');
const json=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const load=async()=>JSON.parse(await readFile(receiptPath,'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const key of ['AGENT_DRIVER_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','TYPESAFE_API_KEY'])delete process.env[key];
const action=process.argv[2];

if(action==='merge'){
  const files=['data','browser','research-watch'];const connections={sources:[],targets:[],local_records:[],snapshots:[]},cases=[];
  for(const name of files){
    const input=JSON.parse(await readFile(resolve(`tests/evidence/phase112-${name}-connections.json`),'utf8'));
    for(const key of Object.keys(connections))connections[key].push(...(input[key]??[]));
    const definitions=JSON.parse(await readFile(resolve(`tests/evidence/phase112-${name}-cases.json`),'utf8'));
    for(const item of Array.isArray(definitions)?definitions:definitions.cases){
      if(name==='research-watch'&&!['research.search','monitor.watch'].includes(item.family))continue;
      cases.push({...item,completion_condition:item.completion_condition??`Actual ${item.family} Pack execution, an Office result saved and reread, and verified Work completion are required. ${item.acceptance.join(' ')}`});
    }
  }
  const usedSources=new Set([...connections.snapshots.map(row=>row.source_id),...cases.flatMap(row=>[...(row.recipe?.sources??row.expected_recipe?.sources??[]).map(source=>source.id),...(row.source_id?[row.source_id]:[])])]);
  connections.sources=connections.sources.filter(source=>usedSources.has(source.id));
  for(const key of ['sources','targets','local_records']){const ids=connections[key].map(row=>row.id);if(new Set(ids).size!==ids.length)throw Error('MATRIX_DUPLICATE_'+key);}
  const families=Object.fromEntries([...new Set(cases.map(row=>row.family))].map(family=>[family,cases.filter(row=>row.family===family).length]));
  if(cases.length!==24||Object.keys(families).length!==8||Object.values(families).some(count=>count!==3))throw Error('MATRIX_NOT_8_BY_3');
  await json(resolve('tests/evidence/phase112-matrix-connections.json'),connections);
  await json(resolve('tests/evidence/phase112-matrix-cases.json'),{phase:112,evidence_level:'user_environment',families,cases});
  console.log(JSON.stringify({cases:cases.length,families,sources:connections.sources.length,external_submission:false}));
}else if(action==='prepare'){
  try{await stat(receiptPath);throw Error('MATRIX_SESSION_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
  const connections=process.argv[3]?JSON.parse(await readFile(resolve(process.argv[3]),'utf8')):{};
  const catalog=await codexModelCatalog();
  if(catalog.status!=='available')throw Error('LIVE_SUBSCRIPTION_CATALOG_UNAVAILABLE');
  const model=catalog.models.find(row=>/^gpt-(?:6(?:\.\d+)?|5\.6)-sol$/u.test(row.id))?.id;
  if(!model)throw Error('LIVE_SOL_MODEL_NOT_OFFERED');
  const root=await mkdtemp(join(tmpdir(),'office-phase112-'));
  await mkdir(join(root,'inputs'),{mode:0o700});
  const path=join(root,'host.json');
  const sources=(connections.sources??[
    {id:'weather',kind:'http',url:'https://raw.githubusercontent.com/vega/vega-datasets/main/data/seattle-weather.csv',parameters:[],format:'csv'},
    {id:'iris',kind:'http',url:'https://raw.githubusercontent.com/vega/vega-datasets/main/data/iris.json',parameters:[],format:'json'},
    {id:'hn',kind:'browser',url:'https://news.ycombinator.com/',parameters:[],rows:'tr.athing',columns:{title:'.titleline > a',rank:'.rank'},ready:'.hnname',auth_gate:'form[action="login"]',auth_required:false,account_selector:'.hnname',account_text:'Hacker News'},
  ]).map(source=>({...source,...(source.kind==='file'?{path:source.path.replace('{ROOT}',root)}:{})}));
  const aside='/mnt/c/Users/takko/AppData/Local/Aside/CLI/current/aside.exe';
  const host={schema_version:1,project_id:'phase112-'+randomUUID().slice(0,8),caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',work:{model_data_approved:true},packs:{models:'jev_llm',model_data_approved:true,sources,targets:connections.targets??[],local_records:(connections.local_records??[]).map(record=>({...record,path:record.path.replace('{ROOT}',root)}))},swarm:{enabled:true,model_data_approved:true},browser_executors:{targets:[{id:'office-playwright',engine:'playwright',environment:'owned_headless',platform:'linux',profile_ref:'phase112-owned',priority:70},{id:'office-aside',engine:'aside',environment:'host_foreground',platform:'win32',profile_ref:'aside-local',executable:aside,priority:40}]}};
  await json(path,host);const config=loadHostConfig(path);
  const defaults=publicModelSettings(null,{}).selection;
  saveModelSettings(modelSettingsPath(config),{revision:0,onboarding_step:2,selection:{...defaults,mode:'subscription',client:'codex',client_models:{codex:model,claude:null,opencode:null},codex_reasoning_effort:'high',api_to_subscription:false,jev:'off',role_model_mode:'inherit'}},{});
  await json(receiptPath,{format:1,evidence_level:'user_environment',state:'prepared',root,config:path,model,effort:'high',catalog,created_at:new Date().toISOString(),paid_api:false,jev:false,cases:[]});
  await json(join(root,'connections.json'),connections);
  console.log(JSON.stringify({state:'prepared',model,effort:'high',sources:sources.map(s=>s.id),targets:host.packs.targets.map(t=>t.id),receipt:receiptPath}));
}else if(action==='refresh-connections'){
  const saved=await load();if(saved.state!=='prepared'||saved.cases.length)throw Error('MATRIX_CONFIGURATION_FROZEN');
  const connections=JSON.parse(await readFile(resolve(process.argv[3]),'utf8')),host=JSON.parse(await readFile(saved.config,'utf8'));
  host.packs.sources=connections.sources.map(source=>({...source,...(source.kind==='file'?{path:source.path.replace('{ROOT}',saved.root)}:{})}));host.packs.targets=connections.targets??[];
  host.packs.local_records=(connections.local_records??[]).map(row=>({...row,path:row.path.replace('{ROOT}',saved.root)}));
  await json(saved.config,host);loadHostConfig(saved.config);await json(join(saved.root,'connections.json'),connections);console.log(JSON.stringify({state:'connections_refreshed',sources:host.packs.sources.length}));
}else if(action==='inputs'){
  const saved=await load(),config=loadHostConfig(saved.config),connections=JSON.parse(await readFile(join(saved.root,'connections.json'),'utf8')),snapshots=[];
  const cache=new Map();
  for(const item of connections.snapshots??[]){
    let observation=cache.get(item.source_id);
    if(!observation){const source=config.packs.sources.find(row=>row.id===item.source_id);if(!source)throw Error('MATRIX_SOURCE_MISSING');observation=await collectSource(source,{},config);cache.set(item.source_id,observation);}
    let rows=observation.rows;
    if(item.select){const field=item.select.field;rows=item.select.partitions.flatMap(partition=>{
      const selected=observation.rows.filter(row=>partition.op==='eq'?row[field]===partition.value:partition.op==='gte'?Number(row[field])>=partition.value:Number(row[field])<partition.value).slice(0,partition.take);
      if(selected.length!==partition.take)throw Error('MATRIX_ACTUAL_PARTITION_MISSING_'+item.source_id);return selected;
    });}
    if(item.local_fields)rows=rows.map(row=>({...row,...item.local_fields}));
    const path=item.destination.replace('{ROOT}',saved.root);if(!path.startsWith(join(saved.root,'inputs')+'/'))throw Error('MATRIX_INPUT_SCOPE');
    const bytes=Buffer.from(item.format==='csv'?encodeCsv(rows,[...new Set(rows.flatMap(row=>Object.keys(row)))]):JSON.stringify(rows,null,2)+'\n');
    await writeFile(path,bytes,{mode:0o600,flag:'wx'});
    snapshots.push({source_id:item.source_id,destination:path,sha256:digest(await readFile(path)),rows:rows.length,format:item.format,evidence:observation.evidence,source_rows:observation.rows,selected_rows:rows,local_fields:item.local_fields??null});
  }
  await json(join(saved.root,'input-provenance.json'),snapshots);
  console.log(JSON.stringify({state:'inputs_ready',files:snapshots.map(row=>({source_id:row.source_id,rows:row.rows,sha256:row.sha256}))}));
}else if(action==='preflight'){
  const saved=await load(),config=loadHostConfig(saved.config),cases=JSON.parse(await readFile(resolve('tests/evidence/phase112-matrix-cases.json'),'utf8')).cases,checks=[];
  for(const source of config.packs.sources.filter(row=>row.kind!=='file')){
    const related=cases.find(row=>row.recipe?.sources?.some(request=>request.id===source.id));const parameters=related?.recipe.sources.find(request=>request.id===source.id)?.parameters??{};
    try{const value=await collectSource(source,parameters,config);checks.push({source_id:source.id,status:'PASS',rows:value.rows.length,evidence:value.evidence,sample:value.rows.slice(0,4)});}
    catch(error){checks.push({source_id:source.id,status:'FAIL',error:error instanceof Error?error.message:String(error)});}
    const last=checks.at(-1);console.log(JSON.stringify({source_id:last.source_id,status:last.status,rows:last.rows,error:last.error}));
  }
  await json(join(saved.root,'preflight.json'),checks);if(checks.some(row=>row.status==='FAIL'))process.exitCode=1;
}else if(action==='submit'){
  const saved=await load(),matrix=JSON.parse(await readFile(resolve('tests/evidence/phase112-matrix-cases.json'),'utf8'));
  const selected=matrix.cases.filter(item=>!process.argv[3]||item.family===process.argv[3]||item.id===process.argv[3]);if(!selected.length)throw Error('MATRIX_NO_CASES');
  for(const item of selected){
    if((await load()).cases.some(row=>row.id===item.id)){console.log(JSON.stringify({id:item.id,state:'already_registered'}));continue;}
    const path=join(saved.root,item.id+'-case.json');await json(path,item);
    const exit=await new Promise(resolve=>{const child=spawn(process.execPath,[process.argv[1],'start',path],{env:process.env,stdio:'inherit'});child.once('error',error=>{console.error(error.message);resolve(-1);});child.once('exit',code=>resolve(code));});
    if(exit!==0)console.log(JSON.stringify({id:item.id,state:'intake_failed',exit_code:exit}));
  }
}else if(action==='serve'){
  const saved=await load();if(!['prepared','stopped'].includes(saved.state))throw Error('MATRIX_ALREADY_SERVING');
  const server=await startControlCenter(loadHostConfig(saved.config));
  await json(receiptPath,{...saved,state:'serving',pid:process.pid,url:server.url,started_at:new Date().toISOString()});
  console.log(JSON.stringify({state:'serving',pid:process.pid,receipt:'tests/evidence/phase112-session.json'}));
  let closing=false;const close=async()=>{if(closing)return;closing=true;await server.close();await json(receiptPath,{...await load(),state:'stopped',stopped_at:new Date().toISOString()});};
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void close());
  await server.closed;
}else if(action==='start'){
  const saved=await load();if(saved.state!=='serving')throw Error('MATRIX_NOT_SERVING');
  const item=JSON.parse(await readFile(resolve(process.argv[3]),'utf8'));
  if(saved.cases.some(row=>row.id===item.id))throw Error('MATRIX_CASE_ALREADY_REGISTERED');
  const begin=Date.now();
  const response=await fetch(saved.url+'work/start',{method:'POST',headers:{origin:new URL(saved.url).origin,'x-agent-driver':'human-office','content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({request_id:item.id,prompt:item.prompt,intake_mode:'quick',completion_condition:item.completion_condition,delivery_target_ids:['app'],execute:true,cost_acknowledged:true,timezone:'Asia/Seoul'}),signal:AbortSignal.timeout(300000)});
  if(!response.ok)throw Error('MATRIX_INTAKE_HTTP_'+response.status);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',registered=null,final=null;
  const consume=async line=>{if(!line.trim())return;const event=JSON.parse(line);await json(join(saved.root,item.id+'-intake-'+event.type+'.json'),event);if(event.type==='registered'){registered=event.work;const current=await load();await json(receiptPath,{...current,cases:[...current.cases,{...item,work_id:registered.work_id,started_at:new Date(begin).toISOString(),state:'registered'}]});console.log(JSON.stringify({id:item.id,event:'registered',work_id:registered.work_id}));}if(event.type==='result')final=event.result;if(event.type==='error')throw Error(event.error);};
  while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.indexOf('\n'))>=0){await consume(buffer.slice(0,index));buffer=buffer.slice(index+1);}}
  if(buffer.trim())await consume(buffer);if(!registered||!final)throw Error('MATRIX_INTAKE_INCOMPLETE');
  const current=await load();await json(receiptPath,{...current,cases:current.cases.map(row=>row.id===item.id?{...row,state:'admitted',intake:final,intake_elapsed_ms:Date.now()-begin}:row)});
  console.log(JSON.stringify({id:item.id,event:'admitted',work_id:registered.work_id,status:final.status,admission:final.admission,intake_elapsed_ms:Date.now()-begin}));
}else if(action==='define'){
  const saved=await load(),item=saved.cases.find(row=>row.id===process.argv[3]);
  if(saved.state!=='serving'||!item)throw Error('MATRIX_CASE_NOT_SERVING');
  const begin=Date.now();const response=await fetch(saved.url+'work/define',{method:'POST',headers:{origin:new URL(saved.url).origin,'x-agent-driver':'human-office','content-type':'application/json'},body:JSON.stringify({work_id:item.work_id}),signal:AbortSignal.timeout(300000)});
  const value=await response.json();await json(join(saved.root,item.id+'-define-'+Date.now()+'.json'),{at:new Date().toISOString(),elapsed_ms:Date.now()-begin,http_status:response.status,value});
  console.log(JSON.stringify({id:item.id,http_status:response.status,status:value.status,reason:value.reason??null,admission:value.admission??null,elapsed_ms:Date.now()-begin}));
}else if(action==='session'){
  const saved=await load();console.log(JSON.stringify({state:saved.state,root:saved.root,pid:saved.pid,model:saved.model,registered:saved.cases.length,cases:saved.cases.map(item=>({id:item.id,state:item.state,intake_status:item.intake?.status,intake_reason:item.intake?.reason}))}));
}else if(action==='repair'){
  // Only normal user control endpoints. No SQLite writes, approvals, discarded
  // receipts, identity changes or weakened completion conditions.
  const saved=await load();if(saved.state!=='serving')throw Error('MATRIX_NOT_SERVING');
  const directions={
    'phase112-portal-usgs':'원래 완료조건을 그대로 유지하세요. 새 portal.collect는 columns=["id"], format="csv"를 지원합니다. TXT를 CSV로 간주하지 말고 실제 id 한 열의 CSV를 생성·재조회하세요. 과거 JSON/TXT는 이전 증거로 보존합니다.',
    'phase112-portal-food':'원래 완료조건을 그대로 유지하세요. 소스에서 관측한 critical_flag=Critical인 모든 원본 행이 대상입니다. 한 식당으로 camis 필터를 추가하거나 다른 식당 행을 생략하지 마세요. 동일 식당의 서로 다른 위반도 합치지 말고 별개 행으로 유지한 실제 CSV를 생성·재조회하세요.',
    'phase112-file-311':'원래 완료조건을 그대로 유지하세요. nyc311_file은 이미 등록된 읽기 허용 Pack source입니다. 사용자 폴더 이동/권한 도구 runtime_files_request 대신 file.pipeline Pack에 이 소스를 지정해 Closed 행 전체를 필요한 열과 정렬로 별도 CSV에 저장·재조회하세요. 원본은 변경하지 마세요.',
    'phase112-file-food':'원래 완료조건을 그대로 유지하세요. nycfood_file은 이미 등록된 읽기 허용 Pack source입니다. 사용자 폴더 이동/권한 도구 runtime_files_request 대신 file.pipeline Pack에 이 소스를 지정해 Not Critical 행 전체를 필요한 열과 숫자 정렬로 별도 JSON에 저장·재조회하세요. 원본은 변경하지 마세요.',
    'phase112-inbox-311':'원래 완료조건을 그대로 유지하세요. 네 원본 상태가 분류 근거입니다. 질문에 status의 정확한 문자열 Closed→closed, In Progress→open을 명시하여 inbox.triage로 재분류하세요. 근거 인용은 관측 필드의 값 자체(예: Closed)여야 합니다. 분류 초안만 작성하며 사용자의 확인/발송을 대신 승인하지 마세요.',
    'phase112-inbox-food':'원래 네 행의 모든 식별자·critical_flag·최종 label·unknown=0 조건을 유지하세요. Office는 Agent Office 결과 저장소를 뜻합니다. 원래 요청에는 특정 파일 확장자나 Microsoft Office 파일 요구가 없습니다. 구조화 JSON 내용을 보존한 실제 TXT 결과 파일도 전체 재읽기와 필드 대조를 통과하면 유효하며, 명시되지 않은 TXT 금지 조건을 추가하지 마세요. 외부 전달·제출은 금지합니다.',
  };
  for(const item of saved.cases){
    if(process.argv[3]&&item.id!==process.argv[3])continue;
    const response=await fetch(saved.url+'work/detail?id='+encodeURIComponent(item.work_id));const detail=await response.json();
    const state=detail.run_status??detail.status;
    if(!['failed','waiting_approval','awaiting_review','waiting_model','paused'].includes(state)&&!(state==='succeeded'&&item.id==='phase112-portal-food'))continue;
    let instruction=directions[item.id];
    if(item.family==='record.update')instruction='원래 대상 식별자·수정할 로컬 필드·초안만 저장·원본과 비대상 행 무변경이라는 완료조건을 그대로 유지하세요. 과거 관측과 거절을 보존하세요. 정확히 한 행이라는 근거가 없는 과거 영수증에 matched_rows를 소급해서 붙이지 말고, 새 request_id로 현재 등록된 로컬 레코드를 검증된 읽기 도구로 조회해 실제 matched_rows 및 원본 SHA를 확인하세요. 승인 거절이나 불확실한 쓰기를 재실행하지 마세요. 이미 검증된 전체 배열 JSON 초안은 그대로 대조·재조회할 수 있습니다. 외부 제출·전송은 금지합니다.';
    if(item.family==='form.draft-submit')instruction='원래 완료조건과 지정한 일곱 필드를 그대로 유지하세요. verified_values_before_capture와 verified_values_after_capture 및 실제 capture_sha256으로 검증된 초안은 재사용할 수 있습니다. 이 관측 필드가 없는 과거 초안을 소급해서 관측했다고 주장하지 마세요. 필요한 경우에만 새 draft-only Pack 요청으로 동일 필드를 다시 준비하고 캡처 전후 실제 DOM 재조회 값을 확인하세요. Submit·메시지 전송·가입은 금지합니다.';
    const actions=instruction?['edit','resume']:['retry'];let revision=detail.revision;
    for(const step of actions){
      const result=await fetch(saved.url+'work/control',{method:'POST',headers:{origin:new URL(saved.url).origin,'x-agent-driver':'human-office','content-type':'application/json'},body:JSON.stringify({work_id:item.work_id,revision,action:step,...(step==='edit'?{instruction}:{})})});const value=await result.json();
      await json(join(saved.root,item.id+'-repair-'+step+'-'+Date.now()+'.json'),{at:new Date().toISOString(),http_status:result.status,value,instruction:step==='edit'?instruction:null});
      console.log(JSON.stringify({id:item.id,action:step,http_status:result.status,state:value.state,reason:value.reason??value.error??null}));
      if(!result.ok)break;revision=value.work_revision??value.revision??revision+1;
    }
  }
}else if(action==='pause-pending'){
  const saved=await load();if(saved.state!=='serving')throw Error('MATRIX_NOT_SERVING');
  for(const item of saved.cases){
    const detailResponse=await fetch(saved.url+'work/detail?id='+encodeURIComponent(item.work_id),{signal:AbortSignal.timeout(15000)});const detail=await detailResponse.json();
    if(!['queued','running','retry_wait'].includes(detail.run_status??detail.status))continue;
    const response=await fetch(saved.url+'work/control',{method:'POST',headers:{origin:new URL(saved.url).origin,'x-agent-driver':'human-office','content-type':'application/json'},body:JSON.stringify({work_id:item.work_id,revision:detail.revision,action:'pause'}),signal:AbortSignal.timeout(15000)});
    const value=await response.json();await json(join(saved.root,item.id+'-pause-for-repair-'+Date.now()+'.json'),{at:new Date().toISOString(),http_status:response.status,value});
    console.log(JSON.stringify({id:item.id,http_status:response.status,state:value.state,reason:value.reason??value.error??null}));
  }
}else if(action==='retry'||action==='pause'||action==='resume'||action==='edit'){
  const saved=await load(),item=saved.cases.find(row=>row.id===process.argv[3]);if(saved.state!=='serving'||!item)throw Error('MATRIX_CASE_NOT_SERVING');
  const detailResponse=await fetch(saved.url+'work/detail?id='+encodeURIComponent(item.work_id),{signal:AbortSignal.timeout(15000)});const detail=await detailResponse.json();
  const instruction=action==='edit'?process.argv[4]:undefined;if(action==='edit'&&!instruction)throw Error('MATRIX_INSTRUCTION_REQUIRED');
  const response=await fetch(saved.url+'work/control',{method:'POST',headers:{origin:new URL(saved.url).origin,'x-agent-driver':'human-office','content-type':'application/json'},body:JSON.stringify({work_id:item.work_id,revision:detail.revision,action,...(instruction?{instruction}:{})}),signal:AbortSignal.timeout(15000)});
  const value=await response.json();await json(join(saved.root,item.id+'-'+action+'-'+Date.now()+'.json'),{at:new Date().toISOString(),http_status:response.status,value});console.log(JSON.stringify({id:item.id,action,http_status:response.status,state:value.state,reason:value.reason??value.error??null}));
}else if(action==='stop'){
  const saved=await load();if(saved.state!=='serving')throw Error('MATRIX_NOT_SERVING');
  const command=await readFile('/proc/'+saved.pid+'/cmdline','utf8');
  if(!command.includes('live-pack-work-matrix.mjs')||!command.includes('serve'))throw Error('MATRIX_PROCESS_IDENTITY_CHANGED');
  process.kill(saved.pid,'SIGTERM');console.log(JSON.stringify({state:'stop_requested',pid:saved.pid}));
}else if(action==='verdict'||action==='report'){
  const saved=await load(),config=loadHostConfig(saved.config),provenance=JSON.parse(await readFile(join(saved.root,'input-provenance.json'),'utf8')),files=await readdir(saved.root),results=[];
  for(const item of saved.cases){
    const latest=files.filter(name=>name.startsWith(item.id+'-audit-')).sort().at(-1);
    if(!latest){results.push({id:item.id,family:item.family,status:'NOT_RUN',reason:'independent_audit_pending'});continue;}
    const audit=JSON.parse(await readFile(join(saved.root,latest),'utf8')),module=item.family==='form.draft-submit'||item.family==='choose.stage'?'browser':item.family==='research.search'||item.family==='monitor.watch'?'research-watch':'data';
    const validator=await import(`./live-pack-${module}-acceptance.mjs`),verdict=validator.validate(item,audit,config,provenance);
    results.push({id:item.id,family:item.family,work_id:item.work_id,execution_state:audit.supervisor?.state??'not_started',completion_verified:audit.supervisor?.result?.completion_verified===true,audit_at:audit.at,...verdict});
  }
  const report={at:new Date().toISOString(),evidence_level:'user_environment',results};
  await json(join(saved.root,'independent-verdicts-'+Date.now()+'.json'),report);
  await json(join(saved.root,'independent-verdicts.json'),report);
  if(action==='report'){
    // A queued/running Work has not finished its E2E acceptance check. Preserve
    // its incomplete evidence, but never report that as a completed failure or
    // count a stale successful audit as a fresh completion.
    const currentDb=new DatabaseSync(config.dbPath,{readOnly:true});currentDb.exec('PRAGMA query_only=ON');
    let outcomes;
    try{outcomes=results.map(result=>{
      const row=currentDb.prepare('SELECT state,result,updated_at FROM office_supervisor WHERE project_id=? AND work_id=? ORDER BY created_at DESC LIMIT 1').get(config.project.id,result.work_id);
      const state=row?.state??'not_started',final=row?.result?JSON.parse(row.result):null;
      const fresh=Boolean(result.audit_at&&row&&Date.parse(result.audit_at)>=Date.parse(row.updated_at));
      const pending=['not_started','queued','running','retry_wait'].includes(state)||!fresh;
      const verified=state==='succeeded'&&final?.completion_verified===true&&fresh&&result.status==='PASS';
      return {id:result.id,family:result.family,work_id:result.work_id,evidence_level:'user_environment',status:verified?'PASS':pending?'NOT_RUN':'FAIL',execution_state:state,completion_verified:final?.completion_verified===true,audit_current:fresh,failed_checks:result.checks?.filter(check=>!check.pass),reason:pending?'E2E acceptance pending':verified?null:'Actual Work or independent acceptance is incomplete'};
    });}finally{currentDb.close();}
    const matrix=JSON.parse(await readFile(resolve('tests/evidence/phase112-matrix-cases.json'),'utf8'));
    // Additional probes retain their own evidence, never inflate the original
    // 24-case acceptance numerator or make an original failure disappear.
    const originalIds=new Set(matrix.cases.map(item=>item.id)),originalOutcomes=outcomes.filter(item=>originalIds.has(item.id)),supplemental=outcomes.filter(item=>!originalIds.has(item.id));
    const registered=saved.cases.filter(item=>originalIds.has(item.id)).length;
    const publicReport={phase:112,at:report.at,evidence_level:'user_environment',expected_cases:24,registered,families:matrix.families,model:saved.model,reasoning_effort:saved.effort,jev:saved.jev,paid_api:saved.paid_api,external_submit:false,external_message:false,counts:Object.fromEntries(['PASS','FAIL','NOT_RUN'].map(status=>[status,originalOutcomes.filter(row=>row.status===status).length])),all_pass:registered===24&&originalOutcomes.length===24&&new Set(originalOutcomes.map(item=>item.id)).size===24&&originalOutcomes.every(row=>row.status==='PASS'),results:originalOutcomes,supplemental_results:supplemental,limitations:['Draft-only form, record and choice validation; no external submission or message delivery is exercised.','Individual public-source observations are bounded, not universal site coverage.','Failed earlier attempts are retained separately; a recovered success is not a first-attempt success.']};
    await json(resolve('tests/evidence/phase112-live-pack-matrix-'+Date.now()+'.json'),publicReport);
    await json(resolve('tests/evidence/phase112-live-pack-matrix.json'),publicReport);
    console.log(JSON.stringify({registered:publicReport.registered,counts:publicReport.counts,all_pass:publicReport.all_pass}));
  }
  for(const result of results)console.log(JSON.stringify({id:result.id,family:result.family,status:result.status,failed_checks:result.checks?.filter(row=>!row.pass)}));
}else if(action==='status'||action==='audit'||action==='summary'||action==='activity'||action==='decision-diagnostic'){
  const saved=await load(),config=loadHostConfig(saved.config),db=new DatabaseSync(config.dbPath,{readOnly:true});db.exec('PRAGMA query_only=ON');
  const summary=[];
  try{for(const item of saved.cases){
    if(process.argv[3]&&item.id!==process.argv[3])continue;
    const row=db.prepare('SELECT run_id,state,reason,attempts,checkpoint,result,updated_at FROM office_supervisor WHERE project_id=? AND work_id=? ORDER BY created_at DESC LIMIT 1').get(config.project.id,item.work_id);
    const checkpoint=row?JSON.parse(row.checkpoint):null,observations=checkpoint?.observations??[];
    const packRows=db.prepare("SELECT r.*,e.checkpoint AS execution_checkpoint FROM family_run r JOIN office_run o ON o.source_kind='pack' AND o.source_id=r.id LEFT JOIN family_execution e ON e.run_id=r.id WHERE o.project_id=? AND o.work_id=? ORDER BY r.rowid").all(config.project.id,item.work_id).map(r=>({...r,recipe:JSON.parse(r.recipe),result:JSON.parse(r.result),execution_checkpoint:JSON.parse(r.execution_checkpoint??'{}')}));
    const activity=db.prepare('SELECT kind,summary,created_at,metadata FROM office_activity WHERE project_id=? AND work_id=? ORDER BY id').all(config.project.id,item.work_id);
    if(action==='decision-diagnostic'){
      // Inspect only this app-created test Work's exact opaque native session.
      // Emit validation facts, not prompts, reasoning, credentials or raw text.
      const key=hashJson({work_id:item.work_id,run_id:row.run_id,actor_id:'supervisor',role:'worker',provider:'codex'});
      const session=JSON.parse(await readFile(join(saved.root,'data/.connection/decision-sessions',key,'session.json'),'utf8'));
      if(!session.session_id){console.log(JSON.stringify({id:item.id,state:'native_session_unobserved'}));continue;}
      const nativeRoot=join(process.env.CODEX_HOME??join(process.env.HOME,'.codex'),'sessions'),matches=[];
      const walk=async path=>{for(const entry of await readdir(path,{withFileTypes:true})){if(entry.isDirectory())await walk(join(path,entry.name));else if(entry.name.includes(session.session_id)&&entry.name.endsWith('.jsonl'))matches.push(join(path,entry.name));}};
      await walk(nativeRoot);if(matches.length!==1)throw Error('MATRIX_NATIVE_SESSION_NOT_UNIQUE');
      const events=(await readFile(matches[0],'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
      const messages=events.filter(event=>event.type==='event_msg'&&event.payload?.type==='agent_message').slice(-2);
      const work=db.prepare('SELECT spec FROM office_intake WHERE project_id=? AND work_id=?').get(config.project.id,item.work_id),spec=JSON.parse(work.spec);
      const diagnostics=messages.map(event=>{let decision;try{decision=JSON.parse(event.payload.message);}catch{return {json:'invalid'};}
        let stage_error=null;try{acceptStageClaims(spec.plan,observations,currentStageReports(spec.plan,checkpoint.stage_reports),decision.completed_stages??[]);}catch(error){stage_error=error.message;}
        return {action:decision.action,stage_id:decision.stage_id,completed_stages:decision.completed_stages,check_ids:decision.completed_checks?.map(check=>check.id),stage_error};
      });
      console.log(JSON.stringify({id:item.id,plan_stages:spec.plan.steps.map(step=>({id:step.id,binding:stageBinding(step)})),accepted_stages:currentStageReports(spec.plan,checkpoint.stage_reports).map(report=>report.stage_id),bound_observations:observations.filter(o=>o.receipt.status==='succeeded').map(o=>({stage_id:o.invocation.stage_id,binding:o.invocation.stage_binding,evidence_ids:o.receipt.evidence_ids})),diagnostics}));continue;
    }
    if(action==='activity'){
      console.log(JSON.stringify({id:item.id,activity:activity.slice(-10).map(event=>({kind:event.kind,summary:event.summary,at:event.created_at}))}));continue;
    }
    const receipt={...item,at:new Date().toISOString(),evidence_level:'user_environment',supervisor:row?{...row,checkpoint,result:row.result?JSON.parse(row.result):null}:null,pack_runs:packRows,observations,activity};
    if(action==='audit'){
      const artifacts=packRows.flatMap(r=>r.result?.artifact?[r.result.artifact]:[]);
      for(const artifact of artifacts){const bytes=await readFile(artifact.path);artifact.independent_readback={bytes:bytes.length,sha256:digest(bytes),matches:bytes.length===artifact.bytes&&digest(bytes)===artifact.sha256,text:bytes.toString('utf8')};}
      for(const run of packRows){
        if(run.result?.capture_ref){const bytes=await readFile(run.result.capture_ref),stages=db.prepare('SELECT detail_json FROM task_stage_timing WHERE task_id=? AND stage=? ORDER BY id DESC').all(run.task_id,'browser_prepare_capture'),recorded=stages.map(row=>JSON.parse(row.detail_json)).find(row=>row.capture_sha256)?.capture_sha256;run.capture_readback={path:run.result.capture_ref,bytes:bytes.length,sha256:digest(bytes),recorded_sha256:recorded??null,matches:recorded===digest(bytes)};}
        if(run.recipe.family==='monitor.watch'){const watch=db.prepare('SELECT * FROM family_watch WHERE run_id=?').get(run.id);run.watch_state=watch?{...watch,paused:Boolean(watch.paused),baseline:JSON.parse(watch.baseline)}:null;run.events=db.prepare('SELECT * FROM family_event WHERE project_id=? AND run_id=? ORDER BY id').all(config.project.id,run.id).map(event=>({...event,body:JSON.parse(event.body)}));}
      }
      receipt.office_artifacts=[];
      for(const observation of observations.filter(row=>row.invocation.tool_name==='office_result_draft'&&row.receipt.status==='succeeded'&&row.receipt.effect_state==='verified')){const artifact=observation.receipt.value.artifact,bytes=await readFile(artifact.path);receipt.office_artifacts.push({...artifact,request_id:observation.invocation.request_id,independent_readback:{bytes:bytes.length,sha256:digest(bytes),matches:bytes.length===artifact.bytes&&digest(bytes)===artifact.sha256,text:bytes.toString('utf8')}});}
      if(saved.state==='serving'){const response=await fetch(saved.url+'work/detail?id='+encodeURIComponent(item.work_id),{signal:AbortSignal.timeout(15000)});receipt.detail=response.ok?await response.json():{http_status:response.status};}
      const path=join(saved.root,item.id+'-audit-'+Date.now()+'.json');await json(path,receipt);
    }
    const result={id:item.id,work_id:item.work_id,state:row?.state??'not_started',reason:row?.reason??null,turn:checkpoint?.turn??null,tools:observations.map(o=>({tool:o.invocation.tool_name,status:o.receipt.status,error:o.receipt.value?.error??null})),packs:packRows.map(r=>({family:r.recipe.family,status:r.status,error:r.result?.error??null})),updated_at:row?.updated_at??null};
    summary.push(result);if(action!=='summary')console.log(JSON.stringify(result));
  }if(action==='summary')console.log(JSON.stringify({registered:summary.length,states:Object.fromEntries([...new Set(summary.map(row=>row.state))].map(state=>[state,summary.filter(row=>row.state===state).length])),attention:summary.filter(row=>!['running','queued','succeeded','retry_wait'].includes(row.state)).map(row=>({id:row.id,state:row.state,reason:row.reason})),active:summary.filter(row=>row.state==='running').map(row=>({id:row.id,turn:row.turn,last_tool:row.tools.at(-1)?.tool??null}))}));}finally{db.close();}
}else throw Error('Use prepare, serve, start, status or audit');
