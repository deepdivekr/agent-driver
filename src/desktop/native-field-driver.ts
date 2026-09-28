import {randomUUID} from 'node:crypto';
import {type DatabaseSync} from 'node:sqlite';
import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {assertDesktopText,type DesktopObservation} from './windows-decision.js';
import {type WindowsCommand,type WindowsJob,type WindowsWorkflowDriver} from './windows-runtime.js';

/** Backend-neutral field port. No Codex or computer-use host is required. */
export interface NativeWindow {id:number;app:string;title?:string;}
export interface NativeField {index:number;automation_id:string;label:string;value:string|null;enabled:boolean;visible:boolean;token?:string;}
export interface NativeFieldState {window:NativeWindow;field:NativeField;focus:string|null;identity?:string;}
export type NativeReadPurpose='observe'|'pre_input'|'readback'|'reconcile';
export interface NativeFieldClient {
  readField(scope:NativeFieldScope,purpose?:NativeReadPurpose):Promise<NativeFieldState>;
  setValue(state:NativeFieldState,value:string):Promise<void>;
}
export interface NativeFieldScope {
  work_id:string;window:NativeWindow;window_title:string;automation_id:string;
  label:string;request_field:string;expires_at_ms:number;
  local_draft_only:true;auto_submits:false;sensitive:false;
}
interface Capture {job:WindowsJob;state:NativeFieldState;field:NativeField;observation:DesktopObservation;stamp:string;}
interface ActionRecord {command_hash:string;binding:string;work_id:string;window_ref:string;target_id:string;before_stamp:string;after_value_hash:string;outcome:'claimed'|'performed'|'not_performed';}
const denyApp=/(?:kakaotalk|outlook|teams|slack|discord|telegram|whatsapp|chrome|firefox|msedge|browseros|browserclaw|codex|chatgpt|powershell|pwsh|cmd\.exe|windowsterminal|conhost|lockapp|logonui|credential|1password|bitwarden|keepass|securityhealth|msmpeng)/iu;
const denyField=/(?:password|passcode|one.?time|otp|credential|api.?key|secret|비밀번호|인증번호|보안|암호)/iu;
const ref=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const stateHash=(observation:DesktopObservation)=>{const {capture_id:_,captured_at_ms:__,...rest}=observation;return snapshotHash(rest);};
const commandHash=(c:WindowsCommand)=>{const {capture_id:_,action_id:__,...intent}=c;return snapshotHash(intent);};

/** Native adapter for one reviewed local form field. It intentionally does not
 * advertise Kakao, authentication, shell, arbitrary coordinates or all-app
 * support. Other applications need their own independently verified profile. */
export class NativeFieldDriver implements WindowsWorkflowDriver {
  readonly id:string;
  private connected=true;
  private scopes=new Map<string,NativeFieldScope>();
  private captures=new Map<string,Capture>();
  private reviews=new Map<string,{command:WindowsCommand;stamp:string;expires:number;approved:boolean}>();
  private inFlight=new Set<string>();
  constructor(readonly client:NativeFieldClient,readonly db:DatabaseSync,id:string){
    requireCondition(ref(id),'NATIVE_FIELD_DRIVER_ID_INVALID');this.id=id;
    db.exec('CREATE TABLE IF NOT EXISTS windows_native_action(driver_id TEXT NOT NULL,action_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(driver_id,action_id));');
  }
  availability(){return {connected:this.connected,supported_workflows:['windows.form.draft'],reason:this.connected?'HOST_NATIVE_FIELD_CONNECTED':'NATIVE_FIELD_DISCONNECTED'};}
  bind(scope:NativeFieldScope){
    requireCondition(this.connected,'NATIVE_FIELD_DISCONNECTED');
    requireCondition(scope.local_draft_only===true&&scope.auto_submits===false&&scope.sensitive===false,'NATIVE_FIELD_REVIEWED_LOCAL_FIELD_REQUIRED');
    requireCondition(Number.isSafeInteger(scope.window.id)&&scope.window.id>0&&scope.window.app.length>0&&!denyApp.test(scope.window.app),'NATIVE_FIELD_APPLICATION_FORBIDDEN');
    requireCondition(scope.window_title.length>0&&scope.label.length>0&&scope.label.length<=160&&scope.automation_id.length>0&&!/[\r\n]/u.test(scope.automation_id+scope.label),'NATIVE_FIELD_FIELD_SCOPE_INVALID');
    requireCondition(!denyField.test(scope.label+' '+scope.window_title+' '+scope.request_field),'NATIVE_FIELD_SENSITIVE_FIELD');
    requireCondition(scope.expires_at_ms>Date.now()&&scope.expires_at_ms<=Date.now()+30*60_000,'NATIVE_FIELD_SCOPE_EXPIRY_INVALID');
    assertDesktopText(scope.label);this.scopes.set(scope.work_id,structuredClone(scope));this.reviews.clear();this.captures.clear();
  }
  revoke(workId:string){this.scopes.delete(workId);this.reviews.clear();this.captures.clear();}
  disconnect(){this.connected=false;this.scopes.clear();this.reviews.clear();this.captures.clear();}
  private scope(job:WindowsJob){
    requireCondition(this.connected,'NATIVE_FIELD_DISCONNECTED');
    requireCondition(job.workflow_id==='windows.form.draft','NATIVE_FIELD_WORKFLOW_UNSUPPORTED');
    const scope=this.scopes.get(job.work_id);requireCondition(scope&&scope.expires_at_ms>Date.now(),'NATIVE_FIELD_SCOPE_REQUIRED');
    requireCondition(job.inputs.field===scope.request_field,'NATIVE_FIELD_FIELD_INTENT_MISMATCH');
    requireCondition(typeof job.inputs.value==='string'&&job.inputs.value.length>0&&job.inputs.value.length<=512&&!/[\r\n\t\x00-\x1f\x7f]/u.test(job.inputs.value),'NATIVE_FIELD_SINGLE_LINE_VALUE_REQUIRED');
    assertDesktopText(job.inputs.value);return scope;
  }
  private windowRef(window:NativeWindow){return 'window:'+snapshotHash({id:window.id,app:window.app}).slice(0,32);}
  private targetId(scope:NativeFieldScope){return 'field:'+snapshotHash({id:scope.automation_id,label:scope.label}).slice(0,32);}
  private record(actionId:string):ActionRecord|null {const row=this.db.prepare('SELECT body FROM windows_native_action WHERE driver_id=? AND action_id=?').get(this.id,actionId);return row?JSON.parse(String(row.body)) as ActionRecord:null;}
  private save(actionId:string,record:ActionRecord){this.db.prepare('INSERT INTO windows_native_action VALUES(?,?,?) ON CONFLICT(driver_id,action_id) DO UPDATE SET body=excluded.body').run(this.id,actionId,JSON.stringify(record));}
  private async capture(job:WindowsJob,purpose:NativeReadPurpose='observe'):Promise<Capture>{
    const scope=this.scope(job),state=await this.client.readField(scope,purpose);
    this.scope(job);
    requireCondition(state.window.id===scope.window.id&&state.window.app===scope.window.app&&state.window.title===scope.window_title,'NATIVE_FIELD_CAPTURE_WINDOW_MISMATCH');
    const field=state.field;
    requireCondition(field.automation_id===scope.automation_id&&field.label===scope.label,'NATIVE_FIELD_IDENTITY_MISMATCH');
    const stamp=snapshotHash({window:state.window,index:field.index,id:field.automation_id,label:field.label,value_hash:field.value===null?null:snapshotHash(field.value),enabled:field.enabled,visible:field.visible,focus:state.focus,...(state.identity?{identity:state.identity}:{})});
    const observation:DesktopObservation={capture_id:randomUUID(),window_ref:this.windowRef(state.window),application:'host-registered',captured_at_ms:Date.now(),screen:'workspace',recipient:'unknown',recipient_evidence:[],
      controls:field.enabled&&field.visible?[{id:this.targetId(scope),label:scope.label,role:'edit',enabled:true,visible:true,sensitive:false}]:[],
      facts:[{key:'native_field_state',evidence_ref:'field-state:'+stamp,binding_sha256:job.binding_sha256,action_id:null}]};
    if(field.value===job.inputs.value){
      const rows=this.db.prepare('SELECT action_id,body FROM windows_native_action WHERE driver_id=? ORDER BY rowid DESC LIMIT 50').all(this.id);
      const own=rows.find(row=>{const r=JSON.parse(String(row.body)) as ActionRecord;return r.outcome==='performed'&&r.binding===job.binding_sha256&&r.work_id===job.work_id&&r.window_ref===observation.window_ref&&r.target_id===observation.controls[0]?.id&&r.after_value_hash===snapshotHash(field.value);});
      observation.facts.push({key:'form_field_matches',evidence_ref:'value-sha:'+snapshotHash(field.value),binding_sha256:job.binding_sha256,action_id:own?String(own.action_id):null});
    }
    const captured={job:structuredClone(job),state,field,observation,stamp};this.captures.set(job.run_id,captured);return captured;
  }
  async observe(job:WindowsJob){
    const previous=this.captures.get(job.run_id);
    const rows=previous?this.db.prepare('SELECT body FROM windows_native_action WHERE driver_id=? ORDER BY rowid DESC LIMIT 20').all(this.id):[];
    const performed=rows.some(row=>{const r=JSON.parse(String(row.body)) as ActionRecord;return r.binding===job.binding_sha256&&r.work_id===job.work_id&&r.outcome==='performed';});
    return (await this.capture(job,performed?'readback':'observe')).observation;
  }
  private validate(command:WindowsCommand,capture:Capture){
    this.scope(capture.job);
    requireCondition(command.effect==='local_draft'&&command.action==='replace_text'&&command.step_id==='field','NATIVE_FIELD_EFFECT_FORBIDDEN');
    requireCondition(command.work_id===capture.job.work_id&&command.run_id===capture.job.run_id&&command.workflow_id===capture.job.workflow_id&&command.binding_sha256===capture.job.binding_sha256&&command.text===capture.job.inputs.value,'NATIVE_FIELD_COMMAND_BINDING_MISMATCH');
    requireCondition(command.application===capture.observation.application&&command.window_ref===capture.observation.window_ref&&command.target_id===capture.observation.controls[0]?.id&&command.observation_sha256===stateHash(capture.observation),'NATIVE_FIELD_TARGET_CHANGED');
    requireCondition(Date.now()-capture.observation.captured_at_ms<=15_000,'NATIVE_FIELD_CAPTURE_STALE');
  }
  async authorize(command:WindowsCommand){
    const capture=this.captures.get(command.run_id);requireCondition(capture,'NATIVE_FIELD_CAPTURE_REQUIRED');this.validate(command,capture);
    const key=commandHash(command),review=this.reviews.get(key);
    if(review?.approved&&review.expires>Date.now()&&review.stamp===capture.stamp)return true;
    this.reviews.set(key,{command:structuredClone(command),stamp:capture.stamp,expires:Date.now()+60_000,approved:false});return false;
  }
  /** Local host-only review, never an MCP approval tool. The caller must have
   * actual authority for this exact draft; no external-send permit exists. */
  pendingReviews(){return [...this.reviews].filter(([,v])=>!v.approved&&v.expires>Date.now()).map(([review_id,v])=>({review_id,work_id:v.command.work_id,run_id:v.command.run_id,window_ref:v.command.window_ref,target_id:v.command.target_id,effect:v.command.effect,text:v.command.text,expires_at_ms:v.expires}));}
  approveLocalDraft(reviewId:string){const review=this.reviews.get(reviewId);requireCondition(this.connected&&review&&review.expires>Date.now(),'NATIVE_FIELD_REVIEW_EXPIRED');review.approved=true;}
  async act(command:WindowsCommand){
    requireCondition(!this.inFlight.size,'NATIVE_FIELD_FOREGROUND_BUSY');
    const capture=this.captures.get(command.run_id);requireCondition(capture,'NATIVE_FIELD_CAPTURE_REQUIRED');this.validate(command,capture);
    requireCondition(command.capture_id===capture.observation.capture_id,'NATIVE_FIELD_CAPTURE_CHANGED');
    requireCondition(!this.record(command.action_id),'NATIVE_FIELD_ACTION_ALREADY_CLAIMED');
    const key=commandHash(command),review=this.reviews.get(key);requireCondition(review?.approved&&review.expires>Date.now()&&review.stamp===capture.stamp,'NATIVE_FIELD_APPROVAL_REQUIRED');
    this.reviews.delete(key);this.inFlight.add(command.action_id);
    const record:ActionRecord={command_hash:key,binding:command.binding_sha256,work_id:command.work_id,window_ref:command.window_ref,target_id:command.target_id,before_stamp:capture.stamp,after_value_hash:snapshotHash(command.text),outcome:'claimed'};
    let dispatched=false;
    try{
      const fresh=await this.capture(capture.job,'pre_input');this.validate(command,fresh);requireCondition(fresh.stamp===capture.stamp,'NATIVE_FIELD_STATE_CHANGED');
      this.save(command.action_id,record);
      dispatched=true;
      await this.client.setValue(fresh.state,command.text!);
      // A setter return only records dispatch. Runtime performs an independent
      // readback before completing the step; no receipt claims Work success.
      record.outcome='performed';this.save(command.action_id,record);
      return {action_id:command.action_id,capture_id:command.capture_id,window_ref:command.window_ref,target_id:command.target_id,outcome:'performed'};
    }catch(error){if(!dispatched){record.outcome='not_performed';this.save(command.action_id,record);}throw error;}
    finally{this.inFlight.delete(command.action_id);}
  }
  async reconcile(job:WindowsJob,command:WindowsCommand){
    const record=this.record(command.action_id);const base={action_id:command.action_id,binding_sha256:command.binding_sha256,quiescent:!this.inFlight.has(command.action_id),evidence_ref:'native-action:'+command.action_id};
    if(!record||record.command_hash!==commandHash(command)||record.binding!==job.binding_sha256||record.work_id!==job.work_id||!base.quiescent||record.outcome==='claimed')return {...base,outcome:'unknown'};
    if(record.outcome==='not_performed')return {...base,outcome:'not_performed'};
    const observed=await this.capture(job,'reconcile');
    if(!observed.observation.facts.some(f=>f.key==='form_field_matches'&&f.action_id===command.action_id))return {...base,outcome:'unknown'};
    return {...base,outcome:'performed',observation:observed.observation};
  }
}
