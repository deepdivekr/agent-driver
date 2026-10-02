import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
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

export function clientEnvironment(client:'codex'|'claude',environment:NodeJS.ProcessEnv=process.env,home=homedir()):ClientEnvironment{
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
