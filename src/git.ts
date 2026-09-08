import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileChange } from './model.js';

const execFileP = promisify(execFile);
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class GitError extends Error {
  constructor(message: string, public readonly args: string[]) { super(message); }
}

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, maxBuffer = 64 * 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    const detail = (err.stderr ?? '').trim().split('\n')[0] || err.message;
    throw new GitError(`git ${args[0]}: ${detail}`, args);
  }
}

export async function repoRoot(cwd: string): Promise<string | null> {
  try { return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); } catch { return null; }
}

export async function gitDir(cwd: string): Promise<string> {
  const d = (await git(cwd, ['rev-parse', '--git-dir'])).trim();
  return path.isAbsolute(d) ? d : path.join(cwd, d);
}

export async function headTree(cwd: string): Promise<string> {
  try { return (await git(cwd, ['rev-parse', 'HEAD^{tree}'])).trim(); } catch { return EMPTY_TREE; }
}

export async function resolveTree(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{tree}`])).trim();
}

/**
 * Snapshot the working tree (tracked + untracked, honoring .gitignore) as a tree object without touching the index.
 * Starts from a copy of the real index so git can reuse stat data instead of re-hashing every file.
 */
export async function snapshotWorkingTree(cwd: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gatekeep-idx-'));
  const idx = path.join(dir, 'index');
  const env = { GIT_INDEX_FILE: idx };
  try {
    let seeded = false;
    try { await fs.copyFile(path.join(await gitDir(cwd), 'index'), idx); seeded = true; await git(cwd, ['update-index', '-q', '--refresh'], env).catch(() => undefined); } catch { /* no index yet */ }
    if (!seeded) { try { await git(cwd, ['read-tree', 'HEAD'], env); } catch { /* no HEAD yet */ } }
    try { await git(cwd, ['add', '-A', '--sparse', '--', '.'], env); }
    catch { await git(cwd, ['add', '-A', '--', '.'], env); } // older git without --sparse
    return (await git(cwd, ['write-tree'], env)).trim();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function catFile(cwd: string, tree: string, p: string): Promise<string | undefined> {
  try { return await git(cwd, ['cat-file', '-p', `${tree}:${p}`]); } catch { return undefined; }
}

/** One long-lived `git cat-file --batch` process; reads blobs sequentially without a subprocess per file. */
export class BlobBatch {
  private proc: ChildProcess;
  private buf: Buffer = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(cwd: string) {
    this.proc = spawn('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout!.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.wake?.(); });
    this.proc.on('close', () => { this.closed = true; this.wake?.(); });
  }
  private async fill(need: (b: Buffer) => boolean): Promise<void> {
    while (!need(this.buf)) {
      if (this.closed) throw new Error('git cat-file --batch exited');
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }
  /** Returns the blob bytes, or null when the path does not exist in that tree. */
  read(tree: string, p: string): Promise<Buffer | null> {
    const job = this.queue.then(async () => {
      this.proc.stdin!.write(`${tree}:${p}\n`);
      await this.fill((b) => b.indexOf(0x0a) >= 0);
      const nl = this.buf.indexOf(0x0a);
      const header = this.buf.subarray(0, nl).toString('utf8');
      this.buf = this.buf.subarray(nl + 1);
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) return null;
      const size = parseInt(header.split(' ')[2] ?? '0', 10);
      await this.fill((b) => b.length >= size + 1);
      const body = Buffer.from(this.buf.subarray(0, size));
      this.buf = this.buf.subarray(size + 1);
      return body;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
  close(): void { if (!this.closed) { this.proc.stdin!.end(); } }
}

export interface DiffOptions {
  maxBytes?: number;
  /** Only load contents for paths where this returns true (everything else is reported by path only). */
  shouldLoad?: (p: string) => boolean;
}

/** Diff two tree objects and load file contents for the changed paths the rules need to read. */
export async function diffTrees(cwd: string, base: string, cur: string, opts: DiffOptions = {}): Promise<FileChange[]> {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const shouldLoad = opts.shouldLoad ?? (() => true);
  const out = await git(cwd, ['diff-tree', '-r', '-M', '--name-status', '-z', base, cur]);
  const parts = out.split('\0').filter((s) => s.length > 0);
  const changes: FileChange[] = [];
  const batch = new BlobBatch(cwd);
  const load = (tree: string, p: string) => loadBlob(batch, tree, p, maxBytes);
  try {
  for (let i = 0; i < parts.length;) {
    const st = parts[i]!;
    const code = st[0] as FileChange['status'] | 'C' | 'T';
    let c: FileChange;
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i + 1]!, newPath = parts[i + 2]!;
      i += 3;
      c = { path: newPath, oldPath, status: 'R' };
      if (shouldLoad(oldPath) || shouldLoad(newPath)) {
        const b = await load(base, oldPath), a = await load(cur, newPath);
        c.before = b.text; c.after = a.text;
        markUnreadable(c, b.unreadable, a.unreadable);
      }
    } else {
      const p = parts[i + 1]!;
      i += 2;
      const status: FileChange['status'] = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M';
      c = { path: p, status };
      if (shouldLoad(p)) {
        const b = status === 'A' ? { text: undefined, unreadable: false } : await load(base, p);
        const a = status === 'D' ? { text: undefined, unreadable: false } : await load(cur, p);
        c.before = b.text; c.after = a.text;
        markUnreadable(c, b.unreadable, a.unreadable);
      }
    }
    changes.push(c);
  }
  } finally { batch.close(); }
  return changes;
}

function markUnreadable(c: FileChange, b: boolean, a: boolean): void {
  if (b && a) c.unreadable = 'both'; else if (b) c.unreadable = 'before'; else if (a) c.unreadable = 'after';
}

async function loadBlob(batch: BlobBatch, tree: string, p: string, maxBytes: number): Promise<{ text: string | undefined; unreadable: boolean }> {
  const b = await batch.read(tree, p);
  if (b === null) return { text: undefined, unreadable: false };
  if (b.length > maxBytes) return { text: undefined, unreadable: true };
  if (b.subarray(0, 8000).includes(0)) return { text: undefined, unreadable: true }; // binary
  return { text: b.toString('utf8'), unreadable: false };
}
