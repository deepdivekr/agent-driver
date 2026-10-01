import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function evidenceInputs(){
  const paths=['package.json','package-lock.json','tsconfig.json'];
  function walk(dir){if(!existsSync(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=`${dir}/${entry.name}`;if(entry.isDirectory()){if(entry.name!=='evidence')walk(path);}
    else if(/\.(?:ts|js|mjs)$/.test(path))paths.push(path);
  }}
  for(const dir of ['src','dist','tests','scripts/runtime','scripts/evaluation-v2'])walk(dir);
  // These live acceptance helpers and the matrix harness are executable
  // inputs to phase-112 tests, while their private evidence output is not.
  paths.push(...['live-pack-browser-acceptance.mjs','live-pack-data-acceptance.mjs','live-pack-research-watch-acceptance.mjs','live-pack-work-matrix.mjs'].map(name=>`scripts/${name}`));
  return Object.fromEntries(paths.sort().filter(existsSync).map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
}
export function changedInputs(before,after){return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(path=>before[path]!==after[path]);}
