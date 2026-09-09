import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const execFileP = promisify(execFile);
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Read-only object commands do not need the repository index; a nonexistent path keeps a corrupt or mid-write index from failing them. */
export const NO_INDEX = { GIT_INDEX_FILE: path.join(os.tmpdir(), 'gatekeep-no-index') };
export class GitError extends Error {
    args;
    constructor(message, args) {
        super(message);
        this.args = args;
    }
}
export async function git(cwd, args, env, maxBuffer = 64 * 1024 * 1024) {
    try {
        const { stdout } = await execFileP('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer });
        return stdout;
    }
    catch (e) {
        const err = e;
        const detail = (err.stderr ?? '').trim().split('\n')[0] || err.message;
        throw new GitError(`git ${args[0]}: ${detail}`, args);
    }
}
export async function repoRoot(cwd) {
    try {
        return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    }
    catch {
        return null;
    }
}
export async function gitDir(cwd) {
    const d = (await git(cwd, ['rev-parse', '--git-dir'])).trim();
    return path.isAbsolute(d) ? d : path.join(cwd, d);
}
export async function headTree(cwd) {
    try {
        return (await git(cwd, ['rev-parse', 'HEAD^{tree}'], NO_INDEX)).trim();
    }
    catch {
        return EMPTY_TREE;
    }
}
/** A shallow clone has most history missing, which is what `--base main` hits in CI when `fetch-depth` was left at 1. */
export async function isShallow(cwd) {
    try {
        return (await git(cwd, ['rev-parse', '--is-shallow-repository'], NO_INDEX)).trim() === 'true';
    }
    catch {
        return false;
    }
}
export async function resolveTree(cwd, ref) {
    return (await git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{tree}`], NO_INDEX)).trim();
}
/**
 * Index bits that tell git to ignore a file's contents. `git ls-files -v` prefixes each path with a status letter:
 * `S` is skip-worktree and any lowercase letter is assume-unchanged. Either one makes `git add -A` skip the file, so
 * an agent can edit a test and keep it out of the snapshot entirely.
 */
async function clearIndexFlags(cwd, env) {
    let out;
    try {
        out = await git(cwd, ['ls-files', '-v'], env);
    }
    catch {
        return [];
    }
    const flagged = [];
    for (const line of out.split('\n')) {
        if (!line)
            continue;
        const tag = line[0];
        if (tag === 'S' || (tag >= 'a' && tag <= 'z'))
            flagged.push(line.slice(2));
    }
    if (flagged.length === 0)
        return [];
    // Cleared in the throwaway index only; the developer's real index keeps whatever they set.
    for (const args of [['update-index', '--no-skip-worktree', '--'], ['update-index', '--no-assume-unchanged', '--']]) {
        try {
            await git(cwd, [...args, ...flagged], env);
        }
        catch { /* one of the two always applies */ }
    }
    return flagged;
}
/**
 * Untracked paths that `.git/info/exclude` or `core.excludesFile` hide but a committed `.gitignore` does not.
 * Those two live outside the tree, so no diff can show them being edited, and both keep files out of `git add -A`.
 */
async function hiddenByLocalExcludes(cwd) {
    const list = async (args) => {
        try {
            return new Set((await git(cwd, args, NO_INDEX)).split('\0').filter(Boolean));
        }
        catch {
            return new Set();
        }
    };
    const gitignoreOnly = await list(['ls-files', '--others', '-z', '--exclude-per-directory=.gitignore']);
    if (gitignoreOnly.size === 0)
        return [];
    const standard = await list(['ls-files', '--others', '-z', '--exclude-standard']);
    return [...gitignoreOnly].filter((p) => !standard.has(p)).sort();
}
export async function snapshotWorkingTree(cwd, problems) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gatekeep-idx-'));
    const idx = path.join(dir, 'index');
    const env = { GIT_INDEX_FILE: idx };
    try {
        let seeded = false;
        try {
            const real = path.join(await gitDir(cwd), 'index');
            await fs.copyFile(real, idx);
            // Keep the original index mtime: git treats entries whose file mtime is not older than the index as "racy" and
            // re-hashes them. A fresh copy would look newer than every file and let a same-second, same-size edit go unseen.
            const st = await fs.stat(real);
            await fs.utimes(idx, st.atime, st.mtime);
            seeded = true;
        }
        catch { /* no index yet */ }
        if (!seeded) {
            try {
                await git(cwd, ['read-tree', 'HEAD'], env);
            }
            catch { /* no HEAD yet */ }
        }
        if (problems) {
            problems.indexFlags = await clearIndexFlags(cwd, env);
            problems.hidden = await hiddenByLocalExcludes(cwd);
        }
        const addAll = async () => { try {
            await git(cwd, ['add', '-A', '--sparse', '--', '.'], env);
        }
        catch {
            await git(cwd, ['add', '-A', '--', '.'], env);
        } }; // older git without --sparse
        try {
            await addAll();
        }
        catch (e) {
            // A copy taken while git was rewriting the index can be unreadable: start over from HEAD instead of failing the gate.
            if (!seeded)
                throw e;
            await fs.rm(idx, { force: true });
            try {
                await git(cwd, ['read-tree', 'HEAD'], env);
            }
            catch { /* no HEAD yet */ }
            await addAll();
        }
        return (await git(cwd, ['write-tree'], env)).trim();
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
/** Every file path in a tree. Read-only, so it runs without the index. */
export async function lsTree(cwd, tree) {
    const out = await git(cwd, ['ls-tree', '-r', '--name-only', '-z', tree], NO_INDEX);
    return out.split('\0').filter(Boolean);
}
export async function catFile(cwd, tree, p) {
    try {
        return await git(cwd, ['cat-file', '-p', `${tree}:${p}`], NO_INDEX);
    }
    catch {
        return undefined;
    }
}
/** One long-lived `git cat-file --batch` process; reads blobs sequentially without a subprocess per file. */
export class BlobBatch {
    proc;
    buf = Buffer.alloc(0);
    wake = null;
    closed = false;
    queue = Promise.resolve();
    constructor(cwd) {
        this.proc = spawn('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...NO_INDEX } });
        this.proc.stdout.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.wake?.(); });
        this.proc.on('close', () => { this.closed = true; this.wake?.(); });
    }
    async fill(need) {
        while (!need(this.buf)) {
            if (this.closed)
                throw new Error('git cat-file --batch exited');
            await new Promise((r) => { this.wake = r; });
            this.wake = null;
        }
    }
    /** Returns the blob bytes, or null when the path does not exist in that tree. */
    read(tree, p) {
        const job = this.queue.then(async () => {
            this.proc.stdin.write(`${tree}:${p}\n`);
            await this.fill((b) => b.indexOf(0x0a) >= 0);
            const nl = this.buf.indexOf(0x0a);
            const header = this.buf.subarray(0, nl).toString('utf8');
            this.buf = this.buf.subarray(nl + 1);
            if (header.endsWith(' missing') || header.endsWith(' ambiguous'))
                return null;
            const size = parseInt(header.split(' ')[2] ?? '0', 10);
            await this.fill((b) => b.length >= size + 1);
            const body = Buffer.from(this.buf.subarray(0, size));
            this.buf = this.buf.subarray(size + 1);
            return body;
        });
        this.queue = job.catch(() => undefined);
        return job;
    }
    close() { if (!this.closed) {
        this.proc.stdin.end();
    } }
}
/** Diff two tree objects and load file contents for the changed paths the rules need to read. */
export async function diffTrees(cwd, base, cur, opts = {}) {
    const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    const shouldLoad = opts.shouldLoad ?? (() => true);
    const out = await git(cwd, ['diff-tree', '-r', '-M', '--name-status', '-z', base, cur], NO_INDEX);
    const parts = out.split('\0').filter((s) => s.length > 0);
    const changes = [];
    const batch = new BlobBatch(cwd);
    const load = (tree, p) => loadBlob(batch, tree, p, maxBytes);
    try {
        for (let i = 0; i < parts.length;) {
            const st = parts[i];
            const code = st[0];
            let c;
            if (code === 'R' || code === 'C') {
                const oldPath = parts[i + 1], newPath = parts[i + 2];
                i += 3;
                c = { path: newPath, oldPath, status: 'R' };
                if (shouldLoad(oldPath) || shouldLoad(newPath)) {
                    const b = await load(base, oldPath), a = await load(cur, newPath);
                    c.before = b.text;
                    c.after = a.text;
                    markUnreadable(c, b.unreadable, a.unreadable);
                }
            }
            else {
                const p = parts[i + 1];
                i += 2;
                const status = code === 'A' ? 'A' : code === 'D' ? 'D' : 'M';
                c = { path: p, status };
                if (shouldLoad(p)) {
                    const b = status === 'A' ? { text: undefined, unreadable: false } : await load(base, p);
                    const a = status === 'D' ? { text: undefined, unreadable: false } : await load(cur, p);
                    c.before = b.text;
                    c.after = a.text;
                    markUnreadable(c, b.unreadable, a.unreadable);
                }
            }
            changes.push(c);
        }
    }
    finally {
        batch.close();
    }
    return changes;
}
function markUnreadable(c, b, a) {
    if (b && a)
        c.unreadable = 'both';
    else if (b)
        c.unreadable = 'before';
    else if (a)
        c.unreadable = 'after';
}
async function loadBlob(batch, tree, p, maxBytes) {
    const b = await batch.read(tree, p);
    if (b === null)
        return { text: undefined, unreadable: false };
    if (b.length > maxBytes)
        return { text: undefined, unreadable: true };
    if (b.subarray(0, 8000).includes(0))
        return { text: undefined, unreadable: true }; // binary
    return { text: b.toString('utf8'), unreadable: false };
}
/**
 * Unified diff between two trees, split per file and keyed by the new path (old path for deletions).
 * Read-only: runs without the index. Used by the model-backed review, which reads text rather than parse trees.
 */
export async function diffPatches(cwd, base, cur, maxBuffer = 256 * 1024 * 1024) {
    const out = await git(cwd, ['diff-tree', '-r', '-p', '-M', '--no-color', '--no-ext-diff', base, cur], NO_INDEX, maxBuffer);
    const patches = new Map();
    const chunks = out.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
    for (const c of chunks) {
        const plus = /^\+\+\+ b\/(.+)$/m.exec(c);
        const minus = /^--- a\/(.+)$/m.exec(c);
        const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(c);
        const p = plus?.[1] ?? (minus ? null : head?.[2]) ?? head?.[2] ?? null;
        // Deletions have no +++ path: key them by the old one so the caller can still find them.
        const key = plus ? plus[1] : (minus?.[1] ?? p);
        if (key)
            patches.set(key, c);
    }
    return patches;
}
//# sourceMappingURL=git.js.map