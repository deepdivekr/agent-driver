import {randomUUID,createHash} from 'node:crypto';
import {closeSync,constants,existsSync,fchmodSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';

const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/u);
const platform=z.enum(['telegram','slack','discord']);
const label=z.string().trim().min(1).max(80).refine(value=>!/[\x00-\x1f\x7f]/u.test(value));
const token=z.string().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/u);
const chat=z.string().regex(/^(?:-?\d{1,25}|@[A-Za-z0-9_]{5,32})$/u);
const supplied=z.object({id:id,platform,label,telegram_bot_token:z.string().optional(),telegram_chat_id:z.string().optional(),webhook_url:z.string().optional()}).strict();
export const deliverySettingsUpdateSchema=z.object({revision:z.number().int().nonnegative(),targets:z.array(supplied).max(20),default_target_ids:z.array(id).max(21)}).strict();
export type DeliverySettingsUpdate=z.input<typeof deliverySettingsUpdateSchema>;
export type DeliveryPlatform=z.infer<typeof platform>;
export type DeliveryTarget=z.infer<typeof supplied>;
const savedSchema=z.object({format:z.literal(1),revision:z.number().int().positive(),targets:z.array(supplied).max(20),default_target_ids:z.array(id).max(21)}).strict();
type Saved=z.infer<typeof savedSchema>;

export const deliverySettingsPath=(config:Pick<HostConfig,'dbPath'>)=>join(dirname(config.dbPath),'.connection','deliveries.json');

function webhook(raw:string,kind:'slack'|'discord'){
  requireCondition(raw.length<=2048,'DELIVERY_WEBHOOK_INVALID');
  let url:URL;try{url=new URL(raw);}catch{throw Error('DELIVERY_WEBHOOK_INVALID');}
  requireCondition(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash,'DELIVERY_WEBHOOK_INVALID');
  if(kind==='slack')requireCondition((url.hostname==='hooks.slack.com'||url.hostname==='hooks.slack-gov.com')&&/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(url.pathname),'DELIVERY_WEBHOOK_INVALID');
  else requireCondition(url.hostname==='discord.com'&&/^\/api\/(?:v\d+\/)?webhooks\/\d{10,25}\/[A-Za-z0-9_-]{20,200}$/u.test(url.pathname),'DELIVERY_WEBHOOK_INVALID');
  return url.toString();
}
function normalized(input:z.infer<typeof supplied>,prior?:DeliveryTarget):DeliveryTarget{
  requireCondition(input.id!=='app','DELIVERY_TARGET_RESERVED');
  requireCondition(!prior||prior.platform===input.platform,'DELIVERY_TARGET_PLATFORM_CONFLICT');
  if(input.platform==='telegram'){
    requireCondition(input.webhook_url===undefined,'DELIVERY_TARGET_FIELD_INVALID');
    return {id:input.id,platform:input.platform,label:input.label,telegram_bot_token:token.parse(input.telegram_bot_token||prior?.telegram_bot_token),telegram_chat_id:chat.parse(input.telegram_chat_id||prior?.telegram_chat_id)};
  }
  requireCondition(input.telegram_bot_token===undefined&&input.telegram_chat_id===undefined,'DELIVERY_TARGET_FIELD_INVALID');
  return {id:input.id,platform:input.platform,label:input.label,webhook_url:webhook(input.webhook_url||prior?.webhook_url||'',input.platform)};
}
/** Recheck saved or injected targets at the network boundary. */
export function validateDeliveryTarget(raw:unknown):DeliveryTarget{return normalized(supplied.parse(raw));}
function safeFile(path:string){const stat=lstatSync(path);requireCondition(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'DELIVERY_SETTINGS_UNSAFE_FILE');if(process.platform!=='win32')requireCondition((stat.mode&0o077)===0,'DELIVERY_SETTINGS_UNSAFE_MODE');}
export function readDeliverySettings(path:string):Saved|null{
  try{safeFile(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  requireCondition(!lstatSync(dirname(path)).isSymbolicLink(),'DELIVERY_SETTINGS_UNSAFE_DIRECTORY');
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    requireCondition(fstatSync(fd).size<=32_000,'DELIVERY_SETTINGS_TOO_LARGE');
    const saved=savedSchema.parse(JSON.parse(readFileSync(fd,'utf8')));
    for(const target of saved.targets)validateDeliveryTarget(target);
    requireCondition(new Set(saved.targets.map(target=>target.id)).size===saved.targets.length,'DELIVERY_TARGET_DUPLICATE');
    requireCondition(new Set(saved.default_target_ids).size===saved.default_target_ids.length&&saved.default_target_ids.every(id=>id==='app'||saved.targets.some(target=>target.id===id)),'DELIVERY_TARGET_NOT_CONFIGURED');
    return saved;
  }catch{throw Error('DELIVERY_SETTINGS_INVALID');}finally{closeSync(fd);}
}
export type PublicDeliverySettings={revision:number;targets:Array<{id:string;platform:DeliveryPlatform;label:string;configured:true;connection:'stored_unverified'}>;default_target_ids:string[];app_available:true};
export class WorkDeliverySettings{
  constructor(readonly path:string){}
  static fromConfig(config:Pick<HostConfig,'dbPath'>){return new WorkDeliverySettings(deliverySettingsPath(config));}
  private read(){return readDeliverySettings(this.path);}
  publicState():PublicDeliverySettings{
    const saved=this.read();return {revision:saved?.revision??0,targets:(saved?.targets??[]).map(({id,platform,label})=>({id,platform,label,configured:true as const,connection:'stored_unverified' as const})),default_target_ids:saved?.default_target_ids??['app'],app_available:true};
  }
  targetSnapshot(id:string):{target:DeliveryTarget;fingerprint:string}|null{
    const target=this.read()?.targets.find(target=>target.id===id);return target?{target,fingerprint:createHash('sha256').update(JSON.stringify(target)).digest('hex')}:null;
  }
  target(id:string):DeliveryTarget|null{return this.targetSnapshot(id)?.target??null;}
  fingerprint(id:string):string|null{return this.targetSnapshot(id)?.fingerprint??null;}
  save(raw:unknown):PublicDeliverySettings{
    const update=deliverySettingsUpdateSchema.parse(raw),directory=dirname(this.path);mkdirSync(directory,{recursive:true,mode:0o700});
    requireCondition(lstatSync(directory).isDirectory()&&!lstatSync(directory).isSymbolicLink(),'DELIVERY_SETTINGS_UNSAFE_DIRECTORY');
    const lock=join(directory,'.delivery-settings.lock');let lockFd:number;
    try{lockFd=openSync(lock,'wx',0o600);}catch{throw Error('DELIVERY_SETTINGS_BUSY');}
    const temporary=join(directory,`.${randomUUID()}.tmp`);
    try{
      const prior=this.read();requireCondition(update.revision===(prior?.revision??0),'DELIVERY_SETTINGS_CONFLICT');
      requireCondition(new Set(update.targets.map(item=>item.id)).size===update.targets.length,'DELIVERY_TARGET_DUPLICATE');
      const targets=update.targets.map(item=>normalized(item,prior?.targets.find(old=>old.id===item.id)));
      requireCondition(new Set(update.default_target_ids).size===update.default_target_ids.length,'DELIVERY_SELECTION_DUPLICATE');
      requireCondition(update.default_target_ids.every(id=>id==='app'||targets.some(target=>target.id===id)),'DELIVERY_TARGET_NOT_CONFIGURED');
      const next:Saved={format:1,revision:update.revision+1,targets,default_target_ids:update.default_target_ids};
      const fd=openSync(temporary,'wx',0o600);try{fchmodSync(fd,0o600);writeFileSync(fd,JSON.stringify(savedSchema.parse(next))+'\n');}finally{closeSync(fd);}
      renameSync(temporary,this.path);return this.publicState();
    }finally{if(existsSync(temporary))unlinkSync(temporary);closeSync(lockFd);unlinkSync(lock);}
  }
}
