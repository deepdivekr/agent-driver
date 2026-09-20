import {spawn, execFile, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {promisify} from 'node:util';
import {StringDecoder} from 'node:string_decoder';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {redact, type CliEvent, type TerminalSession, type TurnResult} from './contracts.js';

export interface CliTransport {
  readonly child: ChildProcessWithoutNullStreams;
  writable(): boolean;
  send(turn: string, prompt: string): void;
  stop(): Promise<void>;
}
export interface CliCallbacks {event(event: CliEvent): void; failure(code: string): void; exit(): void}
export type CliLauncher = (config: HostConfig, session: TerminalSession, resume: boolean, callbacks: CliCallbacks) => Promise<CliTransport>;

export function cliEnvironment() {
  const env: NodeJS.ProcessEnv = {DISABLE_AUTOUPDATER: '1'};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export function claudeArgs(config: HostConfig, session: TerminalSession, resume: boolean) {
  requireCondition(config.terminal && session.worktree === config.project.worktree, 'CLI_BINDING_REQUIRED');
  // These flags were verified on 2.1.126. OAuth remains in the CLI's own auth store.
  const permissions = config.terminal.tools.length ? [`Read(/${config.project.worktree}/**)`, `Edit(/${config.project.worktree}/**)`] : [];
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    resume ? '--resume' : '--session-id', session.cli_session_id,
    '--tools', config.terminal.tools.join(','), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--settings', JSON.stringify({disableAllHooks: true, permissions: {allow: permissions}}),
    '--disable-slash-commands', '--no-chrome', '--permission-mode', 'dontAsk'];
}
export async function verifyClaude(config: HostConfig) {
  requireCondition(config.terminal, 'TERMINAL_DISABLED');
  const output = await promisify(execFile)(config.terminal.executable, ['--version'], {cwd: config.project.worktree, env: cliEnvironment(), shell: false, windowsHide: true, timeout: 7000, maxBuffer: 4096});
  requireCondition(output.stdout.trim() === `${config.terminal.version} (Claude Code)`, 'CLI_VERSION_MISMATCH');
}

/** Incremental framing, not a TUI/prompt-text recognizer. Unknown frames fail closed. */
export class JsonLineDecoder {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  constructor(private readonly receive: (event: CliEvent) => void, private readonly limit = 1024 * 1024) {}
  push(bytes: Buffer) {
    const text = this.decoder.write(bytes);
    // Bound each frame even when many frames arrive in a single chunk.
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      this.pending += parts[i]!;
      requireCondition(Buffer.byteLength(this.pending) <= this.limit, 'CLI_FRAME_TOO_LARGE');
      if (i < parts.length - 1) {
        const line = this.pending.trim(); this.pending = '';
        if (!line) continue;
        const event: unknown = JSON.parse(line);
        requireCondition(typeof event === 'object' && event !== null && 'type' in event && typeof event.type === 'string', 'CLI_INVALID_FRAME');
        this.receive(event as CliEvent);
      }
    }
  }
  end() {
    this.pending += this.decoder.end();
    requireCondition(!this.pending.trim(), 'CLI_TRUNCATED_FRAME');
  }
}
export function transportFromChild(child: ChildProcessWithoutNullStreams, session: TerminalSession, callbacks: CliCallbacks): CliTransport {
  let stopped = false, closed = false, stopPromise: Promise<void> | null = null;
  const decoder = new JsonLineDecoder(callbacks.event);
  const fail = (code: string) => {if (!stopped) {stopped = true; callbacks.failure(code);}};
  child.stdout.on('data', (chunk: Buffer) => {if (!stopped) try {decoder.push(chunk);} catch (error) {fail(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CLI_PROTOCOL_ERROR');}});
  child.stdout.on('end', () => {if (!stopped) try {decoder.end();} catch {fail('CLI_TRUNCATED_FRAME');}});
  // Always drain stderr, but do not persist arbitrary CLI stderr (paths/secrets).
  child.stderr.on('data', () => {});
  child.on('error', () => fail('CLI_PROCESS_ERROR'));
  child.stdin.on('error', () => fail('CLI_STDIN_ERROR'));
  const ended = new Promise<void>(resolve => child.once('close', () => {closed = true; callbacks.exit(); resolve();}));
  return {
    child,
    writable: () => !closed && !stopped && child.exitCode === null && child.signalCode === null && child.stdin.writable && !child.stdin.destroyed,
    send(turn, prompt) {
      requireCondition(!closed && !stopped && child.exitCode === null && child.signalCode === null && child.stdin.writable && !child.stdin.destroyed, 'CLI_NOT_WRITABLE');
      const message = {type: 'user', uuid: turn, session_id: session.cli_session_id, message: {role: 'user', content: prompt}, parent_tool_use_id: null};
      // One bounded prompt at a time; never a shell command, even after child exit.
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        stopped = true;
        if (closed) return;
        child.stdin.end(); child.kill('SIGTERM');
        const timer = setTimeout(() => {if (!closed) child.kill('SIGKILL');}, 2000);
        try {await ended;} finally {clearTimeout(timer);}
      })();
      return stopPromise;
    },
  };
}
export const launchClaude: CliLauncher = async (config, session, resume, callbacks) => {
  const child = spawn(config.terminal!.executable, claudeArgs(config, session, resume), {cwd: session.worktree, env: cliEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  return transportFromChild(child, session, callbacks);
};
export function classifyResult(event: CliEvent): TurnResult {
  requireCondition(event.type === 'result' && typeof event.is_error === 'boolean' && Array.isArray(event.permission_denials), 'UNRECOGNIZED_CLI_RESULT');
  const outcome = event.permission_denials.length ? 'waiting_approval' : event.subtype === 'success' && !event.is_error ? 'completed' : 'state_unknown';
  return {outcome, text: typeof event.result === 'string' ? redact(event.result.slice(0, 65536)) : null, is_error: event.is_error, source: 'official_result', project_completed: false};
}
