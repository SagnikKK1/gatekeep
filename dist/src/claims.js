import fs from 'node:fs/promises';
import { langFor } from './lang.js';
/**
 * Roadmap item 3: claim verification. The Stop hook receives the session transcript; compare what the agent said in its
 * final message to what it actually ran and changed. Claude Code transcript format (JSONL of {type, message:{content:[...]}}).
 */
export const CLAIM_SEVERITIES = {
    'claim-tests-unverified': 'warn',
    'claim-checks-unverified': 'warn',
    'summary-files-mismatch': 'warn',
    'history-rewritten': 'block',
    'claims-not-recorded': 'warn',
};
const TEST_CMD = /\b(pytest|py\.test|python3? -m (pytest|unittest)|python3? [\w.\/-]*tests?[\w.\/-]*\.py|unittest|jest|vitest|mocha|ava\b|tap\b|node --test|npm (run )?test|yarn test|pnpm test|bun test|deno test|go test|cargo test|mvn (test|verify)|gradle\w* (test|check)|dotnet test|phpunit|rspec|tox\b|nox\b|make (test|check)|nose2?|karma|cypress run|playwright test)\b/;
const BUILD_CMD = /\b((npm|pnpm|yarn|bun) (run )?build|tsc\b|cargo build|go build|make\b|gradle\w* (build|assemble)|mvn (package|compile|install)|dotnet build|webpack|vite build|next build|esbuild|rollup|python -m build|setup\.py build)\b/;
const LINT_CMD = /\b(eslint|ruff|flake8|pylint|biome|golangci-lint|rubocop|clippy|(npm|pnpm|yarn) (run )?lint|prettier --check|black --check|isort --check|stylelint|shellcheck)\b/;
const TYPE_CMD = /\b(tsc\b|mypy|pyright|(npm|pnpm|yarn) (run )?(typecheck|type-check|types)|flow check)\b/;
const TEST_CLAIM = /\b(all |the |every )?(unit |integration |existing |new )?tests? (now |still |all )?(pass|passes|passing|are passing|succeed|succeeds|are green|is green|green)\b|\b\d+ (tests? )?(passed|passing)\b|\btest suite (passes|is green|passed)\b|\bpasses all (the )?tests\b|\bsuite (is )?green\b|\btests? (run|ran) (clean|successfully)\b/i;
const BUILD_CLAIM = /\b(the )?(build|compilation) (is |now )?(clean|passes|succeeds|successful|works|green)\b|\bbuilds? (cleanly|successfully|without errors)\b|\bcompiles? (cleanly|without errors|successfully)\b/i;
const LINT_CLAIM = /\b(lint|linter|linting) (is |now )?(clean|passes|pass|happy)\b|\bno lint(ing)? (errors|warnings|issues)\b|\blint-free\b|\bpasses lint\b/i;
const TYPE_CLAIM = /\b(type ?checks?|typecheck(ing)?|mypy|pyright|tsc) (is |now |all )?(pass|passes|clean|happy|green)\b|\bno type errors\b|\btypes? check out\b/i;
const HISTORY_CMD = /\bgit\s+(commit\s+[^\n]*--amend|push\s+[^\n]*(--force|-f\b|--force-with-lease)|rebase\b|reset\s+--hard|filter-branch|filter-repo|update-ref|reflog\s+(expire|delete)|replace\b|update-index\b|sparse-checkout\b|worktree\s+add\b|checkout\s+[^\n]*--orphan|symbolic-ref\b|gc\s+[^\n]*--prune|notes\s+(add|append|edit|copy|remove|prune)\b)/;
const EXCLUDE_WRITE = /\.git\/info\/exclude|core\.excludesFile|excludesfile/i;
const STASH_CMD = /\bgit\s+stash\b(?!\s+(pop|apply|list|show|drop))/;
const STASH_RESTORE = /\bgit\s+stash\s+(pop|apply)\b/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const BASH_WRITES = /(^|[^2&>])>(?!&)|\bsed\s+-i\b|\btee\b|\bcp\s|\bmv\s|\brm\s|\bgit\s+(checkout|restore|apply|revert)\b|\bpatch\b|<<\s*['"]?\w+/;
/**
 * The shell part of a command: heredoc bodies and the script after `-c` are data, and routinely contain `>` and other
 * characters that look like redirects. Scanning them for writes is what makes a read-only check look like an edit.
 */
function shellOnly(cmd) {
    const lines = cmd.split('\n');
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        kept.push(line);
        const here = /<<-?\s*(['"]?)(\w+)\1/.exec(line);
        if (here) {
            const end = here[2];
            while (i + 1 < lines.length && lines[i + 1].trim() !== end)
                i++;
            i++;
        }
    }
    return kept.join('\n').replace(/(^|\s)-c\s+(['"])[\s\S]*?\2/g, '$1-c ARG');
}
/**
 * The part of a command that actually runs something. `echo "npm test"` prints a string; it is not a test run, and
 * counting it as one let a session claim green tests without running any.
 */
function runnable(cmd) {
    return shellOnly(cmd).replace(/(^|[\n;&|(])\s*(echo|printf)\b[^\n;&|)]*/g, '$1');
}
/** `python -c` is usually a read-only check; it is an edit only when the inline script actually writes. */
const INLINE_PY = /\bpython3?\s+-c\b/;
const INLINE_PY_WRITES = /\.write(_text|_bytes|lines)?\s*\(|open\s*\([^)]*['"][rbt]*[wax]\+?[rbt]*['"]|\bshutil\.|\bos\.(remove|unlink|rename|replace|makedirs|mkdir|rmdir)\b|\bsubprocess\.|\bPath\([^)]*\)\s*\.\s*(write|touch|unlink|rename)/;
/**
 * Where a command redirects its output, ignoring heredoc bodies (`cat > f <<'EOF' ... EOF`), whose text is data and
 * routinely contains `>`. Returns a path only when every redirect in the command is an absolute one, which is the
 * case the caller can check against the diff; anything else is left unknown and treated as touching the tree.
 */
function redirectTarget(cmd) {
    const lines = cmd.split('\n');
    const targets = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const here = /<<-?\s*(['"]?)(\w+)\1/.exec(line);
        for (const m of line.matchAll(/(?:^|[^2&>])>>?\s*(['"]?)([^\s|&;'"]+)\1/g))
            if (m[2] !== '/dev/null')
                targets.push(m[2]);
        if (here) {
            const end = here[2];
            while (i + 1 < lines.length && lines[i + 1].trim() !== end)
                i++;
            i++;
        }
    }
    return targets.length > 0 && targets.every((t) => t.startsWith('/')) ? targets[0] : undefined;
}
/** Parse a Claude Code transcript. Unknown formats yield recognized=false and no findings. */
export function parseTranscript(text) {
    const events = [];
    let i = 0, recognized = false;
    let lastAssistantTexts = [];
    let lastWasAssistantText = false;
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        let o;
        try {
            o = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (o.isSidechain === true)
            continue; // subagent traffic has its own transcript
        const msg = o.message;
        if (!msg || !Array.isArray(msg.content))
            continue;
        recognized = true;
        if (o.type === 'assistant') {
            const texts = [];
            let hadTool = false;
            for (const b of msg.content) {
                if (b.type === 'text' && typeof b.text === 'string') {
                    texts.push(b.text);
                    events.push({ i: i++, kind: 'text', text: b.text });
                }
                if (b.type === 'tool_use') {
                    hadTool = true;
                    const name = String(b.name ?? '');
                    const input = (b.input ?? {});
                    if (EDIT_TOOLS.has(name))
                        events.push({ i: i++, kind: 'edit', file: typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined });
                    else if (READ_TOOLS.has(name))
                        events.push({ i: i++, kind: 'read', file: typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : typeof input.path === 'string' ? input.path : undefined });
                    else if (name === 'Bash' && typeof input.command === 'string') {
                        events.push({ i: i++, kind: 'bash', command: input.command });
                        const shell = shellOnly(input.command);
                        const inlinePyWrites = INLINE_PY.test(shell) && INLINE_PY_WRITES.test(input.command);
                        if (BASH_WRITES.test(shell) || inlinePyWrites)
                            events.push({ i: i++, kind: 'edit', command: input.command, file: redirectTarget(input.command) });
                    }
                }
            }
            // the final message is the run of assistant text blocks after the last tool use
            if (hadTool) {
                lastAssistantTexts = [];
                lastWasAssistantText = false;
            }
            if (texts.length) {
                if (!lastWasAssistantText)
                    lastAssistantTexts = [];
                lastAssistantTexts.push(...texts);
                lastWasAssistantText = true;
            }
        }
        else if (o.type === 'user') {
            // a human turn resets the "final message" window; tool results do not
            const isHuman = msg.content.every((b) => b.type === 'text');
            if (isHuman) {
                lastAssistantTexts = [];
                lastWasAssistantText = false;
            }
        }
    }
    return { events, finalText: lastAssistantTexts.join('\n'), recognized };
}
export async function readTranscript(p) {
    if (!p)
        return null;
    try {
        const st = await fs.stat(p);
        if (st.size > 200 * 1024 * 1024)
            return null;
        return parseTranscript(await fs.readFile(p, 'utf8'));
    }
    catch {
        return null;
    }
}
/**
 * Tool names, across harnesses. The recorder normalises what it can — a `command` makes an event a shell call
 * whatever the tool is called — but the edit/read split has to come from the name, and every harness spells it
 * differently. Unknown names are treated as reads: crediting an unknown tool with an edit would make every test
 * run look stale.
 */
export function classifyTool(name) {
    if (EDIT_TOOLS.has(name) || READ_TOOLS.has(name))
        return EDIT_TOOLS.has(name) ? 'edit' : 'read';
    return /(edit|write|patch|create|update|replace|insert|append|delete|remove|move|rename)/i.test(name) ? 'edit' : 'read';
}
/**
 * The same `Transcript` shape, built from our own recorder rather than a harness's transcript file. The bash-write
 * derivation below is deliberately identical to the transcript parser's: if the two disagreed about when an edit
 * happened, the same session would get different findings depending on which source was available.
 */
export function transcriptFromTools(tools, finalText) {
    const events = [];
    let i = 0;
    for (const t of tools) {
        if (typeof t.command === 'string' && t.command !== '') {
            events.push({ i: i++, kind: 'bash', command: t.command, ...(t.failed === true ? { failed: true } : {}) });
            const shell = shellOnly(t.command);
            const inlinePyWrites = INLINE_PY.test(shell) && INLINE_PY_WRITES.test(t.command);
            if (BASH_WRITES.test(shell) || inlinePyWrites)
                events.push({ i: i++, kind: 'edit', command: t.command, file: redirectTarget(t.command) });
            continue;
        }
        if (t.file === undefined)
            continue;
        events.push({ i: i++, kind: classifyTool(t.tool), file: t.file });
    }
    return { events, finalText, recognized: true };
}
const PATH_RE = /(?:^|[\s`'"(\[])((?:[\w.@-]+\/)+[\w.@-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|mts|cts|go|rs|java|kt|rb|php|cs|swift|scala|json|ya?ml|toml|cfg|ini|sh|md|sql|html|css|scss|vue|svelte)|[\w.@-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|mts|cts|go|rs|java|kt|rb|php|cs|swift|scala))(?=$|[\s`'"):\],.;])/g;
export function claimFindings(t, changes, severities, isTest) {
    if (!t || !t.recognized)
        return [];
    const out = [];
    const sev = (rule) => severities[rule] ?? CLAIM_SEVERITIES[rule] ?? 'warn';
    const emit = (f) => { const s = sev(f.rule); if (s !== 'off')
        out.push({ ...f, severity: s }); };
    const bash = t.events.filter((e) => e.kind === 'bash');
    // An edit only makes a test run stale if it touched the tree under review: an absolute path that matches nothing
    // in the diff (a scratch file under /tmp, say) leaves the tested code exactly as the run found it.
    const changedPaths = changes.map((c) => c.path).concat(changes.flatMap((c) => (c.oldPath ? [c.oldPath] : [])));
    const touchesTree = (e) => {
        const f = e.file;
        if (f === undefined || !f.startsWith('/'))
            return true;
        const norm = f.replace(/\/+$/, '');
        return changedPaths.some((p) => norm === p || norm.endsWith('/' + p));
    };
    const lastEdit = Math.max(-1, ...t.events.filter((e) => e.kind === 'edit' && touchesTree(e)).map((e) => e.i));
    const matchingRuns = (re) => bash.filter((e) => re.test(runnable(e.command)));
    const lastRun = (re) => Math.max(-1, ...matchingRuns(re).map((e) => e.i));
    const final = t.finalText;
    // 1. "tests pass" without a test run after the last edit
    if (TEST_CLAIM.test(final)) {
        const runs = matchingRuns(TEST_CMD);
        const run = lastRun(TEST_CMD);
        if (run < 0)
            emit({ rule: 'claim-tests-unverified', file: '.', message: `The final message says tests pass, but no test command ran in this session` });
        else if (run < lastEdit)
            emit({ rule: 'claim-tests-unverified', file: '.', message: `The final message says tests pass, but the last test run happened before the last edit` });
        else if (runs.find((e) => e.i === run)?.failed === true)
            emit({ rule: 'claim-tests-unverified', file: '.', message: `The final message says tests pass, but the harness reported the last test command as failed` });
    }
    // 2. build / lint / typecheck claims without a matching command
    for (const [label, claim, cmd] of [['build', BUILD_CLAIM, BUILD_CMD], ['lint', LINT_CLAIM, LINT_CMD], ['type check', TYPE_CLAIM, TYPE_CMD]]) {
        if (claim.test(final) && lastRun(cmd) < 0)
            emit({ rule: 'claim-checks-unverified', file: '.', message: `The final message says the ${label} is clean, but no ${label} command ran in this session` });
        else if (claim.test(final) && lastRun(cmd) < lastEdit)
            emit({ rule: 'claim-checks-unverified', file: '.', message: `The final message says the ${label} is clean, but the last ${label} command ran before the last edit` });
    }
    // 3. files named in the summary vs the diff
    const mentioned = new Set();
    for (const m of final.matchAll(PATH_RE))
        mentioned.add(m[1].replace(/^\.\//, ''));
    if (mentioned.size > 0) {
        const changed = changes.map((c) => c.path).concat(changes.flatMap((c) => (c.oldPath ? [c.oldPath] : [])));
        const matches = (mention, p) => p === mention || p.endsWith('/' + mention) || p.split('/').pop() === mention;
        // A file the agent read and then discussed is ordinary reporting, not a claim about a change it did not make.
        // Only a file the session never touched at all — never read, never named in a command, never changed — is a ghost.
        const touched = new Set();
        for (const e of t.events) {
            if (e.file)
                touched.add(e.file);
            if (e.command)
                for (const m of e.command.matchAll(PATH_RE))
                    touched.add(m[1]);
        }
        const seen = [...touched].map((p) => p.replace(/^\.\//, ''));
        const ghost = [...mentioned].filter((m) => !changed.some((p) => matches(m, p)) && !seen.some((p) => matches(m, p)));
        const relevant = changes.filter((c) => langFor(c.path) !== null || isTest(c.path)).map((c) => c.path);
        const unmentioned = relevant.filter((p) => ![...mentioned].some((m) => matches(m, p)));
        if (ghost.length > 0)
            emit({ rule: 'summary-files-mismatch', file: ghost[0], message: `The final message names ${ghost.length} file(s) that did not change: ${ghost.slice(0, 5).join(', ')}` });
        if (unmentioned.length > 0 && unmentioned.length <= 25)
            emit({ rule: 'summary-files-mismatch', file: unmentioned[0], message: `${unmentioned.length} changed file(s) the final message never mentions: ${unmentioned.slice(0, 5).join(', ')}` });
    }
    // 4. history rewriting and diff hiding
    for (const e of bash) {
        const c = e.command;
        if (HISTORY_CMD.test(c))
            emit({ rule: 'history-rewritten', file: '.', message: `Git history rewritten during the session: ${firstLine(c)}` });
        else if (EXCLUDE_WRITE.test(c))
            emit({ rule: 'history-rewritten', file: '.', message: `Exclude rules written during the session (hides files from the diff): ${firstLine(c)}` });
    }
    const stashes = bash.filter((e) => STASH_CMD.test(e.command)).map((e) => e.i);
    const lastStash = Math.max(-1, ...stashes), lastRestore = lastRun(STASH_RESTORE);
    if (lastStash >= 0 && lastRestore < lastStash)
        emit({ rule: 'history-rewritten', file: '.', message: `Changes were stashed and not restored; the working tree the gate sees is not what the agent worked on` });
    return out;
}
function firstLine(s) { return s.split('\n')[0].slice(0, 120); }
//# sourceMappingURL=claims.js.map