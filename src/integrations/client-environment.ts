import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';

/** What a connected AI app already has on this computer: where its settings live and the names of its skills,
 * MCP servers and plugins. Read-only. Names and counts only: commands, arguments, tokens and file contents are
 * never read into the result, so a server's secrets cannot leave its own configuration file.
 *
 * The owner's setup is often split in two: the command-line apps inside WSL and the desktop apps on Windows keep
 * separate folders (live: Aside was registered as an MCP server only in the Windows Codex settings). Both are read. */
export interface EnvironmentHome {side:'local'|'windows';home:string;}
export interface ClientEnvironment {
  client:'codex'|'claude';
  found:boolean;
  /** The first place that was found, for a one-line display. */
  config_home:string;
  locations:Array<{side:'local'|'windows';config_home:string}>;
  default_model:string|null;
  reasoning:string|null;
  skills:string[];
  mcp_servers:string[];
  plugins:string[];
  projects:number;
  /** MCP servers whose name says they drive a browser Office can also register (Aside, Neo). */
  browser_hints:Array<'aside'|'neo'>;
}
const LIST_LIMIT=80,name=(value:string)=>value.replace(/[^\p{L}\p{N} ._:@/-]/gu,'').slice(0,80);
const names=(values:Iterable<string>)=>[...new Set([...values].map(name).filter(Boolean))].sort().slice(0,LIST_LIMIT);
// A skill folder may be a link (Windows junctions, links into a shared skill pack); one unreadable entry does not hide the rest.
const folders=(directory:string)=>{let entries:string[];try{entries=readdirSync(directory);}catch{return [];}return entries.filter(entry=>{if(entry.startsWith('.'))return false;try{return statSync(join(directory,entry)).isDirectory();}catch{return existsSync(join(directory,entry,'SKILL.md'));}});};
// Seen from WSL, a Windows link to a skill kept elsewhere is a small file without an extension. It is counted by
// name; its description cannot be read from here.
const skillNames=(directory:string)=>{let entries:string[];try{entries=readdirSync(directory);}catch{return [];}return [...new Set([...folders(directory),...entries.filter(entry=>!entry.startsWith('.')&&!entry.includes('.')&&(()=>{try{const stat=statSync(join(directory,entry));return stat.isFile()&&stat.size<4096;}catch{return true;}})())])];};
const text=(path:string)=>{try{const size=statSync(path).size;return size>4_000_000?'':readFileSync(path,'utf8').replace(/\r\n/gu,'\n');}catch{return '';}};
const json=(path:string)=>{try{return JSON.parse(text(path)||'{}') as Record<string,unknown>;}catch{return {};}};
const keys=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value):[];
const hints=(servers:string[])=>(['aside','neo'] as const).filter(engine=>servers.some(server=>new RegExp(`(?:^|[^a-z])${engine}(?:[^a-z]|$)`,'iu').test(server)));
const shown=(path:string,place:EnvironmentHome)=>{const inside=path.startsWith(place.home)?'~'+path.slice(place.home.length):path;return place.side==='windows'?'Windows '+inside:inside;};

let windowsProfileCache:string|null|undefined;
/** The Windows user folder as a path this process can read, when it runs inside WSL. */
function windowsProfile(environment:NodeJS.ProcessEnv){
  if(environment.AGENT_OFFICE_WINDOWS_PROFILE!==undefined)return environment.AGENT_OFFICE_WINDOWS_PROFILE||null;
  if(environment!==process.env||process.platform!=='linux'||!environment.WSL_DISTRO_NAME)return null;
  if(windowsProfileCache!==undefined)return windowsProfileCache;
  windowsProfileCache=null;
  try{
    const powershell='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    if(existsSync(powershell)){
      const reported=execFileSync(powershell,['-NoProfile','-NonInteractive','-Command','[Environment]::GetFolderPath("UserProfile")'],{timeout:5000,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
      const match=/^([A-Za-z]):\\([^\r\n]+)$/u.exec(reported),path=match?`/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/gu,'/')}`:'';
      if(path&&existsSync(path))windowsProfileCache=path;
    }
  }catch{/* No Windows side is reported when it cannot be asked. */}
  return windowsProfileCache;
}
/** The folders to look in. An injected environment without a home directory (a test, a restricted service) never
 * falls back to the real one. */
export function environmentHomes(environment:NodeJS.ProcessEnv=process.env):EnvironmentHome[]{
  const local=environment.HOME||environment.USERPROFILE||(environment===process.env?homedir():join(tmpdir(),'agent-office-no-home')),windows=windowsProfile(environment);
  return [{side:'local',home:local},...(windows&&windows!==local?[{side:'windows' as const,home:windows}]:[])];
}
interface Found {root:string;found:boolean;model:string|null;reasoning:string|null;skills:string[];servers:string[];plugins:string[];projects:number;}
function codexAt(place:EnvironmentHome,environment:NodeJS.ProcessEnv):Found{
  const root=place.side==='local'&&environment.CODEX_HOME||join(place.home,'.codex'),config=text(join(root,'config.toml'));
  // Section headers and two top-level keys are all that is read from the TOML.
  const top=config.split(/^\[/mu)[0]??'';
  return {root,found:existsSync(root),model:/^model\s*=\s*"([^"\n]{1,80})"/mu.exec(top)?.[1]??null,reasoning:/^model_reasoning_effort\s*=\s*"([a-z]{1,12})"/mu.exec(top)?.[1]??null,
    skills:skillNames(join(root,'skills')),servers:[...config.matchAll(/^\[mcp_servers\.(?:"([^"\]]+)"|([A-Za-z0-9_-]+))[.\]]/gmu)].map(match=>match[1]??match[2]!),
    plugins:[...config.matchAll(/^\[plugins\.(?:"([^"\]]+)"|([A-Za-z0-9_@./-]+))\]/gmu)].map(match=>match[1]??match[2]!),projects:(config.match(/^\[projects\./gmu)??[]).length};
}
function claudeAt(place:EnvironmentHome,environment:NodeJS.ProcessEnv):Found{
  const custom=place.side==='local'&&environment.CLAUDE_CONFIG_DIR,root=custom||join(place.home,'.claude');
  const global=json(custom?join(root,'.claude.json'):join(place.home,'.claude.json')),settings=json(join(root,'settings.json'));
  // The desktop app keeps its own list of MCP servers.
  const desktop=place.side==='windows'?json(join(place.home,'AppData','Roaming','Claude','claude_desktop_config.json')):{};
  return {root,found:existsSync(root),model:typeof settings.model==='string'?name(settings.model):null,reasoning:typeof settings.effortLevel==='string'?name(settings.effortLevel):null,
    skills:skillNames(join(root,'skills')),servers:[...keys(global.mcpServers),...keys(desktop.mcpServers)],
    plugins:Object.entries(settings.enabledPlugins&&typeof settings.enabledPlugins==='object'?settings.enabledPlugins as Record<string,unknown>:{}).filter(([,enabled])=>enabled!==false).map(([plugin])=>plugin),projects:keys(global.projects).length};
}
export function clientEnvironment(client:'codex'|'claude',environment:NodeJS.ProcessEnv=process.env,places:string|EnvironmentHome[]=environmentHomes(environment)):ClientEnvironment{
  const homes=typeof places==='string'?[{side:'local' as const,home:places}]:places;
  const found=homes.map(place=>({place,at:client==='codex'?codexAt(place,environment):claudeAt(place,environment)})).filter(entry=>entry.at.found);
  const servers=names(found.flatMap(entry=>entry.at.servers)),first=found[0];
  return {client,found:found.length>0,config_home:first?shown(first.at.root,first.place):shown(join(homes[0]!.home,client==='codex'?'.codex':'.claude'),homes[0]!),
    locations:found.map(entry=>({side:entry.place.side,config_home:shown(entry.at.root,entry.place)})),
    default_model:found.map(entry=>entry.at.model).find(Boolean)??null,reasoning:found.map(entry=>entry.at.reasoning).find(Boolean)??null,
    skills:names(found.flatMap(entry=>entry.at.skills)),mcp_servers:servers,plugins:names(found.flatMap(entry=>entry.at.plugins)),projects:found.reduce((sum,entry)=>sum+entry.at.projects,0),browser_hints:hints(servers)};
}
/** One line for the setup log. Counts only. */
export function clientEnvironmentSummary(found:ClientEnvironment){
  return `기존 환경 확인 · 스킬 ${found.skills.length}개 · MCP ${found.mcp_servers.length}개 · 플러그인 ${found.plugins.length}개 · 프로젝트 ${found.projects}개`;
}

/** How the owner already works with their AI apps: the standing instruction files they wrote for those apps
 * (AGENTS.md, CLAUDE.md) and the skills they keep, each with its own description, from every place found. This is
 * given to the planner and the worker as the owner's preferences. It is text the owner already sends to the same AI
 * provider; it never grants a tool, a permission or a fact. Lines that look like credentials are left out. */
export interface OwnerEnvironment {instructions:Array<{app:'codex'|'claude';file:string;text:string}>;skills:Array<{app:'codex'|'claude';name:string;description:string}>;}
const INSTRUCTION_LIMIT=6000,SKILL_LIMIT=40;
const credentialLine=/(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\bapikey_[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._-]{16,}|(?:token|password|secret|api.?key|passwd)\s*[=:]\s*\S{6,})/iu;
const standing=(path:string)=>text(path).split('\n').filter(line=>!credentialLine.test(line)).join('\n').trim().slice(0,INSTRUCTION_LIMIT);
function skillDescription(directory:string){
  const head=text(join(directory,'SKILL.md')).slice(0,4000),front=/^---\n([\s\S]*?)\n---/u.exec(head)?.[1]??'';
  return (/^description:\s*(.+)$/mu.exec(front)?.[1]??'').replace(/^["']|["']$/gu,'').slice(0,160);
}
export function ownerEnvironment(environment:NodeJS.ProcessEnv=process.env,places:string|EnvironmentHome[]=environmentHomes(environment)):OwnerEnvironment{
  const homes=typeof places==='string'?[{side:'local' as const,home:places}]:places,instructions:OwnerEnvironment['instructions']=[],skills:OwnerEnvironment['skills']=[];
  for(const place of homes){
    const codex=place.side==='local'&&environment.CODEX_HOME||join(place.home,'.codex'),claude=place.side==='local'&&environment.CLAUDE_CONFIG_DIR||join(place.home,'.claude'),label=place.side==='windows'?' (Windows)':'';
    for(const [app,path,file] of [['codex',join(codex,'AGENTS.md'),'AGENTS.md'],['claude',join(claude,'CLAUDE.md'),'CLAUDE.md']] as const){
      const body=standing(path);if(body&&!instructions.some(item=>item.app===app&&item.text===body))instructions.push({app,file:file+label,text:body});
    }
    for(const [app,root] of [['codex',join(codex,'skills')],['claude',join(claude,'skills')]] as const)for(const entry of folders(root).sort()){
      const item={app,name:name(entry),description:skillDescription(join(root,entry))};
      if(item.name&&!credentialLine.test(item.description)&&!skills.some(known=>known.app===app&&known.name===item.name))skills.push(item);
    }
  }
  return {instructions,skills:skills.slice(0,SKILL_LIMIT)};
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
