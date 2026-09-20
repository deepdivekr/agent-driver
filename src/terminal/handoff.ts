import {createHash} from 'node:crypto';
import {mkdirSync, openSync, closeSync, fstatSync, fsyncSync, readFileSync, readdirSync, writeSync, constants} from 'node:fs';
import {dirname, join} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {loadHostConfig, type HostConfig} from '../interface/config.js';
import {handoffSchema, redact, type TurnResult} from './contracts.js';
import {collectGitSnapshot} from './git-snapshot.js';
import {type TerminalStore} from './store.js';
import {ScopedFiles} from './scoped-files.js';
import {brokerTools} from './file-contracts.js';
import {observeArtifact} from '../storage/artifacts.js';

function savePrivateHandoff(config: HostConfig, sessionId: string, document: unknown) {
  const content = Buffer.from(JSON.stringify(document, null, 2) + '\n');
  requireCondition(content.length <= 1048576, 'HANDOFF_OUTPUT_LIMIT');
  const hash = createHash('sha256').update(content).digest('hex'), filename = `${sessionId}-${hash}.json`;
  const directory = join(dirname(config.dbPath), 'terminal-handoffs');
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const anchored = `/proc/self/fd/${dir}`, target = `${anchored}/${filename}`;
    const existing = readdirSync(anchored).filter(name => name.startsWith(`${sessionId}-`));
    let fd: number;
    if (existing.includes(filename)) {
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {const stat = fstatSync(fd); requireCondition(stat.isFile() && stat.nlink === 1 && stat.size === content.length && readFileSync(fd).equals(content), 'HANDOFF_ARTIFACT_MISMATCH');}
      finally {closeSync(fd);}
    } else {
      requireCondition(existing.length < 16, 'HANDOFF_RETENTION_LIMIT');
      fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {let offset = 0; while (offset < content.length) {const n = writeSync(fd, content, offset); requireCondition(n > 0, 'HANDOFF_WRITE_FAILED'); offset += n;} fsyncSync(fd);}
      finally {closeSync(fd);}
      fsyncSync(dir);
    }
  } finally {closeSync(dir);}
  return {kind: 'terminal_handoff', filename, sha256: hash, bytes: content.length, storage: 'private_runtime_data', contains_untrusted_data: true};
}

export async function prepareTerminalHandoff(store: TerminalStore, config: HostConfig, id: string, generation: number, includeDiff: boolean) {
  requireCondition(process.platform === 'linux', 'TERMINAL_PLATFORM_UNVERIFIED');
  requireCondition(loadHostConfig(config.path).fingerprint === config.fingerprint, 'CONFIG_CHANGED');
  const context = store.handoffContext(config.project.id, id, generation), {session, turns} = context;
  requireCondition(session.config_hash === config.fingerprint && session.worktree === config.project.worktree, 'CONFIG_CHANGED');
  const git = await collectGitSnapshot(session.worktree, includeDiff);
  const effects = store.fileIntents(id).map(i => ({intent_id: i.id, turn_id: i.turn_id, generation: i.generation, path: i.path, before_sha256: i.before_hash, after_sha256: i.after_hash, status: i.status}));
  const records = store.verifications(id), latest = records.at(-1);
  let tests: {check: string; status: 'PASS' | 'FAIL' | 'NOT_RUN' | 'BLOCKED_ENV'; evidence: string | null} = {check: 'project_tests', status: 'NOT_RUN', evidence: null};
  if (latest?.result_json && latest.turn_id === session.last_turn_id && latest.generation === generation && latest.config_hash === config.fingerprint && !session.active_turn_id) {
    try {
      const manifest = new ScopedFiles(config).snapshot().map(f => ({path: f.path, sha256: f.sha256}));
      const observed = JSON.parse(String(latest.result_json)) as {status: typeof tests.status};
      if (JSON.stringify(manifest) === latest.manifest_json) tests = {check: 'project_tests', status: observed.status, evidence: String(latest.id)};
    } catch { /* A prior PASS is not current evidence if files cannot be reobserved. */ }
  }
  requireCondition(loadHostConfig(config.path).fingerprint === config.fingerprint, 'CONFIG_CHANGED');
  store.readSession(config.project.id, id, generation);
  requireCondition(store.revision(id) === context.revision, 'HISTORY_CHANGED_RESTART_PAGE');
  const unresolved = turns.filter(turn => ['dispatched', 'acknowledged', 'uncertain'].includes(turn.status)).map(turn => turn.id);
  const pending = turns.filter(turn => turn.status === 'accepted').map(turn => turn.id);
  const handoff = handoffSchema.parse({schema_version: 1, session_ref: id, cli_session_id: session.cli_session_id, generation,
    goal: turns[0] ? redact(turns[0].prompt) : 'unobserved', completed: [],
    remaining: [...(unresolved.length ? ['Reconcile uncertain turns against external effects; do not replay.'] : []), ...(pending.length ? ['Accepted turn remains owned by the existing host; do not duplicate.'] : []), 'Verify actual files, tests and original completion criteria before continuing.'],
    commit: git.commit, worktree: session.worktree, dirty_diff: git.status === 'observed' && includeDiff ? `STAGED\n${git.staged_diff}\nUNSTAGED\n${git.unstaged_diff}` : null,
    verification: [{check: 'git_snapshot_collection', status: git.status === 'observed' ? 'PASS' : 'NOT_RUN', evidence: git.snapshot_sha256 ?? git.reason},
      tests, {check: 'project_completion_criteria', status: 'NOT_RUN', evidence: null}],
    failure_cause: session.error_code, next_action: unresolved.length ? 'reconcile_before_any_replay' : pending.length || session.active_turn_id ? 'observe_existing_host_do_not_start_duplicate' : 'review_handoff_and_current_worktree',
    delegation: {project_id: config.project.id, allowed_tools: config.terminal!.files ? [...brokerTools] : [], remaining_turns: Math.max(0, config.terminal!.max_turns - session.turn_count)}, prepared_kind: 'handoff', automatic_execution: false});
  const document = {handoff, observations: {revision: context.revision, terminal_state: session.state, goal_source: turns.length ? 'first_submitted_prompt_not_verified_project_goal' : 'unobserved',
    completed_scope: 'independently_verified_project_work_only', unresolved_turn_ids: unresolved, pending_turn_ids: pending,
    turns: turns.map(turn => {const result = turn.result_json ? JSON.parse(turn.result_json) as TurnResult : null; return {turn_id: turn.id, status: turn.status, generation: turn.generation,
      reported_result: result?.text ? redact(result.text.slice(0, 2000)) : null, result_truncated: result?.text ? result.text.length > 2000 : false, project_claim_verified: false};}), git, file_effects: effects,
      verifications: records.map(row => ({verification_id: row.id, turn_id: row.turn_id, generation: row.generation, manifest: JSON.parse(String(row.manifest_json)) as unknown, result: row.result_json ? JSON.parse(String(row.result_json)) as unknown : 'unobserved'}))},
    content_trust: 'untrusted_data', project_completed: false,
    limitations: ['No model call, test command, CLI start, resume or replay is performed.', 'Git data is a bounded double observation, not an atomic filesystem snapshot or a security sandbox.', 'Credential-pattern redaction is best effort; keep this artifact private.', 'Untracked, ignored and submodule file contents are not collected. Linked gitdirs and partial clones are unverified.']};
  return {...document, artifact: store.storage(config).run('handoff', Buffer.byteLength(JSON.stringify(document, null, 2)) + 1048576, () => store.persistHandoff(config.project.id, id, generation, context.revision, () => {
    const artifact=savePrivateHandoff(config,id,document);
    store.registerArtifact(id,generation,'handoff',observeArtifact(config.dbPath,'terminal-handoffs',artifact.filename));
    return artifact;
  }))};
}
