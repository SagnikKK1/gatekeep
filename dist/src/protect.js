import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.js';
import { isTestFile } from './rules.js';
import { repoStateDir } from './session.js';
/**
 * The prevention lane. Everything else in gatekeep is a gate: it reads what already happened and decides afterwards.
 * This turns the test tree read-only for the session instead, so the tampering never happens and there is nothing to
 * accuse anyone of. It is deliberately separate from the gate — its own command, its own hook event, its own settings
 * entries — because the two answer different questions and a user may want either one alone.
 *
 * Three layers, weakest last:
 *   1. `permissions.deny`             — Claude Code refuses the file tools outright.
 *   2. `sandbox.filesystem.denyWrite` — the OS refuses the write, which is the only layer that covers arbitrary shell.
 *   3. the `PreToolUse` hook here     — a fallback that also explains *why*, which the two above do not.
 */
export const PROTECT_RULE = 'test-write-denied';
export const PROTECT_HOOK_RE = /(gatekeep|cli\.js)['"]?\s+hook\s+pre-tool-use\b/;
/** File tools whose writes the hook inspects. Bash is included for the best-effort scan below. */
export const PROTECT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash';
/** Directory names that mean "everything under here is a test", so the whole subtree can be covered by one pattern. */
const TEST_DIR_NAMES = new Set(['tests', 'test', 'spec', '__tests__', 'benches']);
/** Filename shapes, in the order they are tried. The first whose regexp matches supplies the pattern for that file. */
const NAME_SHAPES = [
    [/^test_.*\.(py|rb)$/, (ext) => `**/test_*.${ext}`],
    [/_test\.(py|go|rb)$/, (ext) => `**/*_test.${ext}`],
    [/_spec\.rb$/, () => '**/*_spec.rb'],
    [/(?:Test|Tests|IT)\.java$/, () => '**/*Test*.java'],
];
/** One glob covering `file` and the files like it, or the file itself when nothing more general fits. */
export function patternFor(file) {
    const parts = file.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
        if (TEST_DIR_NAMES.has(parts[i]))
            return `${parts.slice(0, i + 1).join('/')}/**`;
    }
    const base = parts[parts.length - 1];
    const ts = /\.(test|spec)\.([A-Za-z0-9]+)$/.exec(base);
    if (ts)
        return `**/*.${ts[1]}.${ts[2]}`;
    for (const [re, make] of NAME_SHAPES) {
        const m = re.exec(base);
        if (m)
            return make(m[1] ?? '');
    }
    return file;
}
const MAX_PATTERNS = 40;
/** Every tracked or untracked-but-not-ignored file the rules would call a test. */
export async function discoverTestTree(root, cfg) {
    let out;
    try {
        out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    }
    catch {
        return { patterns: [], files: [], truncated: false };
    }
    const files = out.split('\0').filter((p) => p !== '' && isTestFile(p, cfg)).sort();
    const seen = new Set();
    for (const f of files)
        seen.add(patternFor(f));
    // A directory pattern makes every filename-shape pattern under it redundant, but not the other way round, so
    // directory patterns are kept and shapes are kept: dropping shapes would leave colocated tests uncovered.
    const patterns = [...seen].sort();
    return { patterns: patterns.slice(0, MAX_PATTERNS), files, truncated: patterns.length > MAX_PATTERNS };
}
function recordFile(root) { return path.join(repoStateDir(root), 'protect.json'); }
export async function readProtectRecord(root) {
    try {
        return JSON.parse(await fs.readFile(recordFile(root), 'utf8'));
    }
    catch {
        return null;
    }
}
export function denyEntries(patterns) {
    // `Edit` and `Write` are separate permission rules; naming both is right whichever way the harness maps them.
    return patterns.flatMap((p) => [`Edit(${p})`, `Write(${p})`]);
}
async function readSettings(file) {
    let raw;
    try {
        raw = await fs.readFile(file, 'utf8');
    }
    catch {
        return {};
    }
    try {
        return JSON.parse(raw);
    }
    catch (e) {
        throw new Error(`${file} exists but is not valid JSON (${e.message}). Fix it by hand; gatekeep will not overwrite it.`);
    }
}
export async function applyProtect(root, file, patterns, command) {
    const settings = await readSettings(file);
    const deny = denyEntries(patterns);
    const perms = (settings.permissions ??= {});
    perms.deny = [...new Set([...(perms.deny ?? []), ...deny])];
    const sandbox = (settings.sandbox ??= {});
    const fsx = (sandbox.filesystem ??= {});
    fsx.denyWrite = [...new Set([...(fsx.denyWrite ?? []), ...patterns])];
    settings.hooks ??= {};
    const list = settings.hooks.PreToolUse ?? [];
    const existing = list.flatMap((e) => e.hooks ?? []).find((c) => PROTECT_HOOK_RE.test(c.command));
    if (existing) {
        existing.command = command;
        existing.timeout = 10;
    }
    else
        list.push({ matcher: PROTECT_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] });
    settings.hooks.PreToolUse = list;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
    const rec = { file, deny, denyWrite: patterns, writtenAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(recordFile(root)), { recursive: true });
    await fs.writeFile(recordFile(root), JSON.stringify(rec, null, 2) + '\n');
    return { deny, denyWrite: patterns };
}
/** Remove only what a previous `protect-tests` wrote. With no record, fall back to what discovery would emit now. */
export async function removeProtect(root, file, fallbackPatterns) {
    const rec = await readProtectRecord(root);
    const ownedDeny = new Set(rec && rec.file === file ? rec.deny : denyEntries(fallbackPatterns));
    const ownedWrite = new Set(rec && rec.file === file ? rec.denyWrite : fallbackPatterns);
    const settings = await readSettings(file);
    let removed = 0;
    const perms = settings.permissions;
    if (perms?.deny) {
        const before = perms.deny.length;
        perms.deny = perms.deny.filter((d) => !ownedDeny.has(d));
        removed += before - perms.deny.length;
        if (perms.deny.length === 0)
            delete perms.deny;
        if (Object.keys(perms).length === 0)
            delete settings.permissions;
    }
    const fsx = settings.sandbox?.filesystem;
    if (fsx?.denyWrite) {
        const before = fsx.denyWrite.length;
        fsx.denyWrite = fsx.denyWrite.filter((d) => !ownedWrite.has(d));
        removed += before - fsx.denyWrite.length;
        if (fsx.denyWrite.length === 0)
            delete fsx.denyWrite;
        if (Object.keys(fsx).length === 0)
            delete settings.sandbox.filesystem;
        if (settings.sandbox && Object.keys(settings.sandbox).length === 0)
            delete settings.sandbox;
    }
    let hookRemoved = false;
    const list = settings.hooks?.PreToolUse;
    if (list) {
        for (const e of list) {
            const before = e.hooks?.length ?? 0;
            e.hooks = (e.hooks ?? []).filter((c) => !PROTECT_HOOK_RE.test(c.command));
            if (e.hooks.length !== before)
                hookRemoved = true;
        }
        settings.hooks.PreToolUse = list.filter((e) => e.hooks.length > 0);
        if (settings.hooks.PreToolUse.length === 0)
            delete settings.hooks.PreToolUse;
        if (Object.keys(settings.hooks).length === 0)
            delete settings.hooks;
    }
    await fs.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
    await fs.rm(recordFile(root), { force: true });
    return { removed, hookRemoved };
}
/**
 * Which settings files currently carry the lane. The hook denies whenever it is called, so "is the lane on" is
 * really "which file wires it" — a project `--off` cannot reach a copy wired globally, and this is what says so.
 */
export async function protectedIn(root, files) {
    const out = [];
    for (const file of files) {
        let s;
        try {
            s = await readSettings(file);
        }
        catch {
            continue;
        }
        const deny = (s.permissions?.deny ?? []).filter((d) => /^(Edit|Write)\(/.test(d)).length;
        const hook = (s.hooks?.PreToolUse ?? []).some((e) => (e.hooks ?? []).some((c) => PROTECT_HOOK_RE.test(c.command)));
        if (hook)
            out.push({ file, deny, hook });
    }
    return out;
}
/* ------------------------------------------------------------------ the hook side */
/**
 * Shell commands that write to a path they are given. The sandbox layer is what actually stops arbitrary shell; this
 * list only exists so the common cases still get an explanation when the sandbox is off. It is deliberately a
 * whitelist of verbs rather than a parser: anything cleverer would be guessing, and guessing here blocks honest work.
 */
const MUTATING = new Set(['rm', 'mv', 'cp', 'truncate', 'shred', 'dd', 'tee', 'patch', 'install', 'unlink', 'rmdir']);
/** Candidate paths a shell command looks like it will write to. Best-effort; never throws. */
export function bashWriteTargets(command) {
    const out = [];
    for (const seg of command.split(/\n|;|&&|\|\||\|/)) {
        const raw = seg.trim().split(/\s+/).filter(Boolean);
        if (raw.length === 0)
            continue;
        const toks = raw.map((t) => t.replace(/^["']|["']$/g, ''));
        // Redirections write to their target whatever the command is.
        for (let i = 0; i < toks.length; i++) {
            const m = /^[0-9]*>>?(.*)$/.exec(toks[i]);
            if (m) {
                const t = m[1] || toks[i + 1];
                if (t)
                    out.push(t.replace(/^["']|["']$/g, ''));
            }
        }
        let i = 0;
        while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]))
            i++; // leading VAR=value
        const cmd = (toks[i] ?? '').split('/').pop() ?? '';
        const args = toks.slice(i + 1);
        const inPlace = (bin) => (bin === 'sed' || bin === 'perl' || bin === 'ruby') && args.some((a) => /^-[a-zA-Z]*i/.test(a));
        const gitWrite = cmd === 'git' && ['rm', 'mv', 'checkout', 'restore', 'stash'].includes(args[0] ?? '');
        if (!MUTATING.has(cmd) && !inPlace(cmd) && !gitWrite)
            continue;
        for (const a of args)
            if (!a.startsWith('-') && !a.includes('='))
                out.push(a);
    }
    return out;
}
/**
 * Resolve symlinks on the deepest part of `p` that exists. `/tmp` and `/var` are symlinks on macOS, so a hook's
 * `cwd` can arrive as `/var/folders/...` while `git rev-parse --show-toplevel` always answers `/private/var/...`.
 * Compare those two unresolved and every path looks like it is outside the repository — the lane would then permit
 * everything, silently. The tail is kept unresolved because the file being written may not exist yet.
 */
export function realish(p) {
    let cur = path.resolve(p);
    const tail = [];
    for (;;) {
        try {
            return path.join(realpathSync(cur), ...tail);
        }
        catch { /* not on disk yet: try the parent */ }
        const parent = path.dirname(cur);
        if (parent === cur)
            return path.resolve(p);
        tail.unshift(path.basename(cur));
        cur = parent;
    }
}
/** Paths a tool call is about to write, given Claude Code's `tool_name` / `tool_input`. */
export function writeTargets(toolName, toolInput) {
    const str = (k) => (typeof toolInput[k] === 'string' ? toolInput[k] : null);
    switch (toolName) {
        case 'Edit':
        case 'Write':
        case 'MultiEdit': {
            const f = str('file_path');
            return f ? [f] : [];
        }
        case 'NotebookEdit': {
            const f = str('notebook_path') ?? str('file_path');
            return f ? [f] : [];
        }
        case 'Bash': {
            const c = str('command');
            return c ? bashWriteTargets(c) : [];
        }
        default: return [];
    }
}
export function protectReason(rel, viaBash) {
    return [
        `gatekeep (${PROTECT_RULE}): ${rel} is a test file and this session may not write to it.`,
        'The tests are the specification here. Change the implementation until they pass; do not change what they assert.',
        viaBash ? 'This was refused because the shell command looked like it would write to that path.' : '',
        'If the test itself is genuinely wrong for this task, stop and say so instead of editing it. To lift the lane: `gatekeep protect-tests --off`.',
    ].filter(Boolean).join(' ');
}
/** The decision for one tool call. `root` is the repository root; paths outside it are never our business. */
export function decideProtect(root, cwd, toolName, toolInput, cfg) {
    const rootReal = realish(root), cwdReal = realish(cwd);
    for (const t of writeTargets(toolName, toolInput)) {
        const abs = realish(path.resolve(cwdReal, t));
        const rel = path.relative(rootReal, abs).replace(/\\/g, '/');
        if (rel === '' || rel.startsWith('../') || path.isAbsolute(rel))
            continue;
        if (isTestFile(rel, cfg))
            return { deny: true, file: rel, reason: protectReason(rel, toolName === 'Bash') };
    }
    return { deny: false };
}
//# sourceMappingURL=protect.js.map