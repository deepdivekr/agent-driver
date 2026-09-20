import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const soakHelp='  soak start --config-file PATH\n  soak status --run PATH\n  soak stop --run PATH\n';
export async function runSoakCli(args:string[]){
  if(args[0]!=='soak')return false;
  const child=spawn(process.execPath,[fileURLToPath(new URL('../../scripts/runtime/soak.mjs',import.meta.url)),...args.slice(1)],{stdio:'inherit',shell:false,windowsHide:true});
  process.exitCode=await new Promise<number>(resolve=>{child.once('error',()=>resolve(1));child.once('close',code=>resolve(code??1));});
  return true;
}
