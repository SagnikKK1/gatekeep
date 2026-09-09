import fs from 'node:fs/promises';
import type { FileChange, Finding, Severity } from './model.js';
import { langFor } from './lang.js';

/**
 * Roadmap item 3: claim verification. The Stop hook receives the session transcript; compare what the agent said in its
 * final message to what it actually ran and changed. Claude Code transcript format (JSONL of {type, message:{content:[...]}}).
 */

export const CLAIM_SEVERITIES: Record<string, Severity> = {
  'claim-tests-unverified': 'warn',
  'claim-checks-unverified': 'warn',
  'summary-files-mismatch': 'warn',
  'history-rewritten': 'block',
};

export interface TranscriptEvent {
  /** position in the transcript, for ordering */
  i: number;
  kind: 'text' | 'edit' | 'bash' | 'read';
  text?: string;
  file?: string;
  command?: string;
}

export interface Transcript {
  events: TranscriptEvent[];
  /** Text of the agent's last message (the one that triggered Stop). */
  finalText: string;
  recognized: boolean;
}

const TEST_CMD = /\b(pytest|py\.test|python3? -m (pytest|unittest)|python3? [\w.\/-]*tests?[\w.\/-]*\.py|unittest|jest|vitest|mocha|ava\b|tap\b|node --test|npm (run )?test|yarn test|pnpm test|bun test|deno test|go test|cargo test|mvn (test|verify)|gradle\w* (test|check)|dotnet test|phpunit|rspec|tox\b|nox\b|make (test|check)|nose2?|karma|cypress run|playwright test)\b/;
const BUILD_CMD = /\b((npm|pnpm|yarn|bun) (run )?build|tsc\b|cargo build|go build|make\b|gradle\w* (build|assemble)|mvn (package|compile|install)|dotnet build|webpack|vite build|next build|esbuild|rollup|python -m build|setup\.py build)\b/;
const LINT_CMD = /\b(eslint|ruff|flake8|pylint|biome|golangci-lint|rubocop|clippy|(npm|pnpm|yarn) (run )?lint|prettier --check|black --check|isort --check|stylelint|shellcheck)\b/;
const TYPE_CMD = /\b(tsc\b|mypy|pyright|(npm|pnpm|yarn) (run )?(typecheck|type-check|types)|flow check)\b/;

const TEST_CLAIM = /\b(all |the |every )?(unit |integration |existing |new )?tests? (now |still |all )?(pass|passes|passing|are passing|succeed|succeeds|are green|is green|green)\b|\b\d+ (tests? )?(passed|passing)\b|\btest suite (passes|is green|passed)\b|\bpasses all (the )?tests\b|\bsuite (is )?green\b|\btests? (run|ran) (clean|successfully)\b/i;
const BUILD_CLAIM = /\b(the )?(build|compilation) (is |now )?(clean|passes|succeeds|successful|works|green)\b|\bbuilds? (cleanly|successfully|without errors)\b|\bcompiles? (cleanly|without errors|successfully)\b/i;
const LINT_CLAIM = /\b(lint|linter|linting) (is |now )?(clean|passes|pass|happy)\b|\bno lint(ing)? (errors|warnings|issues)\b|\blint-free\b|\bpasses lint\b/i;
const TYPE_CLAIM = /\b(type ?checks?|typecheck(ing)?|mypy|pyright|tsc) (is |now |all )?(pass|passes|clean|happy|green)\b|\bno type errors\b|\btypes? check out\b/i;

const HISTORY_CMD = /\bgit\s+(commit\s+[^\n]*--amend|push\s+[^\n]*(--force|-f\b|--force-with-lease)|rebase\b|reset\s+--hard|filter-branch|filter-repo|update-ref|reflog\s+(expire|delete)|replace\b)/;
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
function shellOnly(cmd: string): string {
  const lines = cmd.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    kept.push(line);
    const here = /<<-?\s*(['"]?)(\w+)\1/.exec(line);
    if (here) { const end = here[2]!; while (i + 1 < lines.length && lines[i + 1]!.trim() !== end) i++; i++; }
  }
  return kept.join('\n').replace(/(^|\s)-c\s+(['"])[\s\S]*?\2/g, '$1-c ARG');
}

/** `python -c` is usually a read-only check; it is an edit only when the inline script actually writes. */
const INLINE_PY = /\bpython3?\s+-c\b/;
const INLINE_PY_WRITES = /\.write(_text|_bytes|lines)?\s*\(|open\s*\([^)]*['"][rbt]*[wax]\+?[rbt]*['"]|\bshutil\.|\bos\.(remove|unlink|rename|replace|makedirs|mkdir|rmdir)\b|\bsubprocess\.|\bPath\([^)]*\)\s*\.\s*(write|touch|unlink|rename)/;
/**
 * Where a command redirects its output, ignoring heredoc bodies (`cat > f <<'EOF' ... EOF`), whose text is data and
 * routinely contains `>`. Returns a path only when every redirect in the command is an absolute one, which is the
 * case the caller can check against the diff; anything else is left unknown and treated as touching the tree.
 */
function redirectTarget(cmd: string): string | undefined {
  const lines = cmd.split('\n');
  const targets: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const here = /<<-?\s*(['"]?)(\w+)\1/.exec(line);
    for (const m of line.matchAll(/(?:^|[^2&>])>>?\s*(['"]?)([^\s|&;'"]+)\1/g)) if (m[2] !== '/dev/null') targets.push(m[2]!);
    if (here) { const end = here[2]!; while (i + 1 < lines.length && lines[i + 1]!.trim() !== end) i++; i++; }
  }
  return targets.length > 0 && targets.every((t) => t.startsWith('/')) ? targets[0] : undefined;
}

/** Parse a Claude Code transcript. Unknown formats yield recognized=false and no findings. */
export function parseTranscript(text: string): Transcript {
  const events: TranscriptEvent[] = [];
  let i = 0, recognized = false;
  let lastAssistantTexts: string[] = [];
  let lastWasAssistantText = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (o.isSidechain === true) continue; // subagent traffic has its own transcript
    const msg = o.message as { role?: string; content?: unknown } | undefined;
    if (!msg || !Array.isArray(msg.content)) continue;
    recognized = true;
    if (o.type === 'assistant') {
      const texts: string[] = [];
      let hadTool = false;
      for (const b of msg.content as Record<string, unknown>[]) {
        if (b.type === 'text' && typeof b.text === 'string') { texts.push(b.text); events.push({ i: i++, kind: 'text', text: b.text }); }
        if (b.type === 'tool_use') {
          hadTool = true;
          const name = String(b.name ?? ''); const input = (b.input ?? {}) as Record<string, unknown>;
          if (EDIT_TOOLS.has(name)) events.push({ i: i++, kind: 'edit', file: typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined });
          else if (READ_TOOLS.has(name)) events.push({ i: i++, kind: 'read', file: typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : typeof input.path === 'string' ? input.path : undefined });
          else if (name === 'Bash' && typeof input.command === 'string') {
            events.push({ i: i++, kind: 'bash', command: input.command });
            const shell = shellOnly(input.command);
            const inlinePyWrites = INLINE_PY.test(shell) && INLINE_PY_WRITES.test(input.command);
            if (BASH_WRITES.test(shell) || inlinePyWrites) events.push({ i: i++, kind: 'edit', command: input.command, file: redirectTarget(input.command) });
          }
        }
      }
      // the final message is the run of assistant text blocks after the last tool use
      if (hadTool) { lastAssistantTexts = []; lastWasAssistantText = false; }
      if (texts.length) { if (!lastWasAssistantText) lastAssistantTexts = []; lastAssistantTexts.push(...texts); lastWasAssistantText = true; }
    } else if (o.type === 'user') {
      // a human turn resets the "final message" window; tool results do not
      const isHuman = (msg.content as Record<string, unknown>[]).every((b) => b.type === 'text');
      if (isHuman) { lastAssistantTexts = []; lastWasAssistantText = false; }
    }
  }
  return { events, finalText: lastAssistantTexts.join('\n'), recognized };
}

export async function readTranscript(p: string | undefined): Promise<Transcript | null> {
  if (!p) return null;
  try {
    const st = await fs.stat(p);
    if (st.size > 200 * 1024 * 1024) return null;
    return parseTranscript(await fs.readFile(p, 'utf8'));
  } catch { return null; }
}

const PATH_RE = /(?:^|[\s`'"(\[])((?:[\w.@-]+\/)+[\w.@-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|mts|cts|go|rs|java|kt|rb|php|cs|swift|scala|json|ya?ml|toml|cfg|ini|sh|md|sql|html|css|scss|vue|svelte)|[\w.@-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|mts|cts|go|rs|java|kt|rb|php|cs|swift|scala))(?=$|[\s`'"):\],.;])/g;

export function claimFindings(t: Transcript | null, changes: FileChange[], severities: Record<string, Severity>, isTest: (p: string) => boolean): Finding[] {
  if (!t || !t.recognized) return [];
  const out: Finding[] = [];
  const sev = (rule: string): Severity => severities[rule] ?? CLAIM_SEVERITIES[rule] ?? 'warn';
  const emit = (f: Omit<Finding, 'severity'>) => { const s = sev(f.rule); if (s !== 'off') out.push({ ...f, severity: s }); };
  const bash = t.events.filter((e) => e.kind === 'bash');
  // An edit only makes a test run stale if it touched the tree under review: an absolute path that matches nothing
  // in the diff (a scratch file under /tmp, say) leaves the tested code exactly as the run found it.
  const changedPaths = changes.map((c) => c.path).concat(changes.flatMap((c) => (c.oldPath ? [c.oldPath] : [])));
  const touchesTree = (e: TranscriptEvent) => {
    const f = e.file;
    if (f === undefined || !f.startsWith('/')) return true;
    const norm = f.replace(/\/+$/, '');
    return changedPaths.some((p) => norm === p || norm.endsWith('/' + p));
  };
  const lastEdit = Math.max(-1, ...t.events.filter((e) => e.kind === 'edit' && touchesTree(e)).map((e) => e.i));
  const lastRun = (re: RegExp) => Math.max(-1, ...bash.filter((e) => re.test(e.command!)).map((e) => e.i));
  const final = t.finalText;

  // 1. "tests pass" without a test run after the last edit
  if (TEST_CLAIM.test(final)) {
    const run = lastRun(TEST_CMD);
    if (run < 0) emit({ rule: 'claim-tests-unverified', file: '.', message: `The final message says tests pass, but no test command ran in this session` });
    else if (run < lastEdit) emit({ rule: 'claim-tests-unverified', file: '.', message: `The final message says tests pass, but the last test run happened before the last edit` });
  }
  // 2. build / lint / typecheck claims without a matching command
  for (const [label, claim, cmd] of [['build', BUILD_CLAIM, BUILD_CMD], ['lint', LINT_CLAIM, LINT_CMD], ['type check', TYPE_CLAIM, TYPE_CMD]] as const) {
    if (claim.test(final) && lastRun(cmd) < 0) emit({ rule: 'claim-checks-unverified', file: '.', message: `The final message says the ${label} is clean, but no ${label} command ran in this session` });
    else if (claim.test(final) && lastRun(cmd) < lastEdit) emit({ rule: 'claim-checks-unverified', file: '.', message: `The final message says the ${label} is clean, but the last ${label} command ran before the last edit` });
  }
  // 3. files named in the summary vs the diff
  const mentioned = new Set<string>();
  for (const m of final.matchAll(PATH_RE)) mentioned.add(m[1]!.replace(/^\.\//, ''));
  if (mentioned.size > 0) {
    const changed = changes.map((c) => c.path).concat(changes.flatMap((c) => (c.oldPath ? [c.oldPath] : [])));
    const matches = (mention: string, p: string) => p === mention || p.endsWith('/' + mention) || p.split('/').pop() === mention;
    // A file the agent read and then discussed is ordinary reporting, not a claim about a change it did not make.
    // Only a file the session never touched at all — never read, never named in a command, never changed — is a ghost.
    const touched = new Set<string>();
    for (const e of t.events) {
      if (e.file) touched.add(e.file);
      if (e.command) for (const m of e.command.matchAll(PATH_RE)) touched.add(m[1]!);
    }
    const seen = [...touched].map((p) => p.replace(/^\.\//, ''));
    const ghost = [...mentioned].filter((m) => !changed.some((p) => matches(m, p)) && !seen.some((p) => matches(m, p)));
    const relevant = changes.filter((c) => langFor(c.path) !== null || isTest(c.path)).map((c) => c.path);
    const unmentioned = relevant.filter((p) => ![...mentioned].some((m) => matches(m, p)));
    if (ghost.length > 0) emit({ rule: 'summary-files-mismatch', file: ghost[0]!, message: `The final message names ${ghost.length} file(s) that did not change: ${ghost.slice(0, 5).join(', ')}` });
    if (unmentioned.length > 0 && unmentioned.length <= 25) emit({ rule: 'summary-files-mismatch', file: unmentioned[0]!, message: `${unmentioned.length} changed file(s) the final message never mentions: ${unmentioned.slice(0, 5).join(', ')}` });
  }
  // 4. history rewriting and diff hiding
  for (const e of bash) {
    const c = e.command!;
    if (HISTORY_CMD.test(c)) emit({ rule: 'history-rewritten', file: '.', message: `Git history rewritten during the session: ${firstLine(c)}` });
    else if (EXCLUDE_WRITE.test(c)) emit({ rule: 'history-rewritten', file: '.', message: `Exclude rules written during the session (hides files from the diff): ${firstLine(c)}` });
  }
  const stashes = bash.filter((e) => STASH_CMD.test(e.command!)).map((e) => e.i);
  const lastStash = Math.max(-1, ...stashes), lastRestore = lastRun(STASH_RESTORE);
  if (lastStash >= 0 && lastRestore < lastStash) emit({ rule: 'history-rewritten', file: '.', message: `Changes were stashed and not restored; the working tree the gate sees is not what the agent worked on` });
  return out;
}

function firstLine(s: string): string { return s.split('\n')[0]!.slice(0, 120); }
