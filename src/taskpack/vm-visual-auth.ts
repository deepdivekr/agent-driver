import {createHash} from 'node:crypto';
import {connect,type Socket} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {requireCondition} from '../core/contracts.js';

/**
 * A deliberately tiny VM-only visual-input surface. It is not a general VNC
 * controller: the sole effect it can emit is one left-click selecting a
 * Chromium saved-password suggestion that a reviewed browser adapter has
 * anchored to its own password field.
 */
export interface BrowserWindowMetrics {
  screen_x:number;screen_y:number;outer_width:number;outer_height:number;
  inner_width:number;inner_height:number;screen_width:number;screen_height:number;device_pixel_ratio:number;
}
export interface BrowserFieldBox {x:number;y:number;width:number;height:number;}
export interface SavedPasswordSuggestionPolicy {anchor_x_ratio:number;row_offset_y_css_px:number;popover_wait_ms:number;hover_probe_offsets_y_css_px:readonly number[];}
export interface SavedPasswordSuggestionTarget {x:number;y:number;}
export interface VmFramebufferGeometry {width:number;height:number;}
export interface VmObservationRect {x:number;y:number;width:number;height:number;}

const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value);
function validPolicy(policy:SavedPasswordSuggestionPolicy){
  requireCondition(finite(policy.anchor_x_ratio)&&policy.anchor_x_ratio>=0.2&&policy.anchor_x_ratio<=0.8,'INVALID_SAVED_PASSWORD_ANCHOR');
  requireCondition(Number.isInteger(policy.row_offset_y_css_px)&&policy.row_offset_y_css_px>=8&&policy.row_offset_y_css_px<=120,'INVALID_SAVED_PASSWORD_ROW_OFFSET');
  requireCondition(Number.isInteger(policy.popover_wait_ms)&&policy.popover_wait_ms>=50&&policy.popover_wait_ms<=1_000,'INVALID_SAVED_PASSWORD_POPOVER_WAIT');
  requireCondition(Array.isArray(policy.hover_probe_offsets_y_css_px)&&policy.hover_probe_offsets_y_css_px.length>=1&&policy.hover_probe_offsets_y_css_px.length<=8&&policy.hover_probe_offsets_y_css_px.every(offset=>Number.isInteger(offset)&&offset>=8&&offset<=120),'INVALID_SAVED_PASSWORD_HOVER_PROBES');
}
/**
 * Derives an Xvfb/VNC screen coordinate from browser-owned geometry. The
 * caller cannot provide a free-form host coordinate, and the suggestion must
 * fit below the visible password field before any VM input is emitted.
 */
function scaleForFramebuffer(metrics:BrowserWindowMetrics,framebuffer?:VmFramebufferGeometry){
  if(!framebuffer)return {x:1,y:1};
  requireCondition(Number.isInteger(framebuffer.width)&&Number.isInteger(framebuffer.height)&&framebuffer.width>0&&framebuffer.height>0,'INVALID_VM_FRAMEBUFFER_GEOMETRY');
  requireCondition(Number.isInteger(metrics.screen_width)&&Number.isInteger(metrics.screen_height)&&metrics.screen_width>0&&metrics.screen_height>0,'INVALID_VM_BROWSER_SCREEN');
  const x=framebuffer.width/metrics.screen_width,y=framebuffer.height/metrics.screen_height;
  requireCondition(x>=.5&&x<=2&&y>=.5&&y<=2&&Math.abs(x-y)<=.02,'VM_BROWSER_FRAMEBUFFER_SCALE_UNSUPPORTED');
  return {x,y};
}
/**
 * Chromium in the owned Xvfb guest can report CSS viewport dimensions while
 * reporting outer-window and screen dimensions in framebuffer pixels (the
 * current guest uses an 0.8 scale). Support only that bounded low-DPI shape;
 * arbitrary HiDPI/remote-desktop scaling remains fail-closed.
 */
function browserCssScale(metrics:BrowserWindowMetrics){
  requireCondition(metrics.device_pixel_ratio>=.75&&metrics.device_pixel_ratio<=1.01,'VM_VISUAL_AUTH_SCALE_UNSUPPORTED');
  const width=metrics.inner_width*metrics.device_pixel_ratio,height=metrics.inner_height*metrics.device_pixel_ratio;
  requireCondition(metrics.outer_width+1>=width&&metrics.outer_height>height&&width>0&&height>0,'INVALID_VM_BROWSER_SIZE');
  return metrics.device_pixel_ratio;
}
export function savedPasswordSuggestionTarget(metrics:BrowserWindowMetrics,field:BrowserFieldBox,policy:SavedPasswordSuggestionPolicy,framebuffer?:VmFramebufferGeometry):SavedPasswordSuggestionTarget {
  validPolicy(policy);
  for(const value of [metrics.screen_x,metrics.screen_y,metrics.outer_width,metrics.outer_height,metrics.inner_width,metrics.inner_height,metrics.screen_width,metrics.screen_height,metrics.device_pixel_ratio,field.x,field.y,field.width,field.height])requireCondition(finite(value),'INVALID_VM_BROWSER_GEOMETRY');
  requireCondition(Number.isInteger(metrics.screen_x)&&Number.isInteger(metrics.screen_y)&&metrics.screen_x>=0&&metrics.screen_y>=0,'INVALID_VM_BROWSER_POSITION');
  const cssScale=browserCssScale(metrics);
  requireCondition(field.width>0&&field.height>0&&field.x>=0&&field.y>=0&&field.x+field.width<=metrics.inner_width&&field.y+field.height<=metrics.inner_height,'INVALID_VM_PASSWORD_FIELD_BOX');
  const chromeHeight=metrics.outer_height-metrics.inner_height*cssScale,scale=scaleForFramebuffer(metrics,framebuffer);
  const x=Math.round((metrics.screen_x+(field.x+field.width*policy.anchor_x_ratio)*cssScale)*scale.x);
  const y=Math.round((metrics.screen_y+chromeHeight+(field.y+field.height+policy.row_offset_y_css_px)*cssScale)*scale.y);
  requireCondition(x>=metrics.screen_x*scale.x&&x<(metrics.screen_x+metrics.outer_width)*scale.x&&y>=metrics.screen_y*scale.y&&y<(metrics.screen_y+metrics.outer_height)*scale.y,'VM_SAVED_PASSWORD_SUGGESTION_OUTSIDE_WINDOW');
  return {x,y};
}
/** Derives only a Pack-listed candidate row; a caller cannot scan arbitrary guest coordinates. */
export function savedPasswordSuggestionProbeTarget(metrics:BrowserWindowMetrics,field:BrowserFieldBox,policy:SavedPasswordSuggestionPolicy,offset:number,framebuffer?:VmFramebufferGeometry){
  validPolicy(policy);requireCondition(policy.hover_probe_offsets_y_css_px.includes(offset),'VM_SAVED_PASSWORD_PROBE_UNDELEGATED');
  return savedPasswordSuggestionTarget(metrics,field,{...policy,row_offset_y_css_px:offset},framebuffer);
}
/** The first physical click is constrained to the center of the reviewed field. */
export function savedPasswordFieldTarget(metrics:BrowserWindowMetrics,field:BrowserFieldBox,framebuffer?:VmFramebufferGeometry):SavedPasswordSuggestionTarget {
  const policy={anchor_x_ratio:.5,row_offset_y_css_px:48,popover_wait_ms:50,hover_probe_offsets_y_css_px:[48]};validPolicy(policy);
  for(const value of [metrics.screen_x,metrics.screen_y,metrics.outer_width,metrics.outer_height,metrics.inner_width,metrics.inner_height,metrics.screen_width,metrics.screen_height,metrics.device_pixel_ratio,field.x,field.y,field.width,field.height])requireCondition(finite(value),'INVALID_VM_BROWSER_GEOMETRY');
  requireCondition(Number.isInteger(metrics.screen_x)&&Number.isInteger(metrics.screen_y)&&metrics.screen_x>=0&&metrics.screen_y>=0&&metrics.inner_width>0&&metrics.inner_height>0,'INVALID_VM_BROWSER_GEOMETRY');
  const cssScale=browserCssScale(metrics);
  requireCondition(field.width>0&&field.height>0&&field.x>=0&&field.y>=0&&field.x+field.width<=metrics.inner_width&&field.y+field.height<=metrics.inner_height,'INVALID_VM_PASSWORD_FIELD_BOX');
  const scale=scaleForFramebuffer(metrics,framebuffer),chromeHeight=metrics.outer_height-metrics.inner_height*cssScale,x=Math.round((metrics.screen_x+(field.x+field.width/2)*cssScale)*scale.x),y=Math.round((metrics.screen_y+chromeHeight+(field.y+field.height/2)*cssScale)*scale.y);
  requireCondition(x>=metrics.screen_x*scale.x&&x<(metrics.screen_x+metrics.outer_width)*scale.x&&y>=metrics.screen_y*scale.y&&y<(metrics.screen_y+metrics.outer_height)*scale.y,'VM_PASSWORD_FIELD_OUTSIDE_WINDOW');
  return {x,y};
}

class RfbReader {
  #pending=Buffer.alloc(0);
  #iterator:AsyncIterableIterator<Buffer>;
  constructor(socket:Socket){this.#iterator=socket[Symbol.asyncIterator]();}
  async take(length:number){
    requireCondition(Number.isInteger(length)&&length>0&&length<=1_048_576,'INVALID_RFB_READ_LENGTH');
    while(this.#pending.length<length){
      const next=await this.#iterator.next();requireCondition(!next.done,'VM_RFB_CONNECTION_CLOSED');
      this.#pending=Buffer.concat([this.#pending,Buffer.from(next.value)]);
    }
    const output=this.#pending.subarray(0,length);this.#pending=this.#pending.subarray(length);return output;
  }
}
async function openLoopbackRfb(port:number){
  requireCondition(Number.isInteger(port)&&port>=1024&&port<=65535,'INVALID_VM_VNC_PORT');
  return await new Promise<Socket>((resolveOpen,rejectOpen)=>{
    const socket=connect({host:'127.0.0.1',port});
    const fail=(error:Error)=>{socket.destroy();rejectOpen(error);};
    socket.once('error',fail);socket.once('connect',()=>{socket.off('error',fail);resolveOpen(socket);});
  });
}
async function write(socket:Socket,bytes:Buffer){
  await new Promise<void>((resolveWrite,rejectWrite)=>socket.write(bytes,error=>error?rejectWrite(error):resolveWrite()));
}
async function openLoopbackRfbSession(vncPort:number){
  const socket=await openLoopbackRfb(vncPort);socket.setTimeout(5_000,()=>socket.destroy(new Error('VM_RFB_TIMEOUT')));
  const reader=new RfbReader(socket),version=await reader.take(12);requireCondition(version.toString('ascii')==='RFB 003.008\n','VM_RFB_PROTOCOL_UNSUPPORTED');
  await write(socket,Buffer.from('RFB 003.008\n','ascii'));
  const securityCount=(await reader.take(1))[0]!;requireCondition(securityCount>0&&securityCount<=16,'VM_RFB_SECURITY_INVALID');
  const types=await reader.take(securityCount);requireCondition(types.includes(1),'VM_RFB_SECURITY_UNSUPPORTED');
  await write(socket,Buffer.from([1]));requireCondition((await reader.take(4)).readUInt32BE(0)===0,'VM_RFB_AUTH_FAILED');
  await write(socket,Buffer.from([1]));const init=await reader.take(24),width=init.readUInt16BE(0),height=init.readUInt16BE(2),nameLength=init.readUInt32BE(20);
  requireCondition(width>0&&width<=4096&&height>0&&height<=4096&&nameLength<=4096,'VM_RFB_SERVER_INIT_INVALID');await reader.take(nameLength);
  const bitsPerPixel=init[4]!,depth=init[5]!,trueColor=init[7]!;
  requireCondition(bitsPerPixel>0&&bitsPerPixel<=32&&bitsPerPixel%8===0&&depth>0&&depth<=bitsPerPixel&&trueColor!==0,'VM_RFB_PIXEL_FORMAT_UNSUPPORTED');
  return {socket,reader,width,height,bytesPerPixel:bitsPerPixel/8};
}
/** Reports only the agent VM framebuffer dimensions; it never requests pixels. */
export async function loopbackRfbDisplayGeometry(vncPort:number):Promise<VmFramebufferGeometry>{
  const {socket,width,height}=await openLoopbackRfbSession(vncPort);try{return {width,height};}finally{socket.end();socket.destroy();}
}
async function observationFingerprintFromSession(session:Awaited<ReturnType<typeof openLoopbackRfbSession>>,rect:VmObservationRect){
  requireCondition(rect.x+rect.width<=session.width&&rect.y+rect.height<=session.height,'VM_OBSERVATION_OUTSIDE_DISPLAY');
  const encodings=Buffer.alloc(8);encodings[0]=2;encodings.writeUInt16BE(1,2);encodings.writeInt32BE(0,4);await write(session.socket,encodings);
  const request=Buffer.alloc(10);request[0]=3;request.writeUInt16BE(rect.x,2);request.writeUInt16BE(rect.y,4);request.writeUInt16BE(rect.width,6);request.writeUInt16BE(rect.height,8);await write(session.socket,request);
  const discard=async (bytes:number)=>{for(let remaining=bytes;remaining>0;){const chunk=Math.min(remaining,65_536);await session.reader.take(chunk);remaining-=chunk;}};
  // x11vnc can queue a cursor/frame update after a pointer event. Consume at
  // most four such raw updates, never retain their pixels, and use only the
  // explicitly requested tiny rectangle for the fingerprint.
  for(let updateCount=0;updateCount<4;updateCount++){
    const type=(await session.reader.take(1))[0]!;
    if(type===2)continue; // Bell
    if(type===3){const cut=await session.reader.take(7);await discard(cut.readUInt32BE(3));continue;}
    requireCondition(type===0,'VM_RFB_OBSERVATION_UPDATE_UNSUPPORTED');
    const update=await session.reader.take(3),rectangles=update.readUInt16BE(1);requireCondition(rectangles>0&&rectangles<=16,'VM_RFB_OBSERVATION_UPDATE_UNSUPPORTED');
    let fingerprint:string|undefined;
    for(let index=0;index<rectangles;index++){
      const header=await session.reader.take(12),x=header.readUInt16BE(0),y=header.readUInt16BE(2),width=header.readUInt16BE(4),height=header.readUInt16BE(6),encoding=header.readInt32BE(8);
      if(encoding===-223)continue; // DesktopSize pseudo-rectangle has no pixels.
      requireCondition(encoding===0,'VM_RFB_OBSERVATION_RECT_UNSUPPORTED');const pixelBytes=width*height*session.bytesPerPixel;
      if(x===rect.x&&y===rect.y&&width===rect.width&&height===rect.height){fingerprint=createHash('sha256').update(await session.reader.take(pixelBytes)).digest('hex');}
      else await discard(pixelBytes);
    }
    if(fingerprint!==undefined)return fingerprint;
  }
  throw new Error('VM_RFB_OBSERVATION_TARGET_UNAVAILABLE');
}
/**
 * Captures no display artifact. It asks the agent VM for one tiny raw pixel
 * rectangle, immediately returns only its SHA-256 fingerprint, and releases
 * the socket and pixel bytes. This is used solely to verify that Chromium's
 * browser-chrome suggestion appeared before the approved click can proceed.
 */
export async function loopbackRfbObservationFingerprint(vncPort:number,rect:VmObservationRect){
  for(const value of [rect.x,rect.y,rect.width,rect.height])requireCondition(Number.isInteger(value)&&value>=0,'INVALID_VM_OBSERVATION_RECT');
  requireCondition(rect.width>=8&&rect.width<=64&&rect.height>=8&&rect.height<=64,'INVALID_VM_OBSERVATION_RECT');
  let socket:Socket|undefined;
  try {
    const session=await openLoopbackRfbSession(vncPort);socket=session.socket;
    return await observationFingerprintFromSession(session,rect);
  } finally {socket?.end();socket?.destroy();}
}
async function leftClickOnSession(session:Awaited<ReturnType<typeof openLoopbackRfbSession>>,target:SavedPasswordSuggestionTarget){
  requireCondition(target.x<session.width&&target.y<session.height,'VM_SAVED_PASSWORD_TARGET_OUTSIDE_DISPLAY');
  const pointer=(buttonMask:number)=>Buffer.from([5,buttonMask,(target.x>>8)&255,target.x&255,(target.y>>8)&255,target.y&255]);
  // Chromium browser chrome needs a real hover turn before activation. The
  // bounded dwell prevents a coalesced move/press/release from being treated
  // as an outside-popup dismissal by the guest window manager.
  await write(session.socket,pointer(0));await delay(75);await write(session.socket,pointer(1));await delay(50);await write(session.socket,pointer(0));await delay(50);
}
/**
 * x11vnc inside the agent-owned VM exposes a loopback-forwarded RFB 3.8
 * endpoint with `None` security. Any other protocol/security mode fails
 * closed. No framebuffer is requested or retained.
 */
async function leftClickOverLoopbackRfb(vncPort:number,target:SavedPasswordSuggestionTarget){
  requireCondition(Number.isInteger(target.x)&&Number.isInteger(target.y)&&target.x>=0&&target.y>=0,'INVALID_VM_SAVED_PASSWORD_TARGET');
  let socket:Socket|undefined;
  try {
    const session=await openLoopbackRfbSession(vncPort);socket=session.socket;const {width,height}=session;
    requireCondition(target.x<width&&target.y<height,'VM_SAVED_PASSWORD_TARGET_OUTSIDE_DISPLAY');await leftClickOnSession(session,target);
  } finally {socket?.end();socket?.destroy();}
}
async function moveOverLoopbackRfb(vncPort:number,target:SavedPasswordSuggestionTarget){
  requireCondition(Number.isInteger(target.x)&&Number.isInteger(target.y)&&target.x>=0&&target.y>=0,'INVALID_VM_SAVED_PASSWORD_TARGET');
  let socket:Socket|undefined;
  try {
    const session=await openLoopbackRfbSession(vncPort);socket=session.socket;requireCondition(target.x<session.width&&target.y<session.height,'VM_SAVED_PASSWORD_TARGET_OUTSIDE_DISPLAY');
    await write(socket,Buffer.from([5,0,(target.x>>8)&255,target.x&255,(target.y>>8)&255,target.y&255]));
  } finally {socket?.end();socket?.destroy();}
}
async function savedPasswordKeyPressOverLoopbackRfb(vncPort:number,key:'down'|'enter'|'tab'|'escape'){
  let socket:Socket|undefined;
  try {
    const session=await openLoopbackRfbSession(vncPort);socket=session.socket;await savedPasswordKeyPressOnSession(session,key);
  } finally {socket?.end();socket?.destroy();}
}
async function savedPasswordKeyPressOnSession(session:Awaited<ReturnType<typeof openLoopbackRfbSession>>,key:'down'|'enter'|'tab'|'escape'){
  const keySym=key==='down'?0xff54:key==='enter'?0xff0d:key==='tab'?0xff09:0xff1b,keyEvent=(down:boolean)=>Buffer.from([4,down?1:0,0,0,(keySym>>>24)&255,(keySym>>>16)&255,(keySym>>>8)&255,keySym&255]);
  await write(session.socket,keyEvent(true));await delay(50);await write(session.socket,keyEvent(false));
}
/** No generic mouse API is exported: this action can only focus the reviewed password field. */
export async function focusSavedPasswordFieldOverLoopbackRfb(vncPort:number,target:SavedPasswordSuggestionTarget){await leftClickOverLoopbackRfb(vncPort,target);}
/** Retained for reviewed packs that use an explicitly measured suggestion row. */
export async function selectSavedPasswordOverLoopbackRfb(vncPort:number,target:SavedPasswordSuggestionTarget){await leftClickOverLoopbackRfb(vncPort,target);}
/** Selects and accepts Chromium's already-observed first saved-password row in one guest VNC client. */
export async function selectFirstSavedPasswordSuggestionOverLoopbackRfb(vncPort:number){
  let socket:Socket|undefined;
  try {
    const session=await openLoopbackRfbSession(vncPort);socket=session.socket;
    await savedPasswordKeyPressOnSession(session,'down');await delay(100);await savedPasswordKeyPressOnSession(session,'tab');await delay(100);
    return {highlighted_first_row:true,accepted:true};
  } finally {socket?.end();socket?.destroy();}
}
/** Hovering is restricted to Pack-derived saved-password candidates before one selection click. */
export async function hoverSavedPasswordSuggestionOverLoopbackRfb(vncPort:number,target:SavedPasswordSuggestionTarget){await moveOverLoopbackRfb(vncPort,target);}
/** These are the only keyboard events allowed: select and accept Chromium's focused saved-password row. */
export async function highlightFirstSavedPasswordSuggestionOverLoopbackRfb(vncPort:number){await savedPasswordKeyPressOverLoopbackRfb(vncPort,'down');}
export async function acceptHighlightedSavedPasswordSuggestionOverLoopbackRfb(vncPort:number){await savedPasswordKeyPressOverLoopbackRfb(vncPort,'enter');}
/**
 * This is intentionally not a generic keyboard API.  It is the browser's
 * Cancel-equivalent only after a human has visually confirmed the one Pack
 * approved JavaScript dialog in the agent-owned VM.
 */
export async function dismissHumanConfirmedJavaScriptDialogOverLoopbackRfb(vncPort:number){await savedPasswordKeyPressOverLoopbackRfb(vncPort,'escape');}
