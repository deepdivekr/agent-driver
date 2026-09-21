import {readFileSync, realpathSync, statSync} from 'node:fs';
import {dirname, isAbsolute, resolve, relative} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {requireCondition, type ProjectBinding} from '../core/contracts.js';
import {fileDelegation} from '../terminal/file-contracts.js';
import {resourceBudgetSchema,type ResourceBudget} from '../resources/budget.js';
import {storagePolicySchema,type StoragePolicy} from '../storage/budget.js';
import {packPolicySchema,type PackPolicy} from '../packs/contracts.js';

const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const TerminalConfigSchema=z.object({
  executable:z.string().min(1),version:z.literal('2.1.126'),mode:z.literal('structured').default('structured'),
  tools:z.array(z.enum(['Read','Edit','Write','Glob','Grep'])).max(5).default([]),
  max_turns:z.number().int().min(1).max(100).default(20),
  turn_deadline_ms:z.number().int().min(1000).max(600000).default(120000),
  spool_bytes:z.number().int().min(65536).max(16777216).default(4194304),
  files:fileDelegation.optional(),
}).strict();
export type TerminalConfig=z.infer<typeof TerminalConfigSchema>;
export const HostConfigSchema=z.object({
  schema_version:z.literal(1), project_id:identifier, caller_ref:identifier,
  account_ref:identifier, worktree:z.string().min(1), data_dir:z.string().min(1),
  environment:z.enum(['production','fixture']).default('production'),
  fixture_url:z.string().url().optional(),
  recovery_policy:z.enum(['auto_resume','prepare_only']).default('auto_resume'),
  terminal:TerminalConfigSchema.optional(),
  resources:resourceBudgetSchema.optional(),
  storage:storagePolicySchema.optional(),
  packs:packPolicySchema.optional(),
}).strict();
export interface HostConfig {
  path:string; fingerprint:string; dbPath:string; environment:'production'|'fixture';
  fixtureUrl:string|null; project:ProjectBinding;
  recoveryPolicy:'auto_resume'|'prepare_only';
  terminal:TerminalConfig|null;
  resources:ResourceBudget|null;
  storage:StoragePolicy|null;
  packs:PackPolicy|null;
}
export function loadHostConfig(path:string):HostConfig {
  const actual=realpathSync(path);requireCondition(statSync(actual).size<=16_384,'CONFIG_TOO_LARGE');
  const raw=HostConfigSchema.parse(JSON.parse(readFileSync(actual,'utf8')));
  const worktree=realpathSync(isAbsolute(raw.worktree)?raw.worktree:resolve(dirname(actual),raw.worktree));
  const worktreeStat=statSync(worktree);requireCondition(worktreeStat.isDirectory(),'INVALID_WORKTREE');
  const data=resolve(dirname(actual),raw.data_dir);
  requireCondition(raw.environment==='fixture'||raw.fixture_url===undefined,'FIXTURE_DISABLED');
  let origin:string|undefined;
  if(raw.environment==='fixture'){
    requireCondition(raw.fixture_url,'FIXTURE_URL_REQUIRED');const url=new URL(raw.fixture_url);
    requireCondition(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port!==''&&!url.username&&!url.password&&!url.hash&&!url.search,'FIXTURE_LOOPBACK_REQUIRED');
    requireCondition(/^\/[a-zA-Z0-9._-]+\/(account-a|account-b)\/$/.test(url.pathname)&&url.pathname.endsWith(`/${raw.account_ref}/`),'FIXTURE_ACCOUNT_PATH_REQUIRED');
    origin=url.origin;
  }
  let terminal:TerminalConfig|null=null,executableStamp:unknown=null;
  if(raw.terminal){
    requireCondition(isAbsolute(raw.terminal.executable),'CLI_ABSOLUTE_EXECUTABLE_REQUIRED');
    const executable=realpathSync(raw.terminal.executable),stat=statSync(executable);requireCondition(stat.isFile(),'CLI_EXECUTABLE_REQUIRED');
    requireCondition(new Set(raw.terminal.tools).size===raw.terminal.tools.length,'DUPLICATE_CLI_TOOL');
    requireCondition(raw.terminal.tools.length===0,'CLI_FILE_TOOLS_UNVERIFIED');
    const files=raw.terminal.files;
    if(files){
      requireCondition(process.platform==='linux','FILE_BROKER_PLATFORM_UNVERIFIED');
      const outside=(path:string)=>{const rel=relative(worktree,path);return rel==='..'||rel.startsWith('../')||isAbsolute(rel);};
      requireCondition(outside(actual)&&outside(data),'FILE_CONFIG_AND_DATA_MUST_BE_OUTSIDE_WORKTREE');
      requireCondition(new Set(files.read).size===files.read.length&&new Set(files.write).size===files.write.length,'DUPLICATE_FILE_DELEGATION');
      requireCondition(files.write.every(path=>files.read.includes(path)),'FILE_WRITE_REQUIRES_READ');
      if(files.verifier)requireCondition(files.read.includes(files.verifier.entry)&&new Set(files.verifier.cases.map(c=>c.id)).size===files.verifier.cases.length,'INVALID_VERIFIER_DELEGATION');
    }
    terminal={...raw.terminal,executable};executableStamp={executable,size:stat.size,mtime:stat.mtimeMs};
  }
  const packs=raw.packs??null;
  if(packs){
    for(const items of [packs.sources,packs.targets])requireCondition(new Set(items.map(s=>s.id)).size===items.length,'DUPLICATE_PACK_CONNECTION');
    for(const source of packs.sources)if(source.kind==='file'){
      source.path=resolve(worktree,source.path);
      requireCondition(!/(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.secrets|\.ssh|\.aws|credentials(?:\.json)?)(?:[\\/]|$)/iu.test(source.path),'PACK_SECRET_SOURCE_FORBIDDEN');
    }
    const urls=[...packs.sources.flatMap(s=>s.kind==='file'?[]:[s.url]),...packs.targets.flatMap(t=>[t.url,t.readback_url])];
    for(const value of urls){const url=new URL(value);requireCondition((url.protocol==='https:'||raw.environment==='fixture'&&url.protocol==='http:'&&url.hostname==='127.0.0.1')&&!url.username&&!url.password&&!url.hash,'PACK_URL_NOT_ALLOWED');requireCondition(![...url.searchParams.keys()].some(k=>/token|password|api.?key|secret/iu.test(k)),'PACK_URL_CONTAINS_SECRET');}
    for(const target of packs.targets)requireCondition(new URL(target.url).origin===new URL(target.readback_url).origin,'PACK_READBACK_ORIGIN_MISMATCH');
    requireCondition(packs.models==='off'||packs.model_data_approved,'MODEL_DATA_APPROVAL_REQUIRED');
  }
  const project:ProjectBinding={id:raw.project_id,callerRef:raw.caller_ref,accountRef:raw.account_ref,worktree,profileRef:resolve(data,'profiles',raw.project_id),allowedOrigins:[...new Set([...(origin?[origin]:[]),...(packs?.targets.map(t=>new URL(t.url).origin)??[])])],capabilities:[...(origin?['fixture.draft.save']:[]),...(terminal?['coding.session']:[]),...(packs?.targets.map(t=>`pack.${t.id}`)??[])]};
  return {path:actual,dbPath:resolve(data,'runtime.sqlite'),environment:raw.environment,fixtureUrl:raw.fixture_url??null,project,recoveryPolicy:raw.recovery_policy,terminal,resources:raw.resources??null,storage:raw.storage??null,packs,
    fingerprint:createHash('sha256').update(JSON.stringify({raw,worktree,data,...(terminal?{executableStamp,worktreeIdentity:{device:worktreeStat.dev,inode:worktreeStat.ino}}:{})})).digest('hex')};
}
