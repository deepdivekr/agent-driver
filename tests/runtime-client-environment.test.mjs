import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clientEnvironment,clientEnvironmentSummary,environmentHomes,ownerEnvironment,ownerEnvironmentContext,enableOwnerEnvironment,disableOwnerEnvironment} from '../dist/integrations/client-environment.js';

// Owner direction 2026-10-02: a connected AI app already has an environment; the check finds it instead of
// treating the installation as empty. Names and counts only.
test('runtime contract the existing Codex and Claude setup is found by name and count, never by value',async t=>{
  const home=await mkdtemp(join(tmpdir(),'client-environment-'));t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'.codex','skills','staff-code-review'),{recursive:true});await mkdir(join(home,'.codex','skills','webapp-testing'));
  await writeFile(join(home,'.codex','config.toml'),['model = "gpt-6.1-sol"','model_reasoning_effort = "low"','','[mcp_servers.aside]','command = "aside.exe"','args = ["--token","fixture-secret-do-not-read"]','',
    '[mcp_servers."team-docs".env]','API_KEY = "fixture-secret-do-not-read"','','[projects."/home/me/app"]','trust_level = "trusted"','[projects."/home/me/other"]','trust_level = "trusted"',''].join('\n'));
  const codex=clientEnvironment('codex',{},home);
  assert.deepEqual({...codex},{client:'codex',found:true,config_home:'~/.codex',locations:[{side:'local',config_home:'~/.codex'}],default_model:'gpt-6.1-sol',reasoning:'low',skills:['staff-code-review','webapp-testing'],mcp_servers:['aside','team-docs'],plugins:[],projects:2,browser_hints:['aside']});
  assert.doesNotMatch(JSON.stringify(codex),/fixture-secret|aside\.exe|--token/u,'Commands, arguments and environment values are not read into the result.');
  assert.equal(clientEnvironmentSummary(codex),'기존 환경 확인 · 스킬 2개 · MCP 2개 · 플러그인 0개 · 프로젝트 2개');
  await mkdir(join(home,'.claude','skills','autoplan'),{recursive:true});
  await writeFile(join(home,'.claude.json'),JSON.stringify({mcpServers:{openchrome:{command:'npx',args:['fixture-secret-do-not-read']},'agent-driver':{command:'agent-office'}},projects:{'/home/me/app':{}}}));
  await writeFile(join(home,'.claude','settings.json'),JSON.stringify({model:'opus',effortLevel:'high',enabledPlugins:{'frontend@official':true,'old@official':false},env:{TOKEN:'fixture-secret-do-not-read'}}));
  const claude=clientEnvironment('claude',{},home);
  assert.deepEqual({...claude},{client:'claude',found:true,config_home:'~/.claude',locations:[{side:'local',config_home:'~/.claude'}],default_model:'opus',reasoning:'high',skills:['autoplan'],mcp_servers:['agent-driver','openchrome'],plugins:['frontend@official'],projects:1,browser_hints:[]});
  assert.doesNotMatch(JSON.stringify(claude),/fixture-secret/u);
  const empty=await mkdtemp(join(tmpdir(),'client-environment-empty-'));t.after(()=>rm(empty,{recursive:true,force:true}));
  assert.equal(clientEnvironment('codex',{},empty).found,false);assert.deepEqual(clientEnvironment('claude',{},empty).skills,[]);
  assert.equal(clientEnvironment('codex',{CODEX_HOME:join(home,'.codex')},empty).found,true,'A custom Codex home is followed.');
});

// Owner direction 2026-10-02: the owner's standing instructions and skills come along to the planner and the worker.
test('runtime contract the owner\'s instruction files and skill descriptions are read without credential lines, and only when enabled',async t=>{
  const home=await mkdtemp(join(tmpdir(),'owner-environment-'));t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'.codex','skills','staff-code-review'),{recursive:true});await mkdir(join(home,'.claude'),{recursive:true});
  await writeFile(join(home,'.codex','AGENTS.md'),'# Rules\nAnswer in Korean.\nDEPLOY_TOKEN=fixture-secret-do-not-read\nUse KRW for prices.\n');
  await writeFile(join(home,'.claude','CLAUDE.md'),'Keep changes small.\n');
  await writeFile(join(home,'.codex','skills','staff-code-review','SKILL.md'),'---\nname: staff-code-review\ndescription: Use for architecture decisions and code review.\n---\n\n# Body that is not read\n');
  const found=ownerEnvironment({},home);
  assert.deepEqual(found.instructions,[{app:'codex',file:'AGENTS.md',text:'# Rules\nAnswer in Korean.\nUse KRW for prices.'},{app:'claude',file:'CLAUDE.md',text:'Keep changes small.'}]);
  assert.deepEqual(found.skills,[{app:'codex',name:'staff-code-review',description:'Use for architecture decisions and code review.'}]);
  assert.doesNotMatch(JSON.stringify(found),/fixture-secret|Body that is not read/u);
  assert.deepEqual(ownerEnvironmentContext(),{},'Nothing is read unless a service process enabled it.');
  enableOwnerEnvironment(()=>found);t.after(()=>disableOwnerEnvironment());
  assert.deepEqual(ownerEnvironmentContext(),{owner_environment:found});
  enableOwnerEnvironment(()=>({instructions:[],skills:[]}));assert.deepEqual(ownerEnvironmentContext(),{},'An empty environment adds nothing to a model call.');
});

// Owner direction 2026-10-03: the command-line apps in WSL and the desktop apps on Windows keep separate folders,
// and both are the owner's setup (live: Aside was an MCP server only in the Windows Codex settings).
test('runtime contract the Windows side of the owner\'s setup is read together with the local side',async t=>{
  const local=await mkdtemp(join(tmpdir(),'env-local-')),windows=await mkdtemp(join(tmpdir(),'env-windows-'));t.after(()=>Promise.all([rm(local,{recursive:true,force:true}),rm(windows,{recursive:true,force:true})]));
  await mkdir(join(local,'.codex','skills','runner'),{recursive:true});await writeFile(join(local,'.codex','config.toml'),'model = "gpt-6.1-sol"\n[projects."/home/me/app"]\n');
  await mkdir(join(windows,'.codex','skills','runner'),{recursive:true});await mkdir(join(windows,'.codex','skills','dockerize-app'));
  await writeFile(join(windows,'.codex','config.toml'),'model = "gpt-6.1-sol"\r\n\r\n[mcp_servers.aside]\r\ncommand = "C:\\\\fixture-secret-do-not-read\\\\aside.exe"\r\n\r\n[mcp_servers.browseros-neo]\r\nurl = "http://127.0.0.1:9010/mcp"\r\n\r\n[plugins."browser@openai-bundled"]\r\nenabled = true\r\n');
  await writeFile(join(windows,'.codex','AGENTS.md'),'Windows rule: keep answers short.\r\n');await writeFile(join(windows,'.codex','skills','dockerize-app','SKILL.md'),'---\r\nname: dockerize-app\r\ndescription: Containerise an app.\r\n---\r\n');
  await mkdir(join(windows,'.claude','skills','careful'),{recursive:true});await mkdir(join(windows,'AppData','Roaming','Claude'),{recursive:true});
  await writeFile(join(windows,'AppData','Roaming','Claude','claude_desktop_config.json'),JSON.stringify({mcpServers:{'desktop-files':{command:'fixture-secret-do-not-read'}}}));
  const environment={HOME:local,AGENT_OFFICE_WINDOWS_PROFILE:windows};
  assert.deepEqual(environmentHomes(environment),[{side:'local',home:local},{side:'windows',home:windows}]);
  const codex=clientEnvironment('codex',environment);
  assert.deepEqual(codex.locations,[{side:'local',config_home:'~/.codex'},{side:'windows',config_home:'Windows ~/.codex'}]);
  assert.deepEqual(codex.skills,['dockerize-app','runner']);assert.deepEqual(codex.mcp_servers,['aside','browseros-neo']);assert.deepEqual(codex.plugins,['browser@openai-bundled']);assert.deepEqual(codex.browser_hints,['aside','neo']);assert.equal(codex.projects,1);
  const claude=clientEnvironment('claude',environment);
  assert.deepEqual(claude.locations,[{side:'windows',config_home:'Windows ~/.claude'}]);assert.deepEqual(claude.skills,['careful']);assert.deepEqual(claude.mcp_servers,['desktop-files'],'The desktop app\'s own MCP list is read by name.');
  const owner=ownerEnvironment(environment);
  assert.deepEqual(owner.instructions,[{app:'codex',file:'AGENTS.md (Windows)',text:'Windows rule: keep answers short.'}]);
  assert.deepEqual(owner.skills.map(skill=>skill.app+':'+skill.name),['codex:runner','codex:dockerize-app','claude:careful']);assert.equal(owner.skills[1].description,'Containerise an app.');
  assert.doesNotMatch(JSON.stringify([codex,claude,owner]),/fixture-secret|9010/u);
  assert.deepEqual(environmentHomes({HOME:local}),[{side:'local',home:local}],'An injected environment has no Windows side unless it names one.');
});
