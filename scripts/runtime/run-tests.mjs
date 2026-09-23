import {readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

export function runtimeTestFiles(mode='quick',root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')){
  if(!['quick','soak','full'].includes(mode))throw Error('RUNTIME_TEST_MODE_INVALID');
  const tests=join(root,'tests'),files=readdirSync(tests).filter(name=>/^runtime-.*\.test\.mjs$/u.test(name)).sort();
  const selected=mode==='quick'?files.filter(name=>name!=='runtime-soak.test.mjs'):mode==='soak'?files.filter(name=>name==='runtime-soak.test.mjs'):files;
  if(!selected.length)throw Error('RUNTIME_TESTS_NOT_FOUND');
  return selected.map(name=>join(tests,name));
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),mode=process.argv[2]??'quick';
  const result=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter=./scripts/runtime/test-reporter.mjs',...runtimeTestFiles(mode,root)],{cwd:root,stdio:'inherit'});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}
