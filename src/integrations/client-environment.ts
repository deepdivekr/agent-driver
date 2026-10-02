import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';

/** What a connected AI app already has on this computer: where its settings live and the names of its skills,
 * MCP servers and plugins. Read-only. Names and counts only: commands, arguments, tokens and file contents are
 * never read into the result, so a server's secrets cannot leave its own configuration file. */
export interface ClientEnvironment {
  client:'codex'|'claude';
  found:boolean;
  config_home:string;
  default_model:string|null;
  reasoning:string|null;
  skills:string[];
  mcp_servers:string[];
  plugins:string[];
  projects:number;
  /** MCP servers whose name says they drive a browser Office can also register (Aside, Neo). */
  browser_hints:Array<'aside'|'neo'>;
}
const LIST_LIMIT=60,name=(value:string)=>value.replace(/[^\p{L}\p{N} ._:@/-]/gu,'').slice(0,80);
const names=(values:Iterable<string>)=>[...new Set([...values].map(name).filter(Boolean))].sort().slice(0,LIST_LIMIT);
const folders=(directory:string)=>{try{return readdirSync(directory).filter(entry=>!entry.startsWith('.')&&statSync(join(directory,entry)).isDirectory());}catch{return [];}};
const text=(path:string)=>{try{const size=statSync(path).size;return size>4_000_000?'':readFileSync(path,'utf8');}catch{return '';}};
const hints=(servers:string[])=>(['aside','neo'] as const).filter(engine=>servers.some(server=>new RegExp(`(?:^|[^a-z])${engine}(?:[^a-z]|$)`,'iu').test(server)));
const tilde=(path:string,home:string)=>path.startsWith(home)?'~'+path.slice(home.length):path;

// An injected environment without a home directory (a test, a restricted service) never falls back to the real one.
export function clientEnvironment(client:'codex'|'claude',environment:NodeJS.ProcessEnv=process.env,home=environment.HOME||environment.USERPROFILE||(environment===process.env?homedir():join(tmpdir(),'agent-office-no-home'))):ClientEnvironment{
  if(client==='codex'){
    const root=environment.CODEX_HOME||join(home,'.codex'),config=text(join(root,'config.toml'));
    // Section headers and two top-level keys are all that is read from the TOML.
    const servers=names([...config.matchAll(/^\[mcp_servers\.(?:"([^"\]]+)"|([A-Za-z0-9_-]+))[.\]]/gmu)].map(match=>match[1]??match[2]!));
    const plugins=names([...config.matchAll(/^\[plugins\.(?:"([^"\]]+)"|([A-Za-z0-9_@./-]+))\]/gmu)].map(match=>match[1]??match[2]!));
    const top=config.split(/^\[/mu)[0]??'';
    return {client,found:existsSync(root),config_home:tilde(root,home),default_model:/^model\s*=\s*"([^"\n]{1,80})"/mu.exec(top)?.[1]??null,reasoning:/^model_reasoning_effort\s*=\s*"([a-z]{1,12})"/mu.exec(top)?.[1]??null,
      skills:names(folders(join(root,'skills'))),mcp_servers:servers,plugins,projects:(config.match(/^\[projects\./gmu)??[]).length,browser_hints:hints(servers)};
  }
  const root=environment.CLAUDE_CONFIG_DIR||join(home,'.claude');
  let global:{mcpServers?:Record<string,unknown>;projects?:Record<string,unknown>}={},settings:{model?:unknown;effortLevel?:unknown;enabledPlugins?:Record<string,unknown>}={};
  try{global=JSON.parse(text(environment.CLAUDE_CONFIG_DIR?join(root,'.claude.json'):join(home,'.claude.json'))||'{}') as typeof global;}catch{/* Unreadable settings are reported as absent. */}
  try{settings=JSON.parse(text(join(root,'settings.json'))||'{}') as typeof settings;}catch{/* Unreadable settings are reported as absent. */}
  const servers=names(Object.keys(global.mcpServers??{}));
  return {client,found:existsSync(root),config_home:tilde(root,home),default_model:typeof settings.model==='string'?name(settings.model):null,reasoning:typeof settings.effortLevel==='string'?name(settings.effortLevel):null,
    skills:names(folders(join(root,'skills'))),mcp_servers:servers,plugins:names(Object.entries(settings.enabledPlugins??{}).filter(([,enabled])=>enabled!==false).map(([plugin])=>plugin)),
    projects:Object.keys(global.projects??{}).length,browser_hints:hints(servers)};
}
/** One line for the setup log. Counts only. */
export function clientEnvironmentSummary(found:ClientEnvironment){
  return `기존 환경 확인 · 스킬 ${found.skills.length}개 · MCP ${found.mcp_servers.length}개 · 플러그인 ${found.plugins.length}개 · 프로젝트 ${found.projects}개`;
}

/** How the owner already works with their AI apps: the standing instruction files they wrote for those apps
 * (AGENTS.md, CLAUDE.md) and the skills they keep, each with its own description. This is given to the planner and
 * the worker as the owner's preferences. It is text the owner already sends to the same AI provider; it never
 * grants a tool, a permission or a fact. Lines that look like credentials are left out. */
export interface OwnerEnvironment {instructions:Array<{app:'codex'|'claude';file:string;text:string}>;skills:Array<{app:'codex'|'claude';name:string;description:string}>;}
const INSTRUCTION_LIMIT=6000,SKILL_LIMIT=30;
const credentialLine=/(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\bapikey_[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._-]{16,}|(?:token|password|secret|api.?key|passwd)\s*[=:]\s*\S{6,})/iu;
const standing=(path:string)=>text(path).split('\n').filter(line=>!credentialLine.test(line)).join('\n').trim().slice(0,INSTRUCTION_LIMIT);
function skillDescription(directory:string){
  const head=text(join(directory,'SKILL.md')).slice(0,4000),front=/^---\n([\s\S]*?)\n---/u.exec(head)?.[1]??'';
  return (/^description:\s*(.+)$/mu.exec(front)?.[1]??'').replace(/^["']|["']$/gu,'').slice(0,240);
}
export function ownerEnvironment(environment:NodeJS.ProcessEnv=process.env,home=environment.HOME||environment.USERPROFILE||(environment===process.env?homedir():join(tmpdir(),'agent-office-no-home'))):OwnerEnvironment{
  const codex=environment.CODEX_HOME||join(home,'.codex'),claude=environment.CLAUDE_CONFIG_DIR||join(home,'.claude');
  const instructions=([['codex',join(codex,'AGENTS.md'),'AGENTS.md'],['claude',join(claude,'CLAUDE.md'),'CLAUDE.md']] as const).map(([app,path,file])=>({app,file,text:standing(path)})).filter(item=>item.text);
  const skills=([['codex',join(codex,'skills')],['claude',join(claude,'skills')]] as const).flatMap(([app,root])=>folders(root).sort().map(entry=>({app,name:name(entry),description:skillDescription(join(root,entry))}))).filter(item=>item.name&&!credentialLine.test(item.description)).slice(0,SKILL_LIMIT);
  return {instructions,skills};
}
/** Only a real service process reads the owner's files. A test or a library use of the runtime gets nothing unless
 * it asks for it, so no test depends on, or leaks, what is in the developer's own home folder. */
let ownerEnvironmentSource:(()=>OwnerEnvironment)|null=null;
export function enableOwnerEnvironment(source:()=>OwnerEnvironment=()=>ownerEnvironment()){ownerEnvironmentSource=source;}
export function disableOwnerEnvironment(){ownerEnvironmentSource=null;}
export function ownerEnvironmentContext():{owner_environment?:OwnerEnvironment}{
  // AGENT_OFFICE_OWNER_ENVIRONMENT=on asks for it in a process that is not one of the service entries.
  if(!ownerEnvironmentSource&&process.env.AGENT_OFFICE_OWNER_ENVIRONMENT==='on')ownerEnvironmentSource=()=>ownerEnvironment();
  if(!ownerEnvironmentSource||process.env.AGENT_OFFICE_OWNER_ENVIRONMENT==='off')return {};
  try{const found=ownerEnvironmentSource();return found.instructions.length||found.skills.length?{owner_environment:found}:{};}catch{return {};}
}
