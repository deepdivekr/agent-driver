import {connect,type Socket} from 'node:net';
import {requireCondition} from '../core/contracts.js';
import {type ControlSurface} from '../interface/config.js';

export interface SurfaceFrame {content_type:'image/jpeg'|'image/bmp';body:Buffer;captured_at:string;}

class Reader {
  #pending=Buffer.alloc(0);#iterator:AsyncIterableIterator<Buffer>;
  constructor(socket:Socket){this.#iterator=socket[Symbol.asyncIterator]();}
  async take(length:number){requireCondition(Number.isInteger(length)&&length>0&&length<=67_108_864,'CONTROL_RFB_READ_INVALID');while(this.#pending.length<length){const next=await this.#iterator.next();requireCondition(!next.done,'CONTROL_RFB_CLOSED');this.#pending=Buffer.concat([this.#pending,Buffer.from(next.value)]);}const out=this.#pending.subarray(0,length);this.#pending=this.#pending.subarray(length);return out;}
}
const write=(socket:Socket,body:Buffer)=>new Promise<void>((resolve,reject)=>socket.write(body,error=>error?reject(error):resolve()));
async function openRfb(port:number){
  const socket=await new Promise<Socket>((resolve,reject)=>{const value=connect({host:'127.0.0.1',port});value.once('error',reject);value.once('connect',()=>resolve(value));});socket.setTimeout(3_000,()=>socket.destroy(new Error('CONTROL_RFB_TIMEOUT')));const reader=new Reader(socket);
  requireCondition((await reader.take(12)).toString('ascii')==='RFB 003.008\n','CONTROL_RFB_PROTOCOL_UNSUPPORTED');await write(socket,Buffer.from('RFB 003.008\n','ascii'));
  const count=(await reader.take(1))[0]!;requireCondition(count>0&&count<=16,'CONTROL_RFB_SECURITY_INVALID');const security=await reader.take(count);requireCondition(security.includes(1),'CONTROL_RFB_SECURITY_UNSUPPORTED');await write(socket,Buffer.from([1]));requireCondition((await reader.take(4)).readUInt32BE(0)===0,'CONTROL_RFB_AUTH_FAILED');await write(socket,Buffer.from([1]));
  const init=await reader.take(24),width=init.readUInt16BE(0),height=init.readUInt16BE(2),name=init.readUInt32BE(20);requireCondition(width>0&&width<=4096&&height>0&&height<=4096&&width*height<=16_777_216&&name<=4096,'CONTROL_RFB_SIZE_INVALID');await reader.take(name);
  // Force 32-bit little-endian true colour so conversion does not depend on the guest default.
  const format=Buffer.alloc(20);format[0]=0;format[4]=32;format[5]=24;format[6]=0;format[7]=1;format.writeUInt16BE(255,8);format.writeUInt16BE(255,10);format.writeUInt16BE(255,12);format[14]=16;format[15]=8;format[16]=0;await write(socket,format);
  const encodings=Buffer.alloc(8);encodings[0]=2;encodings.writeUInt16BE(1,2);encodings.writeInt32BE(0,4);await write(socket,encodings);return {socket,reader,width,height};
}
function bmp(rgb:Buffer,width:number,height:number,maxWidth=640,maxHeight=400){
  const scale=Math.min(1,maxWidth/width,maxHeight/height),outWidth=Math.max(1,Math.floor(width*scale)),outHeight=Math.max(1,Math.floor(height*scale)),stride=(outWidth*3+3)&~3,size=54+stride*outHeight,out=Buffer.alloc(size);out.write('BM');out.writeUInt32LE(size,2);out.writeUInt32LE(54,10);out.writeUInt32LE(40,14);out.writeInt32LE(outWidth,18);out.writeInt32LE(outHeight,22);out.writeUInt16LE(1,26);out.writeUInt16LE(24,28);out.writeUInt32LE(stride*outHeight,34);
  for(let y=0;y<outHeight;y++)for(let x=0;x<outWidth;x++){const sourceX=Math.min(width-1,Math.floor(x/scale)),sourceY=Math.min(height-1,Math.floor((outHeight-1-y)/scale)),source=(sourceY*width+sourceX)*3,target=54+y*stride+x*3;out[target]=rgb[source+2]!;out[target+1]=rgb[source+1]!;out[target+2]=rgb[source]!;}return out;
}
export async function captureVncSurface(port:number):Promise<SurfaceFrame>{
  let socket:Socket|undefined;try{const session=await openRfb(port);socket=session.socket;const request=Buffer.alloc(10);request[0]=3;request.writeUInt16BE(session.width,6);request.writeUInt16BE(session.height,8);await write(socket,request);const rgb=Buffer.alloc(session.width*session.height*3);let painted=0;
    for(let update=0;update<8&&painted<session.width*session.height;update++){const type=(await session.reader.take(1))[0]!;if(type===2)continue;if(type===3){const cut=await session.reader.take(7);await session.reader.take(cut.readUInt32BE(3));continue;}requireCondition(type===0,'CONTROL_RFB_UPDATE_UNSUPPORTED');const header=await session.reader.take(3),rectangles=header.readUInt16BE(1);requireCondition(rectangles>0&&rectangles<=128,'CONTROL_RFB_RECTS_INVALID');for(let index=0;index<rectangles;index++){const rect=await session.reader.take(12),x=rect.readUInt16BE(0),y=rect.readUInt16BE(2),width=rect.readUInt16BE(4),height=rect.readUInt16BE(6),encoding=rect.readInt32BE(8);if(encoding===-223)continue;requireCondition(encoding===0&&x+width<=session.width&&y+height<=session.height,'CONTROL_RFB_RECT_UNSUPPORTED');const pixels=await session.reader.take(width*height*4);for(let row=0;row<height;row++)for(let column=0;column<width;column++){const source=(row*width+column)*4,target=((y+row)*session.width+x+column)*3;rgb[target]=pixels[source+2]!;rgb[target+1]=pixels[source+1]!;rgb[target+2]=pixels[source]!;}painted+=width*height;}}
    requireCondition(painted>0,'CONTROL_RFB_EMPTY_FRAME');return {content_type:'image/bmp',body:bmp(rgb,session.width,session.height),captured_at:new Date().toISOString()};
  }finally{socket?.end();socket?.destroy();}
}
export async function captureBrowserSurface(endpoint:string):Promise<SurfaceFrame>{
  const url=new URL(endpoint);requireCondition(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port!==''&&!url.username&&!url.password&&!url.search&&!url.hash,'CONTROL_SURFACE_LOOPBACK_REQUIRED');
  const {chromium}=await import('playwright');const browser=await chromium.connectOverCDP(endpoint);try{const pages=browser.contexts().flatMap(context=>context.pages()).filter(page=>page.url()!=='about:blank');requireCondition(pages.length===1,'CONTROL_BROWSER_PAGE_AMBIGUOUS');const body=await pages[0]!.screenshot({type:'jpeg',quality:55,scale:'css',animations:'disabled'});requireCondition(body.length<=4_194_304,'CONTROL_SURFACE_FRAME_TOO_LARGE');return {content_type:'image/jpeg',body,captured_at:new Date().toISOString()};}finally{await browser.close();}
}
export function captureSurface(surface:ControlSurface){return surface.kind==='vnc'?captureVncSurface(surface.port):captureBrowserSurface(surface.endpoint);}

// Only endpoints registered by the owned executor are passed here, never page or model input.
export async function captureManagedSurface(endpoint:string):Promise<SurfaceFrame>{
  const url=new URL(endpoint);requireCondition(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Number(url.port)>=1024&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/[a-f0-9]{48}\/frame\/[a-zA-Z0-9._-]+$/u.test(url.pathname),'CONTROL_MANAGED_ENDPOINT_INVALID');
  const response=await fetch(url,{signal:AbortSignal.timeout(3_000),redirect:'error'});
  requireCondition(response.ok&&response.headers.get('content-type')==='image/jpeg','CONTROL_MANAGED_FRAME_UNAVAILABLE');
  const captured=response.headers.get('x-captured-at');requireCondition(captured!==null&&Number.isFinite(Date.parse(captured)),'CONTROL_MANAGED_FRAME_TIMESTAMP_REQUIRED');
  const reader=response.body?.getReader();requireCondition(reader,'CONTROL_MANAGED_FRAME_UNAVAILABLE');const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;requireCondition(size<=4_194_304,'CONTROL_SURFACE_FRAME_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel();}
  const body=Buffer.concat(chunks);requireCondition(body.length>2&&body[0]===0xff&&body[1]===0xd8,'CONTROL_MANAGED_FRAME_INVALID');
  return {content_type:'image/jpeg',body,captured_at:captured};
}
