import {readFileSync, realpathSync, statSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {requireCondition, type ProjectBinding} from '../core/contracts.js';

const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const TerminalConfigSchema=z.object({
  executable:z.string().min(1),version:z.literal('2.1.126'),mode:z.literal('structured').default('structured'),
  tools:z.array(z.enum(['Read','Edit','Write','Glob','Grep'])).max(5).default([]),
  max_turns:z.number().int().min(1).max(100).default(20),
  turn_deadline_ms:z.number().int().min(1000).max(600000).default(120000),
  spool_bytes:z.number().int().min(65536).max(16777216).default(4194304),
}).strict();
export type TerminalConfig=z.infer<typeof TerminalConfigSchema>;
export const HostConfigSchema=z.object({
  schema_version:z.literal(1), project_id:identifier, caller_ref:identifier,
  account_ref:identifier, worktree:z.string().min(1), data_dir:z.string().min(1),
  environment:z.enum(['production','fixture']).default('production'),
  fixture_url:z.string().url().optional(),
  recovery_policy:z.enum(['auto_resume','prepare_only']).default('auto_resume'),
  terminal:TerminalConfigSchema.optional(),
}).strict();
export interface HostConfig {
  path:string; fingerprint:string; dbPath:string; environment:'production'|'fixture';
  fixtureUrl:string|null; project:ProjectBinding;
  recoveryPolicy:'auto_resume'|'prepare_only';
  terminal:TerminalConfig|null;
}
export function loadHostConfig(path:string):HostConfig {
  const actual=realpathSync(path);requireCondition(statSync(actual).size<=16_384,'CONFIG_TOO_LARGE');
  const raw=HostConfigSchema.parse(JSON.parse(readFileSync(actual,'utf8')));
  const worktree=realpathSync(isAbsolute(raw.worktree)?raw.worktree:resolve(dirname(actual),raw.worktree));
  requireCondition(statSync(worktree).isDirectory(),'INVALID_WORKTREE');
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
    terminal={...raw.terminal,executable};executableStamp={executable,size:stat.size,mtime:stat.mtimeMs};
  }
  const project:ProjectBinding={id:raw.project_id,callerRef:raw.caller_ref,accountRef:raw.account_ref,worktree,profileRef:resolve(data,'profiles',raw.project_id),allowedOrigins:origin?[origin]:[],capabilities:[...(origin?['fixture.draft.save']:[]),...(terminal?['coding.session']:[])]};
  return {path:actual,dbPath:resolve(data,'runtime.sqlite'),environment:raw.environment,fixtureUrl:raw.fixture_url??null,project,recoveryPolicy:raw.recovery_policy,terminal,
    fingerprint:createHash('sha256').update(JSON.stringify({raw,worktree,data,...(terminal?{executableStamp}:{})})).digest('hex')};
}
