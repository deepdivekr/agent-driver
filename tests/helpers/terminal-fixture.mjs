// Synthetic stream-json CLI. Never use as evidence of actual Claude behavior.
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
const session = process.argv[2], root = process.argv[3];
const emit = event => process.stdout.write(JSON.stringify({session_id: session, ...event}) + '\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
lines.on('line', line => {void (async () => {
  const input = JSON.parse(line), mode = existsSync(join(root, 'mode.txt')) ? readFileSync(join(root, 'mode.txt'), 'utf8') : 'normal';
  appendFileSync(join(root, 'received.jsonl'), JSON.stringify(input) + '\n');
  emit({type: 'system', subtype: 'init', permissionMode: 'dontAsk', tools: []});
  if (mode === 'before-ack') {while (!existsSync(join(root, 'release'))) await wait(10);}
  if (mode === 'no-ack') {emit({type: 'result', subtype: 'success', is_error: false, permission_denials: [], result: 'unbound'}); return;}
  emit({...input, type: 'user', session_id: mode === 'wrong-session' ? 'foreign-session' : session});
  if (input.message.content === 'owned-load-stream') {
    // Finite producer, honors the OS pipe. No API/model or unbounded write queue.
    for (let i = 0; i < 50000; i++) {
      if (!emit({type: 'assistant', uuid: `${i}`.padEnd(150, 'x')})) await once(process.stdout, 'drain');
    }
    return;
  }
  if (mode === 'after-ack') {while (!existsSync(join(root, 'release'))) await wait(10);}
  if (mode === 'unknown') {emit({type: 'changed_protocol'}); return;}
  if (mode === 'flood') {for (let i = 0; i < 1500; i++) emit({type: 'assistant', uuid: `${i}`.padEnd(150, 'x')}); return;}
  if (mode === 'oversized') {process.stdout.write('x'.repeat(1024 * 1024 + 1)); return;}
  emit({type: 'rate_limit_event'});
  emit({type: 'assistant', message: {content: [{type: 'text', text: input.message.content}]}});
  emit({type: 'result', subtype: 'success', is_error: false, permission_denials: mode === 'denied' ? [{tool_name: 'Write'}] : [], result: input.message.content});
  if (mode === 'exit') setTimeout(() => process.exit(0), 30);
})();});
lines.on('close', () => process.exit(0));
