import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {win32} from 'node:path';
import {type ProjectScan} from './project-scan.js';

/** Network files are read by Windows with its existing login, never mounted or copied. */
export function networkProjectPath(raw:string):string|null{
  const value=raw.trim().replace(/\//gu,'\\');
  if(!value.startsWith('\\\\')||/^\\\\wsl(?:\.localhost|\$)\\/iu.test(value))return null;
  if(value.length>2048||/[\u0000-\u001f]/u.test(value)||/^\\\\[?.]\\/u.test(value))throw Error('PROJECT_NETWORK_PATH_INVALID');
  const parts=value.slice(2).split('\\');
  if(parts.length<3||!parts[0]||!parts[1]||!parts[2]||parts.some(p=>p==='..'||p==='.'||/[<>:"|?*]/u.test(p)))throw Error('PROJECT_NETWORK_PROJECT_FOLDER_REQUIRED');
  return win32.normalize(value).replace(/\\+$/u,'');
}
const powershell='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
function executable(file:string,args:string[],input?:string,timeout=30_000):Promise<string>{
  return new Promise((resolve,reject)=>{
    // Do not carry Node preload hooks into the isolated filesystem reader.
    const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_PATH;
    const child=execFile(file,args,{windowsHide:true,timeout,maxBuffer:600_000,encoding:'utf8',env},(error,stdout)=>{
      if(error){reject(Error(error.killed?'PROJECT_NETWORK_SCAN_TIMEOUT':'PROJECT_NETWORK_WINDOWS_ACCESS_REQUIRED'));return;}resolve(stdout.trim());
    });
    child.stdin?.on('error',()=>{});child.stdin?.end(input??'');
  });
}
export function windowsModulePath(linuxPath:string,distro:string){
  if(!/^[A-Za-z0-9_.-]+$/u.test(distro))throw Error('PROJECT_NETWORK_WSL_REQUIRED');
  const mounted=/^\/mnt\/([a-z])\/(.+)$/u.exec(linuxPath);
  return mounted?`${mounted[1]!.toUpperCase()}:\\${mounted[2]!.replace(/\//gu,'\\')}`:`\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//gu,'\\')}`;
}
export async function scanNetworkProject(raw:string):Promise<ProjectScan>{
  const path=networkProjectPath(raw);if(!path)throw Error('PROJECT_NETWORK_PATH_INVALID');
  const distro=process.env.WSL_DISTRO_NAME;if(process.platform!=='linux'||!distro)throw Error('PROJECT_NETWORK_MOUNT_REQUIRED');
  const node=await executable(powershell,['-NoProfile','-NonInteractive','-Command',"(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source"],undefined,10_000);
  if(!/^[A-Za-z]:\\[^\r\n]*\\node\.exe$/iu.test(node))throw Error('PROJECT_NETWORK_WINDOWS_NODE_REQUIRED');
  const program=`import {pathToFileURL} from 'node:url';
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>4096)process.exit(2);}
try{const {scanProject}=await import(pathToFileURL(process.argv[1]).href);const result=await scanProject(JSON.parse(input).path);process.stdout.write(JSON.stringify({ok:true,result}));}
catch(error){const allowed=['PROJECT_ROOT_TOO_BROAD','PROJECT_DIRECTORY_REQUIRED'];process.stdout.write(JSON.stringify({ok:false,error:allowed.includes(error.message)?error.message:'PROJECT_NETWORK_WINDOWS_ACCESS_REQUIRED'}));}`;
  const module=windowsModulePath(fileURLToPath(new URL('./project-scan.js',import.meta.url)),distro);
  const output=await executable(`/mnt/${node[0]!.toLowerCase()}/${node.slice(3).replace(/\\/gu,'/')}`,['--input-type=module','-e',program,module],JSON.stringify({path}));
  let data;try{data=JSON.parse(output);}catch{throw Error('PROJECT_NETWORK_RESPONSE_INVALID');}
  if(!data?.ok)throw Error(data?.error||'PROJECT_NETWORK_WINDOWS_ACCESS_REQUIRED');
  const scan=data.result as ProjectScan;
  if(scan?.format!==1||!Array.isArray(scan.evidence)||scan.evidence.length>100||!scan.authority||Object.values(scan.authority).some(value=>value!==false)||networkProjectPath(scan.root)?.toLowerCase()!==path.toLowerCase())throw Error('PROJECT_NETWORK_RESPONSE_INVALID');
  return scan;
}
