import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, openSync, closeSync, constants} from 'node:fs';
import {dirname, join} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {loadHostConfig, type HostConfig} from '../interface/config.js';
import {TerminalStore} from './store.js';
import {ScopedFiles, sha256, writeAll, type FileObservation} from './scoped-files.js';

interface Execution {exit: number | null; signal: string | null; stdout: string; stderr: string; reason: string | null; elapsed_ms: number}
export function sandboxArgs(snapshot: string, nodeArgs: string[], timeout: number) {
  return ['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--size', '16777216', '--tmpfs', '/',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--size', '33554432', '--tmpfs', '/tmp', '--ro-bind', snapshot, '/workspace', '--dir', '/runtime', '--ro-bind', process.execPath, '/runtime/node', '--chdir', '/workspace',
    '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
    '/usr/bin/prlimit', `--cpu=${Math.ceil(timeout / 1000) + 1}`, '--as=8589934592', '--fsize=10485760', '--nofile=64', '--', '/runtime/node', ...nodeArgs];
}
export async function runSandbox(snapshot: string, args: string[], stdin: string, timeout: number, cancelled: () => boolean): Promise<Execution> {
  const started = performance.now(), child = spawn('/usr/bin/bwrap', sandboxArgs(snapshot, args, timeout), {stdio: ['pipe','pipe','pipe'], shell: false, windowsHide: true, env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}});
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), reason: string | null = null;
  const stop = (why: string) => {reason ??= why; child.kill('SIGKILL');};
  child.stdin.on('error', () => {});
  child.stdout.on('data', (b: Buffer) => {if (stdout.length + b.length > 65536) stop('OUTPUT_LIMIT'); else stdout = Buffer.concat([stdout,b]);});
  child.stderr.on('data', (b: Buffer) => {if (stderr.length + b.length > 65536) stop('OUTPUT_LIMIT'); else stderr = Buffer.concat([stderr,b]);});
  const timer = setTimeout(() => stop('VERIFICATION_DEADLINE'), timeout);
  const monitor = setInterval(() => {try {if (cancelled()) stop('VERIFICATION_CANCELLED');} catch {stop('VERIFICATION_FENCE_LOST');}}, 50);
  return await new Promise(resolve => {
    child.once('error', () => {reason = 'SANDBOX_UNAVAILABLE';});
    child.once('close', (exit, signal) => {clearTimeout(timer); clearInterval(monitor); resolve({exit, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), reason, elapsed_ms: performance.now() - started});});
    child.stdin.end(stdin);
  });
}
const manifestOf = (files: FileObservation[]) => files.map(f => ({path: f.path, sha256: f.sha256}));
export async function verifyFiles(store: TerminalStore, config: HostConfig, session: string, generation: number, turn: string, request: string) {
  const delegation = config.terminal?.files, verifier = delegation?.verifier;
  requireCondition(verifier && process.platform === 'linux', 'FILE_VERIFIER_NOT_DELEGATED');
  const scoped = new ScopedFiles(config), files = scoped.snapshot(), manifest = manifestOf(files);
  const reservation = store.beginVerification(config, session, generation, turn, request, manifest), id = String(reservation.record.id);
  if (!reservation.created) return {verification_id: id, deduplicated: true, manifest: JSON.parse(String(reservation.record.manifest_json)) as unknown, result: reservation.record.result_json ? JSON.parse(String(reservation.record.result_json)) as unknown : null, status: reservation.record.result_json ? 'recorded' : 'in_progress_or_interrupted_no_replay'};
  const cancelled = () => {const s = store.session(session); return loadHostConfig(config.path).fingerprint !== config.fingerprint || s.generation !== generation || s.last_turn_id !== turn || !!s.active_turn_id || !!s.interrupt_requested || !!s.manual_control || !!store.task(s.task_id).cancel_requested;};
  let observation: Record<string, unknown>;
  try {
    const snapshots = join(dirname(config.dbPath), 'verification-snapshots'); mkdirSync(snapshots, {recursive: true, mode: 0o700});
    const snapshot = mkdtempSync(join(snapshots, `${id}-`));
    for (const file of files) if (file.content !== null) {
      const target = join(snapshot, file.path); mkdirSync(dirname(target), {recursive: true, mode: 0o700});
      const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
      try {writeAll(fd, Buffer.from(file.content));} finally {closeSync(fd);}
    }
    // No fallback to the host: even the preflight runs under the exact namespace policy.
    requireCondition(!cancelled(), 'VERIFICATION_CANCELLED');
    const preflight = await runSandbox(snapshot, ['--eval', "process.stdout.write('apd-isolated:'+process.version)"], '', 5000, cancelled);
    if (preflight.reason || preflight.exit !== 0 || preflight.stdout !== 'apd-isolated:v22.22.0' || preflight.stderr !== '') observation = {status: 'BLOCKED_ENV', reason: preflight.reason ?? 'SANDBOX_PREFLIGHT_FAILED', checks: [], preflight, project_completed: false};
    else {
      const checks = [];
      for (const item of verifier.cases) {
        if (cancelled()) {checks.push({id: item.id, status: 'NOT_RUN', reason: 'VERIFICATION_CANCELLED'}); continue;}
        const actual = await runSandbox(snapshot, [`/workspace/${verifier.entry}`, ...item.args], item.stdin, verifier.timeout_ms, cancelled);
        const pass = !actual.reason && actual.exit === item.exit && actual.stdout === item.stdout && actual.stderr === item.stderr;
        checks.push({id: item.id, status: pass ? 'PASS' : 'FAIL', actual, oracle_sha256: sha256(JSON.stringify(item))});
      }
      const unchanged = JSON.stringify(manifestOf(scoped.snapshot())) === JSON.stringify(manifest) && !cancelled();
      observation = {status: !unchanged ? 'NOT_RUN' : checks.length === verifier.cases.length && checks.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL',
        reason: unchanged ? null : 'CURRENT_FILES_OR_BINDING_CHANGED', snapshot_checks: checks, checks_run: checks.filter(c => 'actual' in c).length, expected_checks: verifier.cases.length,
        current_files_match_snapshot: unchanged, kind: verifier.kind, preflight, project_completed: false,
        limitations: ['Tests only the host-configured stdin/stdout/exit contract; not arbitrary project completion.', 'Namespace isolation is not a VM or a same-user/kernel/denial-of-service security guarantee.']};
    }
  } catch (error) {observation = {status: 'NOT_RUN', reason: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'VERIFICATION_FAILED_UNOBSERVED', project_completed: false};}
  store.finishVerification(id, session, observation);
  return {verification_id: id, turn_id: turn, generation, manifest, result: observation, deduplicated: false};
}
