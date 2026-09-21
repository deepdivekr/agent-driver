// Reinspect a previously completed synthetic PRODUCT session; no model calls or resume.
import {readFile, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {loadHostConfig} from '../../dist/interface/config.js';
import {RuntimeApi} from '../../dist/interface/api.js';
import {liveness} from '../../dist/supervisor/identity.js';
if (!process.argv[2] || process.argv[3] !== '--run') throw Error('Explicit config and --run required');
const config = loadHostConfig(process.argv[2]);
if (config.project.id !== 'native-cli-smoke') throw Error('Owned native smoke config required');
const api = new RuntimeApi(config), id = `terminal-reconnect-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const receipt = {id, status: 'NOT_RUN', new_model_prompts: 0};
try {
  const listing = await api.call('runtime_terminal_sessions_list', {});
  if (listing.sessions.length !== 1 || listing.next_cursor) throw Error('SESSION_COUNT_MISMATCH');
  const session = listing.sessions[0], request = {session_ref: session.session_ref, expected_generation: session.generation};
  const before = api.store.session(session.session_ref);
  if (await liveness(JSON.parse(before.process_identity_json)) !== 'dead') throw Error('LIVE_SESSION_NOT_IN_SCOPE');
  const history = await api.call('runtime_terminal_history', request), output = await api.call('runtime_terminal_output_read', {...request, limit: 50});
  const handoff = await api.call('runtime_terminal_handoff', request);
  const after = api.store.session(session.session_ref);
  receipt.observations = {sessions: listing.sessions.length, turns: history.turns.length, generations: [...new Set(history.turns.map(row => row.generation))],
    output_frames: output.frames.length, integrity_checked: output.frames.every(row => row.integrity === 'sha256_matches_durable_event'),
    handoff_saved: Boolean(handoff.artifact.sha256), automatic_execution: handoff.handoff.automatic_execution, project_tests: handoff.handoff.verification.find(row => row.check === 'project_tests').status,
    no_resurrection_or_replay: before.process_identity_json === after.process_identity_json && before.turn_count === after.turn_count && await liveness(JSON.parse(after.process_identity_json)) === 'dead'};
  if (history.turns.length !== 4 || output.next_cursor || output.frames.length === 0 || !receipt.observations.integrity_checked || !receipt.observations.no_resurrection_or_replay || handoff.handoff.automatic_execution) throw Error('RECONNECT_MISMATCH');
  receipt.status = 'PASS';
} catch (error) {receipt.status = 'FAIL'; receipt.error = /^[A-Z_]+$/.test(error.message) ? error.message : 'RECONNECT_FAILED'; process.exitCode = 1;}
finally {api.close();}
await writeFile(`tests/evidence/${id}.json`, JSON.stringify(receipt, null, 2));
const report = JSON.parse(await readFile('tests/report.json', 'utf8'));
report.cases.push({case_id: id, evidence_level: 'native_integration', status: receipt.status, environment: `WSL Linux / real Claude session records / Node ${process.version}`, observations: receipt, evidence_paths: [`tests/evidence/${id}.json`]});
await writeFile('tests/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(receipt));
