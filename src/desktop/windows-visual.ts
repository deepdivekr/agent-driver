import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {WINDOWS_VISUAL_SCRIPT} from './windows-visual-script.js';

export const visualBoundsSchema=z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),width:z.number().int().positive(),height:z.number().int().positive()}).strict();
export type VisualBounds=z.infer<typeof visualBoundsSchema>;
const regionSchema=z.object({text:z.string().min(1).max(2000),bounds:visualBoundsSchema}).strict();
export type VisualRegion=z.infer<typeof regionSchema>;
const resultSchema=z.object({mode:z.enum(['full','region','unchanged']),tiles:z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(2048),regions:z.array(regionSchema).max(512),area:visualBoundsSchema});
export interface VisualFrame {key:string;capture_id:string;width:number;height:number;png:Buffer;window:{pid:number;window_id:number};}
export interface VisualExtraction {regions:VisualRegion[];frame_sha256:string;mode:'full'|'region'|'unchanged';elapsed_ms:number;processed_pixels:number;source:'windows_ocr';confidence:null;}
export interface WindowsVisualReader {read(frame:VisualFrame):Promise<VisualExtraction>;close():Promise<void>;}
export function visualIntersects(a:VisualBounds,b:VisualBounds){return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;}
export function assertVisualBounds(b:VisualBounds,width:number,height:number){requireCondition(b.x+b.width<=width&&b.y+b.height<=height,'VISUAL_BOUNDS_OUTSIDE_CAPTURE');}

/** Lazy Windows OCR child. Its only authority is reading supplied PNG bytes.
 * No model request, screenshot persistence, window access or input mechanism.
 * A fresh whole-window capture guards every reuse. Only changed pixels are OCR'd;
 * unchanged labels are reused as observations, never as permission or completion. */
export class OwnedWindowsVisualReader implements WindowsVisualReader {
  private child:ChildProcessWithoutNullStreams|null=null;
  private opening:Promise<void>|null=null;
  private stopped=false;
  private idle:ReturnType<typeof setTimeout>|null=null;
  private pending:{id:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void}|null=null;
  private cache=new Map<string,{width:number;height:number;png_hash:string;tiles:string[];regions:VisualRegion[];at:number}>();
  readonly counters={full:0,region:0,unchanged:0,processed_pixels:0};
  get pid(){return this.child?.pid??null;}
  private start(){
    requireCondition(process.platform==='win32'&&!this.stopped,'WINDOWS_OCR_HOST_REQUIRED');
    if(this.idle){clearTimeout(this.idle);this.idle=null;}
    if(this.opening)return this.opening;
    this.opening=new Promise<void>((resolve,reject)=>{
      const system=process.env.SystemRoot??'C:\\Windows';
      const child=spawn(join(system,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(WINDOWS_VISUAL_SCRIPT,'utf16le').toString('base64')],{
        windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:system,WINDIR:system,TEMP:process.env.TEMP??join(system,'Temp'),PATH:join(system,'System32')},
      });this.child=child;
      let buffer='',ready=false;
      const fail=(code:string)=>{reject(Error(code));this.pending?.reject(Error(code));this.pending=null;child.kill();};
      const timer=setTimeout(()=>fail('WINDOWS_OCR_START_TIMEOUT'),15_000);
      child.stdout.setEncoding('utf8');child.stderr.resume();
      child.on('error',()=>{clearTimeout(timer);fail('WINDOWS_OCR_START_FAILED');});
      child.on('exit',()=>{clearTimeout(timer);reject(Error('WINDOWS_OCR_EXITED'));this.pending?.reject(Error('WINDOWS_OCR_EXITED'));this.pending=null;if(this.child===child){this.child=null;this.opening=null;}});
      child.stdout.on('data',(chunk:string)=>{
        buffer+=chunk;if(Buffer.byteLength(buffer)>512_000){fail('WINDOWS_OCR_OUTPUT_LIMIT');return;}
        let newline:number;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(!line)continue;
          try{const message=JSON.parse(line) as {ready?:boolean;id?:string};
            if(!ready&&message.ready===true){ready=true;clearTimeout(timer);resolve();}
            else if(this.pending&&message.id===this.pending.id){const request=this.pending;this.pending=null;request.resolve(message);}
            else fail('WINDOWS_OCR_PROTOCOL');
          }catch{fail('WINDOWS_OCR_PROTOCOL');}
        }
      });
    });return this.opening;
  }
  async read(frame:VisualFrame):Promise<VisualExtraction>{
    requireCondition(!this.stopped&&Buffer.isBuffer(frame.png)&&frame.png.length>24&&frame.png.length<=8_000_000&&frame.png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'WINDOWS_OCR_PNG_REQUIRED');
    requireCondition(Number.isSafeInteger(frame.width)&&Number.isSafeInteger(frame.height)&&frame.width>0&&frame.height>0&&frame.width*frame.height<=8_000_000&&frame.png.readUInt32BE(16)===frame.width&&frame.png.readUInt32BE(20)===frame.height,'WINDOWS_OCR_DIMENSIONS');
    const started=performance.now(),hash=createHash('sha256').update(frame.png).digest('hex');
    for(const [key,value] of this.cache)if(Date.now()-value.at>60_000)this.cache.delete(key);
    const previous=this.cache.get(frame.key),sameSize=previous?.width===frame.width&&previous.height===frame.height;
    if(sameSize&&previous.png_hash===hash){previous.at=Date.now();this.counters.unchanged++;return {regions:structuredClone(previous.regions),frame_sha256:hash,mode:'unchanged',elapsed_ms:Math.round(performance.now()-started),processed_pixels:0,source:'windows_ocr',confidence:null};}
    await this.start();requireCondition(this.child&&!this.pending&&!this.stopped,'WINDOWS_OCR_BUSY_OR_CLOSED');
    const id=randomUUID();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const raw=await new Promise<unknown>((resolve,reject)=>{
        this.pending={id,resolve,reject};timer=setTimeout(()=>{reject(Error('WINDOWS_OCR_READ_TIMEOUT'));this.child?.kill();},15_000);
        this.child!.stdin.write(JSON.stringify({id,png:frame.png.toString('base64'),width:frame.width,height:frame.height,window:frame.window,...(sameSize?{previous:{tiles:previous.tiles,bounds:previous.regions.map(r=>r.bounds)}}:{})})+'\n','utf8',error=>{if(error){reject(Error('WINDOWS_OCR_PIPE'));this.child?.kill();}});
      });
      const envelope=z.object({ok:z.boolean(),code:z.string().optional()}).parse(raw);
      requireCondition(envelope.ok,envelope.code==='DPI_UNVERIFIED'?'CUA_VISUAL_DPI_UNVERIFIED':envelope.code==='WINDOW_CHANGED'?'CUA_VISUAL_WINDOW_CHANGED':'WINDOWS_OCR_UNAVAILABLE');
      const result=resultSchema.parse(raw);assertVisualBounds(result.area,frame.width,frame.height);
      requireCondition(result.tiles.length===Math.ceil(frame.width/128)*Math.ceil(frame.height/128),'WINDOWS_OCR_TILE_COUNT');
      for(const region of result.regions)assertVisualBounds(region.bounds,frame.width,frame.height);
      requireCondition(result.mode==='full'||sameSize,'WINDOWS_OCR_CACHE_BINDING');
      const regions=result.mode==='unchanged'?previous!.regions:result.mode==='region'?[...previous!.regions.filter(r=>!visualIntersects(r.bounds,result.area)),...result.regions]:result.regions;
      requireCondition(regions.length<=512,'WINDOWS_OCR_REGION_LIMIT');
      this.cache.delete(frame.key);while(this.cache.size>=4)this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(frame.key,{width:frame.width,height:frame.height,png_hash:hash,tiles:result.tiles,regions,at:Date.now()});
      const pixels=result.mode==='unchanged'?0:result.area.width*result.area.height;this.counters[result.mode]++;this.counters.processed_pixels+=pixels;
      return {regions:structuredClone(regions),frame_sha256:hash,mode:result.mode,elapsed_ms:Math.round(performance.now()-started),processed_pixels:pixels,source:'windows_ocr',confidence:null};
    }finally{
      if(timer)clearTimeout(timer);this.pending=null;
      this.idle=setTimeout(()=>{if(!this.pending){this.child?.stdin.end();this.cache.clear();}},30_000);this.idle.unref();
    }
  }
  async close(){this.stopped=true;this.cache.clear();if(this.idle)clearTimeout(this.idle);const child=this.child;this.pending?.reject(Error('WINDOWS_OCR_CLOSED'));this.pending=null;if(!child)return;
    await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill(),500);child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();if(child.exitCode!==null){clearTimeout(timer);resolve();}});
  }
}
