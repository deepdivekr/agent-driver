import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat, realpath, readlink} from 'node:fs/promises';
import {join, relative, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {requireCondition} from '../core/contracts.js';
import {redact} from './contracts.js';

const exec = promisify(execFile);
const MAX_BYTES = 262144;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const controls = ['--no-pager', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs',
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false',
  '-c', 'core.pager=', '-c', 'diff.external=', '-c', 'diff.renames=false', '-c', 'protocol.allow=never'];
const environment = {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1'};

async function command(worktree: string, args: string[], extra: string[] = [], missing = false) {
  try {
    const result = await exec('/usr/bin/git', [...controls, ...extra, ...args], {cwd: worktree, env: environment, encoding: 'utf8', timeout: 3000, maxBuffer: MAX_BYTES, windowsHide: true, killSignal: 'SIGKILL'});
    return result.stdout;
  } catch (error) {
    // Never return Git stderr, which can contain paths, config values or credential-bearing remotes.
    const failure = error as {code?: unknown; killed?: boolean};
    if (missing && failure.code === 1) return '';
    throw Error(failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'GIT_OUTPUT_LIMIT' : failure.killed ? 'GIT_DEADLINE' : 'GIT_READ_FAILED');
  }
}
async function stamp(worktree: string) {
  requireCondition(await realpath(worktree) === worktree, 'WORKTREE_CHANGED');
  const stat = await lstat(worktree); requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), 'WORKTREE_CHANGED');
  return `${stat.dev}:${stat.ino}`;
}
async function changedMetadata(worktree: string, status: string) {
  const rows = status.split('\0').filter(Boolean); requireCondition(rows.length <= 1000, 'GIT_FILE_COUNT_LIMIT');
  return Promise.all(rows.map(async row => {
    requireCondition(row.length >= 4 && row[2] === ' ' && !/[RC]/.test(row.slice(0, 2)), 'GIT_STATUS_UNVERIFIED');
    const name = row.slice(3), path = join(worktree, name), local = relative(worktree, path);
    requireCondition(local && !isAbsolute(name) && local !== '..' && !local.startsWith('../'), 'GIT_PATH_OUTSIDE_WORKTREE');
    try {
      const stat = await lstat(path, {bigint: true});
      return [name, String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), stat.isSymbolicLink() ? await readlink(path) : null];
    } catch (e) {if ((e as {code?: string}).code === 'ENOENT') return [name, 'absent']; throw e;}
  }));
}
export interface GitSnapshot {
  status: 'observed' | 'unavailable'; reason: string | null; worktree: string; commit: string | null;
  head_state: 'commit' | 'unborn' | 'unknown'; entries: Array<{index: string; working_tree: string; path: string}>;
  staged_diff: string | null; unstaged_diff: string | null; diff_requested: boolean;
  snapshot_sha256: string | null; consistency: 'double_observation_matched' | 'unknown';
  untracked_contents: 'not_read'; submodule_contents: 'not_read'; ignored_contents: 'not_read'; atomic_filesystem_snapshot: false;
}

export async function collectGitSnapshot(worktree: string, includeDiff: boolean): Promise<GitSnapshot> {
  const unavailable = (reason: string): GitSnapshot => ({status: 'unavailable', reason, worktree, commit: null, head_state: 'unknown', entries: [], staged_diff: null, unstaged_diff: null, diff_requested: includeDiff, snapshot_sha256: null, consistency: 'unknown', untracked_contents: 'not_read', submodule_contents: 'not_read', ignored_contents: 'not_read', atomic_filesystem_snapshot: false});
  try {
    requireCondition(process.platform === 'linux', 'GIT_PLATFORM_UNVERIFIED');
    const before = await stamp(worktree);
    // Refuse parent-repo discovery, bare repositories, and linked gitdirs until their boundaries are verified.
    const dot = await lstat(join(worktree, '.git'));
    requireCondition(dot.isDirectory() && !dot.isSymbolicLink(), 'GIT_EXTERNAL_DIR_UNVERIFIED');
    const gitIdentity = `${dot.dev}:${dot.ino}`;
    const extra = [`--git-dir=${join(worktree, '.git')}`, `--work-tree=${worktree}`];
    const config = () => command(worktree, ['config', '--null', '--includes', '--list'], extra);
    const firstConfig = await config();
    requireCondition(!/(?:^|\0)(?:extensions\.partialclone|remote\.[^\n]+\.promisor)\n/i.test(firstConfig), 'GIT_PARTIAL_CLONE_UNVERIFIED');
    // --no-textconv does NOT disable clean/process filters used when reading working-tree content.
    const filterNames = new Set<string>();
    for (const entry of firstConfig.split('\0')) {
      const key = entry.split('\n', 1)[0]!, match = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(key);
      if (match) {requireCondition(/^[a-zA-Z0-9._-]{1,100}$/.test(match[1]!), 'GIT_FILTER_NAME_UNVERIFIED'); filterNames.add(match[1]!);}
    }
    requireCondition(filterNames.size <= 64, 'GIT_FILTER_LIMIT');
    const filters: string[] = [];
    for (const name of filterNames) for (const suffix of ['clean', 'smudge', 'process', 'required']) filters.push('-c', `filter.${name}.${suffix}=${suffix === 'required' ? 'false' : ''}`);
    const safe = [...extra, ...filters];
    const observe = async () => {
      const head = await command(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], safe, true);
      requireCondition(!head || /^(?:[a-f0-9]{40}|[a-f0-9]{64})\n$/.test(head), 'GIT_HEAD_UNVERIFIED');
      if (!head) {
        // A missing object or detached broken HEAD is not an empty repository.
        const ref = (await command(worktree, ['symbolic-ref', '--quiet', 'HEAD'], safe)).trim();
        requireCondition(ref.startsWith('refs/heads/'), 'GIT_HEAD_UNVERIFIED');
        requireCondition(!(await command(worktree, ['rev-parse', '--verify', '--quiet', ref], safe, true)), 'GIT_HEAD_UNVERIFIED');
      }
      const status = await command(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames'], safe);
      const metadata = await changedMetadata(worktree, status);
      const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--no-color', '--no-relative'];
      // Two separate diffs retain staged changes even if the worktree reverses them.
      const staged = await command(worktree, ['diff', '--cached', ...diffArgs, '--'], safe);
      const unstaged = await command(worktree, ['diff', ...diffArgs, '--'], safe);
      return {head, status, staged, unstaged, metadata};
    };
    const first = await observe(), second = await observe();
    const afterDot = await lstat(join(worktree, '.git'));
    requireCondition(before === await stamp(worktree) && afterDot.isDirectory() && !afterDot.isSymbolicLink() && gitIdentity === `${afterDot.dev}:${afterDot.ino}`, 'WORKTREE_CHANGED');
    requireCondition(firstConfig === await config() && JSON.stringify(first) === JSON.stringify(second), 'GIT_CHANGED_DURING_READ');
    const entries = first.status.split('\0').filter(Boolean).map(row => {
      requireCondition(row.length >= 4 && row[2] === ' ' && !row.slice(0, 2).match(/[RC]/), 'GIT_STATUS_UNVERIFIED');
      return {index: row[0]!, working_tree: row[1]!, path: redact(row.slice(3))};
    });
    return {status: 'observed', reason: null, worktree, commit: first.head.trim() || null, head_state: first.head ? 'commit' : 'unborn', entries,
      staged_diff: includeDiff ? redact(first.staged) : null, unstaged_diff: includeDiff ? redact(first.unstaged) : null, diff_requested: includeDiff,
      snapshot_sha256: digest(JSON.stringify(first)), consistency: 'double_observation_matched', untracked_contents: 'not_read', submodule_contents: 'not_read', ignored_contents: 'not_read', atomic_filesystem_snapshot: false};
  } catch (error) {
    const e = error as {message?: string; code?: string};
    return unavailable(e.code === 'ENOENT' ? 'GIT_OR_WORKTREE_UNAVAILABLE' : e.message && /^[A-Z_]+$/.test(e.message) ? e.message : 'GIT_READ_FAILED');
  }
}
