import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeProjectPath,scanProject} from '../dist/work/project-scan.js';

test('selected project is scanned read-only; secrets and symlink escapes are excluded',async t=>{
  const parent=await mkdtemp(join(tmpdir(),'driver-import-scan-')),root=join(parent,'project'),outside=join(parent,'outside');
  t.after(()=>rm(parent,{recursive:true,force:true}));
  await mkdir(join(root,'src'),{recursive:true});await mkdir(outside);
  await writeFile(join(root,'README.md'),'# Weather helper\nA Telegram bot for weather updates.\n');
  await writeFile(join(root,'src','bot.ts'),'const telegram = makeBot();\nbot.command("weather", getWeather);\nawait telegram.sendMessage(user, forecast);\n');
  await writeFile(join(root,'.env'),'apikey_this_key_must_never_be_in_scan_123456789');
  await writeFile(join(outside,'secret.ts'),'const token = "outside-secret";');
  await symlink(outside,join(root,'src','link'));
  const result=await scanProject(root);
  assert.equal(result.kind,'bot_only');assert.equal(result.purpose,'Weather helper');
  assert.equal(result.authority.execution,false);assert.equal(result.authority.project_write,false);assert.equal(result.authority.jev_call,false);
  assert.ok(result.evidence.some(item=>item.file==='src/bot.ts'&&item.signal==='bot_channel'));
  assert.ok(!JSON.stringify(result).includes('this_key_must_never'));
  assert.ok(!JSON.stringify(result).includes('outside-secret'));
  assert.ok(result.recommendations.length>=2);
});

test('agentic repository classification relies on observed model, tools and execution flow',async t=>{
  const root=await mkdtemp(join(tmpdir(),'driver-import-agent-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'README.md'),'# Research assistant\n');
  await writeFile(join(root,'main.py'),'import openai\nfrom tools import execute_tool\nasync def run_agent(task):\n  while True:\n    await execute_tool(task)\n');
  const result=await scanProject(root);
  assert.equal(result.kind,'agentic_workflow');assert.ok(result.evidence.every(item=>item.source==='observed_code'));
});

test('relative, broad and wrong-distro project paths are refused',async()=>{
  assert.throws(()=>normalizeProjectPath('./repo'),/PROJECT_PATH_ABSOLUTE_REQUIRED/u);
  assert.throws(()=>normalizeProjectPath('\\\\wsl.localhost\\Other\\home\\repo','linux','Ubuntu-24.04'),/PROJECT_WSL_DISTRO_MISMATCH/u);
  await assert.rejects(scanProject('/'),/PROJECT_ROOT_TOO_BROAD/u);
});
