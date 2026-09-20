import {createServer, type Server} from 'node:net';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdirSync, mkdtempSync, openSync, writeSync, fsyncSync, closeSync, chmodSync, unlinkSync, rmdirSync, fstatSync, constants} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {loadHostConfig, type HostConfig} from '../interface/config.js';
import {requireCondition} from '../core/contracts.js';
import {processIdentity, liveness, bootClock, type ProcessIdentity} from '../supervisor/identity.js';
import {TerminalStore} from './store.js';
import {launchClaude, verifyClaude, classifyResult, type CliLauncher, type CliTransport} from './claude.js';
import {redact, type CliEvent, type TerminalSession} from './contracts.js';
import {brokerTools, fileRead, fileWrite, wirePrompt} from './file-contracts.js';

interface Managed {session: TerminalSession; transport: CliTransport | null; failed: boolean; exited: boolean; starting: boolean; pending: CliEvent[]}
export class TerminalHost {
  readonly store: TerminalStore;
  private instance: string | null = null;
  private server: Server | null = null;
  private socketDirectory: string | null = null;
  private managed = new Map<string, Managed>();
  private stopping = false;
  constructor(readonly config: HostConfig, private readonly launch: CliLauncher = launchClaude, private readonly preflight: (config: HostConfig) => Promise<void> = verifyClaude) {
    requireCondition(process.platform === 'linux', 'TERMINAL_PLATFORM_UNVERIFIED');
    requireCondition(config.terminal, 'TERMINAL_DISABLED');
    this.store = new TerminalStore(config.dbPath); this.store.registerProject(config.project);
  }
  private fresh() {const current = loadHostConfig(this.config.path); requireCondition(current.fingerprint === this.config.fingerprint, 'CONFIG_CHANGED'); return current;}
  async start() {
    this.fresh(); await this.preflight(this.config);
    const identity = await processIdentity(process.pid); requireCondition(typeof identity !== 'string', 'HOST_IDENTITY_UNAVAILABLE');
    const old = this.store.terminalHost(this.config.project.id);
    if (old) requireCondition(await liveness(JSON.parse(old.identity_json) as ProcessIdentity) === 'dead', 'TERMINAL_HOST_EXISTS');
    const directory = mkdtempSync(join(tmpdir(), 'apd-cli-')); chmodSync(directory, 0o700);
    this.socketDirectory = directory;
    const endpoint = join(directory, 'host.sock'), token = randomBytes(32).toString('hex');
    this.server = createServer(socket => {
      let received = ''; socket.setTimeout(1000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', chunk => {
        received += chunk.toString('utf8');
        if (received.length > 512) {socket.destroy(); return;}
        if (!received.includes('\n')) return;
        const supplied = Buffer.from(received.trim()), expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {socket.destroy(); return;}
        socket.end(JSON.stringify({instance_id: this.instance, process_identity: identity}) + '\n');
      });
    });
    await new Promise<void>((resolve, reject) => {this.server!.once('error', reject); this.server!.listen(endpoint, () => {this.server!.off('error', reject); resolve();});});
    chmodSync(endpoint, 0o600);
    this.instance = this.store.claimTerminalHost(this.config, identity, old?.instance_id ?? null, endpoint, token);
    return this.instance;
  }
  private record(id: string, event: CliEvent) {
    const managed = this.managed.get(id)!;
    const session = this.store.session(id);
    const safe = {type: event.type, subtype: typeof event.subtype === 'string' ? redact(event.subtype.slice(0, 256)) : null, uuid: typeof event.uuid === 'string' ? redact(event.uuid.slice(0, 256)) : null,
      session_id: session.cli_session_id, model: event.type === 'system' && typeof event.model === 'string' ? redact(event.model.slice(0, 200)) : undefined,
      result: event.type === 'result' && typeof event.result === 'string' ? redact(event.result.slice(0, 65536)) : undefined};
    const line = Buffer.from(JSON.stringify(safe) + '\n');
    requireCondition(session.spool_bytes + line.length <= this.config.terminal!.spool_bytes, 'CLI_SPOOL_QUOTA');
    const directory = join(dirname(this.config.dbPath), 'terminal-spool'); mkdirSync(directory, {recursive: true, mode: 0o700});
    const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const fd = openSync(`/proc/self/fd/${dir}/${id}.jsonl`, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const stat = fstatSync(fd); requireCondition(stat.isFile() && stat.nlink === 1 && stat.size === session.spool_bytes, 'CLI_SPOOL_DURABILITY_GAP');
        let written = 0; while (written < line.length) {const count = writeSync(fd, line, written); requireCondition(count > 0, 'CLI_SPOOL_WRITE_FAILED'); written += count;}
        fsyncSync(fd);
      } finally {closeSync(fd);}
    } finally {closeSync(dir);}
    this.store.noteSpool(id, this.instance!, managed.session.generation, line.length, event.type, createHash('sha256').update(line).digest('hex'));
  }
  private event(id: string, event: CliEvent) {
    const managed = this.managed.get(id)!;
    if (managed.failed || this.stopping) return;
    if (managed.starting) {
      requireCondition(managed.pending.length < 8, 'CLI_EARLY_OUTPUT_LIMIT'); managed.pending.push(event); return;
    }
    const session = this.store.session(id), generation = managed.session.generation;
    requireCondition(event.session_id === session.cli_session_id || event.type === 'rate_limit_event', 'CLI_SESSION_MISMATCH');
    requireCondition(['system', 'user', 'assistant', 'result', 'rate_limit_event'].includes(event.type), 'CLI_UNKNOWN_EVENT');
    this.record(id, event);
    if (event.type === 'system') {
      requireCondition(event.subtype === 'init' && event.permissionMode === 'dontAsk' && Array.isArray(event.tools), 'CLI_INIT_MISMATCH');
      const expected = this.config.terminal!.files ? [...brokerTools] : [];
      requireCondition(JSON.stringify([...event.tools].sort()) === JSON.stringify(expected.sort()), 'CLI_TOOL_SCOPE_MISMATCH');
      if (this.config.terminal!.files) {
        requireCondition(JSON.stringify(event.mcp_servers) === JSON.stringify([{name: 'runtime_files', status: 'connected'}]), 'CLI_BROKER_NOT_CONNECTED');
        requireCondition(this.store.broker(id, generation), 'CLI_BROKER_UNBOUND');
      }
    } else if (event.type === 'user') {
      const message = event.message as {role?: unknown; content?: unknown} | undefined;
      if (Array.isArray(message?.content)) {
        requireCondition(this.config.terminal!.files && message.role === 'user' && event.parent_tool_use_id === null && message.content.length > 0, 'CLI_TOOL_RESULT_MISMATCH');
        for (const item of message.content as Array<Record<string, unknown>>) {
          requireCondition(item.type === 'tool_result' && typeof item.tool_use_id === 'string' && (item.is_error === undefined || typeof item.is_error === 'boolean'), 'CLI_TOOL_RESULT_MISMATCH');
          this.store.observeToolResult(id, this.instance!, generation, item.tool_use_id, item.content, item.is_error === true);
        }
      } else {
        requireCondition(session.active_turn_id && event.uuid === session.active_turn_id, 'CLI_RECEIPT_MISMATCH');
        requireCondition(message?.role === 'user' && message.content === wirePrompt(session.active_turn_id, this.store.turn(session.active_turn_id).prompt, !!this.config.terminal!.files), 'CLI_PROMPT_ECHO_MISMATCH');
        this.store.acknowledge(id, this.instance!, generation, session.active_turn_id);
      }
    } else if (event.type === 'result') {
      this.store.assertToolsSettled(id);
      const result = classifyResult(event);
      this.store.result(id, this.instance!, generation, result);
      const completed = this.store.session(id);
      if (result.outcome === 'completed' && managed.transport?.writable() && !completed.interrupt_requested && !completed.manual_control && !this.store.task(completed.task_id).cancel_requested) this.store.ready(id, this.instance!, generation);
    } else if (event.type === 'rate_limit_event') {
      // This event also appears on successful turns. Never infer a wait from its name.
      // Until installed-version payloads are verified it is telemetry only; deadline/result governs input.
    } else {
      requireCondition(session.active_turn_id, 'CLI_UNSOLICITED_ASSISTANT');
      const message = event.message as {content?: unknown} | undefined;
      if (Array.isArray(message?.content)) for (const item of message.content as Array<Record<string, unknown>>) if (item.type === 'tool_use') {
        requireCondition(this.config.terminal!.files && event.parent_tool_use_id === null && typeof item.id === 'string' && item.id.length <= 128, 'CLI_TOOL_NOT_DELEGATED');
        const schema = item.name === brokerTools[0] ? fileRead : item.name === brokerTools[1] ? fileWrite : null;
        requireCondition(schema, 'CLI_TOOL_NOT_DELEGATED'); const input = schema.parse(item.input);
        requireCondition(input.turn_id === session.active_turn_id, 'CLI_TOOL_TURN_MISMATCH');
        this.store.toolRequested(id, this.instance!, generation, item.id, String(item.name), input);
      }
    }
  }
  private fail(id: string, reason: string) {
    const managed = this.managed.get(id); if (!managed || managed.failed) return;
    managed.failed = true;
    try {this.store.failed(id, this.instance!, managed.session.generation, reason);}
    finally {void managed.transport?.stop();}
  }
  private async launchSession(session: TerminalSession) {
    this.fresh();
    if (session.resume_requested) requireCondition(session.process_identity_json && await liveness(JSON.parse(session.process_identity_json) as ProcessIdentity) === 'dead', 'CLI_STILL_ALIVE_OR_UNKNOWN');
    const claimed = this.store.claimSession(session.id, this.instance!, this.config);
    const managed: Managed = {session: claimed.session, transport: null, failed: false, exited: false, starting: true, pending: []};
    this.managed.set(session.id, managed);
    try {
      managed.transport = await this.launch(this.config, claimed.session, claimed.resume, {
        event: event => this.event(session.id, event),
        failure: reason => this.fail(session.id, reason),
        exit: () => {
          managed.exited = true;
          if (!managed.failed && !this.stopping) this.fail(session.id, 'PROCESS_EXITED');
          this.store.observedExit(session.id, this.instance!, managed.session.generation);
        },
      });
      requireCondition(managed.transport.child.pid, 'CLI_PID_UNAVAILABLE');
      const identity = await processIdentity(managed.transport.child.pid);
      requireCondition(typeof identity !== 'string', 'CLI_IDENTITY_UNAVAILABLE');
      this.store.bindProcess(session.id, this.instance!, claimed.session.generation, identity);
      managed.starting = false;
      for (const event of managed.pending.splice(0)) this.event(session.id, event);
      requireCondition(managed.transport.writable(), 'CLI_NOT_WRITABLE');
      this.store.ready(session.id, this.instance!, claimed.session.generation);
    } catch (error) {managed.starting = false; this.fail(session.id, error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CLI_START_FAILED');}
  }
  async tick() {
    requireCondition(this.instance, 'HOST_NOT_STARTED'); this.fresh(); this.store.assertHost(this.config.project.id, this.instance);
    for (const session of this.store.sessions(this.config.project.id)) {
      let managed = this.managed.get(session.id);
      if (managed?.exited && session.resume_requested) {this.managed.delete(session.id); managed = undefined;}
      if (!managed) {
        if (session.state === 'starting' && !session.host_instance_id && (session.interrupt_requested || session.manual_control || this.store.task(session.task_id).cancel_requested)) {this.store.stopBeforeStart(session.id, this.instance); continue;}
        if (session.state === 'starting' && !session.host_instance_id || session.resume_requested) {await this.launchSession(session); continue;}
        if (session.host_instance_id && session.host_instance_id !== this.instance && !session.error_code) {
          const state = session.process_identity_json ? await liveness(JSON.parse(session.process_identity_json) as ProcessIdentity) : 'unknown';
          this.store.failed(session.id, this.instance, session.generation, state === 'dead' ? 'HOST_DIED_CLI_DEAD' : state === 'alive' ? 'HOST_DIED_CLI_ALIVE' : 'HOST_DIED_CLI_UNKNOWN', true);
        }
        continue;
      }
      if (managed.failed) continue;
      if (session.interrupt_requested || session.manual_control || this.store.task(session.task_id).cancel_requested) {this.fail(session.id, 'INTERRUPTED'); continue;}
      if (!session.active_turn_id) continue;
      const turn = this.store.turn(session.active_turn_id);
      if (turn.status === 'accepted') {
        const transport = managed.transport; requireCondition(transport && transport.writable(), 'CLI_NOT_WRITABLE');
        const identity = await processIdentity(transport.child.pid!);
        requireCondition(typeof identity !== 'string' && JSON.stringify(identity) === session.process_identity_json, 'CLI_IDENTITY_CHANGED');
        this.fresh();
        const dispatched = this.store.dispatch(session.id, this.instance, managed.session.generation, this.config);
        try {transport.send(dispatched.id, dispatched.prompt);} catch {this.fail(session.id, 'CLI_STDIN_UNCERTAIN');}
      } else if (turn.deadline_uptime_ms !== null && bootClock().uptimeMs >= turn.deadline_uptime_ms) this.fail(session.id, 'TURN_DEADLINE');
    }
  }
  async close() {
    if (this.stopping) return;
    this.stopping = true;
    // Fence first; only child handles created by this host are signalled.
    for (const [id, managed] of this.managed) {
      if (!managed.failed && this.instance) {managed.failed = true; try {this.store.failed(id, this.instance, managed.session.generation, 'HOST_STOPPED');} catch {}}
      await managed.transport?.stop();
    }
    if (this.instance) this.store.retireTerminalHost(this.config.project.id, this.instance);
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.socketDirectory) {try {unlinkSync(join(this.socketDirectory, 'host.sock'));} catch {} try {rmdirSync(this.socketDirectory);} catch {}}
    this.store.close();
  }
  async run() {
    const stop = () => {this.stopping = true;};
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try {
      await this.start();
      while (!this.stopping && !this.store.terminalHost(this.config.project.id)?.stop_requested) {await this.tick(); await delay(50);}
    } finally {
      this.stopping = false; await this.close(); process.off('SIGTERM', stop); process.off('SIGINT', stop);
    }
  }
}
