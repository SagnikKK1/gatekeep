import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
/** State lives outside the repository so the agent being gated cannot edit it. Override with GATEKEEP_HOME. */
export function stateHome() {
    return process.env.GATEKEEP_HOME ?? path.join(os.homedir(), '.gatekeep');
}
export function repoStateDir(root) {
    const key = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);
    return path.join(stateHome(), 'repos', `${path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_')}-${key}`);
}
export function sessionDir(root) { return path.join(repoStateDir(root), 'sessions'); }
function keyFile(root) { return path.join(repoStateDir(root), 'hmac.key'); }
/**
 * The `.git` mirror is authoritative but sits inside the repository, where the agent can write. Signing both copies
 * with a key that lives only under the state home turns "edit the mirror" from a silent baseline rewrite into a
 * blocking finding. The key is per repository and created on first use.
 */
const keyCache = new Map();
async function hmacKey(root, create) {
    const p = keyFile(root);
    const hit = keyCache.get(p);
    if (hit)
        return hit;
    try {
        const k = Buffer.from((await fs.readFile(p, 'utf8')).trim(), 'hex');
        if (k.length >= 16) {
            keyCache.set(p, k);
            return k;
        }
    }
    catch { /* not created yet */ }
    if (!create)
        return null;
    const k = randomBytes(32);
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    await writeAtomic(p, k.toString('hex') + '\n');
    keyCache.set(p, k);
    return k;
}
/** Canonical form of the signed payload: every field except the signature, keys in sorted order. */
function payload(s) {
    const { sig: _s, recovered: _r, tampered: _t, ...rest } = s;
    return JSON.stringify(rest, Object.keys(rest).sort());
}
function sign(key, s) {
    return createHmac('sha256', key).update(payload(s)).digest('hex');
}
function verify(key, s) {
    if (typeof s.sig !== 'string' || s.sig.length !== 64)
        return false;
    const want = Buffer.from(sign(key, s), 'hex');
    let got;
    try {
        got = Buffer.from(s.sig, 'hex');
    }
    catch {
        return false;
    }
    return got.length === want.length && timingSafeEqual(got, want);
}
export function verdictDir(root) { return path.join(repoStateDir(root), 'verdicts'); }
function file(root, id) { return path.join(sessionDir(root), `${safe(id)}.json`); }
function safe(id) { return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'default'; }
/** Mirror under the repository's own .git directory: survives a wipe of GATEKEEP_HOME, and agents do not edit .git internals. */
function mirrorFile(root, gitDir, id) {
    return gitDir ? path.join(gitDir, 'gatekeep', 'sessions', `${safe(id)}.json`) : null;
}
/**
 * Read a session. Once the repository has a key, a copy without a valid signature is not evidence: an unverifiable
 * mirror falls back to a verified home copy and reports tampering, and if nothing verifies the caller is told the
 * baseline is gone rather than handed a forged one. `blocks` is taken as the highest of the copies that verified,
 * so lowering the counter in one of them buys nothing.
 */
export async function loadSessionChecked(root, id, gitDir = null) {
    let home = null, mirror = null;
    try {
        home = JSON.parse(await fs.readFile(file(root, id), 'utf8'));
    }
    catch { /* none */ }
    const mf = mirrorFile(root, gitDir, id);
    if (mf) {
        try {
            mirror = JSON.parse(await fs.readFile(mf, 'utf8'));
        }
        catch { /* none */ }
    }
    if (!home && !mirror)
        return { state: null, unverifiable: false };
    const key = await hmacKey(root, false);
    // A copy carrying a signature was written by a key that existed, so a missing key means the key was removed rather
    // than never created. The baseline is still the best evidence available and is used, but it can no longer be
    // trusted to be the one this session started with, and the caller says so at block severity.
    const keyMissing = key === null && (home?.sig !== undefined || mirror?.sig !== undefined);
    // No key and no signatures: state written before signing existed, or a fresh home. Accept; the next save signs it.
    const ok = (x) => x !== null && (key === null ? true : verify(key, x));
    const homeOk = ok(home), mirrorOk = ok(mirror);
    if (!homeOk && !mirrorOk)
        return { state: null, unverifiable: true };
    if (homeOk && mirrorOk && !keyMissing) {
        // Both verify: the mirror is authoritative because it survives a wipe of the state home.
        const h = home, m = mirror;
        h.blocks = Math.max(m.blocks ?? 0, h.blocks ?? 0);
        h.baseTree = m.baseTree;
        h.configText = m.configText;
        h.protectedHashes = m.protectedHashes;
        return { state: h, unverifiable: false };
    }
    if (homeOk)
        return { state: { ...home, ...(keyMissing ? { tampered: 'key-missing' } : mirror ? { tampered: 'mirror' } : {}) }, unverifiable: false };
    return { state: { ...mirror, recovered: !home, ...(keyMissing ? { tampered: 'key-missing' } : home ? { tampered: 'home' } : {}) }, unverifiable: false };
}
export async function loadSession(root, id, gitDir = null) {
    return (await loadSessionChecked(root, id, gitDir)).state;
}
/** Atomic write: tmp + rename, so concurrent hooks never read a torn file. */
export async function writeAtomic(p, text) {
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.rename(tmp, p);
}
/** Serialize read-modify-write of one session across concurrent hooks with an O_EXCL lock file. */
export async function withSessionLock(root, id, fn) {
    const lock = `${file(root, id)}.lock`;
    await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 15000;
    for (;;) {
        try {
            const h = await fs.open(lock, 'wx', 0o600);
            await h.close();
            break;
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
            try {
                const st = await fs.stat(lock);
                if (Date.now() - st.mtimeMs > 60000) {
                    await fs.rm(lock, { force: true });
                    continue;
                }
            }
            catch { /* vanished */ }
            if (Date.now() > deadline)
                throw new Error('session lock timeout');
            await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
        }
    }
    try {
        return await fn();
    }
    finally {
        await fs.rm(lock, { force: true });
    }
}
export async function saveSession(root, s, gitDir = null) {
    const { recovered: _r, tampered: _t, sig: _sig, ...rest } = s;
    const key = await hmacKey(root, true);
    const persisted = { ...rest, ...(key ? { sig: sign(key, rest) } : {}) };
    const text = JSON.stringify(persisted, null, 2) + '\n';
    await writeAtomic(file(root, s.id), text);
    const mf = mirrorFile(root, gitDir, s.id);
    if (mf) {
        try {
            await writeAtomic(mf, text);
        }
        catch { /* read-only .git: mirror is best effort */ }
    }
}
export async function newSession(root, id, harness, baseTree, configText, gitDir = null, protectedHashes) {
    const s = { id, harness, startedAt: new Date().toISOString(), baseTree, prompt: null, blocks: 0, lastVerdict: null, configText, protectedHashes };
    await saveSession(root, s, gitDir);
    return s;
}
export async function listSessions(root) {
    try {
        const names = await fs.readdir(sessionDir(root));
        const out = [];
        for (const n of names)
            if (n.endsWith('.json')) {
                try {
                    out.push(JSON.parse(await fs.readFile(path.join(sessionDir(root), n), 'utf8')));
                }
                catch { /* skip */ }
            }
        return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=session.js.map