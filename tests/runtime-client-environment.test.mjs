import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clientEnvironment,clientEnvironmentSummary} from '../dist/integrations/client-environment.js';

// Owner direction 2026-10-02: a connected AI app already has an environment; the check finds it instead of
// treating the installation as empty. Names and counts only.
test('runtime contract the existing Codex and Claude setup is found by name and count, never by value',async t=>{
  const home=await mkdtemp(join(tmpdir(),'client-environment-'));t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,'.codex','skills','staff-code-review'),{recursive:true});await mkdir(join(home,'.codex','skills','webapp-testing'));
  await writeFile(join(home,'.codex','config.toml'),['model = "gpt-6.1-sol"','model_reasoning_effort = "low"','','[mcp_servers.aside]','command = "aside.exe"','args = ["--token","fixture-secret-do-not-read"]','',
    '[mcp_servers."team-docs".env]','API_KEY = "fixture-secret-do-not-read"','','[projects."/home/me/app"]','trust_level = "trusted"','[projects."/home/me/other"]','trust_level = "trusted"',''].join('\n'));
  const codex=clientEnvironment('codex',{},home);
  assert.deepEqual({...codex},{client:'codex',found:true,config_home:'~/.codex',default_model:'gpt-6.1-sol',reasoning:'low',skills:['staff-code-review','webapp-testing'],mcp_servers:['aside','team-docs'],plugins:[],projects:2,browser_hints:['aside']});
  assert.doesNotMatch(JSON.stringify(codex),/fixture-secret|aside\.exe|--token/u,'Commands, arguments and environment values are not read into the result.');
  assert.equal(clientEnvironmentSummary(codex),'기존 환경 확인 · 스킬 2개 · MCP 2개 · 플러그인 0개 · 프로젝트 2개');
  await mkdir(join(home,'.claude','skills','autoplan'),{recursive:true});
  await writeFile(join(home,'.claude.json'),JSON.stringify({mcpServers:{openchrome:{command:'npx',args:['fixture-secret-do-not-read']},'agent-driver':{command:'agent-office'}},projects:{'/home/me/app':{}}}));
  await writeFile(join(home,'.claude','settings.json'),JSON.stringify({model:'opus',effortLevel:'high',enabledPlugins:{'frontend@official':true,'old@official':false},env:{TOKEN:'fixture-secret-do-not-read'}}));
  const claude=clientEnvironment('claude',{},home);
  assert.deepEqual({...claude},{client:'claude',found:true,config_home:'~/.claude',default_model:'opus',reasoning:'high',skills:['autoplan'],mcp_servers:['agent-driver','openchrome'],plugins:['frontend@official'],projects:1,browser_hints:[]});
  assert.doesNotMatch(JSON.stringify(claude),/fixture-secret/u);
  const empty=await mkdtemp(join(tmpdir(),'client-environment-empty-'));t.after(()=>rm(empty,{recursive:true,force:true}));
  assert.equal(clientEnvironment('codex',{},empty).found,false);assert.deepEqual(clientEnvironment('claude',{},empty).skills,[]);
  assert.equal(clientEnvironment('codex',{CODEX_HOME:join(home,'.codex')},empty).found,true,'A custom Codex home is followed.');
});
