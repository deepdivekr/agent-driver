import {constants, openSync, closeSync, fstatSync, lstatSync, readdirSync, realpathSync, statfsSync, type BigIntStats} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {type DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {processIdentitySync} from '../supervisor/identity.js';

export const storagePolicySchema = z.object({
  max_bytes: z.number().int().min(33554432).max(68719476736),
  min_free_bytes: z.number().int().min(16777216).max(1099511627776).default(268435456),
  journal_margin_bytes: z.number().int().min(1048576).max(67108864).default(8388608),
  segment_bytes: z.number().int().min(65536).max(1048576).default(262144),
  retention_days: z.number().int().min(1).max(3650).default(30),
  cleanup_enabled: z.boolean().default(false),
}).strict().refine(p => p.journal_margin_bytes < p.max_bytes, 'Journal margin must be smaller than the budget');
export type StoragePolicy = z.infer<typeof storagePolicySchema>;
const safeNumber = (value: bigint) => {requireCondition(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), 'STORAGE_COUNTER_UNAVAILABLE'); return Number(value);};
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Bounded descriptor-anchored observation, not an atomic filesystem snapshot or OS quota. */
export function measureStorage(path: string) {
  requireCondition(process.platform === 'linux', 'STORAGE_PLATFORM_UNVERIFIED');
  const root = resolve(path); requireCondition(realpathSync(root) === root, 'STORAGE_ROOT_REDIRECTED');
  const fd = openSync(root, flags), seen = new Set<string>();
  let entries = 0, links = 0, vanished = 0, logical = 0n, allocated = 0n, accounted = 0n;
  try {
    const initial = fstatSync(fd, {bigint: true});
    const add = (s: BigIntStats) => {
      const key = `${s.dev}:${s.ino}`; if (seen.has(key)) return; seen.add(key);
      const bytes = s.blocks * 512n, size = s.isFile() ? s.size : 0n;
      logical += size; allocated += bytes; accounted += size > bytes ? size : bytes;
    };
    const walk = (dir: number, depth: number) => {
      requireCondition(depth <= 32, 'STORAGE_TREE_DEPTH_LIMIT'); add(fstatSync(dir, {bigint: true}));
      for (const name of readdirSync(`/proc/self/fd/${dir}`)) {
        requireCondition(++entries <= 20000, 'STORAGE_TREE_ENTRY_LIMIT');
        const target = `/proc/self/fd/${dir}/${name}`;
        try {
          const stat = lstatSync(target, {bigint: true});
          requireCondition(stat.dev === initial.dev, 'STORAGE_NESTED_FILESYSTEM_UNVERIFIED');
          if (stat.isDirectory()) {const child = openSync(target, flags); try {walk(child, depth + 1);} finally {closeSync(child);}}
          else {if (stat.isSymbolicLink()) links++; add(stat);}
        } catch (e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') vanished++; else throw e;}
      }
    };
    walk(fd, 0);
    const end = lstatSync(root, {bigint: true});
    requireCondition(end.isDirectory() && end.dev === initial.dev && end.ino === initial.ino, 'STORAGE_ROOT_CHANGED');
    const fs = statfsSync(`/proc/self/fd/${fd}`, {bigint: true});
    return {root, identity: `${initial.dev}:${initial.ino}`, logical_bytes: safeNumber(logical), allocated_bytes: safeNumber(allocated),
      accounted_bytes: safeNumber(accounted), available_bytes: safeNumber(fs.bavail * fs.bsize), entries, symlinks_not_followed: links,
      vanished_entries: vanished, observed_at: new Date().toISOString(), atomic_snapshot: false as const};
  } finally {closeSync(fd);}
}
export const storageError = (error: unknown) => {
  const e = error as {code?: string; errcode?: number; message?: string};
  return e.code === 'ENOSPC' || e.code === 'EDQUOT' || e.errcode === 13 ? 'STORAGE_FULL' :
    e.message && /^STORAGE_[A-Z_]+$/.test(e.message) ? e.message : 'STORAGE_UNOBSERVED';
};

export function assertVolumeCapacity(config: HostConfig, directory: string | number, bytes: number) {
  if (!config.storage) return;
  const fd = typeof directory === 'number' ? directory : openSync(directory, flags);
  try {
    const fs = statfsSync(`/proc/self/fd/${fd}`, {bigint: true});
    requireCondition(safeNumber(fs.bavail * fs.bsize) >= bytes + config.storage.min_free_bytes + config.storage.journal_margin_bytes, 'STORAGE_LOW_SPACE');
  } finally {if (typeof directory !== 'number') closeSync(fd);}
}

export class StorageLedger {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(fn: () => T) => T, readonly config: HostConfig) {}
  private policy() {requireCondition(this.config.storage, 'STORAGE_UNCONFIGURED'); return this.config.storage;}
  private observe() {
    const policy = this.policy(), observation = measureStorage(dirname(this.config.dbPath));
    const hash = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
    const old = this.db.prepare('SELECT * FROM storage_policy WHERE singleton=1').get();
    requireCondition(!old || old.policy_hash === hash && old.root_identity === observation.identity, 'STORAGE_POLICY_OR_ROOT_CHANGED');
    const reserved = Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM storage_reservation WHERE active=1').get()!.bytes);
    return {policy, observation, hash, reserved};
  }
  status() {
    if (!this.config.storage) return {status: 'unconfigured', verified: false, usage: 'unobserved'};
    try {
      const {policy, observation, reserved} = this.observe();
      const reason = observation.accounted_bytes + reserved + policy.journal_margin_bytes > policy.max_bytes ? 'STORAGE_BUDGET_EXCEEDED' :
        observation.available_bytes < reserved + policy.min_free_bytes + policy.journal_margin_bytes ? 'STORAGE_LOW_SPACE' : null;
      return {status: reason ? 'blocked' : 'admission_available', reason, verified: true, usage: observation, reserved_bytes: reserved, policy,
        scope: 'configured_runtime_data_directory', hard_filesystem_quota: false, next_action: reason ? 'stop_new_effects_review_storage_plan_or_free_space' : 'none'};
    } catch (e) {return {status: 'unavailable', reason: storageError(e), verified: false, usage: 'unobserved', next_action: 'restore_storage_path_and_capacity_before_dispatch'};}
  }
  assertAvailable(bytes = 0) {
    if (!this.config.storage) return;
    requireCondition(Number.isSafeInteger(bytes) && bytes >= 0, 'STORAGE_INVALID_RESERVATION');
    const {policy, observation, reserved} = this.observe();
    requireCondition(observation.accounted_bytes + reserved + bytes + policy.journal_margin_bytes <= policy.max_bytes, 'STORAGE_BUDGET_EXCEEDED');
    requireCondition(observation.available_bytes >= reserved + bytes + policy.min_free_bytes + policy.journal_margin_bytes, 'STORAGE_LOW_SPACE');
  }
  reserve(kind: string, bytes: number): string | null {
    if (!this.config.storage) return null;
    requireCondition(/^[a-z][a-z_]{0,31}$/.test(kind) && Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 2147483648, 'STORAGE_INVALID_RESERVATION');
    const identity = processIdentitySync(process.pid); requireCondition(typeof identity !== 'string', 'STORAGE_OWNER_UNOBSERVED');
    return this.transaction(() => {
      this.assertAvailable(bytes); const {observation, hash} = this.observe();
      this.db.prepare('INSERT OR IGNORE INTO storage_policy VALUES (1,?,?)').run(hash, observation.identity);
      requireCondition(Number(this.db.prepare('SELECT COUNT(*) AS count FROM storage_reservation WHERE active=1').get()!.count) < 128, 'STORAGE_RESERVATION_LIMIT');
      const id = randomUUID();
      this.db.prepare('INSERT INTO storage_reservation VALUES (?,?,?,?,?,?,1)').run(id, this.config.project.id, kind, bytes, JSON.stringify(identity), new Date().toISOString());
      return id;
    });
  }
  release(id: string | null) {
    if (!id) return;
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM storage_reservation WHERE id=?').get(id);
      requireCondition(row?.project_id === this.config.project.id && row.owner_identity_json === JSON.stringify(processIdentitySync(process.pid)), 'STORAGE_RESERVATION_OWNER_MISMATCH');
      this.db.prepare('DELETE FROM storage_reservation WHERE id=?').run(id);
    });
  }
  run<T>(kind: string, bytes: number, action: () => T): T {
    const id = this.reserve(kind, bytes); let failed = false;
    try {return action();} catch (e) {failed = true; throw e;}
    finally {try {this.release(id);} catch (e) {if (!failed) throw e;}}
  }
  async runAsync<T>(kind: string, bytes: number, action: () => Promise<T>): Promise<T> {
    const id = this.reserve(kind, bytes); let failed = false;
    try {return await action();} catch (e) {failed = true; throw e;}
    finally {try {this.release(id);} catch (e) {if (!failed) throw e;}}
  }
  reapDeadOwners() {
    return this.transaction(() => {
      let released = 0;
      for (const row of this.db.prepare('SELECT * FROM storage_reservation WHERE active=1 AND project_id=?').all(this.config.project.id)) {
        const expected = JSON.parse(String(row.owner_identity_json)) as {pid: number}, actual = processIdentitySync(expected.pid);
        if (actual === 'dead' || typeof actual !== 'string' && JSON.stringify(actual) !== row.owner_identity_json) released += Number(this.db.prepare('DELETE FROM storage_reservation WHERE id=? AND active=1').run(row.id!).changes);
      }
      return {released, unresolved: this.db.prepare('SELECT COUNT(*) AS count FROM storage_reservation WHERE active=1 AND project_id=?').get(this.config.project.id)!.count};
    });
  }
}
