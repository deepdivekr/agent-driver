import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {chmod,mkdir,rename,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';

export const nonInterferingConnectionMode='non_interfering' as const;
export const localConnectionState=z.object({
  format:z.literal(1),connection_id:z.string().uuid(),connected_at:z.string().datetime(),mode:z.literal(nonInterferingConnectionMode),
  computer:z.object({kind:z.literal('persistent_agent_computer'),surface:z.literal('browser'),host_desktop_access:z.literal('none'),host_file_bridge:z.literal('explicit_transfer_only')}).strict(),
  mcp:z.object({command:z.literal('agent-driver mcp'),registration:z.literal('client_managed')}).strict(),
  jev:z.object({status:z.literal('optional')}).strict(),
}).strict();
export type LocalConnectionState=z.infer<typeof localConnectionState>;

export interface LocalConnectionPaths {root:string;state:string;runtimeConfig:string;workspace:string;data:string;}
export interface LocalConnectionScreenModel {
  title:'내 컴퓨터 연결';description:string;
  modes:readonly {id:string;label:string;detail:string;available:boolean;default?:boolean}[];
  status:Readonly<Record<'Browser'|'Hermes'|'Telegram'|'Codex'|'Claude'|'Jev',string>>;
}

/** The screen deliberately exposes one safe, shipped surface. Unsupported surfaces are explanatory only, never consent choices. */
export const localConnectionScreen:LocalConnectionScreenModel=Object.freeze({
  title:'내 컴퓨터 연결',description:'이 기기에서 에이전트가 전용 브라우저와 개발 도구를 사용할 수 있게 합니다.',
  modes:Object.freeze([
    Object.freeze({id:nonInterferingConnectionMode,label:'방해하지 않는 모드',detail:'권장 · 사용자 화면과 브라우저를 건드리지 않는 전용 Agent Computer를 사용합니다.',available:true,default:true}),
    Object.freeze({id:'agent_desktop',label:'에이전트 전용 데스크톱',detail:'준비 중 · 현재 제공되는 전용 surface는 브라우저입니다.',available:false}),
    Object.freeze({id:'shared_screen',label:'공유 화면 허용',detail:'제공하지 않음 · 사용자 desktop·foreground 제어는 Agent Driver의 권한 범위 밖입니다.',available:false}),
  ]),
  status:Object.freeze({Browser:'첫 브라우저 작업 때 전용 환경을 준비합니다',Hermes:'기본 Agent runtime · MCP로 연결',Telegram:'Hermes gateway를 통한 작업 요청·사람 개입 채널',Codex:'MCP 명령 준비됨',Claude:'MCP 명령 준비됨',Jev:'선택사항 — 빠른 typed 판단이 필요할 때 연결'}),
});

function safeRoot(value:string){
  requireCondition(typeof value==='string'&&value.length>0&&isAbsolute(value),'CONNECTION_ROOT_ABSOLUTE_REQUIRED');
  const root=resolve(value);requireCondition(root!==sep,'CONNECTION_ROOT_UNSAFE');return root;
}
export function connectionRoot(environment:NodeJS.ProcessEnv=process.env){
  const configured=environment.AGENT_DRIVER_CONNECTION_ROOT;
  return safeRoot(configured===undefined?join(homedir(),'.agent-driver'):configured);
}
export function localConnectionPaths(root=connectionRoot()):LocalConnectionPaths{
  const base=safeRoot(root);
  return Object.freeze({root:base,state:join(base,'connection.json'),runtimeConfig:join(base,'runtime-config.json'),workspace:join(base,'workspace'),data:join(base,'data')});
}
async function writePrivateJson(path:string,value:unknown){
  const temporary=join(dirname(path),`.${randomUUID()}.partial`);
  await writeFile(temporary,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});await chmod(temporary,0o600);await rename(temporary,path);await chmod(path,0o600);
}
export async function approveNonInterferingConnection(root=connectionRoot(),now=new Date()):Promise<{state:LocalConnectionState;paths:LocalConnectionPaths}> {
  const paths=localConnectionPaths(root);
  await mkdir(paths.root,{recursive:true,mode:0o700});await chmod(paths.root,0o700);
  await mkdir(paths.workspace,{recursive:true,mode:0o700});await mkdir(paths.data,{recursive:true,mode:0o700});
  const state=localConnectionState.parse({format:1,connection_id:randomUUID(),connected_at:now.toISOString(),mode:nonInterferingConnectionMode,computer:{kind:'persistent_agent_computer',surface:'browser',host_desktop_access:'none',host_file_bridge:'explicit_transfer_only'},mcp:{command:'agent-driver mcp',registration:'client_managed'},jev:{status:'optional'}});
  const runtimeConfig={schema_version:1,project_id:'agent-driver-local',caller_ref:'local-agent',account_ref:'owner',worktree:'workspace',data_dir:'data',environment:'production',recovery_policy:'auto_resume'};
  await writePrivateJson(paths.runtimeConfig,runtimeConfig);await writePrivateJson(paths.state,state);return {state,paths};
}
export function readLocalConnection(root=connectionRoot()):LocalConnectionState|null {
  const path=localConnectionPaths(root).state;if(!existsSync(path))return null;
  return localConnectionState.parse(JSON.parse(readFileSync(path,'utf8')));
}
/** Returns the config consumed by the one universal stdio command: `agent-driver mcp`. */
export function approvedMcpConfigPath(root=connectionRoot()){
  requireCondition(readLocalConnection(root)!==null,'COMPUTER_CONNECTION_REQUIRED');const path=localConnectionPaths(root).runtimeConfig;
  requireCondition(existsSync(path),'COMPUTER_CONNECTION_CONFIG_MISSING');return path;
}
