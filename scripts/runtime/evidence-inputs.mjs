import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function evidenceInputs(){
  const paths=['package.json','package-lock.json','tsconfig.json'];
  function walk(dir){if(!existsSync(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=`${dir}/${entry.name}`;if(entry.isDirectory()){if(entry.name!=='evidence')walk(path);}
    else if(/\.(?:ts|js|mjs)$/.test(path))paths.push(path);
  }}
  for(const dir of ['src','dist','tests','scripts/runtime','scripts/evaluation-v2'])walk(dir);
  return Object.fromEntries(paths.sort().filter(existsSync).map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
}
export function changedInputs(before,after){return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(path=>before[path]!==after[path]);}
