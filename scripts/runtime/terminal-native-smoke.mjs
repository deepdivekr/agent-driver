// Opt-in. Four synthetic prompts through the PRODUCT host, existing CLI subscription auth.
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadHostConfig} from '../../dist/interface/config.js';
import {RuntimeApi} from '../../dist/interface/api.js';
import {stopTerminalHost} from '../../dist/terminal/manager.js';
import {liveness} from '../../dist/supervisor/identity.js';
if (process.argv[3] !== '--run' || !process.argv[2]) throw Error('Explicit executable and --run required');
const id = `terminal-native-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const root = resolve('.runtime', id), worktree = join(root, 'synthetic-worktree'); await mkdir(worktree, {recursive: true, mode: 0o700});
const path = join(root, 'host.json');
await writeFile(path, JSON.stringify({schema_version: 1, project_id: 'native-cli-smoke', caller_ref: 'owned-synthetic-test', account_ref: 'cli-existing-subscription', environment: 'production', worktree, data_dir: join(root, 'data'), terminal: {executable: process.argv[2], version: '2.1.126', tools: [], max_turns: 4, turn_deadline_ms: 150000}}), {mode: 0o600});
const config = loadHostConfig(path), api = new RuntimeApi(config);
const receipt = {id, version: '2.1.126', platform: process.platform, mode: 'structured', auth: 'existing_cli_subscription', tools: [], prompts_accepted: 0, inference_count: 'unobserved', turns: [], status: 'NOT_RUN'};
let session, initial;
async function waitFor(predicate, expectedTransition = null) {const end = performance.now() + 160000; while (performance.now() < end) {const row = api.store.session(session); if (predicate(row)) return row; if (row.error_code && row.state !== 'process_exited' && row.error_code !== expectedTransition) throw Error(row.error_code); await delay(100);} throw Error('NATIVE_SMOKE_TIMEOUT');}
async function turn(index, prompt, expected) {
  const before = await waitFor(s => s.state === 'input_ready'), started = performance.now();
  const accepted = await api.call('runtime_terminal_submit_prompt', {request_id: `turn-${index}`, session_ref: session, expected_generation: before.generation, expected_previous_turn_id: before.last_turn_id, prompt});
  receipt.prompts_accepted++;
  await waitFor(s => s.last_turn_id === accepted.turn_id && ['input_ready', 'waiting_approval', 'state_unknown'].includes(s.state));
  const result = await api.call('runtime_terminal_status', {session_ref: session}), pass = result.result?.text?.trim() === expected && result.terminal_state === 'input_ready';
  receipt.turns.push({index, status: pass ? 'PASS' : 'FAIL', elapsed_ms: performance.now() - started, generation: result.session_generation, same_cli_session: result.cli_session_id === initial.cli_session_id, project_completed: result.project_completed, result: result.result?.text ?? 'unobserved', expected});
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  if (!pass) throw Error('NATIVE_RESULT_MISMATCH');
}
try {
  const started = await api.call('runtime_terminal_start', {request_id: 'native-session'}); session = started.session_ref;
  initial = await waitFor(s => s.state === 'input_ready');
  await turn(1, '이것은 합성 런타임 연결 시험이다. 식별어 토끼-602를 기억하고 준비완료 네 글자만 답해. 도구는 사용하지 마.', '준비완료');
  await turn(2, '내가 직전 지시에서 기억하라고 한 식별어만 답해.', '토끼-602');
  await turn(3, '기억한 식별어에 -끝을 붙인 결과만 답해.', '토끼-602-끝');
  await api.call('runtime_terminal_interrupt', {session_ref: session, expected_generation: 1});
  await waitFor(s => s.state === 'process_exited', 'INTERRUPTED');
  await api.call('runtime_terminal_resume', {session_ref: session, expected_generation: 1});
  await waitFor(s => s.state === 'input_ready' && s.generation === 2);
  await turn(4, '우리가 이 세션 첫 메시지에서 기억하기로 한 원래 식별어만 답해. -끝은 붙이지 마.', '토끼-602');
  const events = api.store.events(config.project.id, 'native-evidence', 1000);
  receipt.event_counts = Object.fromEntries(['terminal.prompt_accepted', 'terminal.prompt_started', 'terminal.prompt_received', 'terminal.turn_completed', 'terminal.input_ready', 'terminal.resume_started'].map(kind => [kind, events.filter(e => e.kind === kind).length]));
  const bound = {session_ref: session, expected_generation: 2};
  const history = await api.call('runtime_terminal_history', {...bound, limit: 2});
  const next = await api.call('runtime_terminal_history', {...bound, limit: 2, cursor: history.next_cursor});
  const output = await api.call('runtime_terminal_output_read', bound);
  const handoff = await api.call('runtime_terminal_handoff', bound);
  receipt.handoff_checks = {history_turns: history.turns.length + next.turns.length, history_generations: [...new Set([...history.turns, ...next.turns].map(row => row.generation))],
    bounded_output_has_hashes: output.frames.length > 0 && output.frames.every(row => row.integrity === 'sha256_matches_durable_event'),
    prepared_kind: handoff.handoff.prepared_kind, automatic_execution: handoff.handoff.automatic_execution,
    project_tests: handoff.handoff.verification.find(row => row.check === 'project_tests').status, artifact_sha256: handoff.artifact.sha256,
    no_additional_prompt: api.store.session(session).turn_count === 4};
  if (receipt.handoff_checks.history_turns !== 4 || !receipt.handoff_checks.bounded_output_has_hashes || !receipt.handoff_checks.no_additional_prompt || handoff.handoff.automatic_execution || handoff.handoff.verification.find(row => row.check === 'project_tests').status !== 'NOT_RUN') throw Error('NATIVE_HANDOFF_MISMATCH');
  receipt.status = 'PASS';
} catch (error) {receipt.status = 'FAIL'; receipt.error = /^[A-Z_]+$/.test(error.message) ? error.message : 'NATIVE_SMOKE_FAILED'; process.exitCode = 1;}
finally {
  receipt.host_stop = await stopTerminalHost(config);
  receipt.processes_after_stop = await Promise.all(api.store.sessions(config.project.id).map(s => s.process_identity_json ? liveness(JSON.parse(s.process_identity_json)) : 'unobserved'));
  if (!receipt.host_stop.stopped || receipt.processes_after_stop.some(s => s !== 'dead')) {receipt.status = 'FAIL'; process.exitCode = 1;}
  if (session) {
    const spool = await readFile(join(root, 'data', 'terminal-spool', `${session}.jsonl`), 'utf8').catch(() => '');
    receipt.observed_models = [...new Set(spool.trim().split('\n').filter(Boolean).map(JSON.parse).map(e => e.model).filter(Boolean))];
  }
  api.close();
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await mkdir('tests/evidence', {recursive: true});
  // Public-safe synthetic receipt, no raw transcript, token, user auth path or DB.
  await writeFile(`tests/evidence/${id}.json`, JSON.stringify(receipt, null, 2));
  const report = JSON.parse(await readFile('tests/report.json', 'utf8'));
  report.cases.push({case_id: id, evidence_level: 'native_integration', status: receipt.status, environment: `WSL Linux / Claude 2.1.126 / Node ${process.version}`, observations: receipt, evidence_paths: [`tests/evidence/${id}.json`]});
  await writeFile('tests/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({id, status: receipt.status, prompts_accepted: receipt.prompts_accepted, turns: receipt.turns.map(t => ({index: t.index, status: t.status, elapsed_ms: t.elapsed_ms})), error: receipt.error ?? null, receipt: join(root, 'receipt.json')}));
}
