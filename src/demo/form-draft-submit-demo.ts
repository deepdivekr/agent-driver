import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {type AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {type Capability,type Lease,type Observation,requireCondition,type Verification} from '../core/contracts.js';
import {RuntimeStore} from '../store/runtime-store.js';
import {taskPackManifest,type TaskPackManifest,snapshotHash} from '../taskpack/contracts.js';
import {OwnedPersistentPage} from '../taskpack/owned-playwright.js';
import {type ApprovedBrowserAdapter,type BrowserPreparation,ApprovedBrowserProtocol} from '../taskpack/protocol.js';

const demoDateTime=z.string().regex(/^20\d\d-\d\d-\d\dT\d\d:\d\d\+09:00$/);
export const formDraftSubmitInput=z.object({
  request_id:z.string().regex(/^change-request-[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  subject:z.string().min(1).max(100),effective_at:demoDateTime,follow_up_at:demoDateTime,notes:z.string().min(1).max(400),
}).strict();
export type FormDraftSubmitInput=z.infer<typeof formDraftSubmitInput>;

export const FORM_DRAFT_SUBMIT_DEMO_INPUT:FormDraftSubmitInput={
  request_id:'change-request-2026-09-27',subject:'정기 운영 변경 보고',effective_at:'2026-09-27T18:00+09:00',follow_up_at:'2026-09-27T19:00+09:00',notes:'정기 점검 완료 후 다음 작업을 시작합니다.',
};

export function normalizeFormDraftSubmit(value:unknown):FormDraftSubmitInput {
  const input=formDraftSubmitInput.parse(value);
  requireCondition(Date.parse(input.follow_up_at)>Date.parse(input.effective_at),'FOLLOW_UP_MUST_FOLLOW_EFFECTIVE_TIME');
  return input;
}

export const FORM_DRAFT_SUBMIT_DEMO_CAPABILITY:Capability={
  id:'form.draft-submit.demo',effect:'write_external',route:'playwright.owned.taskpack.v1',environments:['owned_headless'],hiddenVerified:false,
  requiresForeground:false,requiresOsInput:false,usesUserTarget:false,requiresClipboard:false,requiresFileDialog:false,verification:'independent_readback',
};
export const FORM_DRAFT_SUBMIT_DEMO_PACK:TaskPackManifest=taskPackManifest.parse({
  id:'form.draft-submit.demo.v1',version:1,adapter_id:'demo.synthetic.form.browser.v1',effect:'write_external',
  input_fields:[
    {name:'request_id',required:true,description:'Stable request identity.'},{name:'subject',required:true,description:'Short change subject.'},
    {name:'effective_at',required:true,description:'When the change begins.'},{name:'follow_up_at',required:true,description:'When the follow-up begins.'},
    {name:'notes',required:true,description:'Bounded explanatory note.'},
  ],
  observation:{logged_in_signal:'pack-owned synthetic signed-in marker',independent_readback:'separate synthetic record GET'},
  time_constraints:['follow-up time is later than effective time'],
  popup_policy:{known_dismissible:['workspace-tip'],unknown_action:'hold',security_action:'hold'},
  approval:{required:'per_external_write',binds:['task','caller','pack','adapter','normalized_input','form_snapshot','generation'],token:'single_use_expiring'},
});

type DemoState={knownModal:boolean;records:Map<string,FormDraftSubmitInput>;effects:FormDraftSubmitInput[];};
async function requestBody(request:IncomingMessage){const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
function reply(response:ServerResponse,status:number,value:unknown){response.writeHead(status,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));}
function demoPage(state:DemoState){
  const notice=state.knownModal?`<section class="notice" role="dialog" data-popup="workspace-tip" aria-label="Workspace notice"><div><strong>새 알림</strong><p>이 작업과 관계없는 안내입니다.</p></div><button data-dismiss="workspace-tip">닫기</button></section>`:'';
  const noticeStatus=state.knownModal?'대기 중':'정리 완료';
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Driver · Synthetic Demo Portal</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font:16px/1.45 Inter,"Noto Sans KR",Arial,sans-serif}.shell{width:1280px;min-height:720px;margin:0 auto;padding:32px 44px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:26px}.brand{font-weight:760;font-size:23px;letter-spacing:-.4px}.brand b{color:#1f6feb}.fixture{color:#52627b;font-size:13px;border:1px solid #cdd9eb;border-radius:999px;background:#fff;padding:8px 12px}.hero{display:flex;justify-content:space-between;align-items:end;margin-bottom:20px}.hero h1{font-size:32px;letter-spacing:-1px;margin:0}.hero p{margin:7px 0 0;color:#5b6880}.layout{display:grid;grid-template-columns:1.75fr 1fr;gap:22px}.card{background:#fff;border:1px solid #dae3f0;border-radius:16px;box-shadow:0 7px 18px rgba(31,52,86,.06)}.form-card{padding:26px}.panel{padding:24px}.card h2{font-size:18px;margin:0 0 18px}.field{display:grid;grid-template-columns:145px 1fr;gap:15px;align-items:center;margin:11px 0}.field label{font-size:14px;color:#53627a}.field input,.field textarea{width:100%;border:1px solid #cbd7e9;border-radius:8px;padding:10px 12px;color:#172033;background:#fbfdff;font:inherit}.field textarea{height:78px;resize:none}.meta{font-size:12px;color:#75829a;margin:16px 0 18px;padding-top:15px;border-top:1px solid #e8eef6}.submit-row{display:flex;justify-content:space-between;align-items:center}.approval{font-size:13px;color:#a95a00;background:#fff6df;border-radius:8px;padding:8px 10px}.submit{border:0;border-radius:8px;background:#1f6feb;color:#fff;font-weight:700;padding:11px 18px;font:inherit}.status{display:flex;gap:10px;align-items:center;margin:14px 0;padding:11px 12px;border-radius:9px;background:#f6f9fd;font-size:14px}.dot{width:9px;height:9px;border-radius:50%;background:#31a36b}.waiting .dot{background:#e6a43b}.timeline{display:grid;gap:16px;margin-top:10px}.event{display:grid;grid-template-columns:24px 1fr;gap:10px}.event .mark{border:2px solid #94bdf5;border-radius:50%;height:18px;width:18px;margin-top:3px}.event strong{display:block;font-size:14px}.event span{font-size:13px;color:#66748b}.notice{position:fixed;z-index:3;top:24px;right:32px;display:flex;align-items:center;gap:28px;min-width:390px;padding:16px 18px;border:1px solid #b9caf0;border-radius:12px;background:#fff;box-shadow:0 14px 32px rgba(23,56,107,.19)}.notice p{margin:3px 0 0;color:#63708a;font-size:13px}.notice button{border:1px solid #b5c8e9;background:#f7faff;border-radius:7px;padding:8px 14px;color:#245eb7;font:inherit}.footer{margin-top:18px;color:#6d7b92;font-size:12px;text-align:center}
</style><body><main class="shell"><header class="top"><div class="brand">Agent Driver <span>·</span> Demo Portal</div><div class="fixture">SYNTHETIC FIXTURE · EXTERNAL EFFECTS: 0</div></header><section class="hero"><div><h1>변경 보고서 초안</h1><p>자동화가 양식을 확인하고, 제출 직전 사람의 승인을 기다립니다.</p></div><div class="fixture">Pack: form.draft-submit</div></section><section class="layout"><article class="card form-card"><h2>변경 내용</h2><form id="change-form"><div class="field"><label for="request-id">요청 번호</label><input id="request-id" data-field="request_id"></div><div class="field"><label for="subject">제목</label><input id="subject" data-field="subject"></div><div class="field"><label for="effective-at">시작 시각</label><input id="effective-at" data-field="effective_at"></div><div class="field"><label for="follow-up-at">후속 시각</label><input id="follow-up-at" data-field="follow_up_at"></div><div class="field"><label for="notes">내용</label><textarea id="notes" data-field="notes"></textarea></div></form><div class="meta" id="form-ready">필수 항목을 확인하는 중입니다.</div><div class="submit-row"><span class="approval">사람 승인 필요</span><button class="submit" id="submit" type="button">제출</button></div><output id="submit-state" data-ready="false"></output></article><aside class="card panel"><h2>에이전트 활동</h2><div class="status"><span class="dot"></span><span>Agent Computer 연결됨</span></div><div class="timeline"><div class="event"><i class="mark"></i><div><strong>알려진 팝업 확인</strong><span id="notice-status">${noticeStatus}</span></div></div><div class="event"><i class="mark"></i><div><strong>양식 입력 및 검증</strong><span>입력값과 시간 제약을 확인합니다.</span></div></div><div class="event"><i class="mark"></i><div><strong>제출 전 증거 캡처</strong><span>변경된 양식의 스냅샷을 남깁니다.</span></div></div><div class="event"><i class="mark"></i><div><strong>작업 단위 승인 대기</strong><span>승인 전에는 어떤 제출도 실행하지 않습니다.</span></div></div></div></aside></section><p class="footer">로컬 합성 환경에서 실행한 데모입니다. 실제 고객 사이트·계정·외부 제출과 무관합니다.</p></main>${notice}<script>
const fields=[...document.querySelectorAll('[data-field]')];const ready=()=>fields.every(field=>field.value.length>0);for(const field of fields)field.addEventListener('input',()=>{if(ready())document.querySelector('#form-ready').textContent='입력 확인 완료 · 제출 권한 대기'});document.querySelector('[data-dismiss="workspace-tip"]')?.addEventListener('click',async()=>{await fetch('api/dismiss',{method:'POST'});location.reload()});document.querySelector('#submit').addEventListener('click',async()=>{const value=Object.fromEntries(fields.map(field=>[field.dataset.field,field.value]));const response=await fetch('api/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});document.querySelector('#submit-state').dataset.ready=response.ok?'true':'error'});
</script></body></html>`;
}

export async function startSyntheticFormDraftSubmitSite(){
  const state:DemoState={knownModal:true,records:new Map(),effects:[]};
  const server=createServer((request,response)=>{void(async()=>{const path=new URL(request.url??'/','http://synthetic').pathname;
    if(path==='/agent-demo/'&&request.method==='GET'){response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(demoPage(state));return;}
    if(path==='/agent-demo/api/dismiss'&&request.method==='POST'){state.knownModal=false;reply(response,200,{dismissed:'workspace-tip'});return;}
    if(path==='/agent-demo/api/submit'&&request.method==='POST'){const record=normalizeFormDraftSubmit(await requestBody(request));state.records.set(record.request_id,record);state.effects.push(record);reply(response,200,{request_id:record.request_id});return;}
    if(path==='/agent-demo/api/readback'&&request.method==='GET'){const id=new URL(request.url??'/','http://synthetic').searchParams.get('request_id');reply(response,200,id===null?null:state.records.get(id)??null);return;}
    reply(response,404,{error:'not_found'});
  })().catch(()=>{if(!response.headersSent)reply(response,500,{error:'fixture_error'});else response.destroy();});});
  await new Promise<void>(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
  const baseUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {baseUrl,url:`${baseUrl}/agent-demo/`,snapshot:()=>({effects:[...state.effects],records:[...state.records.values()],known_modal:state.knownModal}),async close(){server.closeAllConnections();await new Promise<void>((resolveClose,reject)=>server.close(error=>error===undefined?resolveClose():reject(error)));}};
}

export class SyntheticFormDraftSubmitBrowserAdapter implements ApprovedBrowserAdapter<FormDraftSubmitInput> {
  readonly adapterId='demo.synthetic.form.browser.v1';
  #owned:OwnedPersistentPage|undefined;#binding:{taskId:string;lease:Lease;targetRef:string}|undefined;#input:FormDraftSubmitInput|undefined;#videoPath:string|undefined;
  constructor(readonly url:string,readonly profileDir:string,readonly captureRoot:string,readonly videoRoot?:string){}
  bind(binding:{taskId:string;lease:Lease;targetRef:string}){this.#binding=binding;}
  get videoPath(){return this.#videoPath;}
  async observe():Promise<Observation>{
    requireCondition(this.#binding,'ADAPTER_NOT_BOUND');const origin=new URL(this.url).origin;
    const state=this.#owned===undefined?null:await this.#owned.page.evaluate(()=>({account:document.querySelector('#account')?.textContent,visibility:document.visibilityState,origin:location.origin}));
    return {targetRef:this.#binding.targetRef,targetExists:state!==null,ownerTaskId:this.#binding.taskId,projectId:this.#binding.lease.projectId,profileRef:this.profileDir,accountRef:'synthetic-demo-account',origin:state?.origin??origin,generation:this.#binding.lease.generation,observedMonoMs:performance.now(),visibility:state?.visibility==='hidden'?'hidden':'visible',environment:'owned_headless'};
  }
  async prepare(value:FormDraftSubmitInput):Promise<BrowserPreparation>{
    requireCondition(this.#binding,'ADAPTER_NOT_BOUND');this.#input=normalizeFormDraftSubmit(value);
    this.#owned=new OwnedPersistentPage(this.profileDir,this.captureRoot,true,this.videoRoot===undefined?{}:{recordVideoDir:this.videoRoot,recordVideoSize:{width:1280,height:720}});
    const origin=new URL(this.url).origin;
    const opened=await this.#owned.open(this.#binding.taskId,{url:this.url,allowed_origins:[origin],logged_in:'.brand',authentication_request:'#authentication-request',known_popups:[],unknown_dialog:'[data-popup="unknown"]'});
    if(opened.gate!=='ready'){requireCondition(typeof opened.capture_ref==='string','HOLD_CAPTURE_REQUIRED');return {gate:opened.gate,snapshot:{gate:opened.gate},capture_ref:opened.capture_ref,detail:{closed_popups:opened.closed_popups}};}
    const page=this.#owned.page;
    // Deliberately visible only in the local promotional fixture: it lets the
    // recorded browser show that a reviewed known popup is cleared, not ignored.
    const knownPopup=page.locator('[data-popup="workspace-tip"]');let dismissedKnown=false;
    if(await knownPopup.isVisible().catch(()=>false)){
      await page.waitForTimeout(550);await page.locator('[data-dismiss="workspace-tip"]').click();await knownPopup.waitFor({state:'hidden'});dismissedKnown=true;
    }
    const fields:Record<string,string>={request_id:this.#input.request_id,subject:this.#input.subject,effective_at:this.#input.effective_at,follow_up_at:this.#input.follow_up_at,notes:this.#input.notes};
    for(const [field,value] of Object.entries(fields)){await page.locator(`[data-field="${field}"]`).fill(value);await page.waitForTimeout(110);}
    await page.waitForFunction(()=>document.querySelector('#form-ready')?.textContent?.includes('입력 확인 완료')===true);
    await page.waitForTimeout(500);
    const capture=await this.#owned.capture(this.#binding.taskId),snapshot={account_ref:'synthetic-demo-account',origin,form:fields,pack_id:FORM_DRAFT_SUBMIT_DEMO_PACK.id,adapter_id:this.adapterId};
    return {gate:'ready',snapshot,capture_ref:capture.capture_ref,detail:{closed_popups:dismissedKnown?['workspace-tip']:[],capture_sha256:capture.capture_sha256,snapshot_hash:snapshotHash(snapshot),fixture:'synthetic_loopback'}};
  }
  async execute(){requireCondition(this.#owned&&this.#input,'ADAPTER_NOT_PREPARED');await this.#owned.page.locator('#submit').click();await this.#owned.page.waitForFunction(()=>['true','error'].includes(document.querySelector('#submit-state')?.getAttribute('data-ready')??''));requireCondition(await this.#owned.page.locator('#submit-state').getAttribute('data-ready')==='true','SYNTHETIC_SUBMIT_RESPONSE_UNKNOWN');}
  async verify():Promise<Verification>{
    requireCondition(this.#owned&&this.#input&&this.#binding,'ADAPTER_NOT_PREPARED');const response=await this.#owned.page.context().request.get(`${this.url}api/readback?request_id=${encodeURIComponent(this.#input.request_id)}`);requireCondition(response.ok(),'SYNTHETIC_READBACK_FAILED');const received=await response.json();
    return {result:JSON.stringify(received)===JSON.stringify(this.#input)?'MATCH':'NOT_MATCH',source:'synthetic_independent_form_readback',accountRef:'synthetic-demo-account',targetRef:this.#binding.targetRef,generation:this.#binding.lease.generation,observedMonoMs:performance.now(),detail:{request_id:this.#input.request_id}};
  }
  async close(){if(this.#owned!==undefined){await this.#owned.close();this.#videoPath=this.#owned.videoPath;}this.#owned=undefined;}
}

export interface FormDraftSubmitDemoReceipt {format:1;kind:'synthetic_form_draft_submit_demo';status:'waiting_approval';effects:0;video:string;capture:string;automation:{agent_owned_browser:true;known_popup_dismissed:true;form_fields_verified:true;external_submit:false;};timing:readonly {stage:string;executor:string;elapsed_ms:number}[];disclosure:string;}
export async function renderFormDraftSubmitDemo(outputDir:string){
  const output=resolve(outputDir),runtimeRoot=await mkdtemp(join(tmpdir(),'agent-driver-form-demo-')),site=await startSyntheticFormDraftSubmitSite(),store=new RuntimeStore(join(runtimeRoot,'runtime.sqlite'));
  try {
    await mkdir(output,{recursive:true,mode:0o700});
    const project={id:'form-demo-project',callerRef:'form-demo-caller',worktree:runtimeRoot,profileRef:join(runtimeRoot,'profile'),accountRef:'synthetic-demo-account',allowedOrigins:[site.baseUrl],capabilities:[FORM_DRAFT_SUBMIT_DEMO_CAPABILITY.id]};store.registerProject(project);
    const adapter=new SyntheticFormDraftSubmitBrowserAdapter(site.url,project.profileRef,join(runtimeRoot,'captures'),join(runtimeRoot,'video'));
    const protocol=new ApprovedBrowserProtocol(store,FORM_DRAFT_SUBMIT_DEMO_PACK,FORM_DRAFT_SUBMIT_DEMO_CAPABILITY,adapter);
    const prepared=await protocol.prepare(project.id,project.callerRef,FORM_DRAFT_SUBMIT_DEMO_INPUT);
    requireCondition('approval_token' in prepared,'DEMO_APPROVAL_NOT_REQUESTED');requireCondition(store.task(prepared.task_id).status==='waiting_approval','DEMO_NOT_WAITING_APPROVAL');requireCondition(site.snapshot().effects.length===0,'DEMO_EXTERNAL_EFFECT_FORBIDDEN');
    requireCondition(typeof adapter.videoPath==='string','DEMO_VIDEO_NOT_CAPTURED');
    const videoName='agent-driver-form-draft-demo.webm',captureName='agent-driver-form-draft-final.png';await copyFile(adapter.videoPath,join(output,videoName));await copyFile(prepared.capture_ref,join(output,captureName));
    const receipt:FormDraftSubmitDemoReceipt={format:1,kind:'synthetic_form_draft_submit_demo',status:'waiting_approval',effects:0,video:videoName,capture:captureName,automation:{agent_owned_browser:true,known_popup_dismissed:true,form_fields_verified:true,external_submit:false},timing:prepared.timing,disclosure:'Synthetic loopback fixture only. No customer site, account, remote model provider, or external submission was used.'};
    await writeFile(join(output,'receipt.json'),`${JSON.stringify(receipt,null,2)}\n`,'utf8');return {output,receipt};
  } finally {store.close();await site.close();await rm(runtimeRoot,{recursive:true,force:true});}
}
