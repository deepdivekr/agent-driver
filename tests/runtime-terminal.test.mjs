import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, appendFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {TerminalHost} from '../dist/terminal/host.js';
import {TerminalStore} from '../dist/terminal/store.js';
import {RuntimeStore} from '../dist/store/runtime-store.js';
import {pingTerminalHost} from '../dist/terminal/manager.js';
import {claudeArgs, JsonLineDecoder, classifyResult} from '../dist/terminal/claude.js';
import {terminalSubmit, decisionSchema, handoffSchema} from '../dist/terminal/contracts.js';
import {MIGRATION_1, MIGRATION_2, MIGRATION_3} from '../dist/store/migration.js';
import {liveness} from '../dist/supervisor/identity.js';
import {fixtureLaunch} from './helpers/terminal-launcher.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

async function setup(t, overrides = {}, external = false) {
  const root = await mkdtemp(join(tmpdir(), 'driver-terminal-')), path = join(root, 'host.json');
  const raw = {schema_version: 1, project_id: 'terminal-test', caller_ref: 'test-agent', account_ref: 'test-account', environment: 'production', worktree: root, data_dir: join(root, 'data'), terminal: {executable: process.execPath, version: '2.1.126', tools: [], ...overrides}};
  await writeFile(path, JSON.stringify(raw));
  const config = loadHostConfig(path), api = new RuntimeApi(config);
  const host = external ? null : new TerminalHost(config, fixtureLaunch, async () => {});
  if (host) await host.start();
  const x = {root, path, raw, config, api, host, cleanup: []};
  t.after(async () => {for (const cleanup of x.cleanup) await cleanup(); await host?.close(); api.close(); await rm(root, {recursive: true, force: true});});
  return x;
}
async function until(x, predicate, max = 7000) {
  const end = performance.now() + max;
  while (performance.now() < end) {await x.host?.tick(); if (await predicate()) return; await delay(10);}
  // Buffered stdout may settle durable state while it holds the event loop past the
  // observation deadline. Read once more; do not dispatch another host tick.
  if(await predicate())return;
  const observed=x.api.store.sessions(x.config.project.id).map(s=>({state:s.state,error_code:s.error_code,spool_bytes:s.spool_bytes,active_turn_status:s.active_turn_id?x.api.store.turn(s.active_turn_id).status:null}));
  throw Error('condition timeout '+JSON.stringify(observed));
}
async function session(x) {
  const result = await x.api.call('runtime_terminal_start', {request_id: 'session-start'});
  await until(x, () => x.api.store.session(result.session_ref).state === 'input_ready');
  return result.session_ref;
}
function request(x, id, name, prompt = '한글 🐈\r\n두 번째 줄') {
  const session = x.api.store.session(id);
  return {request_id: name, session_ref: id, expected_generation: session.generation, expected_previous_turn_id: session.last_turn_id, prompt};
}
const received = async x => existsSync(join(x.root, 'received.jsonl')) ? (await readFile(join(x.root, 'received.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) : [];

test('runtime contract terminal polling observes settled state at the deadline without another dispatch',async()=>{
  let ticks=0,reads=0;
  const x={host:{tick:async()=>{ticks++;}},api:{store:{sessions:()=>[]}},config:{project:{id:'fixture'}}};
  await until(x,()=>{reads++;return true;},0);assert.equal(ticks,0);assert.equal(reads,1);
  await assert.rejects(until(x,()=>false,0),/condition timeout/);assert.equal(ticks,0);
});

test('runtime native terminal schema v3 migration preserves historical records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-migration-')); t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'runtime.sqlite'), old = new DatabaseSync(path);
  old.exec(MIGRATION_1); old.exec('INSERT INTO schema_version VALUES (1)'); old.exec(MIGRATION_2); old.exec(MIGRATION_3);
  old.prepare('INSERT INTO project VALUES (?,?)').run('old', '{"id":"old","capabilities":[]}'); old.close();
  const store = new TerminalStore(path); assert.equal(store.project('old').id, 'old'); store.close();
  const db = new DatabaseSync(path); assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 7); db.close();
});
test('runtime contract terminal explicit session, no shell/most-recent/bypass flags and file tools fail closed', async t => {
  const x = await setup(t), id = await session(x), s = x.api.store.session(id);
  const first = claudeArgs(x.config, s, false), resumed = claudeArgs(x.config, s, true);
  assert.equal(first[first.indexOf('--session-id') + 1], s.cli_session_id);
  assert.equal(resumed[resumed.indexOf('--resume') + 1], s.cli_session_id);
  for (const forbidden of ['--continue', '--dangerously-skip-permissions', '--bare', '--chrome']) assert.equal(first.includes(forbidden) || resumed.includes(forbidden), false);
  await writeFile(x.path, JSON.stringify({...x.raw, terminal: {...x.raw.terminal, tools: ['Write']}}));
  assert.throws(() => loadHostConfig(x.path), /CLI_FILE_TOOLS_UNVERIFIED/);
  await assert.rejects(x.api.call('runtime_terminal_submit_prompt', {...request(x, id, 'raw'), raw_stdin: 'anything'}));
});
test('runtime contract terminal UTF8 chunk framing, CRLF, long multiline, ANSI and malformed bounds', () => {
  const frames = [], decoder = new JsonLineDecoder(e => frames.push(e)), text = '한국어🐈\r\n\u001b[200~' + '문장'.repeat(3000) + '\u001b[201~';
  const bytes = Buffer.from(JSON.stringify({type: 'user', content: text}) + '\r\n');
  for (const byte of bytes) decoder.push(Buffer.from([byte])); decoder.end(); assert.equal(frames[0].content, text);
  assert.throws(() => new JsonLineDecoder(() => {}, 8).push(Buffer.from('123456789')), /FRAME_TOO_LARGE/);
  assert.throws(() => new JsonLineDecoder(() => {}).push(Buffer.from('invalid\n')));
  const truncated = new JsonLineDecoder(() => {}); truncated.push(Buffer.from('{')); assert.throws(() => truncated.end(), /TRUNCATED/);
  assert.equal(terminalSubmit.parse({request_id: 'first', session_ref: 'session', expected_generation: 1, expected_previous_turn_id: null, prompt: text}).prompt, text);
});
test('runtime fixture terminal three distinct turns retain receipt, completion and readiness as separate events', async t => {
  const x = await setup(t), id = await session(x);
  const prompts = ['기억해: 수달', '한글🐈\r\n다중행\u001b[200~본문', '종료 아닌 턴 완료; $(touch forbidden)'];
  for (let i = 0; i < prompts.length; i++) {
    const accepted = await x.api.call('runtime_terminal_submit_prompt', request(x, id, `turn-${i}`, prompts[i]));
    await until(x, () => x.api.store.session(id).state === 'input_ready');
    const status = await x.api.call('runtime_terminal_status', {session_ref: id});
    assert.equal(status.result.text, prompts[i]); assert.equal(status.project_completed, false); assert.equal(status.status, 'waiting_orchestrator');
    const events = x.api.store.events(x.config.project.id, 'all', 1000).filter(e => e.data.turn_id === accepted.turn_id);
    assert.deepEqual(events.filter(e => !e.kind.endsWith('output')).map(e => e.kind), ['terminal.prompt_accepted', 'terminal.prompt_started', 'terminal.prompt_received', 'terminal.turn_completed']);
  }
  assert.deepEqual((await received(x)).map(r => r.message.content), prompts);
  const events = x.api.store.events(x.config.project.id, 'all', 1000);
  assert.equal(events.filter(e => e.kind === 'terminal.input_ready').length, 4);
  assert.ok((await readFile(join(x.root, 'data', 'terminal-spool', `${id}.jsonl`), 'utf8')).includes('result'));
  assert.equal(existsSync(join(x.root, 'forbidden')), false);
});
test('runtime fixture terminal duplicate request cannot dispatch twice; conflicts, stale generation and previous turn are rejected', async t => {
  const x = await setup(t), id = await session(x), body = request(x, id, 'same');
  const [a, b] = await Promise.all([x.api.call('runtime_terminal_submit_prompt', body), x.api.call('runtime_terminal_submit_prompt', body)]);
  assert.equal(a.turn_id, b.turn_id); assert.equal(a.deduplicated !== b.deduplicated, true);
  await assert.rejects(x.api.call('runtime_terminal_submit_prompt', {...body, prompt: 'conflict'}), /REQUEST_ID_CONFLICT/);
  await until(x, () => x.api.store.session(id).state === 'input_ready');
  assert.equal((await x.api.call('runtime_terminal_submit_prompt', body)).turn_id, a.turn_id);
  await assert.rejects(x.api.call('runtime_terminal_submit_prompt', {...request(x, id, 'stale'), expected_generation: 999}), /STALE_SESSION_GENERATION/);
  await assert.rejects(x.api.call('runtime_terminal_submit_prompt', {...request(x, id, 'wrong'), expected_previous_turn_id: null}), /PREVIOUS_TURN_MISMATCH/);
  assert.equal((await received(x)).length, 1);
});
test('runtime fixture terminal streaming input is refused and interrupted receipt is never replayed', async t => {
  const x = await setup(t), id = await session(x); await writeFile(join(x.root, 'mode.txt'), 'after-ack');
  const a = await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'hold'));
  await until(x, () => x.api.store.turn(a.turn_id).status === 'acknowledged');
  await assert.rejects(x.api.call('runtime_terminal_submit_prompt', request(x, id, 'too-early')), /NOT_INPUT_READY/);
  await x.api.call('runtime_terminal_interrupt', {session_ref: id, expected_generation: 1});
  await until(x, () => x.api.store.session(id).state === 'reconciliation_required');
  assert.equal(x.api.store.turn(a.turn_id).status, 'uncertain');
  await assert.rejects(x.api.call('runtime_terminal_resume', {session_ref: id, expected_generation: 1}));
  assert.equal((await received(x)).length, 1);
});
test('runtime fixture terminal cancellation before dispatch records no CLI receipt or fabricated effect rollback', async t => {
  const x = await setup(t), id = await session(x), a = await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'cancel'));
  await x.api.call('runtime_task_cancel', {task_id: a.task_id});
  await until(x, () => x.api.store.turn(a.turn_id).status === 'cancelled');
  assert.equal((await received(x)).length, 0); assert.equal(x.api.store.task(a.task_id).effect_state, 'none');
});
test('runtime fixture terminal manual writer relinquishment blocks all subsequent automatic input', async t => {
  const x = await setup(t), id = await session(x); x.api.store.requestInterrupt(id, 1, true); await x.host.tick();
  await assert.rejects(x.api.call('runtime_terminal_submit_prompt', request(x, id, 'after-human')), /NOT_INPUT_READY/);
  assert.equal((await received(x)).length, 0);
});
for (const [mode, reason] of [['wrong-session', 'CLI_SESSION_MISMATCH'], ['no-ack', 'UNBOUND_CLI_RESULT'], ['unknown', 'CLI_UNKNOWN_EVENT'], ['oversized', 'CLI_FRAME_TOO_LARGE'], ['flood', 'CLI_SPOOL_QUOTA']]) {
  test(`runtime fixture terminal ${mode} stops and preserves uncertain turn without fake completion`, async t => {
    const x = await setup(t, {spool_bytes: 65536}), id = await session(x); await writeFile(join(x.root, 'mode.txt'), mode);
    await x.api.call('runtime_terminal_submit_prompt', request(x, id, mode));
    await until(x, () => !!x.api.store.session(id).error_code);
    const snapshot = x.api.store.session(id); assert.equal(snapshot.state, 'reconciliation_required'); assert.equal(snapshot.error_code, reason); assert.equal(snapshot.last_turn_id, null);
    if(mode==='flood')assert.ok(snapshot.spool_bytes<=x.config.terminal.spool_bytes,'durable output exceeds the configured quota');
    assert.equal((await received(x)).length, 1);
  });
}
test('runtime fixture terminal turn deadline uses boot monotonic clock and stops only owned child', async t => {
  const x = await setup(t, {turn_deadline_ms: 1000}), id = await session(x); await writeFile(join(x.root, 'mode.txt'), 'before-ack');
  await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'timeout'));
  await until(x, () => x.api.store.session(id).error_code === 'TURN_DEADLINE');
  assert.equal(x.api.store.session(id).state, 'reconciliation_required'); assert.equal((await received(x)).length, 1);
});
test('runtime fixture terminal finished CLI can explicitly resume same session with a new generation', async t => {
  const x = await setup(t), id = await session(x); await writeFile(join(x.root, 'mode.txt'), 'exit');
  await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'before-exit'));
  await until(x, () => x.api.store.session(id).state === 'process_exited');
  const old = x.api.store.session(id);
  await x.api.call('runtime_terminal_resume', {session_ref: id, expected_generation: 1});
  await writeFile(join(x.root, 'mode.txt'), 'normal'); await until(x, () => x.api.store.session(id).state === 'input_ready');
  const resumed = x.api.store.session(id); assert.equal(resumed.generation, 2); assert.equal(resumed.cli_session_id, old.cli_session_id); assert.notEqual(resumed.process_identity_json, old.process_identity_json);
  await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'after-resume'));
  await until(x, () => x.api.store.session(id).state === 'input_ready'); assert.equal((await received(x)).length, 2);
});
test('runtime fixture terminal no PID attach or generic recovery bypass; host IPC challenge must match', async t => {
  const x = await setup(t), id = await session(x), row = x.api.store.terminalHost(x.config.project.id);
  assert.equal(await pingTerminalHost(row), true); assert.equal(await pingTerminalHost({...row, token: 'wrong'}), false);
  assert.equal(await pingTerminalHost({...row, instance_id: 'wrong'}), false);
  assert.throws(() => x.api.store.recoverTask(x.api.store.session(id).task_id), /MANAGED_RECOVERY_REQUIRES_TERMINAL_HOST/);
  const legacy = new RuntimeStore(x.config.dbPath), task = x.api.store.session(id).task_id;
  try {assert.throws(() => legacy.cancel(task), /MANAGED_CANCELLATION_REQUIRES_TERMINAL_HOST/); assert.equal(legacy.task(task).cancel_requested, 0);} finally {legacy.close();}
});
test('runtime fixture terminal config mutation is checked again at dispatch and sends nothing', async t => {
  const x = await setup(t), id = await session(x); await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'config-change'));
  await writeFile(x.path, JSON.stringify({...x.raw, terminal: {...x.raw.terminal, max_turns: 8}}));
  await assert.rejects(x.host.tick(), /CONFIG_CHANGED/); assert.equal((await received(x)).length, 0);
});
test('runtime fixture terminal limit, denied result, and unrecognized error never imply project completion', async t => {
  const x = await setup(t, {max_turns: 1}), id = await session(x);
  await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'one')); await until(x, () => x.api.store.session(id).state === 'input_ready');
  await assert.rejects(x.api.call('runtime_terminal_submit_prompt', request(x, id, 'over')), /TURN_BUDGET_EXHAUSTED/);
  assert.equal(classifyResult({type: 'result', subtype: 'success', is_error: false, permission_denials: [{}]}).outcome, 'waiting_approval');
  assert.equal(classifyResult({type: 'result', subtype: 'new_error_kind', is_error: true, permission_denials: []}).outcome, 'state_unknown');
  assert.throws(() => classifyResult({type: 'result', subtype: 'success'}), /UNRECOGNIZED/);
});
test('runtime contract terminal decision and handoff schemas retain missing verification and explicit next action', () => {
  assert.equal(decisionSchema.parse({input: {goal: '목표', completion_criteria: ['검증'], current_step: '1', cli_response: 'turn done', diff: '', test_results: [], remaining_errors: [], budget: {remaining_turns: 1}}, output: {decision: 'wait', reason: '검증 전', next_prompt: null, expected_result: 'oracle', verification: []}}).output.decision, 'wait');
  const handoff = {schema_version: 1, session_ref: 'owned', cli_session_id: '8156d832-2020-4138-a8a8-6f6d0c231612', generation: 1, goal: '목표', completed: [], remaining: ['검증'], commit: null, worktree: '/owned', dirty_diff: null, verification: [{check: 'tests', status: 'NOT_RUN', evidence: null}], failure_cause: 'unknown receipt', next_action: 'read transcript, do not resend', delegation: {project_id: 'project', allowed_tools: [], remaining_turns: 1}, prepared_kind: 'handoff', automatic_execution: false};
  assert.equal(handoffSchema.parse(handoff).automatic_execution, false); assert.throws(() => handoffSchema.parse({...handoff, automatic_execution: true}));
});
test('runtime fixture terminal independent host survives gateway exit with same child and durable receipt', {timeout: 20000}, async t => {
  const x = await setup(t, {}, true), child = spawn(process.execPath, ['tests/helpers/terminal-host.mjs', x.path], {stdio: 'ignore'}), exit = once(child, 'exit');
  x.cleanup.push(async () => {child.kill('SIGTERM'); await exit;});
  await until(x, async () => {const row = x.api.store.terminalHost(x.config.project.id); return row && await pingTerminalHost(row);});
  const id = await session(x), old = x.api.store.session(id);
  await writeFile(join(x.root, 'mode.txt'), 'after-ack');
  const body = request(x, id, 'gateway-turn'), file = join(x.root, 'request.json'); await writeFile(file, JSON.stringify(body));
  const gateway = spawn(process.execPath, ['dist/cli.js', 'terminal', 'submit', '--config', x.path, '--request-file', file], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; gateway.stdout.on('data', b => output += b); const [code] = await once(gateway, 'close'); assert.equal(code, 0, output);
  await until(x, () => x.api.store.turn(JSON.parse(output).turn_id).status === 'acknowledged');
  const after = x.api.store.session(id); assert.equal(after.process_identity_json, old.process_identity_json); assert.equal(after.host_instance_id, old.host_instance_id);
  await writeFile(join(x.root, 'release'), ''); await until(x, () => x.api.store.session(id).state === 'input_ready');
  assert.equal((await x.api.call('runtime_terminal_submit_prompt', body)).deduplicated, true); assert.equal((await received(x)).length, 1);
  child.kill('SIGTERM'); await exit;
  assert.equal(await liveness(JSON.parse(old.process_identity_json)), 'dead');
});
test('runtime fixture terminal completed turn interrupt waits for child death before explicit resume', async t => {
  const x = await setup(t), id = await session(x);
  await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'done')); await until(x, () => x.api.store.session(id).state === 'input_ready');
  await x.api.call('runtime_terminal_interrupt', {session_ref: id, expected_generation: 1});
  await until(x, () => x.api.store.session(id).state === 'process_exited');
  await x.api.call('runtime_terminal_resume', {session_ref: id, expected_generation: 1});
  await until(x, () => x.api.store.session(id).state === 'input_ready'); assert.equal(x.api.store.session(id).generation, 2);
});
test('runtime fixture terminal CLI SIGKILL after acknowledgement preserves uncertainty and prevents parent-shell execution', async t => {
  const x = await setup(t), id = await session(x); await writeFile(join(x.root, 'mode.txt'), 'after-ack');
  const input = request(x, id, 'killed', 'touch SHOULD_NOT_EXIST; $(touch SHOULD_NOT_EXIST)');
  const accepted = await x.api.call('runtime_terminal_submit_prompt', input); await until(x, () => x.api.store.turn(accepted.turn_id).status === 'acknowledged');
  const identity = JSON.parse(x.api.store.session(id).process_identity_json); process.kill(identity.pid, 'SIGKILL');
  await until(x, () => x.api.store.session(id).state === 'reconciliation_required');
  await assert.rejects(x.api.call('runtime_terminal_resume', {session_ref: id, expected_generation: 1}), /RESUME_REQUIRES_FINISHED_TRANSCRIPT/);
  await assert.rejects(x.api.call('runtime_terminal_submit_prompt', request(x, id, 'new')), /NOT_INPUT_READY/);
  assert.equal((await received(x)).length, 1); assert.equal(existsSync(join(x.root, 'SHOULD_NOT_EXIST')), false);
});
for (const pending of [false, true]) test(`runtime fixture terminal host SIGKILL ${pending ? 'during receipt' : 'after completion'} does not blindly reissue prompt`, {timeout: 25000}, async t => {
  const x = await setup(t, {}, true);
  async function startOwned() {
    const child = spawn(process.execPath, ['tests/helpers/terminal-host.mjs', x.path], {stdio: 'ignore'}), exit = once(child, 'exit');
    x.cleanup.push(async () => {child.kill('SIGTERM'); await exit;});
    await until(x, async () => {const row = x.api.store.terminalHost(x.config.project.id); return row && JSON.parse(row.identity_json).pid === child.pid && await pingTerminalHost(row);});
    return {child, exit};
  }
  const first = await startOwned(), id = await session(x); if (pending) await writeFile(join(x.root, 'mode.txt'), 'after-ack');
  const accepted = await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'before-host-kill'));
  await until(x, () => pending ? x.api.store.turn(accepted.turn_id).status === 'acknowledged' : x.api.store.session(id).state === 'input_ready');
  const cliIdentity = JSON.parse(x.api.store.session(id).process_identity_json);
  first.child.kill('SIGKILL'); await first.exit; await until(x, async () => await liveness(cliIdentity) === 'dead');
  const second = await startOwned(); await until(x, () => x.api.store.session(id).error_code === 'HOST_DIED_CLI_DEAD');
  assert.equal(x.api.store.session(id).state, pending ? 'reconciliation_required' : 'process_exited'); assert.equal((await received(x)).length, 1);
  if (pending) await assert.rejects(x.api.call('runtime_terminal_resume', {session_ref: id, expected_generation: 1}), /RESUME_REQUIRES_FINISHED_TRANSCRIPT/);
  else {await x.api.call('runtime_terminal_resume', {session_ref: id, expected_generation: 1}); await until(x, () => x.api.store.session(id).state === 'input_ready'); assert.equal(x.api.store.session(id).generation, 2);}
  second.child.kill('SIGTERM'); await second.exit;
});
test('runtime fixture terminal MCP gateway SIGKILL during turn reconnects to the same live host and stdin', {timeout: 25000}, async t => {
  const x = await setup(t, {}, true), host = spawn(process.execPath, ['tests/helpers/terminal-host.mjs', x.path], {stdio: 'ignore'}), exited = once(host, 'exit');
  x.cleanup.push(async () => {host.kill('SIGTERM'); await exited;});
  await until(x, async () => {const row = x.api.store.terminalHost(x.config.project.id); return row && await pingTerminalHost(row);});
  const id = await session(x); await writeFile(join(x.root, 'mode.txt'), 'after-ack');
  const client = new Client({name: 'terminal-gateway', version: '1.0.0'}), transport = new StdioClientTransport({command: process.execPath, args: ['dist/cli.js', 'mcp', '--config', x.path], stderr: 'ignore'});
  await client.connect(transport); x.cleanup.unshift(() => client.close());
  const reply = await client.callTool({name: 'runtime_terminal_submit_prompt', arguments: request(x, id, 'mcp-owned')}); assert.notEqual(reply.isError, true);
  const accepted = JSON.parse(reply.content[0].text); await until(x, () => x.api.store.turn(accepted.turn_id).status === 'acknowledged');
  const before = x.api.store.session(id), closed = new Promise(resolve => {client.onclose = resolve;}); process.kill(transport.pid, 'SIGKILL'); await closed;
  assert.equal(await liveness(JSON.parse(before.process_identity_json)), 'alive');
  await writeFile(join(x.root, 'release'), ''); await until(x, () => x.api.store.session(id).state === 'input_ready');
  const status = await x.api.call('runtime_terminal_status', {session_ref: id}); assert.equal(status.host_instance_id, before.host_instance_id); assert.deepEqual(status.process_identity, JSON.parse(before.process_identity_json)); assert.equal((await received(x)).length, 1);
});
test('runtime fixture terminal durable spool gap stops future completion and keeps evidence ambiguity', async t => {
  const x = await setup(t), id = await session(x); await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'first'));
  await until(x, () => x.api.store.session(id).state === 'input_ready');
  await appendFile(join(x.root, 'data', 'terminal-spool', `${id}.jsonl`), '{"orphaned":true}\n');
  await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'gap')); await until(x, () => !!x.api.store.session(id).error_code);
  assert.equal(x.api.store.session(id).error_code, 'CLI_SPOOL_DURABILITY_GAP'); assert.equal(x.api.store.session(id).state, 'reconciliation_required');
});
test('runtime fixture terminal repeated output and final budget emit replan signals, never a new prompt', async t => {
  const x = await setup(t, {max_turns: 3}), id = await session(x);
  for (let i = 0; i < 3; i++) {await x.api.call('runtime_terminal_submit_prompt', request(x, id, `repeat-${i}`, '동일 답변')); await until(x, () => x.api.store.session(id).state === 'input_ready');}
  const reasons = x.api.store.events(x.config.project.id, 'replan', 1000).filter(e => e.kind === 'orchestrator.replan_required').map(e => e.data.reason);
  assert.deepEqual(reasons.sort(), ['REPEATED_RESULT_REQUIRES_PROGRESS_CHECK', 'TURN_BUDGET_REACHED']); assert.equal((await received(x)).length, 3);
});
for (const action of ['interrupt', 'cancel']) test(`runtime fixture terminal cancellation race ${action} before host claim starts no child`, async t => {
  const x = await setup(t), created = await x.api.call('runtime_terminal_start', {request_id: 'not-started'}), id = created.session_ref;
  if (action === 'interrupt') await x.api.call('runtime_terminal_interrupt', {session_ref: id, expected_generation: 1});
  else await x.api.call('runtime_task_cancel', {task_id: created.task_id});
  await x.host.tick(); const row = x.api.store.session(id);
  assert.equal(row.process_identity_json, null); assert.equal(row.state, 'session_closed'); assert.equal(x.api.store.task(row.task_id).effect_state, 'none');
  assert.equal((await received(x)).length, 0);
});
test('runtime fixture terminal cancellation race result arriving after interrupt preserves known completion without readiness', async t => {
  const x = await setup(t), id = await session(x); await writeFile(join(x.root, 'mode.txt'), 'after-ack');
  const accepted = await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'result-race'));
  await until(x, () => x.api.store.turn(accepted.turn_id).status === 'acknowledged');
  await x.api.call('runtime_terminal_interrupt', {session_ref: id, expected_generation: 1});
  await writeFile(join(x.root, 'release'), '');
  await until({...x, host: null}, () => x.api.store.session(id).last_turn_id === accepted.turn_id);
  const completed = x.api.store.session(id); assert.equal(completed.state, 'turn_completed'); assert.equal(completed.error_code, null);
  const ready = x.api.store.events(x.config.project.id, 'readiness', 1000).filter(e => e.kind === 'terminal.input_ready'); assert.equal(ready.length, 1);
  await until(x, () => x.api.store.session(id).state === 'process_exited');
  assert.equal(x.api.store.turn(accepted.turn_id).status, 'turn_completed'); assert.equal((await received(x)).length, 1);
});
test('runtime fixture terminal queued starts and explicit resume share the same session capacity limit', async t => {
  const x = await setup(t), id = await session(x); await writeFile(join(x.root, 'mode.txt'), 'exit');
  await x.api.call('runtime_terminal_submit_prompt', request(x, id, 'finished')); await until(x, () => x.api.store.session(id).state === 'process_exited');
  for (let i = 0; i < 4; i++) x.api.store.startSession(x.config, `reserved-${i}`);
  await assert.rejects(x.api.call('runtime_terminal_resume', {session_ref: id, expected_generation: 1}), /TERMINAL_SESSION_LIMIT/);
  assert.equal(x.api.store.session(id).resume_requested, 0);
  assert.throws(() => x.api.store.startSession(x.config, 'overflow'), /TERMINAL_SESSION_LIMIT/);
});
