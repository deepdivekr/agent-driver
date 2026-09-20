import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {requireCondition} from '../core/contracts.js';
import {loadHostConfig, type HostConfig} from '../interface/config.js';
import {processIdentitySync, type ProcessIdentity} from '../supervisor/identity.js';
import {TerminalStore} from './store.js';
import {ScopedFiles} from './scoped-files.js';
import {fileRead, fileWrite, type FileAuthority, type FileWrite} from './file-contracts.js';
import {configuredBoundary,resourceFence} from '../resources/configured.js';
import {type BudgetHandle} from '../resources/budget.js';
import {storageError} from '../storage/budget.js';

const result = (value: unknown, failed = false): CallToolResult => ({...(failed ? {isError: true} : {}), content: [{type: 'text', text: JSON.stringify(value)}]});
const safeError = (error: unknown) => storageError(error) === 'STORAGE_FULL' ? 'STORAGE_FULL' : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'FILE_OPERATION_REJECTED';
export type FileCutPoint = (point: 'intent_committed' | 'before_replace' | 'after_replace') => void;
export class FileBroker {
  readonly files: ScopedFiles;
  constructor(readonly config: HostConfig, readonly store: TerminalStore, readonly authority: FileAuthority, private readonly cut?: FileCutPoint,private readonly resourceBoundary:BudgetHandle|null=null) {
    requireCondition(!config.resources||resourceBoundary,'RESOURCE_BOUNDARY_REQUIRED');this.files = new ScopedFiles(config);
  }
  async call(name: 'read_file' | 'write_file', raw: unknown): Promise<CallToolResult> {
    resourceFence(this.resourceBoundary);
    const input = (name === 'read_file' ? fileRead : fileWrite).parse(raw), qualified = `mcp__runtime_files__${name}`;
    // CLI stdout and its MCP child are separate pipes; require the durable matching
    // official tool-use event, allowing only a bounded observation-order delay.
    let tool: string | undefined;
    for (let n = 0; n < 100; n++) {
      resourceFence(this.resourceBoundary);
      this.store.fileFence(this.config, this.authority, input.turn_id);
      tool = this.store.pendingTool(this.authority, input.turn_id, qualified, input);
      if (tool) break;
      await delay(20);
    }
    requireCondition(tool, 'OFFICIAL_TOOL_CALL_UNOBSERVED');
    let answer: CallToolResult;
    try {
      this.files.ownership();
      if (name === 'read_file') answer = this.store.transaction(() => {
        resourceFence(this.resourceBoundary);
        this.store.fileFence(this.config, this.authority, input.turn_id);
        const observation = this.files.read(input.path);
        return result({path: observation.path, sha256: observation.sha256, content: observation.content, turn_id: input.turn_id});
      });
      else answer = this.store.storage(this.config).run('file_effect', Buffer.byteLength((input as FileWrite).content) * 3 + 1048576, () => this.write(input as FileWrite));
    } catch (error) {answer = result({error: safeError(error), automatic_retry: false}, true);}
    this.store.transaction(() => this.store.answerTool(tool, this.authority.session, answer));
    return answer;
  }
  private write(input: FileWrite) {
    requireCondition(this.config.terminal!.files!.write.includes(input.path), 'FILE_WRITE_NOT_DELEGATED');
    requireCondition(Buffer.byteLength(input.content) <= this.config.terminal!.files!.max_bytes, 'FILE_SIZE_LIMIT');
    const before = this.files.read(input.path), {intent, created} = this.store.beginFile(this.config, this.authority, input, before);
    if (!created) {requireCondition(intent.status === 'verified' && intent.result_json, 'FILE_EFFECT_UNCERTAIN'); return result({...JSON.parse(intent.result_json) as Record<string, unknown>, deduplicated: true});}
    this.cut?.('intent_committed');
    try {
      return this.store.transaction(() => {
        resourceFence(this.resourceBoundary);
        this.store.fileFence(this.config, this.authority, input.turn_id);
        const observed = this.files.replace(input.path, before, input.content, intent.id, () => {
          this.cut?.('before_replace');resourceFence(this.resourceBoundary); this.store.storage(this.config).assertAvailable(); this.store.fileFence(this.config, this.authority, input.turn_id);
        }, () => this.cut?.('after_replace'));
        const value = {intent_id: intent.id, turn_id: input.turn_id, path: input.path, sha256: observed.sha256, effect: 'readback_verified', tests: 'NOT_RUN', project_completed: false};
        this.store.finishFile(intent, 'verified', value);
        return result(value);
      });
    } catch (error) {
      // The intent was committed separately. A rolled-back SQLite transaction does
      // NOT roll back rename/fsync; even a known precondition failure needs readback.
      this.store.transaction(() => this.store.finishFile(intent, 'uncertain', {error: safeError(error), automatic_retry: false}));
      throw error;
    }
  }
}

export async function serveFileBroker(path: string, session: string, generation: number, host: string) {
  const config = loadHostConfig(path), store = new TerminalStore(config.dbPath);
  const resourceBoundary=await configuredBoundary(config);
  requireCondition(config.terminal?.files, 'FILE_DELEGATION_REQUIRED');
  const self = processIdentitySync(process.pid), parent = processIdentitySync(process.ppid);
  requireCondition(typeof self !== 'string' && typeof parent !== 'string', 'BROKER_IDENTITY_UNAVAILABLE');
  const authority: FileAuthority = {session, generation, host, broker: JSON.stringify(self), cli: JSON.stringify(parent)};
  let bound = false;
  for (let n = 0; n < 100; n++) {const s = store.session(session); if (s.process_identity_json) {store.bindBroker(config, authority); bound = true; break;} await delay(20);}
  requireCondition(bound, 'BROKER_CLI_UNBOUND');
  const broker = new FileBroker(config, store, authority,undefined,resourceBoundary), server = new McpServer({name: 'runtime-files', version: '1.0.0'});
  for (const name of ['read_file', 'write_file'] as const) server.registerTool(name, {
    description: `${name}. Exact delegated paths only: ${config.terminal.files.read.join(', ')}. Use the Runtime turn_id from the current prompt. No shell, test execution or approval grant.`,
    inputSchema: name === 'read_file' ? fileRead : fileWrite,
    annotations: {readOnlyHint: name === 'read_file', destructiveHint: name === 'write_file', openWorldHint: false},
  }, async args => {try {return await broker.call(name, args);} catch (error) {return result({error: safeError(error), automatic_retry: false}, true);}});
  let closing = false;
  const close = () => {if (closing) return; closing = true; clearInterval(watch); void server.close().finally(() => {store.close();});};
  const watch = setInterval(() => {
    try {
      const currentHost = store.terminalHost(config.project.id), parentStat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      const ppid = Number(parentStat.slice(parentStat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid !== parent.pid || JSON.stringify(processIdentitySync(parent.pid)) !== authority.cli || !currentHost?.active || currentHost.stop_requested || currentHost.instance_id !== host || JSON.stringify(processIdentitySync((JSON.parse(currentHost.identity_json) as ProcessIdentity).pid)) !== currentHost.identity_json) close();
    } catch {close();}
  }, 250);
  process.stdin.once('end', close); process.once('SIGTERM', close); process.once('SIGINT', close);
  server.server.onclose = close;
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, {maxBufferSize: 1048576}));
}
