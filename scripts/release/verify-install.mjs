// Real package installation in temporary homes; the seeded Work uses an injected model.
// No personal credentials, production processes, or real-site effects are used.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const pkg=JSON.parse(await readFile(join(repo,'package.json'),'utf8'));
const published=process.argv.includes('--published'),tag='v'+pkg.version;
const base=await mkdtemp(join(tmpdir(),'agent-driver-release-install-'));
const evidence=join(repo,'tests/evidence/release-install');await mkdir(evidence,{recursive:true});
const runId=new Date().toISOString().replaceAll(':','-'),log=join(evidence,runId+'.log');
const browserCache=process.env.PLAYWRIGHT_BROWSERS_PATH||join(homedir(),'.cache/ms-playwright');
const env=Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{NPM_CONFIG_CACHE:process.env.NPM_CONFIG_CACHE||join(homedir(),'.npm'),PLAYWRIGHT_BROWSERS_PATH:browserCache,AGENT_DRIVER_SKIP_CONNECT:'1'});
async function run(command,args,{cwd=repo,environment=env,timeout=360000}={}){
  await appendFile(log,JSON.stringify({command,args,cwd})+'\n');
  return await new Promise((resolveRun,reject)=>{
    const child=spawn(command,args,{cwd,env:environment,stdio:['ignore','pipe','pipe'],detached:true});
    let output='',timer=setTimeout(()=>{process.kill(-child.pid,'SIGTERM');},timeout);
    child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
    child.on('error',reject);child.on('close',async code=>{
      clearTimeout(timer);await appendFile(log,output+'\n');
      if(code!==0)reject(Error(command+' failed ('+code+'); see '+log));
      else resolveRun(output.trim());
    });
  });
}
const report={version:pkg.version,tag,published_source:published,evidence_level:'native_integration',status:'NOT_RUN',work_model:'fixture',external_model_calls:0,browser_cache:browserCache,root:base,cases:[],started_at:new Date().toISOString()};
try{
  let source='https://github.com/deepdivekr/agent-driver.git';
  if(!published){
    source=join(base,'source');
    // Public release tags may already exist on later CI runs. Do not import
    // the current tag into this disposable candidate mirror or overwrite it.
    await run('git',['clone','--quiet','--no-hardlinks','--no-tags',repo,source]);
    for(const baseline of ['v0.1.0','v0.1.1'])await run('git',['-C',source,'fetch','--quiet','origin',`refs/tags/${baseline}:refs/tags/${baseline}`]);
    const ref=await run('git',['rev-parse','HEAD']);
    await run('git',['-C',source,'checkout','--quiet','--detach',ref]);
    await run('git',['-C',source,'tag',tag,ref]);
    source='file://'+source;
    env.AGENT_DRIVER_ALLOW_LOCAL_FIXTURE='1';
  }
  env.AGENT_DRIVER_REPOSITORY_URL=source;
  for(const scenario of ['upgrade-0.1.0','upgrade-0.1.1','fresh']){
    const baseline=scenario.startsWith('upgrade-')?scenario.slice('upgrade-'.length):null;
    const home=join(base,scenario);await mkdir(home);
    const installed=join(home,'.local/share/agent-driver'),state=join(home,'.agent-driver');
    const childEnv={...env,HOME:home,AGENT_DRIVER_CONNECTION_ROOT:state};
    const installer=join(repo,'install.sh');
    if(baseline){
      console.log('Installing v'+baseline+' for upgrade verification');
      await run('bash',[installer],{environment:{...childEnv,AGENT_DRIVER_VERSION:'v'+baseline}});
      assert.equal(JSON.parse(await readFile(join(installed,'package.json'),'utf8')).version,baseline);
      await run(process.execPath,[join(repo,'scripts/release/install-probe.mjs'),installed,state,'seed',baseline],{environment:childEnv});
    }
    const preserve=['connection.json','runtime-config.json','release-work-id.json','release-model-settings.json'];
    const before=baseline?await Promise.all(preserve.map(f=>readFile(join(state,f)))):[];
    console.log('Installing '+tag+' ('+scenario+')');
    const started=Date.now();
    await run('bash',[installer],{environment:childEnv});
    assert.equal(JSON.parse(await readFile(join(installed,'package.json'),'utf8')).version,pkg.version);
    const installedSha=await run('git',['-C',installed,'rev-parse','HEAD']);
    if(baseline)for(let i=0;i<preserve.length;i++)assert.deepEqual(await readFile(join(state,preserve[i])),before[i]);
    else await run(process.execPath,[join(repo,'scripts/release/install-probe.mjs'),installed,state,'seed',pkg.version],{environment:childEnv});
    await run(join(home,'.local/bin/agent-driver'),['connection','status'],{cwd:base,environment:childEnv});
    const probe=await run(process.execPath,[join(repo,'scripts/release/install-probe.mjs'),installed,state,'verify',pkg.version],{environment:childEnv});
    const dirty=await run('git',['-C',installed,'status','--porcelain']);
    assert.equal(dirty,'');
    report.cases.push({scenario,baseline,status:'PASS',installed_sha:installedSha,duration_ms:Date.now()-started,checks:['real_npm_ci','real_build','real_chromium','wrapper_from_other_directory','mcp_version','common_tool_catalog','work_id_and_prompt_preserved','model_preferences_preserved','local_pretendard','clean_managed_checkout'],probe:JSON.parse(probe.split('\n').at(-1))});
    console.log(scenario+': PASS');
  }
  report.installer_sha256=createHash('sha256').update(await readFile(join(repo,'install.sh'))).digest('hex');
  report.status='PASS';
}catch(error){report.status='FAIL';report.error=error.message;process.exitCode=1;}
finally{
  report.finished_at=new Date().toISOString();
  const path=join(evidence,runId+'.json');await writeFile(path,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,evidence:path,root:base,error:report.error}));
}
