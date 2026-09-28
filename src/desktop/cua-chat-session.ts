import {createHash} from 'node:crypto';
import {type DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {type CuaChatTool} from './cua-connection.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const scopeSchema=z.object({
  request_id:z.string().uuid(),work_id:z.string().uuid(),pid:z.number().int().positive(),window_id:z.number().int().positive(),
  room:z.string().min(1).max(160),message:z.string().min(1).max(2000).refine(v=>!/[\x00-\x1f\x7f]/u.test(v)),
  expires_at_ms:z.number().int().positive(),
}).strict();
export type CuaChatScope=z.infer<typeof scopeSchema>;
export interface CuaChatPort {call(name:CuaChatTool,args:Record<string,unknown>):Promise<unknown>;}
interface ChatSnapshot {capture_id:string;snapshot_id:string;token:string;value:string;at:number;width:number;height:number;visual:boolean;bounds:string;}
const observationSchema=z.object({
  pid:z.number().int(),window_id:z.number().int(),app_name:z.literal('KakaoTalk.exe'),window_title:z.string(),
  capture_id:z.string().min(1).optional(),snapshot_id:z.string().min(1),truncated:z.literal(false),
  screenshot_width:z.number().positive().optional(),screenshot_height:z.number().positive().optional(),
  window_bounds:z.object({x:z.number(),y:z.number(),width:z.number().positive(),height:z.number().positive()}),
  elements:z.array(z.object({element_token:z.string(),role:z.string(),label:z.string(),enabled:z.boolean(),value:z.string().optional(),actions:z.array(z.string())})),
});
/** Host-owned narrow chat adapter. Not a general click proxy and not a new
 * public MCP capability. The host binds the requested room after visual list
 * navigation; exact native title and editable element must then agree.
 * UIA cannot prove receipt of a remote message: dispatch is never success. */
export class CuaChatSession {
  readonly scope:CuaChatScope;
  private current:ChatSnapshot|null=null;
  private approval:{capture_id:string;expires_at_ms:number}|null=null;
  private busy=false;
  private readonly binding:string;
  constructor(scope:CuaChatScope,private readonly db:DatabaseSync,private readonly port:CuaChatPort){
    this.scope=Object.freeze(scopeSchema.parse(scope));
    this.binding=sha(JSON.stringify(this.scope));
    db.exec(`CREATE TABLE IF NOT EXISTS cua_chat_effect (
      request_id TEXT NOT NULL, operation TEXT NOT NULL, binding TEXT NOT NULL,
      status TEXT NOT NULL, captured_at_ms INTEGER NOT NULL,
      PRIMARY KEY (request_id,operation))`);
  }
  private valid(){requireCondition(Date.now()<this.scope.expires_at_ms,'CHAT_SCOPE_EXPIRED');}
  private target(){return {pid:this.scope.pid,window_id:this.scope.window_id};}
  private claim(operation:'draft'|'repair_draft'|'send'){
    // Persist before dispatch. A crash/timeout never grants a retry, including
    // after a new adapter instance is created for the same request.
    const row=this.db.prepare('INSERT OR IGNORE INTO cua_chat_effect VALUES (?,?,?,?,?)').run(this.scope.request_id,operation,this.binding,'claimed',Date.now());
    requireCondition(row.changes===1,'CHAT_EFFECT_ALREADY_CLAIMED');
  }
  private finish(operation:'draft'|'repair_draft'|'send',status:string){
    this.db.prepare('UPDATE cua_chat_effect SET status=? WHERE request_id=? AND operation=? AND binding=?').run(status,this.scope.request_id,operation,this.binding);
  }
  status(){return this.db.prepare('SELECT operation,status,captured_at_ms FROM cua_chat_effect WHERE request_id=? ORDER BY captured_at_ms').all(this.scope.request_id);}
  async observe(visual=false){
    this.valid();requireCondition(!this.busy,'CHAT_BUSY');this.current=null;this.approval=null;
    this.busy=true;
    try{
    const {raw,editor,value}=await this.read(visual);
    requireCondition(!visual||Boolean(raw.capture_id&&raw.screenshot_width&&raw.screenshot_height),'CHAT_VISUAL_CAPTURE_REQUIRED');
    this.current={capture_id:raw.capture_id??raw.snapshot_id,snapshot_id:raw.snapshot_id,token:editor.element_token,value,at:Date.now(),width:raw.screenshot_width??0,height:raw.screenshot_height??0,visual,bounds:JSON.stringify(raw.window_bounds)};
    return {...raw,capture_id:this.current.capture_id,composer_value:value};
    }finally{this.busy=false;}
  }
  private async read(visual:boolean){
    const raw=observationSchema.parse(await this.port.call('get_window_state',{...this.target(),include_accessibility_tree:true,include_screenshot:visual,max_elements:20,max_depth:4,max_image_dimension:0}));
    this.valid();
    requireCondition(raw.pid===this.scope.pid&&raw.window_id===this.scope.window_id&&raw.window_title===this.scope.room,'CHAT_ROOM_CHANGED');
    const editors=raw.elements.filter(e=>e.role==='Document'&&e.label==='RichEdit Control'&&e.enabled&&e.actions.includes('set_value')&&e.actions.includes('text'));
    requireCondition(editors.length===1&&typeof editors[0]!.value==='string','CHAT_COMPOSER_AMBIGUOUS');
    const editor=editors[0]!;
    requireCondition(editor.element_token.startsWith(raw.snapshot_id+':'),'CHAT_TOKEN_STALE');
    // Kakao TextPattern has one trailing document CR, never loose trim.
    const value=editor.value!.replace(/\r$/u,'');
    return {raw,editor,value};
  }
  private async inputState(s:ChatSnapshot){
    // One shallow native read, no extra screenshot or model call. Human edits,
    // a reused window or changed bounds invalidate the earlier visual intent.
    const next=await this.read(false);
    requireCondition(next.value===s.value&&JSON.stringify(next.raw.window_bounds)===s.bounds,'CHAT_STATE_CHANGED_BEFORE_INPUT');
    return next;
  }
  private fresh(capture_id:string){
    this.valid();requireCondition(!this.busy,'CHAT_BUSY');
    const s=this.current;
    requireCondition(s!==null&&s.capture_id===capture_id&&Date.now()-s.at<=60_000,'CHAT_FRESH_OBSERVATION_REQUIRED');
    return s;
  }
  async draft(capture_id:string,emptyComposerSeen:boolean){
    const s=this.fresh(capture_id);
    requireCondition(s.visual&&emptyComposerSeen&&(s.value===''||s.value==='메시지 입력'),'CHAT_NONEMPTY_DRAFT_PRESERVED');
    this.busy=true;this.current=null;this.approval=null;let claimed=false;
    try{
      const fresh=await this.inputState(s);this.claim('draft');claimed=true;
      const result=await this.port.call('set_value',{...this.target(),element_token:fresh.editor.element_token,value:this.scope.message});
      this.finish('draft','dispatched_unverified');return result;
    }catch(error){if(claimed)this.finish('draft','unknown');throw error;}finally{this.busy=false;}
  }
  /** A human/connected agent may correct the exact failed local draft after
   * inspecting it. Never use this to overwrite a pre-existing user's draft. */
  async repairDraft(capture_id:string,expectedCurrentValue:string){
    const s=this.fresh(capture_id),owned=this.db.prepare("SELECT status,binding FROM cua_chat_effect WHERE request_id=? AND operation='draft'").get(this.scope.request_id);
    requireCondition(s.visual&&owned?.binding===this.binding&&['dispatched_unverified','unknown'].includes(String(owned.status))&&expectedCurrentValue===s.value&&s.value!==this.scope.message,'CHAT_OWNED_FAILED_DRAFT_REQUIRED');
    this.busy=true;this.current=null;this.approval=null;let claimed=false;
    try{const fresh=await this.inputState(s);this.claim('repair_draft');claimed=true;const result=await this.port.call('set_value',{...this.target(),element_token:fresh.editor.element_token,value:this.scope.message});this.finish('repair_draft','dispatched_unverified');return result;}
    catch(error){if(claimed)this.finish('repair_draft','unknown');throw error;}finally{this.busy=false;}
  }
  verifyDraft(capture_id:string){
    const s=this.fresh(capture_id);requireCondition(s.value===this.scope.message,'CHAT_DRAFT_MISMATCH');
    this.finish('draft','readback_verified');this.finish('repair_draft','readback_verified');return {message_sha256:sha(s.value),room_sha256:sha(this.scope.room)};
  }
  /** Only the trusted host's action-time confirmation handler may call this.
   * A model judgment, initial task intent or cached procedure is not approval. */
  confirmSend(capture_id:string,confirmation:{source:'human_action_time';room:string;message:string;received_at_ms:number}){
    const s=this.fresh(capture_id);this.verifyDraft(capture_id);
    requireCondition(s.visual&&confirmation.source==='human_action_time'&&confirmation.room===this.scope.room&&confirmation.message===s.value&&confirmation.received_at_ms<=Date.now()&&Date.now()-confirmation.received_at_ms<=60_000,'CHAT_ACTION_TIME_CONFIRMATION_REQUIRED');
    this.approval={capture_id,expires_at_ms:Date.now()+30_000};
  }
  async send(capture_id:string,button:{x:number;y:number}){
    const s=this.fresh(capture_id);
    requireCondition(s.value===this.scope.message&&s.visual&&this.approval?.capture_id===capture_id&&this.approval.expires_at_ms>Date.now(),'CHAT_ACTION_TIME_CONFIRMATION_REQUIRED');
    requireCondition(Number.isFinite(button.x)&&Number.isFinite(button.y)&&button.x>0&&button.x<s.width&&button.y>0&&button.y<s.height,'CHAT_BUTTON_OUTSIDE_CAPTURE');
    const approvedUntil=this.approval.expires_at_ms;this.busy=true;this.current=null;this.approval=null;let claimed=false;
    try{
      await this.inputState(s);requireCondition(Date.now()<approvedUntil,'CHAT_CONFIRMATION_EXPIRED');this.claim('send');claimed=true;
      const result=await this.port.call('click',{...this.target(),scope:'window',capture_id,x:button.x,y:button.y,count:1,delivery_mode:'background'});
      this.finish('send','dispatched_unverified');return result;
    }catch(error){if(claimed)this.finish('send','unknown');throw error;}finally{this.busy=false;}
  }
}
