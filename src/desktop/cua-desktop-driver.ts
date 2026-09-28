import {randomUUID} from 'node:crypto';
import {type DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type WindowsCommand,type WindowsJob,type WindowsWorkflowDriver} from './windows-runtime.js';
import {type DesktopObservation,assertDesktopText,selectableDesktopControl,sameDesktopLabel} from './windows-decision.js';
import {type DesktopCheck,type DesktopPlanningSnapshot} from './work-procedure.js';
import {windowsDesktopCuaConfigSchema,type WindowsDesktopCuaConfig} from './cua-contracts.js';
import {OwnedCuaConnection,type CuaDesktopTool} from './cua-connection.js';
import {decodeCuaFieldValue} from './cua-field-driver.js';
import {captureRecoveryError} from './window-recovery.js';
import {OwnedWindowsVisualReader,type WindowsVisualReader,type VisualBounds,assertVisualBounds,visualBoundsSchema} from './windows-visual.js';

export interface DesktopCuaPort {call(name:CuaDesktopTool,args:Record<string,unknown>):Promise<unknown>;takeScreenshot?():Buffer|null;close():Promise<void>;connected():boolean;}
type WindowScope=WindowsDesktopCuaConfig['grants'][number]['windows'][number];
const rawSchema=z.object({
  pid:z.number().int(),window_id:z.number().int(),app_name:z.string(),window_title:z.string(),
  snapshot_id:z.string().regex(/^s[0-9a-f]{8}$/u),truncated:z.boolean(),
  window_bounds:z.object({x:z.number(),y:z.number(),width:z.number().positive(),height:z.number().positive()}),
  elements:z.array(z.object({element_index:z.number().int().nonnegative(),element_token:z.string(),role:z.string(),
    label:z.string(),value:z.string().optional(),enabled:z.boolean(),actions:z.array(z.string()),
    parent_index:z.number().int().nonnegative().optional(),selected:z.boolean().optional(),
    is_password:z.boolean().optional(),sensitive:z.boolean().optional(),
    frame:z.object({x:z.number(),y:z.number(),w:z.number(),h:z.number()}),
  })).max(256),
});
type Row=DesktopObservation['controls'][number]&{token:string;value:string|null;actions:string[];bounds?:VisualBounds};
type ReadMode='auto'|'hybrid'|'visual';
interface Snapshot {scope:WindowScope;rows:Row[];stamp:string;at:number;mode:ReadMode;image?:{capture_id:string;sha256:string;width:number;height:number};}
interface Capture {job:WindowsJob;snapshot:Snapshot;observation:DesktopObservation;}
const roles:Record<string,Row['role']>={Button:'button',CheckBox:'checkbox',Edit:'edit',Document:'document',MenuItem:'menu_item',ListItem:'list_item',TabItem:'tab_item'};
const secretLabel=/(?:password|passcode|one.?time|otp|credential|api.?key|secret|비밀번호|인증번호|보안|암호)/iu;
const screenSchema=z.object({pid:z.number().int().positive(),window_id:z.number().int().positive(),app_name:z.string(),window_title:z.string(),
  capture_id:z.string().min(1).max(200),screenshot_width:z.number().int().positive(),screenshot_height:z.number().int().positive(),
  window_bounds:z.object({x:z.number(),y:z.number(),width:z.number().positive(),height:z.number().positive()}),
  screenshot_frame_valid:z.boolean().optional(),degraded:z.boolean().optional(),screenshot_scale:z.number().positive().optional(),
});
function visualCapture(value:unknown){
  const error=z.object({screenshot_error:z.string().optional()}).passthrough().safeParse(value);
  if(error.success&&error.data.screenshot_error){
    // Classify without leaking native diagnostics or inventing an empty image.
    // The outer read operation owns the explicit foreground recovery permission.
    requireCondition(!/cannot capture minimized window\b/iu.test(error.data.screenshot_error),'CUA_VISUAL_WINDOW_MINIMIZED');
    requireCondition(false,'CUA_VISUAL_CAPTURE_UNAVAILABLE');
  }
  const parsed=screenSchema.safeParse(value);requireCondition(parsed.success,'CUA_VISUAL_CAPTURE_UNAVAILABLE');return parsed.data;
}
/** Application-neutral UIA/CUA execution. The planner supplies a typed
 * procedure; it cannot mint facts, call arbitrary tools or authorize an effect.
 * UIA gaps use fresh window-bound OCR candidates. OCR does not imply interactivity
 * or enabled state, and cannot prove typing, file writes or message delivery.
 * Unsupported icon-only screens return reobserve/replan. Values/pixels stay local. */
export class CuaDesktopDriver implements WindowsWorkflowDriver {
  readonly config:WindowsDesktopCuaConfig;
  readonly id:string;
  private captures=new Map<string,Capture>();
  private approval=new Map<string,{hash:string;at:number}>();
  private stopped=false;
  private reading:Promise<unknown>=Promise.resolve();
  private generations=new Map<string,number>();
  readonly counters={observations:0,planning_reads:0,verified_target_hits:0,planned_exact_hits:0,actions:0,window_restore_attempts:0,window_restores:0,window_restore_elapsed_ms:0,visual_captures:0,visual_full_reads:0,visual_region_reads:0,visual_reused_reads:0,visual_processed_pixels:0,visual_elapsed_ms:0};
  constructor(config:WindowsDesktopCuaConfig,readonly db:DatabaseSync,readonly port:DesktopCuaPort=new OwnedCuaConnection(config,'desktop'),
    private readonly confirmEffect?:(command:WindowsCommand)=>Promise<boolean>,private readonly visual:WindowsVisualReader=new OwnedWindowsVisualReader()){
    this.config=windowsDesktopCuaConfigSchema.parse(config);this.id='cua-desktop:'+snapshotHash(this.config).slice(0,32);
    requireCondition(new Set(this.config.grants.map(g=>g.work_id)).size===this.config.grants.length,'CUA_DUPLICATE_WORK_SCOPE');
    for(const grant of this.config.grants)requireCondition(new Set(grant.windows.map(w=>w.ref)).size===grant.windows.length,'CUA_DUPLICATE_WINDOW_REF');
    db.exec('CREATE TABLE IF NOT EXISTS cua_desktop_effect(action_id TEXT PRIMARY KEY,driver_id TEXT NOT NULL,command_hash TEXT NOT NULL,binding TEXT NOT NULL,status TEXT NOT NULL,before_counts TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cua_desktop_target(scope TEXT PRIMARY KEY,body TEXT NOT NULL,verified_at INTEGER NOT NULL);');
    db.exec('CREATE TABLE IF NOT EXISTS cua_window_recovery(scope TEXT PRIMARY KEY,attempted_at INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,elapsed_ms INTEGER);');
  }
  availability(){return {connected:this.port.connected(),supported_workflows:[],reason:this.port.connected()?'CUA_GENERIC_CONNECTED':'CUA_GENERIC_CONNECT_ON_OBSERVATION'};}
  diagnostics(){return {provider:'cua-driver',ownership:'agent-office-child',scope:'work-authorized-windows',application_specific_adapter:false,canvas_fallback:'local_windows_ocr_navigation',visual_limitations:['text_required','enabled_and_interactivity_unobserved','no_visual_typing_or_external_effects'],capture_scope:'current_whole_window',extraction_scope:'changed_region_or_full',recovery_scope:'read_failure_then_authorized_visibility_recovery',recovery_limits:['no_automatic_app_restart','no_unscoped_modal_dismissal','no_recovery_during_uncertain_effect'],recent_recovery:this.db.prepare('SELECT attempted_at,status,reason,elapsed_ms FROM cua_window_recovery ORDER BY attempted_at DESC LIMIT 8').all(),retained_observations:this.captures.size,pending_approvals:this.approval.size,...this.counters};}
  private grant(workId:string){requireCondition(!this.stopped,'CUA_CONNECTION_CLOSED');const grant=this.config.grants.find(g=>g.work_id===workId);requireCondition(grant&&grant.expires_at_ms>Date.now(),'CUA_WORK_SCOPE_REQUIRED');return grant;}
  private application(scope:WindowScope){return 'app-'+snapshotHash(scope.app_name.toLowerCase()).slice(0,24);}
  private contract(job:WindowsJob){const step=job.workflow?.steps.find(s=>s.id===job.step_id);requireCondition(step?.desktop,'CUA_TYPED_PROCEDURE_REQUIRED');return step as typeof step&{desktop:NonNullable<typeof step.desktop>};}
  private async read(workId:string,ref:string,mode:ReadMode='auto',assertCurrent?:()=>void,allowRecovery=true):Promise<Snapshot>{
    const next=this.reading.then(async()=>{
      assertCurrent?.();
      try{return await this.readNow(workId,ref,mode);}
      catch(error){
        if(!(error instanceof Error)||!captureRecoveryError(error.message)||!allowRecovery)throw error;
        const scope=this.grant(workId).windows.find(w=>w.ref===ref);
        if(!scope||(!scope.allow_window_restore&&!scope.allow_window_activation))throw error;
        const scopeHash=snapshotHash(scope);
        const check=()=>{assertCurrent?.();const current=this.grant(workId).windows.find(w=>w.ref===ref);requireCondition(current&&snapshotHash(current)===scopeHash,'CUA_WINDOW_SCOPE_CHANGED');};
        const windowState=async()=>{
          const result=await this.port.call('list_windows',{pid:scope.pid});check();
          const listed=z.object({windows:z.array(z.object({pid:z.number().int(),window_id:z.number().int(),app_name:z.string(),title:z.string(),minimized:z.boolean().nullable().optional(),is_on_screen:z.boolean(),responding:z.boolean().nullable().optional()}))}).parse(result);
          const matches=listed.windows.filter(w=>w.pid===scope.pid&&w.window_id===scope.window_id);
          requireCondition(matches.length!==0,'CUA_TARGET_WINDOW_MISSING');
          requireCondition(matches.length===1&&matches[0]!.app_name.toLowerCase()===scope.app_name.toLowerCase()&&matches[0]!.title===scope.title,'CUA_WINDOW_CHANGED');
          requireCondition(matches[0]!.responding!==false,'CUA_WINDOW_UNRESPONSIVE');
          return matches[0]!;
        };
        check();const before=await windowState();
        requireCondition(before.minimized!==null&&before.minimized!==undefined,'CUA_WINDOW_RESTORE_UNVERIFIED');
        const minimized=before.minimized===true;
        // A user may have restored it meanwhile. Otherwise capture failure on a
        // restored/covered window may use foreground only with its own grant.
        const activate=!minimized&&error.message!=='CUA_VISUAL_WINDOW_MINIMIZED';
        if(minimized&&!scope.allow_window_restore)throw error;
        requireCondition(!activate||scope.allow_window_activation,'CUA_WINDOW_ACTIVATION_REQUIRED');
        const recoveryKey=snapshotHash({workId,scope,operation:minimized?'restore':'activate'});
        let recoveryStarted=0;
        if(minimized||activate){
          const previous=this.db.prepare('SELECT attempted_at,status FROM cua_window_recovery WHERE scope=?').get(recoveryKey);
          // Pending/failed activation is never repeated just because the caller
          // retries. Successful recovery has a cooldown to avoid focus thrash.
          requireCondition(!previous||(previous.status==='verified'&&Date.now()-Number(previous.attempted_at)>30_000),'CUA_WINDOW_RECOVERY_EXHAUSTED');
          requireCondition(previous||Number(this.db.prepare("SELECT COUNT(*) n FROM cua_window_recovery WHERE status!='verified'").get()!.n)<512,'CUA_WINDOW_RECOVERY_EXHAUSTED');
          this.db.prepare('INSERT INTO cua_window_recovery VALUES (?,?,?,?,NULL) ON CONFLICT(scope) DO UPDATE SET attempted_at=excluded.attempted_at,status=excluded.status,reason=excluded.reason,elapsed_ms=NULL').run(recoveryKey,Date.now(),'pending',error.message);
          this.db.prepare("DELETE FROM cua_window_recovery WHERE scope IN (SELECT scope FROM cua_window_recovery WHERE status='verified' ORDER BY attempted_at DESC LIMIT -1 OFFSET 128)").run();
          check();this.port.takeScreenshot?.();
          for(const [id,capture] of this.captures)if(capture.snapshot.scope.pid===scope.pid&&capture.snapshot.scope.window_id===scope.window_id){this.captures.delete(id);this.approval.delete(id);}
          const key=scope.pid+':'+scope.window_id;this.generations.set(key,(this.generations.get(key)??0)+1);
          const started=performance.now();recoveryStarted=started;this.counters.window_restore_attempts++;
          try{await this.port.call('bring_to_front',{pid:scope.pid,window_id:scope.window_id});}
          catch{this.db.prepare("UPDATE cua_window_recovery SET status='unverified' WHERE scope=?").run(recoveryKey);throw Error('CUA_WINDOW_RESTORE_UNVERIFIED');}
          finally{this.counters.window_restore_elapsed_ms+=Math.round(performance.now()-started);}
          // Native acknowledgement is not proof. Independently verify the HWND.
          const after=await windowState();
          requireCondition(after.minimized===false&&after.is_on_screen,'CUA_WINDOW_RESTORE_UNVERIFIED');
        }
        check();
        // One fresh observation, not a recursive recovery/input retry loop.
        try{
          const observed=await this.readNow(workId,ref,mode);check();
          if(recoveryStarted){this.counters.window_restores++;this.db.prepare("UPDATE cua_window_recovery SET status='verified',elapsed_ms=? WHERE scope=?").run(Math.round(performance.now()-recoveryStarted),recoveryKey);}
          return observed;
        }catch(error){
          if(recoveryStarted)this.db.prepare("UPDATE cua_window_recovery SET status='unverified',elapsed_ms=? WHERE scope=?").run(Math.round(performance.now()-recoveryStarted),recoveryKey);
          if(error instanceof Error&&captureRecoveryError(error.message))throw Error('CUA_WINDOW_RESTORE_OBSERVATION_UNAVAILABLE');throw error;
        }
      }
    });this.reading=next.catch(()=>{});return next;
  }
  private async readNow(workId:string,ref:string,mode:ReadMode):Promise<Snapshot>{
    const grant=this.grant(workId),scope=grant.windows.find(w=>w.ref===ref);requireCondition(scope,'CUA_WINDOW_OUT_OF_SCOPE');
    let observedAt=Date.now();
    const result=await this.port.call('get_window_state',{pid:scope.pid,window_id:scope.window_id,include_accessibility_tree:mode!=='visual',include_screenshot:mode!=='auto',max_image_dimension:0,max_elements:256,max_depth:12,timeout_ms:1000});
    this.grant(workId);
    if(mode!=='auto')visualCapture(result);
    const raw=mode==='visual'?null:rawSchema.parse(result);
    const identity=raw??visualCapture(result);
    requireCondition(identity.pid===scope.pid&&identity.window_id===scope.window_id&&identity.app_name.toLowerCase()===scope.app_name.toLowerCase()&&identity.window_title===scope.title,'CUA_WINDOW_CHANGED');
    const rows:Row[]=[];
    const elements=new Map(raw?.elements.map(item=>[item.element_index,item]));
    const windowChrome=(item:NonNullable<typeof raw>['elements'][number])=>{
      const visited=new Set<number>();let current:typeof item|undefined=item;
      while(current){requireCondition(!visited.has(current.element_index),'CUA_TREE_CYCLE');visited.add(current.element_index);if(current.role==='TitleBar')return true;current=current.parent_index===undefined?undefined:elements.get(current.parent_index);}return false;
    };
    for(const item of raw?.truncated?[]:raw?.elements??[]){
      // Non-client Close/Minimize controls are not evidence that the application's
      // canvas is accessible. This is a UIA hierarchy rule, not an app/name list.
      const role=roles[item.role];if(!role||!item.label||item.label.length>160||windowChrome(item))continue;
      requireCondition(item.element_token===raw!.snapshot_id+':'+item.element_index,'CUA_TOKEN_BINDING_CHANGED');
      const b=identity.window_bounds,f=item.frame,sensitive=item.is_password===true||item.sensitive===true||secretLabel.test(item.label);
      if(!sensitive)assertDesktopText(item.label);
      rows.push({id:'e'+item.element_index,token:item.element_token,label:sensitive?'[sensitive]':item.label,role,enabled:item.enabled,...(role==='checkbox'?{selected:item.selected??null}:{}),
        visible:f.w>0&&f.h>0&&f.x<b.x+b.width&&f.x+f.w>b.x&&f.y<b.y+b.height&&f.y+f.h>b.y,
        sensitive,value:sensitive?null:decodeCuaFieldValue(item.value,scope.value_encoding),actions:item.actions,source:'uia',bounds:{x:Math.max(0,Math.floor(f.x-b.x)),y:Math.max(0,Math.floor(f.y-b.y)),width:Math.max(1,Math.ceil(f.w)),height:Math.max(1,Math.ceil(f.h))}});
    }
    let image:Snapshot['image'];
    const visualNeeded=mode!=='auto'||raw?.truncated||!rows.some(r=>r.visible&&r.enabled&&!r.sensitive);
    if(visualNeeded&&!rows.some(r=>r.sensitive)){
      if(mode==='auto')observedAt=Date.now();
      const screen=visualCapture(mode==='auto'?await this.port.call('get_window_state',{pid:scope.pid,window_id:scope.window_id,include_accessibility_tree:false,include_screenshot:true,max_image_dimension:0}):result);
      this.grant(workId);
      requireCondition(screen.pid===scope.pid&&screen.window_id===scope.window_id&&screen.app_name.toLowerCase()===scope.app_name.toLowerCase()&&screen.window_title===scope.title&&snapshotHash(screen.window_bounds)===snapshotHash(identity.window_bounds),'CUA_VISUAL_WINDOW_CHANGED');
      requireCondition(screen.screenshot_frame_valid!==false&&screen.degraded!==true,'CUA_VISUAL_CAPTURE_DEGRADED');
      const png=this.port.takeScreenshot?.();requireCondition(png,'CUA_VISUAL_IMAGE_REQUIRED');
      const extracted=await this.visual.read({key:snapshotHash({scope,generation:this.generations.get(scope.pid+':'+scope.window_id)??0,bounds:screen.window_bounds,width:screen.screenshot_width,height:screen.screenshot_height}),capture_id:screen.capture_id,width:screen.screenshot_width,height:screen.screenshot_height,png,window:{pid:scope.pid,window_id:scope.window_id}});
      this.grant(workId);requireCondition(Date.now()-observedAt<=15_000,'CUA_VISUAL_CAPTURE_EXPIRED');this.counters.visual_captures++;this.counters.visual_elapsed_ms+=extracted.elapsed_ms;this.counters.visual_processed_pixels+=extracted.processed_pixels;
      if(extracted.mode==='full')this.counters.visual_full_reads++;else if(extracted.mode==='region')this.counters.visual_region_reads++;else this.counters.visual_reused_reads++;
      image={capture_id:screen.capture_id,sha256:extracted.frame_sha256,width:screen.screenshot_width,height:screen.screenshot_height};
      requireCondition(extracted.regions.length<=512,'CUA_VISUAL_REGION_LIMIT');
      for(const region of extracted.regions){
        const bounds=visualBoundsSchema.parse(region.bounds);assertVisualBounds(bounds,image.width,image.height);
        const label=region.text.trim();if(!label||label.length>160)continue;
        const sensitive=secretLabel.test(label);if(!sensitive)assertDesktopText(label);
        // Prefer structured controls. Only an overlapping equal UIA label is a
        // duplicate; the same text in a different location remains ambiguous.
        if(rows.some(row=>row.role!=='visual'&&row.label===label&&row.bounds&&row.bounds.x<bounds.x+bounds.width&&row.bounds.x+row.bounds.width>bounds.x&&row.bounds.y<bounds.y+bounds.height&&row.bounds.y+row.bounds.height>bounds.y))continue;
        rows.push({id:'v'+snapshotHash({label,bounds}).slice(0,24),token:'',label:sensitive?'[sensitive]':label,role:'visual',enabled:null,visible:true,sensitive,value:null,actions:['click'],bounds,source:'windows_ocr',confidence:null});
      }
    }else this.port.takeScreenshot?.();
    requireCondition(rows.length<=128&&new Set(rows.map(r=>r.id)).size===rows.length,'CUA_AMBIGUOUS_TREE');
    this.counters.observations++;
    return {scope,rows,at:observedAt,mode:visualNeeded?(rows.some(r=>r.source==='uia')?'hybrid':'visual'):'auto',...(image?{image}:{}),stamp:snapshotHash({scope,generation:this.generations.get(scope.pid+':'+scope.window_id)??0,bounds:identity.window_bounds,rows:rows.map(({token:_,...row})=>row),image:image?{sha256:image.sha256,width:image.width,height:image.height}:null})};
  }
  async planningSnapshot(workId:string,observation:'auto'|'visual'='auto',assertCurrent?:()=>void):Promise<DesktopPlanningSnapshot>{
    const grant=this.grant(workId),windows:DesktopPlanningSnapshot['windows']=[];
    for(const scope of grant.windows){const snapshot=await this.read(workId,scope.ref,observation==='visual'?'hybrid':'auto',assertCurrent);this.counters.planning_reads++;
      windows.push({ref:scope.ref,application:this.application(scope),title:scope.title,effects:[...grant.effects],
        controls:snapshot.rows.map(({value:_,token:__,actions:___,id:____,bounds:_____,...row})=>row)});
    }
    return {version:1,capability_revision:snapshotHash({driver:this.id,grant}),windows};
  }
  private count(check:DesktopCheck,rows:Row[]){return rows.filter(r=>r.visible&&!r.sensitive&&sameDesktopLabel(r,check)).length;}
  private matches(check:DesktopCheck,rows:Row[],inputs:Record<string,string>,baseline?:number){
    const rowsMatching=rows.filter(r=>r.visible&&!r.sensitive&&sameDesktopLabel(r,check));
    if(check.kind==='label_count_increased')return baseline!==undefined&&rowsMatching.length>baseline;
    if(check.kind==='field_equals')return rowsMatching.length===1&&rowsMatching[0]!.value!==null&&rowsMatching[0]!.value===inputs[check.input];
    if(check.kind==='control_selected')return rowsMatching.length===1&&rowsMatching[0]!.source==='uia'&&typeof rowsMatching[0]!.selected==='boolean'&&rowsMatching[0]!.selected===check.selected;
    return rowsMatching.length>0;
  }
  private build(job:WindowsJob,snapshot:Snapshot,actionId?:string,baseline?:number[]):DesktopObservation{
    const step=this.contract(job),facts:DesktopObservation['facts']=[];
    const fact=(key:string,action_id:string|null)=>facts.push({key,evidence_ref:snapshotHash({stamp:snapshot.stamp,key}),binding_sha256:job.binding_sha256,action_id});
    // The state digest makes human edits/changed values visible to the runtime
    // without disclosing those values to a decision model or the MCP caller.
    fact('ui_state',null);
    if(step.desktop.before.every(check=>this.matches(check,snapshot.rows,job.inputs)))fact(step.id+'.context',null);
    if(step.desktop.after.every((check,index)=>this.matches(check,snapshot.rows,job.inputs,baseline?.[index])))fact(step.id+'.result',actionId??null);
    return {capture_id:randomUUID(),window_ref:snapshot.scope.ref,application:this.application(snapshot.scope),captured_at_ms:snapshot.at,
      screen:snapshot.rows.some(r=>r.sensitive)?'authentication':snapshot.rows.some(r=>r.visible)?'workspace':'unknown',recipient:'unknown',recipient_evidence:[],facts,
      controls:snapshot.rows.map(({value:_,token:__,actions:___,bounds:____,...row})=>row)};
  }
  async observe(job:WindowsJob,assertCurrent?:()=>void,allowRecovery=true){
    // These contain host-only field values and current UIA tokens, not history.
    // Completed runs release them below; abandoned runs expire and stay bounded.
    for(const [id,item] of this.captures)if(Date.now()-item.snapshot.at>15_000)this.captures.delete(id);
    for(const [id,item] of this.approval)if(Date.now()-item.at>=30_000)this.approval.delete(id);
    this.captures.delete(job.run_id);
    while(this.captures.size>=32)this.captures.delete(this.captures.keys().next().value!);
    const step=this.contract(job),contracts=[step.desktop.target,...step.desktop.before,...step.desktop.after];
    const mode:ReadMode=contracts.some(c=>c.role==='visual')?(contracts.some(c=>c.role!=='visual')?'hybrid':'visual'):'auto';
    const snapshot=await this.read(job.work_id,step.desktop.window_ref,mode,assertCurrent,allowRecovery);
    const prior=this.db.prepare("SELECT action_id,before_counts FROM cua_desktop_effect WHERE driver_id=? AND binding=? AND status='performed' ORDER BY rowid DESC LIMIT 1").get(this.id,job.binding_sha256);
    const counts=prior?JSON.parse(String(prior.before_counts)) as {step_id:string;counts:number[]}:null;
    const observation=this.build(job,snapshot,counts?.step_id===step.id?String(prior!.action_id):undefined,counts?.step_id===step.id?counts.counts:undefined);
    this.captures.set(job.run_id,{job:structuredClone(job),snapshot,observation});return observation;
  }
  private current(command:WindowsCommand){
    const capture=this.captures.get(command.run_id);requireCondition(capture&&Date.now()-capture.snapshot.at<=15_000,'CUA_CURRENT_OBSERVATION_REQUIRED');
    const step=this.contract(capture.job),{capture_id:_,captured_at_ms:__,...state}=capture.observation;
    requireCondition(capture.job.work_id===command.work_id&&capture.job.binding_sha256===command.binding_sha256&&step.id===command.step_id&&step.action===command.action&&step.effect===command.effect&&
      command.window_ref===capture.observation.window_ref&&command.application===capture.observation.application&&snapshotHash(state)===command.observation_sha256&&capture.observation.capture_id===command.capture_id,'CUA_COMMAND_BINDING_CHANGED');
    requireCondition(command.text===(step.input?capture.job.inputs[step.input]:undefined),'CUA_TEXT_CHANGED');
    const target=capture.snapshot.rows.find(r=>r.id===command.target_id);
    requireCondition(target&&sameDesktopLabel(target,step.desktop.target)&&selectableDesktopControl(target,step),'CUA_TARGET_CHANGED');
    requireCondition(capture.snapshot.rows.filter(r=>sameDesktopLabel(r,target)&&r.visible).length===1,'CUA_TARGET_AMBIGUOUS');
    requireCondition(command.action==='replace_text'?target.actions.includes('set_value'):target.actions.some(action=>['click','invoke'].includes(action)),'CUA_OPERATION_NOT_AVAILABLE');
    requireCondition(this.grant(command.work_id).effects.includes(command.effect),'CUA_EFFECT_OUT_OF_SCOPE');
    return {capture,target,step};
  }
  async authorize(command:WindowsCommand){
    this.approval.delete(command.run_id);
    this.current(command);
    if(['external_send','local_write'].includes(command.effect)&&!await this.confirmEffect?.(structuredClone(command)))return false;
    this.approval.set(command.run_id,{hash:snapshotHash({...command,capture_id:null}),at:Date.now()});return true;
  }
  async act(command:WindowsCommand,assertCurrent?:()=>void){
    const {capture,step}=this.current(command),approval=this.approval.get(command.run_id);this.approval.delete(command.run_id);
    requireCondition(approval&&Date.now()-approval.at<30_000&&approval.hash===snapshotHash({...command,capture_id:null}),'CUA_EFFECT_APPROVAL_REQUIRED');
    const fresh=await this.read(command.work_id,step.desktop.window_ref,capture.snapshot.mode,undefined,false);requireCondition(fresh.stamp===capture.snapshot.stamp,'CUA_STATE_CHANGED_BEFORE_INPUT');
    // OCR/native reads can be slow. A pause, instruction/model change or expired
    // approval during that read must still stop before sending any input.
    try{requireCondition(Date.now()-approval.at<30_000,'CUA_EFFECT_APPROVAL_EXPIRED');assertCurrent?.();}
    catch{
      const saved=this.db.prepare('INSERT OR IGNORE INTO cua_desktop_effect VALUES (?,?,?,?,?,?)').run(command.action_id,this.id,snapshotHash(command),command.binding_sha256,'not_performed',JSON.stringify({step_id:step.id,counts:[]}));
      requireCondition(saved.changes===1,'CUA_EFFECT_ALREADY_CLAIMED');
      return {action_id:command.action_id,capture_id:command.capture_id,window_ref:command.window_ref,target_id:command.target_id,outcome:'not_performed'};
    }
    const target=fresh.rows.find(r=>r.id===command.target_id)!;
    const claimed=this.db.prepare('INSERT OR IGNORE INTO cua_desktop_effect VALUES (?,?,?,?,?,?)').run(command.action_id,this.id,snapshotHash(command),command.binding_sha256,'claimed',JSON.stringify({step_id:step.id,before_stamp:fresh.stamp,counts:step.desktop.after.map(check=>this.count(check,fresh.rows))}));
    requireCondition(claimed.changes===1,'CUA_EFFECT_ALREADY_CLAIMED');
    const args=target.role==='visual'?{pid:fresh.scope.pid,window_id:fresh.scope.window_id,scope:'window',capture_id:fresh.image!.capture_id,x:Math.floor(target.bounds!.x+target.bounds!.width/2),y:Math.floor(target.bounds!.y+target.bounds!.height/2)}:{pid:fresh.scope.pid,window_id:fresh.scope.window_id,element_token:target.token};
    const result=await this.port.call(command.action==='replace_text'?'set_value':'click',command.action==='replace_text'?{...args,value:command.text}:{...args,count:1,delivery_mode:'background'});
    requireCondition(typeof result==='object'&&result!==null&&(result as {success?:boolean}).success!==false&&!['refused','failed'].includes(String((result as {status?:string}).status))&&!['refused','partial','suspected_noop'].includes(String((result as {effect?:string}).effect))&&!(result as {error?:unknown}).error,'CUA_EFFECT_UNCERTAIN');
    this.db.prepare("UPDATE cua_desktop_effect SET status='performed' WHERE action_id=?").run(command.action_id);this.counters.actions++;
    return {action_id:command.action_id,capture_id:command.capture_id,window_ref:command.window_ref,target_id:command.target_id,outcome:'performed'};
  }
  private targetScope(job:WindowsJob){const step=this.contract(job),grant=this.grant(job.work_id);return snapshotHash({driver:this.id,grant,workflow:job.workflow,step:step.id});}
  async selectExactTarget(job:WindowsJob,observation:DesktopObservation){
    const step=this.contract(job),verifiedNavigation=step.action==='invoke'&&step.effect==='navigate';
    if(!verifiedNavigation&&(step.action!=='replace_text'||step.effect!=='local_draft'))return null;
    const row=this.db.prepare('SELECT body,verified_at FROM cua_desktop_target WHERE scope=?').get(this.targetScope(job));
    const valid=Boolean(row&&Date.now()-Number(row.verified_at)<=7*86400_000);
    // The planner already chose an exact field from the live capability table.
    // Asking a second model to rediscover the same unique field adds no new
    // evidence. This is not a cache hit or a permission: current context,
    // pre-input identity/value, scope and independent readback still apply.
    const cached=valid?z.object({label:z.string(),role:z.string(),before_stamp:z.string().optional()}).strict().parse(JSON.parse(String(row!.body))):step.desktop.target;
    if(verifiedNavigation&&(!valid||!('before_stamp' in cached)||cached.before_stamp!==this.captures.get(job.run_id)?.snapshot.stamp))return null;
    const targets=observation.controls.filter(c=>sameDesktopLabel(c,cached)&&selectableDesktopControl(c,step));
    if(targets.length!==1)return null;if(valid)this.counters.verified_target_hits++;else this.counters.planned_exact_hits++;return targets[0]!.id;
  }
  async verified(job:WindowsJob,command:WindowsCommand,observation:DesktopObservation){
    const step=this.contract(job);requireCondition(observation.facts.some(f=>f.key===step.id+'.result'&&f.action_id===command.action_id&&f.binding_sha256===job.binding_sha256),'CUA_READBACK_REQUIRED');
    const record=this.db.prepare('SELECT before_counts FROM cua_desktop_effect WHERE action_id=? AND driver_id=? AND binding=?').get(command.action_id,this.id,job.binding_sha256);
    const before=record?JSON.parse(String(record.before_counts)) as {before_stamp?:string}:null;
    this.db.prepare('INSERT INTO cua_desktop_target VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET body=excluded.body,verified_at=excluded.verified_at').run(this.targetScope(job),JSON.stringify({...step.desktop.target,...(before?.before_stamp?{before_stamp:before.before_stamp}:{})}),Date.now());
    this.db.prepare('DELETE FROM cua_desktop_target WHERE verified_at<? OR scope IN (SELECT scope FROM cua_desktop_target ORDER BY verified_at DESC LIMIT -1 OFFSET 512)').run(Date.now()-7*86400_000);
    this.captures.delete(job.run_id);this.approval.delete(job.run_id);
  }
  async reconcile(job:WindowsJob,command:WindowsCommand){
    const record=this.db.prepare('SELECT command_hash,status FROM cua_desktop_effect WHERE action_id=? AND driver_id=? AND binding=?').get(command.action_id,this.id,job.binding_sha256);
    requireCondition(record&&record.command_hash===snapshotHash(command),'CUA_RECONCILIATION_BINDING_CHANGED');
    const performed=record.status==='performed',refused=record.status==='not_performed';
    return {action_id:command.action_id,binding_sha256:command.binding_sha256,quiescent:performed||refused,outcome:performed?'performed':refused?'not_performed':'unknown',evidence_ref:snapshotHash(record),...(performed?{observation:await this.observe(job,undefined,false)}:{})};
  }
  async shutdown(){this.stopped=true;this.captures.clear();this.approval.clear();this.generations.clear();await Promise.all([this.port.close(),this.visual.close()]);}
}
