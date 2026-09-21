import {constants} from 'node:fs';
import {lstat,mkdir,open,readFile,realpath,rename} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertProfileForCatalog,catalogHash,decisionCalibrationProfileSchema,decisionCatalogSchema,decisionHash,stableJson,type DecisionCalibrationProfile,type DecisionCatalog} from './contracts.js';

export const decisionProfileScope=z.enum(['fixture','production']);
export type DecisionProfileScope=z.infer<typeof decisionProfileScope>;
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const installedProfileSchema=z.object({format:z.literal(1),profile_sha256:sha,installed_at:z.string().datetime({offset:true}),profile:decisionCalibrationProfileSchema,report:z.record(z.string(),z.unknown())}).strict();
const activeSchema=z.object({format:z.literal(1),scope:decisionProfileScope,catalog_id:z.string(),catalog_sha256:sha,profile_sha256:sha,previous_profile_sha256:sha.nullable(),activated_at:z.string().datetime({offset:true})}).strict();
type Active=z.infer<typeof activeSchema>;

async function regular(path:string,max=4_194_304){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>max)throw Error('DECISION_REGISTRY_UNSAFE');return stat;}
async function readJson(path:string){await regular(path);return JSON.parse(await readFile(path,'utf8')) as unknown;}
async function atomicJson(path:string,value:unknown){
  await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=join(dirname(path),`.${randomUUID()}.tmp`),handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(stableJson(value)+'\n','utf8');await handle.sync();}finally{await handle.close();}
  await rename(temporary,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
async function activateWithHistory<T>(path:string,value:unknown,activate:()=>Promise<T>){
  const line=stableJson(value)+'\n';await mkdir(dirname(path),{recursive:true,mode:0o700});const handle=await open(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size+Buffer.byteLength(line)>67_108_864)throw Error('DECISION_REGISTRY_UNSAFE');const result=await activate();await handle.write(line);await handle.sync();return result;}finally{await handle.close();}
}

export class DecisionProfileRegistry {
  readonly root:string;
  constructor(root:string){if(!isAbsolute(root))throw Error('DECISION_REGISTRY_ABSOLUTE_REQUIRED');this.root=resolve(root);}
  private async ready(){await mkdir(this.root,{recursive:true,mode:0o700});if(await realpath(this.root)!==this.root)throw Error('DECISION_REGISTRY_REDIRECTED');}
  private profilePath(catalog:DecisionCatalog,hash:string){return join(this.root,'profiles',catalog.id,`${sha.parse(hash)}.json`);}
  private activePath(catalog:DecisionCatalog,scope:DecisionProfileScope){return join(this.root,'active',`${catalog.id}.${scope}.json`);}
  async install(catalogRaw:DecisionCatalog,profileRaw:DecisionCalibrationProfile,report:Record<string,unknown>={}){
    await this.ready();const catalog=decisionCatalogSchema.parse(catalogRaw),profile=assertProfileForCatalog(profileRaw,catalog),profile_sha256=decisionHash(profile),path=this.profilePath(catalog,profile_sha256),record={format:1 as const,profile_sha256,installed_at:new Date().toISOString(),profile,report};
    try{const existing=installedProfileSchema.parse(await readJson(path));if(existing.profile_sha256!==profile_sha256||decisionHash(existing.profile)!==profile_sha256)throw Error('DECISION_PROFILE_IMMUTABILITY_VIOLATION');return {profile_sha256,path,created:false};}
    catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error;}
    await atomicJson(path,record);return {profile_sha256,path,created:true};
  }
  async read(catalogRaw:DecisionCatalog,hash:string){const catalog=decisionCatalogSchema.parse(catalogRaw),record=installedProfileSchema.parse(await readJson(this.profilePath(catalog,hash)));if(record.profile_sha256!==hash||decisionHash(record.profile)!==hash)throw Error('DECISION_PROFILE_HASH_MISMATCH');return {...record,profile:assertProfileForCatalog(record.profile,catalog)};}
  private promotable(profile:DecisionCalibrationProfile,scope:DecisionProfileScope){
    if(profile.status==='provisional'||profile.dataset_sha256===null||profile.calibration_target_precision===null||profile.calibration_confidence_level===null)throw Error('DECISION_PROFILE_NOT_CALIBRATED');
    if(Object.values(profile.rules).some(rule=>rule.execution==='live'&&(rule.source!=='labeled_holdout'||rule.holdout_samples===0||rule.holdout_precision===null||rule.holdout_precision_lower_bound===null||rule.holdout_precision_lower_bound<profile.calibration_target_precision!||rule.risk==='irreversible')))throw Error('DECISION_PROFILE_LIVE_RULE_UNVERIFIED');
    if(scope==='production'&&profile.evidence_level!=='user_environment')throw Error('DECISION_PROFILE_SCOPE_UNVERIFIED');
    if(scope==='fixture'&&!['fixture','user_environment'].includes(profile.evidence_level))throw Error('DECISION_PROFILE_SCOPE_UNVERIFIED');
  }
  async promote(catalogRaw:DecisionCatalog,hash:string,scopeRaw:DecisionProfileScope){
    await this.ready();const catalog=decisionCatalogSchema.parse(catalogRaw),scope=decisionProfileScope.parse(scopeRaw),record=await this.read(catalog,hash);this.promotable(record.profile,scope);const path=this.activePath(catalog,scope);let previous:Active|null=null;
    try{previous=activeSchema.parse(await readJson(path));}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error;}
    if(previous&&previous.catalog_sha256!==catalogHash(catalog))throw Error('DECISION_ACTIVE_CATALOG_MISMATCH');
    const active:Active={format:1,scope,catalog_id:catalog.id,catalog_sha256:catalogHash(catalog),profile_sha256:hash,previous_profile_sha256:previous?.profile_sha256??null,activated_at:new Date().toISOString()};return activateWithHistory(join(this.root,'activation-history.jsonl'),active,async()=>{await atomicJson(path,active);return active;});
  }
  async active(catalogRaw:DecisionCatalog,scopeRaw:DecisionProfileScope){const catalog=decisionCatalogSchema.parse(catalogRaw),scope=decisionProfileScope.parse(scopeRaw),active=activeSchema.parse(await readJson(this.activePath(catalog,scope)));if(active.catalog_sha256!==catalogHash(catalog))throw Error('DECISION_ACTIVE_CATALOG_MISMATCH');const record=await this.read(catalog,active.profile_sha256);this.promotable(record.profile,scope);return {active,profile:record.profile,report:record.report};}
  async rollback(catalogRaw:DecisionCatalog,scopeRaw:DecisionProfileScope){
    const catalog=decisionCatalogSchema.parse(catalogRaw),scope=decisionProfileScope.parse(scopeRaw),current=activeSchema.parse(await readJson(this.activePath(catalog,scope)));if(!current.previous_profile_sha256)throw Error('DECISION_PROFILE_NO_ROLLBACK');
    const previous=await this.read(catalog,current.previous_profile_sha256);this.promotable(previous.profile,scope);const active:Active={...current,profile_sha256:current.previous_profile_sha256,previous_profile_sha256:current.profile_sha256,activated_at:new Date().toISOString()};return activateWithHistory(join(this.root,'activation-history.jsonl'),{...active,rollback:true},async()=>{await atomicJson(this.activePath(catalog,scope),active);return active;});
  }
  async status(catalogRaw:DecisionCatalog,scopeRaw:DecisionProfileScope){const catalog=decisionCatalogSchema.parse(catalogRaw),scope=decisionProfileScope.parse(scopeRaw);try{const value=await this.active(catalog,scope);return {status:'active' as const,scope,profile_sha256:value.active.profile_sha256,profile_id:value.profile.id,profile_status:value.profile.status,evidence_level:value.profile.evidence_level};}catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')return {status:'not_configured' as const,scope};throw error;}}
  async resolve(catalogRaw:DecisionCatalog,scopeRaw:DecisionProfileScope,fallback:DecisionCalibrationProfile){try{return {profile:(await this.active(catalogRaw,scopeRaw)).profile,source:'active' as const};}catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')return {profile:assertProfileForCatalog(fallback,catalogRaw),source:'provisional' as const};throw error;}}
}
