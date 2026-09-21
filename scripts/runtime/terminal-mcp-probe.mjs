// Opt-in installed-CLI protocol observation. No filesystem/shell tool is exposed.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {spawn} from 'node:child_process';
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {cliEnvironment} from '../../dist/terminal/claude.js';
if (process.argv[2] === '--server') {
  const server = new McpServer({name: 'probe', version: '1.0.0'});
  server.registerTool('echo', {inputSchema: z.object({value: z.literal('synthetic-602')}).strict()}, async () => ({content: [{type: 'text', text: JSON.stringify({value: 'observed-602', parent_pid: process.ppid, broker_pid: process.pid})}]}));
  process.stdin.once('end', () => {void server.close();});
  await server.connect(new StdioServerTransport());
} else {
  if (process.argv[3] !== '--run') throw Error('Explicit executable and --run required');
  const id = `terminal-mcp-probe-${randomUUID()}`, root = resolve('.runtime', id);
  mkdirSync(root, {recursive: true, mode: 0o700});
  const cliSession = randomUUID(), turn = randomUUID();
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--session-id', cliSession,
    '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({mcpServers: {probe: {type: 'stdio', command: process.execPath, args: [fileURLToPath(import.meta.url), '--server']}}}),
    '--allowedTools', 'mcp__probe__echo', '--setting-sources', '', '--settings', JSON.stringify({disableAllHooks: true, permissions: {allow: ['mcp__probe__echo']}}), '--disable-slash-commands', '--no-chrome', '--permission-mode', 'dontAsk'];
  const child = spawn(process.argv[2], args, {cwd: root, env: {...cliEnvironment(), ENABLE_TOOL_SEARCH: 'false'}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  let pending = '', stderrBytes = 0;
  const events = [], started = performance.now();
  child.stderr.on('data', b => {stderrBytes += b.length;});
  child.stdout.on('data', b => {
    pending += b.toString('utf8');
    while (pending.includes('\n')) {
      const at = pending.indexOf('\n'), line = pending.slice(0, at); pending = pending.slice(at + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line); events.push(event);
      if (event.type === 'result') child.stdin.end();
    }
  });
  child.stdin.write(JSON.stringify({type: 'user', uuid: turn, session_id: cliSession, message: {role: 'user', content: 'Call mcp__probe__echo exactly once with value synthetic-602, then report the returned value. This is a synthetic protocol test.'}, parent_tool_use_id: null}) + '\n');
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  const closed = await new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  clearTimeout(timer);
  const pass = events.some(e => e.type === 'user' && Array.isArray(e.message?.content) && e.message.content.some(c => c.type === 'tool_result')) && events.some(e => e.type === 'result' && e.subtype === 'success' && !e.is_error);
  const receipt = {id, status: pass ? 'PASS' : 'FAIL', prompts_accepted: 1, elapsed_ms: performance.now() - started, cli_pid: child.pid, closed, stderr_bytes: stderrBytes, events};
  writeFileSync(resolve(root, 'receipt.json'), JSON.stringify(receipt, null, 2), {mode: 0o600});
  const evidence = {id, status: receipt.status, prompts_accepted: 1, elapsed_ms: receipt.elapsed_ms, closed, event_shapes: events.map(e => ({type: e.type, subtype: e.subtype, keys: Object.keys(e), content_types: Array.isArray(e.message?.content) ? e.message.content.map(c => c.type) : null}))};
  writeFileSync(`tests/evidence/${id}.json`, JSON.stringify(evidence, null, 2));
  const report = JSON.parse(readFileSync('tests/report.json', 'utf8'));
  report.cases.push({case_id: id, evidence_level: 'native_integration', status: receipt.status, environment: 'WSL Linux / Claude 2.1.126 / isolated synthetic MCP echo', observations: evidence, evidence_paths: [`tests/evidence/${id}.json`]});
  writeFileSync('tests/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({...evidence, receipt: resolve(root, 'receipt.json'), cli_pid: child.pid}));
  if (!pass) process.exitCode = 1;
}
