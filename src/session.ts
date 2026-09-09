import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionState {
  id: string;
  /** Set when the home copy was missing and the state came from the .git mirror. */
  recovered?: boolean;
  /** Set when a stored copy failed its signature check: which one, so the caller can say so. */
  tampered?: 'mirror' | 'home';
  /** HMAC over the rest of the record. Not part of the signed payload. */
  sig?: string;
  harness: string;
  startedAt: string;
  baseTree: string;
  prompt: string | null;
  /** Every human prompt in the session (capped); overrides are read from here, never from agent-written text. */
  prompts?: string[];
  blocks: number;
  lastVerdict: string | null;
  /** gatekeep.config.json as it was when the session started; the working-tree copy is not trusted after that. */
  configText: string | null;
  /** sha1 of each protected file on disk at session start (covers gitignored files the snapshot cannot see). */
  protectedHashes?: Record<string, string | null>;
}

/** State lives outside the repository so the agent being gated cannot edit it. Override with GATEKEEP_HOME. */
export function stateHome(): string {
  return process.env.GATEKEEP_HOME ?? path.join(os.homedir(), '.gatekeep');
}

export function repoStateDir(root: string): string {
  const key = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(stateHome(), 'repos', `${path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_')}-${key}`);
}

export function sessionDir(root: string): string { return path.join(repoStateDir(root), 'sessions'); }
function keyFile(root: string): string { return path.join(repoStateDir(root), 'hmac.key'); }

/**
 * The `.git` mirror is authoritative but sits inside the repository, where the agent can write. Signing both copies
 * with a key that lives only under the state home turns "edit the mirror" from a silent baseline rewrite into a
 * blocking finding. The key is per repository and created on first use.
 */
const keyCache = new Map<string, Buffer>();
async function hmacKey(root: string, create: boolean): Promise<Buffer | null> {
  const p = keyFile(root);
  const hit = keyCache.get(p);
  if (hit) return hit;
  try {
    const k = Buffer.from((await fs.readFile(p, 'utf8')).trim(), 'hex');
    if (k.length >= 16) { keyCache.set(p, k); return k; }
  } catch { /* not created yet */ }
  if (!create) return null;
  const k = randomBytes(32);
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  await writeAtomic(p, k.toString('hex') + '\n');
  keyCache.set(p, k);
  return k;
}

/** Canonical form of the signed payload: every field except the signature, keys in sorted order. */
function payload(s: SessionState): string {
  const { sig: _s, recovered: _r, tampered: _t, ...rest } = s;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function sign(key: Buffer, s: SessionState): string {
  return createHmac('sha256', key).update(payload(s)).digest('hex');
}

function verify(key: Buffer, s: SessionState): boolean {
  if (typeof s.sig !== 'string' || s.sig.length !== 64) return false;
  const want = Buffer.from(sign(key, s), 'hex');
  let got: Buffer;
  try { got = Buffer.from(s.sig, 'hex'); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}
export function verdictDir(root: string): string { return path.join(repoStateDir(root), 'verdicts'); }

function file(root: string, id: string): string { return path.join(sessionDir(root), `${safe(id)}.json`); }
function safe(id: string): string { return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'default'; }

/** Mirror under the repository's own .git directory: survives a wipe of GATEKEEP_HOME, and agents do not edit .git internals. */
function mirrorFile(root: string, gitDir: string | null, id: string): string | null {
  return gitDir ? path.join(gitDir, 'gatekeep', 'sessions', `${safe(id)}.json`) : null;
}

export interface LoadResult {
  state: SessionState | null;
  /** Set when every stored copy that exists failed verification: the baseline cannot be trusted at all. */
  unverifiable: boolean;
}

/**
 * Read a session. Once the repository has a key, a copy without a valid signature is not evidence: an unverifiable
 * mirror falls back to a verified home copy and reports tampering, and if nothing verifies the caller is told the
 * baseline is gone rather than handed a forged one. `blocks` is taken as the highest of the copies that verified,
 * so lowering the counter in one of them buys nothing.
 */
export async function loadSessionChecked(root: string, id: string, gitDir: string | null = null): Promise<LoadResult> {
  let home: SessionState | null = null, mirror: SessionState | null = null;
  try { home = JSON.parse(await fs.readFile(file(root, id), 'utf8')) as SessionState; } catch { /* none */ }
  const mf = mirrorFile(root, gitDir, id);
  if (mf) { try { mirror = JSON.parse(await fs.readFile(mf, 'utf8')) as SessionState; } catch { /* none */ } }
  if (!home && !mirror) return { state: null, unverifiable: false };

  const key = await hmacKey(root, false);
  // No key yet: state written before signing existed, or a fresh home directory. Accept once; the next save signs it.
  const ok = (x: SessionState | null): boolean => x !== null && (key === null ? true : verify(key, x));
  const homeOk = ok(home), mirrorOk = ok(mirror);
  if (!homeOk && !mirrorOk) return { state: null, unverifiable: true };

  if (homeOk && mirrorOk) {
    // Both verify: the mirror is authoritative because it survives a wipe of the state home.
    const h = home!, m = mirror!;
    h.blocks = Math.max(m.blocks ?? 0, h.blocks ?? 0);
    h.baseTree = m.baseTree; h.configText = m.configText; h.protectedHashes = m.protectedHashes;
    return { state: h, unverifiable: false };
  }
  if (homeOk) return { state: { ...home!, ...(mirror ? { tampered: 'mirror' as const } : {}) }, unverifiable: false };
  return { state: { ...mirror!, recovered: !home, ...(home ? { tampered: 'home' as const } : {}) }, unverifiable: false };
}

export async function loadSession(root: string, id: string, gitDir: string | null = null): Promise<SessionState | null> {
  return (await loadSessionChecked(root, id, gitDir)).state;
}

/** Atomic write: tmp + rename, so concurrent hooks never read a torn file. */
export async function writeAtomic(p: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, p);
}

/** Serialize read-modify-write of one session across concurrent hooks with an O_EXCL lock file. */
export async function withSessionLock<T>(root: string, id: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file(root, id)}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { const h = await fs.open(lock, 'wx', 0o600); await h.close(); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { const st = await fs.stat(lock); if (Date.now() - st.mtimeMs > 60000) { await fs.rm(lock, { force: true }); continue; } } catch { /* vanished */ }
      if (Date.now() > deadline) throw new Error('session lock timeout');
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }
  try { return await fn(); } finally { await fs.rm(lock, { force: true }); }
}

export async function saveSession(root: string, s: SessionState, gitDir: string | null = null): Promise<void> {
  const { recovered: _r, tampered: _t, sig: _sig, ...rest } = s;
  const key = await hmacKey(root, true);
  const persisted: SessionState = { ...(rest as SessionState), ...(key ? { sig: sign(key, rest as SessionState) } : {}) };
  const text = JSON.stringify(persisted, null, 2) + '\n';
  await writeAtomic(file(root, s.id), text);
  const mf = mirrorFile(root, gitDir, s.id);
  if (mf) { try { await writeAtomic(mf, text); } catch { /* read-only .git: mirror is best effort */ } }
}

export async function newSession(root: string, id: string, harness: string, baseTree: string, configText: string | null, gitDir: string | null = null, protectedHashes?: Record<string, string | null>): Promise<SessionState> {
  const s: SessionState = { id, harness, startedAt: new Date().toISOString(), baseTree, prompt: null, blocks: 0, lastVerdict: null, configText, protectedHashes };
  await saveSession(root, s, gitDir);
  return s;
}

export async function listSessions(root: string): Promise<SessionState[]> {
  try {
    const names = await fs.readdir(sessionDir(root));
    const out: SessionState[] = [];
    for (const n of names) if (n.endsWith('.json')) { try { out.push(JSON.parse(await fs.readFile(path.join(sessionDir(root), n), 'utf8')) as SessionState); } catch { /* skip */ } }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  } catch { return []; }
}
