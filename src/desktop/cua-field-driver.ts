import {type DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type DesktopObservation} from './windows-decision.js';
import {type WindowsCommand,type WindowsJob} from './windows-runtime.js';
import {NativeFieldDriver,type NativeFieldScope,type NativeFieldState,type NativeReadPurpose} from './native-field-driver.js';
import {windowsCuaConfigSchema,type WindowsCuaConfig} from './cua-contracts.js';
import {OwnedCuaConnection,type CuaPort} from './cua-connection.js';
import {OwnedWindowsFocusedReader,type WindowsFocusedReader,type FocusedResult,type ReviewedCuaField} from './windows-focused-reader.js';
import {WindowsProcedureStore,focusedLocatorSchema,type FocusedLocator,WINDOWS_PROCEDURE_VERSION} from './windows-procedure.js';
import {windowsWorkflow} from './windows-workflows.js';

const windowSchema=z.object({window_id:z.number().int(),pid:z.number().int(),app_name:z.string(),title:z.string(),is_on_screen:z.boolean(),minimized:z.boolean()});
const elementSchema=z.object({element_index:z.number().int().nonnegative(),element_token:z.string().regex(/^s[0-9a-f]{8}:\d+$/u),
  role:z.string(),label:z.string(),value:z.string().max(8000).optional(),enabled:z.boolean(),actions:z.array(z.string()),
  frame:z.object({x:z.number(),y:z.number(),w:z.number(),h:z.number()})});
const stateSchema=z.object({pid:z.number().int(),window_id:z.number().int(),app_name:z.string(),window_title:z.string(),
  snapshot_id:z.string().regex(/^s[0-9a-f]{8}$/u),truncated:z.literal(false),elements:z.array(z.unknown()).max(256),
  window_bounds:z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number()})});

export function decodeCuaFieldValue(value:string|undefined,encoding:'exact'|'uia_single_line_document'){
  if(value===undefined)return null;
  if(encoding==='exact')return value;
  // Explicit host-reviewed TextPattern single-line profile only. RichEdit UIA
  // document ranges can include their terminal paragraph CR. Do not trim any
  // whitespace, LF, repeated CR or internal line break to force a passing test.
  return /^[^\r\n]*\r$/u.test(value)?value.slice(0,-1):value;
}

/** No tree-string emulation: use CUA's structured elements and native snapshot
 * tokens. An absent value stays null, never "empty"/false or successful readback.
 * CUA marks its walk non-exhaustive even without truncation: only the explicitly
 * reviewed index+label+role can be used; absence proves nothing. */
export function parseCuaField(raw:unknown,scope:NativeFieldScope,pid:number,index:number,onScreen:boolean,encoding:'exact'|'uia_single_line_document'='exact'):NativeFieldState {
  const state=stateSchema.parse(raw);
  requireCondition(state.pid===pid&&state.window_id===scope.window.id&&state.app_name===scope.window.app&&state.window_title===scope.window_title,'CUA_WINDOW_CHANGED');
  const rows=state.elements.filter((item):item is Record<string,unknown>=>typeof item==='object'&&item!==null);
  const matching=rows.filter(item=>item.element_index===index);
  requireCondition(matching.length===1,'CUA_TARGET_NOT_UNIQUE');
  const field=elementSchema.parse(matching[0]);
  requireCondition(field.role==='Edit'&&field.label===scope.label&&field.actions.includes('set_value'),'CUA_FIELD_CHANGED');
  requireCondition(rows.filter(item=>item.role==='Edit'&&item.label===scope.label).length===1,'CUA_FIELD_LABEL_AMBIGUOUS');
  requireCondition(field.element_token===state.snapshot_id+':'+index,'CUA_TOKEN_BINDING_CHANGED');
  const bounds=state.window_bounds,frame=field.frame;
  const intersects=frame.x<bounds.x+bounds.width&&frame.x+frame.w>bounds.x&&frame.y<bounds.y+bounds.height&&frame.y+frame.h>bounds.y;
  return {window:{id:state.window_id,app:state.app_name,title:state.window_title},focus:null,
    field:{index,automation_id:scope.automation_id,label:field.label,value:decodeCuaFieldValue(field.value,encoding),enabled:field.enabled,
      visible:onScreen&&bounds.width>0&&bounds.height>0&&frame.w>0&&frame.h>0&&intersects,token:field.element_token}};
}

interface ObservationBinding {state:NativeFieldState;locator:FocusedLocator;identity:string;token_at_ms:number;}
/** CUA query is only a returned projection, not a cheaper native tree walk.
 * Actual focused reads use the read-only exact-field UIA port. CUA still owns
 * discovery, current snapshot tokens and every input operation. */
class CuaObservationRoute {
  readonly history:Array<{purpose:NativeReadPurpose;path:'full'|'projection'|'focused'|'rediscovery';elapsed_ms:number;returned_elements:number;response_bytes:number;status:'ok'|'failed'}>=[];
  readonly counters={cache_hits:0,cache_misses:0,invalidations:0,verified_saves:0};
  private live=new Map<string,ObservationBinding>();
  private windows=new Map<string,boolean>();
  private loaded=new Map<string,FocusedLocator|null>();
  readonly procedures:WindowsProcedureStore;
  constructor(readonly config:WindowsCuaConfig,db:DatabaseSync,readonly port:CuaPort,readonly focused?:WindowsFocusedReader){this.procedures=new WindowsProcedureStore(db);}
  scope(field:ReviewedCuaField){return snapshotHash({version:WINDOWS_PROCEDURE_VERSION,workflow:windowsWorkflow('windows.form.draft'),work:field.work_id,
    executor:{version:this.config.version,sha:this.config.executable_sha256},app:field.app_name.toLowerCase(),window:field.window_title,label:field.label,intent:field.request_field,encoding:field.value_encoding});}
  private invalidate(field:ReviewedCuaField){this.procedures.invalidate(this.scope(field),'locator');this.live.delete(field.work_id);this.loaded.set(field.work_id,null);this.counters.invalidations++;}
  private fromFocused(raw:FocusedResult,scope:NativeFieldScope,bound:ReviewedCuaField,token?:string):NativeFieldState{
    requireCondition(raw.pid===bound.pid&&raw.window_id===bound.window_id&&raw.app_name.toLowerCase()===bound.app_name.toLowerCase()&&raw.window_title===bound.window_title&&raw.field.label===bound.label,'CUA_FOCUSED_BINDING_CHANGED');
    const frame=raw.field.frame,bounds=raw.window_bounds;
    return {window:{id:raw.window_id,app:bound.app_name,title:raw.window_title},focus:null,
      identity:snapshotHash({process:raw.process_started_ticks,element:raw.field.runtime_id}),
      field:{index:bound.element_index,automation_id:scope.automation_id,label:raw.field.label,value:decodeCuaFieldValue(raw.field.value??undefined,bound.value_encoding),
        enabled:raw.field.enabled,visible:raw.field.visible&&frame.w>0&&frame.h>0&&bounds.width>0&&bounds.height>0&&frame.x<bounds.x+bounds.width&&frame.x+frame.w>bounds.x&&frame.y<bounds.y+bounds.height&&frame.y+frame.h>bounds.y,...(token?{token}:{})}};
  }
  async read(scope:NativeFieldScope,purpose:NativeReadPurpose='observe'):Promise<NativeFieldState>{
    const bound=this.config.fields.find(field=>field.work_id===scope.work_id)!;
    if(!this.loaded.has(bound.work_id)){
      const cached=this.focused?this.procedures.read(this.scope(bound),'locator',focusedLocatorSchema):null;
      this.loaded.set(bound.work_id,cached);cached?this.counters.cache_hits++:this.counters.cache_misses++;
    }
    const saved=this.loaded.get(bound.work_id),live=this.live.get(bound.work_id),locator=live?.locator??saved;
    // An input requires a current CUA snapshot too. A focused observation may
    // discover the current field, but never manufactures a reusable action token.
    const needToken=purpose==='pre_input'&&(!live?.state.field.token||Date.now()-live.token_at_ms>10_000);
    if(this.focused&&locator&&!needToken){
      const started=performance.now();
      try{
        const raw=await this.focused.read(bound,locator),state=this.fromFocused(raw,scope,bound,live?.state.field.token);
        if(live)requireCondition(state.identity===live.identity,'CUA_NATIVE_ELEMENT_REPLACED');
        this.history.push({purpose,path:'focused',elapsed_ms:Math.round(performance.now()-started),returned_elements:1,response_bytes:Buffer.byteLength(JSON.stringify(raw)),status:'ok'});
        // Store current identity across calls; only successful CUA discovery
        // carries an input token. Nothing here promotes a persistent procedure.
        this.live.set(bound.work_id,{state,locator,identity:state.identity!,token_at_ms:live?.token_at_ms??0});
        return state;
      }catch(error){
        this.history.push({purpose,path:'focused',elapsed_ms:Math.round(performance.now()-started),returned_elements:0,response_bytes:0,status:'failed'});
        this.invalidate(bound);
        // After approval/input, do not reinterpret a changed field as a new
        // authorized target. Only initial observation can rediscover read-only.
        if(purpose!=='observe')throw error;
        return this.full(scope,bound,purpose,null,'rediscovery');
      }finally{if(this.history.length>100)this.history.splice(0,this.history.length-100);}
    }
    return this.full(scope,bound,purpose,locator??null,locator?'projection':'full');
  }
  private async full(scope:NativeFieldScope,bound:ReviewedCuaField,purpose:NativeReadPurpose,locator:FocusedLocator|null,path:'full'|'projection'|'rediscovery'){
    const started=performance.now();let returned=0,bytes=0;
    try{
      const focused=this.focused?await this.focused.read(bound,locator??undefined):null;
      if(focused)this.windows.set(scope.work_id,true); // Live exact HWND/PID visibility was checked by the native reader.
      if(!this.windows.has(scope.work_id)){
        const list=z.object({windows:z.array(windowSchema)}).parse(await this.port.call('list_windows',{pid:bound.pid}));
        const matches=list.windows.filter(window=>window.pid===bound.pid&&window.window_id===scope.window.id&&window.app_name===scope.window.app&&window.title===scope.window_title);
        requireCondition(matches.length===1,'CUA_WINDOW_BINDING_CHANGED');this.windows.set(scope.work_id,matches[0]!.is_on_screen&&!matches[0]!.minimized);
      }
      const raw=await this.port.call('get_window_state',{pid:bound.pid,window_id:scope.window.id,include_screenshot:false,max_elements:256,max_depth:12,timeout_ms:1000,...(locator?{query:locator.label}:{})});
      returned=stateSchema.parse(raw).elements.length;bytes=Buffer.byteLength(JSON.stringify(raw));
      let state=parseCuaField(raw,scope,bound.pid,bound.element_index,this.windows.get(scope.work_id)!,bound.value_encoding);
      if(focused){
        const current=this.fromFocused(focused,scope,bound,state.field.token);
        requireCondition(state.field.enabled===current.field.enabled&&state.field.visible===current.field.visible&&(state.field.value===null||state.field.value===current.field.value),'CUA_FOCUSED_STATE_CONFLICT');
        const row=stateSchema.parse(raw).elements.find(item=>(item as {element_index?:number}).element_index===bound.element_index);
        const frame=elementSchema.parse(row).frame;
        requireCondition(['x','y','w','h'].every(key=>Math.abs(frame[key as keyof typeof frame]-focused.field.frame[key as keyof typeof frame])<=2),'CUA_FOCUSED_GEOMETRY_CONFLICT');
        const previous=this.live.get(scope.work_id);if(previous)requireCondition(current.identity===previous.identity,'CUA_NATIVE_ELEMENT_REPLACED');
        const learned:FocusedLocator={label:bound.label,role:'Edit',automation_id:focused.field.automation_id,class_name:focused.field.class_name,value_encoding:bound.value_encoding};
        this.live.set(scope.work_id,{state:current,locator:learned,identity:current.identity!,token_at_ms:Date.now()});state=current;
      }
      this.history.push({purpose,path,elapsed_ms:Math.round(performance.now()-started),returned_elements:returned,response_bytes:bytes,status:'ok'});return state;
    }catch(error){this.invalidate(bound);this.history.push({purpose,path,elapsed_ms:Math.round(performance.now()-started),returned_elements:returned,response_bytes:bytes,status:'failed'});throw error;}
    finally{if(this.history.length>100)this.history.splice(0,this.history.length-100);}
  }
  verified(job:WindowsJob,command:WindowsCommand,observation:DesktopObservation){
    const field=this.config.fields.find(item=>item.work_id===job.work_id),live=this.live.get(job.work_id);
    if(!field||!live||!this.focused)return;
    requireCondition(observation.facts.some(f=>f.key==='form_field_matches'&&f.action_id===command.action_id&&f.binding_sha256===job.binding_sha256),'CUA_PROCEDURE_READBACK_REQUIRED');
    this.procedures.verify(this.scope(field),'locator',live.locator,snapshotHash({binding:job.binding_sha256,action:command.action_id,capture:observation.capture_id,facts:observation.facts}));
    this.loaded.set(job.work_id,live.locator);this.counters.verified_saves++;
    // A completed action's CUA token cannot authorize another turn, even when
    // the owning MCP process stays alive and the next request arrives quickly.
    const {token:_,...observedField}=live.state.field;
    this.live.set(job.work_id,{...live,state:{...live.state,field:observedField},token_at_ms:0});
  }
}

export class CuaFieldDriver extends NativeFieldDriver {
  readonly port:CuaPort;
  private readonly reviewed:WindowsCuaConfig;
  private readonly observations:CuaObservationRoute;
  private readonly focused:WindowsFocusedReader|undefined;
  constructor(config:WindowsCuaConfig,db:DatabaseSync,port:CuaPort=new OwnedCuaConnection(config),focused?:WindowsFocusedReader){
    const reviewed=windowsCuaConfigSchema.parse(config),id='cua:'+snapshotHash(reviewed).slice(0,32);
    requireCondition(new Set(reviewed.fields.map(field=>field.work_id)).size===reviewed.fields.length,'CUA_DUPLICATE_WORK_SCOPE');
    requireCondition(new Set(reviewed.fields.map(field=>field.grant_id)).size===reviewed.fields.length,'CUA_DUPLICATE_GRANT');
    const reader=reviewed.observation_strategy==='full'?undefined:focused??(process.platform==='win32'&&port instanceof OwnedCuaConnection?new OwnedWindowsFocusedReader(reviewed):undefined);
    const observations=new CuaObservationRoute(reviewed,db,port,reader);
    super({
      readField:(scope,purpose)=>observations.read(scope,purpose),
      async setValue(state,value){
        const fields=reviewed.fields.filter(field=>field.window_id===state.window.id&&field.app_name===state.window.app);
        requireCondition(fields.length>0&&fields.every(field=>field.pid===fields[0]!.pid),'CUA_WINDOW_PID_AMBIGUOUS');
        requireCondition(state.field.token,'CUA_TOKEN_REQUIRED');
        const result=await port.call('set_value',{pid:fields[0]!.pid,window_id:state.window.id,element_token:state.field.token,value});
        // CUA's action result is not our completion proof. Fail closed on an
        // explicit unsuccessful result and always perform independent readback.
        requireCondition(typeof result==='object'&&result!==null,'CUA_ACTION_RESULT_INVALID');
        const record=result as Record<string,unknown>;
        requireCondition(record.success!==false&&record.status!=='refused'&&record.status!=='failed','CUA_ACTION_UNVERIFIED');
      }
    },db,id);
    this.port=port;this.reviewed=reviewed;this.observations=observations;this.focused=reader;
    db.exec('CREATE TABLE IF NOT EXISTS windows_cua_grant(grant_id TEXT PRIMARY KEY,binding TEXT NOT NULL,action_id TEXT NOT NULL);');
    for(const field of reviewed.fields.filter(item=>item.expires_at_ms>Date.now()))this.bind({work_id:field.work_id,window:{id:field.window_id,app:field.app_name,title:field.window_title},
      window_title:field.window_title,automation_id:'cua-index:'+field.element_index,label:field.label,request_field:field.request_field,
      expires_at_ms:field.expires_at_ms,local_draft_only:true,auto_submits:false,sensitive:false});
  }
  override availability(){return {connected:this.port.connected(),supported_workflows:['windows.form.draft'],reason:this.port.connected()?'CUA_OWNED_STDIO_CONNECTED':'CUA_CONNECT_ON_FIRST_OBSERVATION'};}
  diagnostics(){return {provider:'cua-driver',version:this.reviewed.version,ownership:'agent-office-child',
    ...(this.port instanceof OwnedCuaConnection?{pid:this.port.pid,timings:[...this.port.timings]}:{}),
    observation_strategy:this.focused?'focused':'full',procedures:{...this.observations.counters},observations:[...this.observations.history],
    ...(this.focused instanceof OwnedWindowsFocusedReader?{focused_reader:{pid:this.focused.pid,timings:[...this.focused.timings]}}:{}),
    screenshot_capture:false,scope:'reviewed-local-field',codex_computer_use:false};}
  /** Code fast path only for an exact human-reviewed field. No free-form
   * semantic target choice, no permission shortcut, no invented probability. */
  async selectExactTarget(job:WindowsJob,observation:DesktopObservation){
    const field=this.reviewed.fields.find(item=>item.work_id===job.work_id);
    if(!field||field.expires_at_ms<=Date.now()||job.workflow_id!=='windows.form.draft'||job.inputs.field!==field.request_field||observation.controls.length!==1)return null;
    const control=observation.controls[0]!;
    return control.label===field.label&&control.role==='edit'&&control.enabled&&control.visible&&!control.sensitive?control.id:null;
  }
  procedureScope(job:WindowsJob){const field=this.reviewed.fields.find(item=>item.work_id===job.work_id);requireCondition(field,'CUA_SCOPE_REQUIRED');return this.observations.scope(field);}
  async verified(job:WindowsJob,command:WindowsCommand,observation:DesktopObservation){this.observations.verified(job,command,observation);}
  override async authorize(command:WindowsCommand){
    if(await super.authorize(command))return true;
    const field=this.reviewed.fields.find(item=>item.work_id===command.work_id);
    if(!field||field.approved_value!==command.text||this.db.prepare('SELECT 1 FROM windows_cua_grant WHERE grant_id=?').get(field.grant_id))return false;
    const review=this.pendingReviews().find(item=>item.run_id===command.run_id&&item.text===field.approved_value);
    if(!review)return false;
    this.approveLocalDraft(review.review_id);
    return super.authorize(command);
  }
  override async act(command:WindowsCommand){
    const field=this.reviewed.fields.find(item=>item.work_id===command.work_id);
    requireCondition(field&&field.expires_at_ms>Date.now(),'CUA_SCOPE_EXPIRED');
    // Claim even before the backend's freshness check; a failed attempt requires
    // a new grant, never an implicit retry. This survives MCP/runtime restarts.
    const grant=this.db.prepare('INSERT OR IGNORE INTO windows_cua_grant VALUES (?,?,?)').run(field.grant_id,snapshotHash(field),command.action_id);
    requireCondition(grant.changes===1,'CUA_GRANT_ALREADY_CONSUMED');
    return super.act(command);
  }
  async shutdown(){this.disconnect();await Promise.all([this.port.close(),this.focused?.close()]);}
}
