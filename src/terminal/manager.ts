import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {loadHostConfig, type HostConfig} from '../interface/config.js';
import {requireCondition} from '../core/contracts.js';
import {liveness, type ProcessIdentity} from '../supervisor/identity.js';
import {TerminalStore} from './store.js';
import {cliEnvironment} from './claude.js';
import {type TerminalHostRecord} from './contracts.js';

export async function pingTerminalHost(row: TerminalHostRecord) {
  return new Promise<boolean>(resolve => {
    const socket = createConnection(row.endpoint); let text = '', settled = false;
    const done = (ok: boolean) => {if (!settled) {settled = true; socket.destroy(); resolve(ok);}};
    socket.setTimeout(1000, () => done(false));
    socket.on('error', () => done(false)); socket.on('end', () => done(false));
    socket.on('connect', () => socket.write(row.token + '\n'));
    socket.on('data', chunk => {
      text += chunk.toString(); if (text.length > 2048) {done(false); return;}
      if (!text.includes('\n')) return;
      try {const response = JSON.parse(text); done(response.instance_id === row.instance_id && JSON.stringify(response.process_identity) === row.identity_json);} catch {done(false);}
    });
  });
}
export async function ensureTerminalHost(config: HostConfig) {
  requireCondition(config.terminal, 'TERMINAL_DISABLED');
  requireCondition(process.platform === 'linux', 'TERMINAL_PLATFORM_UNVERIFIED');
  requireCondition(loadHostConfig(config.path).fingerprint === config.fingerprint, 'CONFIG_CHANGED');
  const store = new TerminalStore(config.dbPath); store.registerProject(config.project);
  try {
    const old = store.terminalHost(config.project.id);
    if (old) {
      const state = await liveness(JSON.parse(old.identity_json) as ProcessIdentity);
      requireCondition(state !== 'unknown', 'TERMINAL_HOST_IDENTITY_UNKNOWN');
      if (state === 'alive') {
        requireCondition(old.active === 1 && !old.stop_requested && old.config_hash === config.fingerprint, 'TERMINAL_HOST_CONFIG_OR_STOP_CHANGED');
        requireCondition(await pingTerminalHost(old), 'TERMINAL_HOST_IPC_UNAVAILABLE'); return old;
      }
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./entry.js', import.meta.url)), config.path], {detached: true, windowsHide: true, shell: false, stdio: 'ignore', env: cliEnvironment()});
    await new Promise<void>((resolve, reject) => {child.once('error', reject); child.once('spawn', () => {child.unref(); resolve();});});
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      const row = store.terminalHost(config.project.id);
      if (row?.active && !row.stop_requested && row.config_hash === config.fingerprint && await liveness(JSON.parse(row.identity_json) as ProcessIdentity) === 'alive' && await pingTerminalHost(row)) return row;
      await delay(50);
    }
    throw Error('TERMINAL_HOST_START_UNCONFIRMED');
  } finally {store.close();}
}
export async function stopTerminalHost(config: HostConfig) {
  const store = new TerminalStore(config.dbPath);
  try {
    const row = store.terminalHost(config.project.id);
    if (!row) return {stopped: true, children: 'unobserved'};
    store.stopTerminalHost(config.project.id, row.instance_id);
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      if (await liveness(JSON.parse(row.identity_json) as ProcessIdentity) === 'dead') return {stopped: true, children: 'inspect_session_identities'};
      await delay(50);
    }
    return {stopped: false, reason: 'TERMINAL_STOP_UNCONFIRMED'};
  } finally {store.close();}
}
