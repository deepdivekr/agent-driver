import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url))),installer=join(root,'install.sh');
function run(executable,args,options={}){const result=spawnSync(executable,args,{encoding:'utf8',...options});return result;}
function must(result){assert.equal(result.status,0,result.stderr||result.stdout);return result;}
async function fixtureSource(base){
  const source=join(base,'source');await mkdir(source);
  await writeFile(join(source,'package.json'),JSON.stringify({name:'fixture-agent-driver',version:'1.0.0',type:'module',scripts:{build:'node build.mjs'}})+'\n');
  await writeFile(join(source,'package-lock.json'),JSON.stringify({name:'fixture-agent-driver',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'fixture-agent-driver',version:'1.0.0'}}})+'\n');
  await writeFile(join(source,'.gitignore'),'node_modules/\ndist/\n');
  await writeFile(join(source,'build.mjs'),"import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/cli.js',`console.log('fixture:'+process.argv.slice(2).join(','))\\n`);\n");
  must(run('git',['init','--initial-branch=main'],{cwd:source}));must(run('git',['config','user.email','fixture@example.test'],{cwd:source}));must(run('git',['config','user.name','Fixture'],{cwd:source}));must(run('git',['add','.'],{cwd:source}));must(run('git',['commit','-m','fixture'],{cwd:source}));return source;
}
async function installEnvironment(base,source){
  const home=join(base,'home'),node=await realpath(process.execPath);await mkdir(home);
  return {...process.env,HOME:home,AGENT_DRIVER_REPOSITORY_URL:`file://${source}`,AGENT_DRIVER_ALLOW_LOCAL_FIXTURE:'1',AGENT_DRIVER_INSTALL_DIR:join(home,'.local','share','agent-driver'),AGENT_DRIVER_BIN_DIR:join(home,'.local','bin'),AGENT_DRIVER_RUNTIME_DIR:join(home,'.local','share','agent-driver-runtime'),AGENT_DRIVER_NODE_BIN:node,AGENT_DRIVER_SKIP_BROWSER_INSTALL:'1',AGENT_DRIVER_SKIP_CONNECT:'1'};
}

test('runtime native bootstrap installs, builds, exposes an absolute wrapper and reruns without user-home or network effects',async t=>{
  const base=await mkdtemp(join(tmpdir(),'agent-driver-bootstrap-'));t.after(()=>rm(base,{recursive:true,force:true}));const source=await fixtureSource(base),environment=await installEnvironment(base,source);
  environment.AGENT_DRIVER_SKIP_CONNECT='0';const first=must(run('bash',[installer],{env:environment}));assert.match(first.stdout,/Agent Driver 내려받기/u);assert.match(first.stdout,/설치 완료/u);assert.match(first.stdout,/관제센터 시작\nfixture:connect/u);
  const launcher=join(environment.AGENT_DRIVER_BIN_DIR,'agent-driver'),result=must(run(launcher,['hello','world'],{env:environment}));assert.equal(result.stdout.trim(),'fixture:hello,world');
  const installed=await realpath(environment.AGENT_DRIVER_INSTALL_DIR);assert.ok(installed.startsWith(await realpath(environment.HOME)+ '/'));
  const second=must(run('bash',[installer],{env:environment}));assert.match(second.stdout,/Agent Driver 소스 업데이트/u);assert.equal((await readFile(join(environment.AGENT_DRIVER_INSTALL_DIR,'.git','agent-driver-managed'),'utf8')).startsWith('format=1\n'),true);
});

test('runtime native bootstrap refuses unmanaged directories and symlink install roots',async t=>{
  const base=await mkdtemp(join(tmpdir(),'agent-driver-bootstrap-refuse-'));t.after(()=>rm(base,{recursive:true,force:true}));const source=await fixtureSource(base),environment=await installEnvironment(base,source);
  await mkdir(environment.AGENT_DRIVER_INSTALL_DIR,{recursive:true});await writeFile(join(environment.AGENT_DRIVER_INSTALL_DIR,'keep.txt'),'user data');
  const unmanaged=run('bash',[installer],{env:environment});assert.notEqual(unmanaged.status,0);assert.match(unmanaged.stderr,/비관리 디렉터리/u);assert.equal(await readFile(join(environment.AGENT_DRIVER_INSTALL_DIR,'keep.txt'),'utf8'),'user data');
  await rm(environment.AGENT_DRIVER_INSTALL_DIR,{recursive:true});const outside=join(environment.HOME,'outside');await mkdir(outside);await mkdir(join(environment.HOME,'.local','share'),{recursive:true});await symlink(outside,environment.AGENT_DRIVER_INSTALL_DIR,'dir');
  const linked=run('bash',[installer],{env:environment});assert.notEqual(linked.status,0);assert.match(linked.stderr,/심볼릭 링크/u);
});

test('runtime contract bootstrap pins official source and toolchain, verifies Node checksum and never requests sudo or evaluates text',async()=>{
  const text=await readFile(installer,'utf8');assert.match(text,/https:\/\/github\.com\/deepdivekr\/agent-driver\.git/u);assert.match(text,/22\.22\.0/u);assert.match(text,/11\.11\.0/u);assert.match(text,/SHASUMS256\.txt/u);assert.match(text,/sha256sum --check/u);assert.match(text,/playwright install chromium/u);
  assert.doesNotMatch(text,/\bsudo\b/u);assert.doesNotMatch(text,/\beval\b/u);assert.doesNotMatch(text,/curl[^\n]*\|\s*(?:ba)?sh/u);
});
