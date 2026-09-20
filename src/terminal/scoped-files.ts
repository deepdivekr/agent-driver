import {constants, openSync, closeSync, fstatSync, fchmodSync, readFileSync, readSync, writeSync, fsyncSync, realpathSync, renameSync, linkSync, unlinkSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {delegatedPath} from './file-contracts.js';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export interface FileObservation {path: string; sha256: string | null; content: string | null; identity: string | null; mode: number | null}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export function writeAll(fd: number, bytes: Buffer) {let offset = 0; while (offset < bytes.length) {const n = writeSync(fd, bytes, offset); requireCondition(n > 0, 'FILE_SHORT_WRITE'); offset += n;} fsyncSync(fd);}

/** Directory descriptors prevent symlink traversal. This is not a same-UID security sandbox. */
export class ScopedFiles {
  constructor(readonly config: HostConfig) {requireCondition(process.platform === 'linux' && config.terminal?.files, 'FILE_DELEGATION_REQUIRED');}
  private parent<T>(path: string, action: (anchored: string, parent: number) => T): T {
    delegatedPath.parse(path); requireCondition(this.config.terminal!.files!.read.includes(path), 'FILE_NOT_DELEGATED');
    const parts = path.split('/'), fds: number[] = [];
    try {
      let fd = openSync(this.config.project.worktree, directoryFlags); fds.push(fd);
      for (const part of parts.slice(0, -1)) {fd = openSync(`/proc/self/fd/${fd}/${part}`, directoryFlags); fds.push(fd);}
      requireCondition(realpathSync(`/proc/self/fd/${fd}`) === dirname(resolve(this.config.project.worktree, path)), 'FILE_PARENT_CHANGED');
      return action(`/proc/self/fd/${fd}/${parts.at(-1)!}`, fd);
    } finally {for (const fd of fds.reverse()) closeSync(fd);}
  }
  private observe(path: string, anchored: string): FileObservation {
    let fd: number;
    try {fd = openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {path, sha256: null, content: null, identity: null, mode: null}; throw error;}
    try {
      const before = fstatSync(fd, {bigint: true});
      requireCondition(before.isFile() && before.nlink === 1n, 'FILE_REGULAR_SINGLE_LINK_REQUIRED');
      requireCondition(before.size <= BigInt(this.config.terminal!.files!.max_bytes), 'FILE_SIZE_LIMIT');
      const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < buffer.length) {const n = readSync(fd, buffer, length, buffer.length - length, null); if (!n) break; length += n;}
      const bytes = buffer.subarray(0, length), after = fstatSync(fd, {bigint: true});
      const identity = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
      requireCondition(identity(before) === identity(after) && bytes.length <= this.config.terminal!.files!.max_bytes, 'FILE_CHANGED_DURING_READ');
      const content = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      requireCondition(Buffer.from(content).equals(bytes), 'FILE_UTF8_REQUIRED');
      return {path, sha256: sha256(bytes), content, identity: identity(after), mode: Number(after.mode & 0o777n)};
    } finally {closeSync(fd);}
  }
  read(path: string) {return this.parent(path, anchored => this.observe(path, anchored));}
  ownership() {
    const root = openSync(this.config.project.worktree, directoryFlags);
    try {
      const stat = fstatSync(root), path = `/proc/self/fd/${root}/.agent-driver-owner.json`;
      const expected = Buffer.from(JSON.stringify({project: this.config.project.id, database: realpathSync(this.config.dbPath), device: stat.dev, inode: stat.ino}));
      let fd: number;
      try {fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; fd = -1;}
      if (fd !== -1) {try {writeAll(fd, expected);} finally {closeSync(fd);} fsyncSync(root);}
      const check = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {const s = fstatSync(check); requireCondition(s.isFile() && s.nlink === 1 && s.size === expected.length && readFileSync(check).equals(expected), 'WORKTREE_OWNERSHIP_CONFLICT');}
      finally {closeSync(check);}
    } finally {closeSync(root);}
  }
  replace(path: string, before: FileObservation, content: string, intent: string, beforeCommit: () => void, afterCommit?: () => void) {
    requireCondition(this.config.terminal!.files!.write.includes(path), 'FILE_WRITE_NOT_DELEGATED');
    requireCondition(Buffer.byteLength(content) <= this.config.terminal!.files!.max_bytes, 'FILE_SIZE_LIMIT');
    return this.parent(path, (anchored, dir) => {
      const stage = `${anchored}.${intent}.apd-stage`;
      const fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {if (before.mode !== null) fchmodSync(fd, before.mode); writeAll(fd, Buffer.from(content));} finally {closeSync(fd);}
      // No async gap between the final fence/content observation and the owned-worktree write.
      beforeCommit();
      const current = this.observe(path, anchored);
      requireCondition(current.sha256 === before.sha256 && current.identity === before.identity, 'FILE_PRECONDITION_CHANGED');
      if (before.sha256 === null) {linkSync(stage, anchored); unlinkSync(stage);} else renameSync(stage, anchored);
      fsyncSync(dir);
      afterCommit?.();
      const observed = this.observe(path, anchored);
      requireCondition(observed.sha256 === sha256(content), 'FILE_READBACK_MISMATCH');
      return observed;
    });
  }
  snapshot() {
    const files = this.config.terminal!.files!.read.map(path => this.read(path));
    for (const file of files) requireCondition(this.read(file.path).identity === file.identity, 'SNAPSHOT_CHANGED');
    return files;
  }
}
