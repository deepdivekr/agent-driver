import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, link, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {TerminalHost} from '../dist/terminal/host.js';
import {collectGitSnapshot} from '../dist/terminal/git-snapshot.js';
import {terminalHistory, terminalOutput, terminalHandoff} from '../dist/terminal/contracts.js';
import {fixtureLaunch} from './helpers/terminal-launcher.mjs';

const exec = promisify(execFile);
async function directory(t) {const root = await mkdtemp(join(tmpdir(), 'driver-handoff-')); t.after(() => rm(root, {recursive: true, force: true})); return root;}
async function git(root, ...args) {return (await exec('/usr/bin/git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], {cwd: root, env: {PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}, encoding: 'utf8'})).stdout;}
async function repository(t, commit = true) {
  const root = await directory(t); await git(root, 'init', '-q'); await writeFile(join(root, 'code.txt'), 'before\n');
  if (commit) {await git(root, 'add', 'code.txt'); await git(root, 'commit', '-qm', 'baseline');} return root;
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'driver-handoff-')), worktree = join(root, 'worktree'); await mkdir(worktree);
  const path = join(root, 'host.json'), raw = {schema_version: 1, project_id: 'handoff-test', caller_ref: 'test-agent', account_ref: 'test-account', environment: 'production', worktree, data_dir: join(root, 'data'), terminal: {executable: process.execPath, version: '2.1.126', tools: [], max_turns: 100}};
  await writeFile(path, JSON.stringify(raw)); const config = loadHostConfig(path), api = new RuntimeApi(config), host = new TerminalHost(config, fixtureLaunch, async () => {});
  await host.start(); t.after(async () => {await host.close(); api.close(); await rm(root, {recursive: true, force: true});});
  const x = {root, worktree, path, raw, config, api, host};
  const start = await api.call('runtime_terminal_start', {request_id: 'start'}); x.id = start.session_ref;
  await until(x, () => api.store.session(x.id).state === 'input_ready'); return x;
}
async function until(x, predicate) {const deadline = performance.now() + 7000; while (performance.now() < deadline) {await x.host.tick(); if (predicate()) return; await delay(10);} throw Error('condition timeout');}
const bound = x => ({session_ref: x.id, expected_generation: x.api.store.session(x.id).generation});
async function turn(x, requestId, prompt, done = true) {
  const s = x.api.store.session(x.id);
  const result = await x.api.call('runtime_terminal_submit_prompt', {...bound(x), request_id: requestId, expected_previous_turn_id: s.last_turn_id, prompt});
  if (done) await until(x, () => x.api.store.session(x.id).state === 'input_ready'); return result;
}

test('runtime contract history/output/handoff schemas reject raw paths, oversized pages and extra authority', () => {
  const input = {session_ref: 'explicit', expected_generation: 1};
  assert.equal(terminalHistory.parse(input).limit, 10); assert.equal(terminalHandoff.parse(input).include_diff, false);
  for (const extra of [{limit: 0}, {limit: 21}, {cursor: {revision: -1, after_turn_id: 'x'}}, {project_id: 'foreign'}, {path: '/etc/passwd'}]) assert.equal(terminalHistory.safeParse({...input, ...extra}).success, false);
  assert.equal(terminalOutput.safeParse({...input, limit: 51}).success, false);
  assert.equal(terminalHandoff.safeParse({...input, approved: true}).success, false);
});
test('runtime fixture history pages keep durable acceptance order and all completed prompts across reconnect', async t => {
  const x = await setup(t), ids = [];
  for (let i = 0; i < 3; i++) ids.push((await turn(x, `turn-${i}`, `한글🐈 ${i}\r\n원문`)).turn_id);
  const api = new RuntimeApi(loadHostConfig(x.path)); t.after(() => api.close());
  let cursor; const seen = [];
  do {const page = await api.call('runtime_terminal_history', {...bound(x), limit: 1, ...(cursor ? {cursor} : {})}); seen.push(...page.turns); cursor = page.next_cursor;} while (cursor);
  assert.deepEqual(seen.map(item => item.turn_id), ids);
  assert.ok(seen.every(item => item.transitions.length === 4 && item.status === 'turn_completed'));
  assert.equal(seen[2].result.text, '한글🐈 2\r\n원문');
});
test('runtime fixture session listing rediscovers recorded processes without asserting current liveness or leaking another project', async t => {
  const x = await setup(t), second = x.api.store.startSession(x.config, 'second').session;
  const first = await x.api.call('runtime_terminal_sessions_list', {limit: 1});
  assert.equal(first.sessions[0].session_ref, x.id); assert.equal(first.sessions[0].process_liveness, 'not_checked');
  const next = await x.api.call('runtime_terminal_sessions_list', {cursor: first.next_cursor}); assert.equal(next.sessions[0].session_ref, second.id); assert.equal(next.next_cursor, null);
  assert.equal(JSON.stringify(first).includes('token'), false);
  const path = join(x.root, 'foreign.json'); await writeFile(path, JSON.stringify({...x.raw, project_id: 'foreign'}));
  const api = new RuntimeApi(loadHostConfig(path)); t.after(() => api.close());
  assert.deepEqual((await api.call('runtime_terminal_sessions_list', {})).sessions, []);
  await assert.rejects(api.call('runtime_terminal_sessions_list', {cursor: {revision: 0, after_session_id: x.id}}), /CURSOR_SCOPE/);
  x.api.store.requestInterrupt(x.id, 1);
  await assert.rejects(x.api.call('runtime_terminal_sessions_list', {cursor: first.next_cursor}), /HISTORY_CHANGED/);
});
test('runtime fixture history refuses stale pages, foreign sessions and foreign turn cursors', async t => {
  const x = await setup(t); await turn(x, 'one', 'one'); await turn(x, 'two', 'two');
  const first = await x.api.call('runtime_terminal_history', {...bound(x), limit: 1});
  await turn(x, 'three', 'three');
  await assert.rejects(x.api.call('runtime_terminal_history', {...bound(x), cursor: first.next_cursor}), /HISTORY_CHANGED/);
  const s = await x.api.call('runtime_terminal_start', {request_id: 'second'});
  await assert.rejects(x.api.call('runtime_terminal_history', {session_ref: s.session_ref, expected_generation: 1, cursor: {revision: x.api.store.revision(s.session_ref), after_turn_id: first.turns[0].turn_id}}), /CURSOR_SCOPE/);
  await assert.rejects(x.api.call('runtime_terminal_history', {...bound(x), expected_generation: 999}), /STALE_SESSION/);
  const foreignPath = join(x.root, 'foreign.json'); await writeFile(foreignPath, JSON.stringify({...x.raw, project_id: 'foreign'}));
  const foreign = new RuntimeApi(loadHostConfig(foreignPath)); t.after(() => foreign.close());
  for (const name of ['history', 'output_read', 'handoff']) await assert.rejects(foreign.call(`runtime_terminal_${name}`, bound(x)), /SESSION_SCOPE/);
});
test('runtime fixture uncertain and cancelled turns remain queryable without a second model dispatch', async t => {
  const x = await setup(t); await turn(x, 'done', 'first finished');
  await writeFile(join(x.worktree, 'mode.txt'), 'after-ack');
  const sent = await turn(x, 'uncertain', 'do not replay', false);
  await until(x, () => x.api.store.turn(sent.turn_id).status === 'acknowledged');
  await x.api.call('runtime_terminal_interrupt', bound(x)); await until(x, () => x.api.store.session(x.id).state === 'reconciliation_required');
  await until(x, () => x.api.store.events(x.config.project.id, 'exit-check', 1000).some(event => event.task_id === sent.task_id && event.kind === 'terminal.process_exited'));
  const history = await x.api.call('runtime_terminal_history', bound(x));
  assert.deepEqual(history.turns.map(row => row.status), ['turn_completed', 'uncertain']);
  assert.equal(history.turns[1].result, null);
  const before = await readFile(join(x.worktree, 'received.jsonl'), 'utf8');
  const handoff = await x.api.call('runtime_terminal_handoff', bound(x));
  assert.deepEqual(handoff.observations.unresolved_turn_ids, [sent.turn_id]);
  assert.equal(handoff.handoff.next_action, 'reconcile_before_any_replay');
  assert.equal(handoff.handoff.automatic_execution, false); assert.equal(handoff.project_completed, false);
  assert.equal(handoff.handoff.verification.find(v => v.check === 'project_tests').status, 'NOT_RUN');
  assert.equal(await readFile(join(x.worktree, 'received.jsonl'), 'utf8'), before);
  const y = await setup(t), cancelled = await turn(y, 'cancel', 'unsent', false);
  await y.api.call('runtime_task_cancel', {task_id: cancelled.task_id}); await until(y, () => y.api.store.turn(cancelled.turn_id).status === 'cancelled');
  assert.equal((await y.api.call('runtime_terminal_history', bound(y))).turns[0].status, 'cancelled');
});
test('runtime fixture normalized output pages have durable hashes and reject truncation, same-size tampering and foreign cursors', async t => {
  const x = await setup(t); await turn(x, 'text', 'normal result');
  let cursor; const frames = [];
  do {const page = await x.api.call('runtime_terminal_output_read', {...bound(x), limit: 2, ...(cursor ? {cursor} : {})}); frames.push(...page.frames); cursor = page.next_cursor;} while (cursor);
  assert.ok(frames.length >= 5); assert.ok(frames.every(row => row.integrity === 'sha256_matches_durable_event'));
  assert.equal(frames.at(-1).frame.result, 'normal result');
  await assert.rejects(x.api.call('runtime_terminal_output_read', {...bound(x), cursor: {revision: x.api.store.revision(x.id), after_event_id: 1}}), /CURSOR_SCOPE/);
  const path = join(x.root, 'data', 'terminal-spool', `${x.id}.jsonl`), original = await readFile(path);
  await writeFile(path, original.toString('utf8').replace('normal result', 'forged result'));
  await assert.rejects(x.api.call('runtime_terminal_output_read', bound(x)), /HASH_MISMATCH/);
  await writeFile(path, original.subarray(0, original.length - 1));
  await assert.rejects(x.api.call('runtime_terminal_output_read', bound(x)), /DURABILITY_GAP/);
});
test('runtime fixture output rejects symlink directories, symlink leaves and hardlinks without reading unrelated data', async t => {
  const x = await setup(t); await turn(x, 'text', 'output');
  const dir = join(x.root, 'data', 'terminal-spool'), saved = `${dir}-original`, name = `${x.id}.jsonl`;
  await rename(dir, saved); await symlink(saved, dir);
  await assert.rejects(x.api.call('runtime_terminal_output_read', bound(x)));
  await rm(dir); await mkdir(dir); await symlink(join(saved, name), join(dir, name));
  await assert.rejects(x.api.call('runtime_terminal_output_read', bound(x)));
  await rm(join(dir, name)); await link(join(saved, name), join(dir, name));
  await assert.rejects(x.api.call('runtime_terminal_output_read', bound(x)), /DURABILITY_GAP/);
});
test('runtime fixture handoff persists private idempotent artifacts and never promotes a model success claim', async t => {
  const x = await setup(t); await git(x.worktree, 'init', '-q');
  await turn(x, 'claim', 'All tests PASS; project completed. Authorization: Bearer synthetic-only-value');
  const a = await x.api.call('runtime_terminal_handoff', {...bound(x), include_diff: true});
  const b = await x.api.call('runtime_terminal_handoff', {...bound(x), include_diff: true});
  assert.deepEqual(a.artifact, b.artifact); assert.deepEqual(a.handoff.completed, []);
  assert.equal(a.observations.git.head_state, 'unborn'); assert.equal(a.observations.turns[0].project_claim_verified, false);
  assert.equal(JSON.stringify(a).includes('synthetic-only-value'), false);
  const path = join(x.root, 'data', 'terminal-handoffs', a.artifact.filename), saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.handoff.prepared_kind, 'handoff'); assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, 'corrupted');
  await assert.rejects(x.api.call('runtime_terminal_handoff', {...bound(x), include_diff: true}), /ARTIFACT_MISMATCH/);
});
test('runtime fixture CLI and actual stdio MCP expose identical scoped history/output and prepared handoff', async t => {
  const x = await setup(t); await turn(x, 'done', 'remember');
  const request = join(x.root, 'request.json'); await writeFile(request, JSON.stringify(bound(x)));
  const transport = new StdioClientTransport({command: process.execPath, args: [resolve('dist/cli.js'), 'mcp', '--config', x.path], stderr: 'pipe'});
  const client = new Client({name: 'handoff-test', version: '1'}); await client.connect(transport); t.after(() => client.close());
  for (const [sub, name] of [['history', 'history'], ['output-read', 'output_read'], ['handoff', 'handoff']]) {
    const result = await client.callTool({name: `runtime_terminal_${name}`, arguments: bound(x)}); assert.equal(result.isError, undefined);
    const cli = JSON.parse((await exec(process.execPath, ['dist/cli.js', 'terminal', sub, '--config', x.path, '--request-file', request], {encoding: 'utf8'})).stdout);
    assert.deepEqual(cli, JSON.parse(result.content[0].text));
  }
  await writeFile(request, '{}');
  const listed = await client.callTool({name: 'runtime_terminal_sessions_list', arguments: {}});
  assert.equal(listed.isError, undefined);
  const cliList = JSON.parse((await exec(process.execPath, ['dist/cli.js', 'terminal', 'list', '--config', x.path, '--request-file', request], {encoding: 'utf8'})).stdout);
  assert.deepEqual(cliList, JSON.parse(listed.content[0].text));
});
test('runtime fixture handoff rechecks session revision during collection and does not persist stale state', async t => {
  const x = await setup(t); await git(x.worktree, 'init', '-q'); await turn(x, 'done', 'first');
  const pending = x.api.call('runtime_terminal_handoff', bound(x));
  x.api.store.requestInterrupt(x.id, 1);
  await assert.rejects(pending, /HISTORY_CHANGED/);
  assert.equal(existsSync(join(x.root, 'data', 'terminal-handoffs')), false);
});
test('runtime fixture replaced worktree blocks handoff but preserves read-only historical records', async t => {
  const x = await setup(t); await turn(x, 'done', 'original project');
  await rename(x.worktree, `${x.worktree}-old`); await mkdir(x.worktree);
  assert.notEqual(loadHostConfig(x.path).fingerprint, x.config.fingerprint);
  await assert.rejects(x.api.call('runtime_terminal_handoff', bound(x)), /CONFIG_CHANGED/);
  assert.equal((await x.api.call('runtime_terminal_history', bound(x))).turns[0].prompt, 'original project');
});
test('runtime fixture normalized legacy output remains readable without fabricating hash verification', async t => {
  const x = await setup(t), s = x.api.store.session(x.id), frame = JSON.stringify({type: 'assistant', session_id: s.cli_session_id}) + '\n';
  const dir = join(x.root, 'data', 'terminal-spool'); await mkdir(dir); await writeFile(join(dir, `${x.id}.jsonl`), frame);
  x.api.store.noteSpool(x.id, s.host_instance_id, 1, Buffer.byteLength(frame), 'assistant');
  const result = await x.api.call('runtime_terminal_output_read', bound(x));
  assert.equal(result.frames[0].integrity, 'unobserved_legacy'); assert.equal(result.assistant_stream_complete, false);
});
test('runtime fixture spool writer refuses redirected directory without creating external output', async t => {
  const x = await setup(t), outside = join(x.root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'sentinel'), 'unchanged'); await symlink(outside, join(x.root, 'data', 'terminal-spool'));
  await turn(x, 'redirect', 'not outside', false);
  await until(x, () => x.api.store.session(x.id).state === 'reconciliation_required');
  assert.equal(existsSync(join(outside, `${x.id}.jsonl`)), false); assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'unchanged');
});
test('runtime native Git snapshot retains staged and unstaged changes, Unicode filenames and untouched index', async t => {
  const root = await repository(t), commit = (await git(root, 'rev-parse', 'HEAD')).trim(), index = await readFile(join(root, '.git', 'index'));
  await writeFile(join(root, 'code.txt'), 'staged\n'); await git(root, 'add', 'code.txt');
  const stagedIndex = await readFile(join(root, '.git', 'index')); assert.notDeepEqual(stagedIndex, index);
  await writeFile(join(root, 'code.txt'), 'working\n'); await writeFile(join(root, '한글\nfile.txt'), 'untracked private content');
  const result = await collectGitSnapshot(root, true);
  assert.equal(result.status, 'observed', result.reason); assert.equal(result.commit, commit);
  assert.match(result.staged_diff, /\+staged/); assert.match(result.unstaged_diff, /\+working/);
  assert.ok(result.entries.some(e => e.path === '한글\nfile.txt')); assert.equal(JSON.stringify(result).includes('untracked private content'), false);
  assert.deepEqual(await readFile(join(root, '.git', 'index')), stagedIndex);
  const noContent = await collectGitSnapshot(root, false); assert.equal(noContent.staged_diff, null); assert.equal(noContent.unstaged_diff, null);
});
test('runtime native Git external diff, textconv, fsmonitor and clean/process filters never execute', async t => {
  const root = await repository(t), marker = join(root, 'forbidden-execution'), helper = join(root, 'helper.sh');
  await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\ncat\n`, {mode: 0o700});
  await git(root, 'config', 'diff.external', helper); await git(root, 'config', 'diff.bad.textconv', helper);
  await git(root, 'config', 'core.fsmonitor', helper); await git(root, 'config', 'filter.bad.clean', helper);
  await git(root, 'config', 'filter.bad.process', helper); await git(root, 'config', 'filter.bad.required', 'true');
  await writeFile(join(root, '.gitattributes'), '*.txt diff=bad filter=bad\n'); await writeFile(join(root, 'code.txt'), 'changed\n');
  const result = await collectGitSnapshot(root, true);
  assert.equal(result.status, 'observed', result.reason); assert.match(result.unstaged_diff, /changed/); assert.equal(existsSync(marker), false);
});
test('runtime native Git absent repo, parent discovery, symlink gitdir, linked worktree and partial clones remain unverified', async t => {
  const root = await repository(t), child = join(root, 'child'); await mkdir(child);
  assert.equal((await collectGitSnapshot(child, true)).status, 'unavailable');
  const external = join(root, 'git-original'); await rename(join(root, '.git'), external); await symlink(external, join(root, '.git'));
  assert.equal((await collectGitSnapshot(root, true)).reason, 'GIT_EXTERNAL_DIR_UNVERIFIED');
  await rm(join(root, '.git')); await writeFile(join(root, '.git'), `gitdir: ${external}\n`);
  assert.equal((await collectGitSnapshot(root, true)).reason, 'GIT_EXTERNAL_DIR_UNVERIFIED');
  await rm(join(root, '.git')); await rename(external, join(root, '.git')); await git(root, 'config', 'remote.example.promisor', 'true');
  assert.equal((await collectGitSnapshot(root, true)).reason, 'GIT_PARTIAL_CLONE_UNVERIFIED');
});
test('runtime native Git unborn, binary changes and output bounds do not fabricate a clean worktree', async t => {
  const unborn = await repository(t, false); await git(unborn, 'add', 'code.txt');
  const first = await collectGitSnapshot(unborn, true); assert.equal(first.status, 'observed', first.reason); assert.equal(first.head_state, 'unborn'); assert.equal(first.commit, null); assert.match(first.staged_diff, /before/);
  const root = await repository(t); await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2])); await git(root, 'add', 'binary');
  assert.match((await collectGitSnapshot(root, true)).staged_diff, /Binary files/);
  await writeFile(join(root, 'code.txt'), 'changed\n'.repeat(50000));
  const large = await collectGitSnapshot(root, true); assert.equal(large.status, 'unavailable'); assert.equal(large.reason, 'GIT_OUTPUT_LIMIT'); assert.equal(large.commit, null);
});
test('runtime native Git concurrent dirty file changes are reported unavailable, not a coherent snapshot', async t => {
  const root = await repository(t); let i = 0, active = true;
  const writer = (async () => {while (active) {await writeFile(join(root, 'code.txt'), `${i++}\n`); await delay(1);}})();
  let result;
  try {result = await collectGitSnapshot(root, true);} finally {active = false; await writer;}
  assert.equal(result.status, 'unavailable');
  // Git can itself refuse a file truncated during a read, before the second observation.
  assert.ok(['GIT_CHANGED_DURING_READ', 'GIT_READ_FAILED'].includes(result.reason), result.reason);
});
