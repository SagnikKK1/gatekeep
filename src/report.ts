import type { Finding } from './model.js';
import type { Verdict } from './verdict.js';
import type { Lang } from './parser.js';
import { catFile } from './git.js';
import { langFor } from './lang.js';
import { modelFor } from './rules.js';
import { INTEGRITY_SEVERITIES } from './integrity.js';
import { CLAIM_SEVERITIES } from './claims.js';
import { SCOPE_SEVERITIES } from './scope.js';

/**
 * `gatekeep report`: one self-contained HTML file for a verdict, with the test bodies before and after the session
 * next to each finding. No scripts, no external resources; everything from the session is escaped.
 */

export interface ReportOptions {
  /** Repository root, for reading the before/after file contents from the verdict's tree objects. Null renders from the verdict alone. */
  root: string | null;
  verdictPath?: string;
  /** Injected in tests. */
  loadFile?: (tree: string, p: string) => Promise<string | undefined>;
}

type Family = 'test integrity' | 'check integrity' | 'claims' | 'scope' | 'original tests' | 'model-backed review' | 'gate';

export function familyOf(rule: string): Family {
  if (rule.startsWith('judge-')) return 'model-backed review';
  if (rule in INTEGRITY_SEVERITIES) return 'check integrity';
  if (rule in CLAIM_SEVERITIES) return 'claims';
  if (rule in SCOPE_SEVERITIES) return 'scope';
  if (['original-tests-fail', 'tests-failing', 'test-run-timeout', 'test-run-error'].includes(rule)) return 'original tests';
  if (['gate-config-changed', 'config-invalid', 'session-state-missing'].includes(rule)) return 'gate';
  return 'test integrity';
}

export interface Excerpt { start: number; lines: string[]; note?: string }
export interface Pair { before: Excerpt | null; after: Excerpt | null; kind: 'test' | 'context' }

const MAX_TEST_LINES = 150;
const CONTEXT = 8;
const MAX_EXCERPTED = 200;

function indentOf(s: string): number { return s.length - s.trimStart().length; }

/** The source lines of one test, given its start line and the start of the next one (both 1-based). */
export function sliceTest(lines: string[], start1: number, next1: number | null, lang: Lang): { start: number; end: number } {
  let i = Math.max(0, start1 - 1);
  const n = lines.length;
  if (i >= n) return { start: n, end: n - 1 };
  // Decorators, attributes and annotations belong to the test.
  while (i > 0 && /^\s*(@\w|#\[)/.test(lines[i - 1]!)) i--;
  const bound = Math.min(n - 1, next1 !== null ? Math.max(i, next1 - 2) : n - 1, i + MAX_TEST_LINES - 1);
  let end: number;
  if (lang === 'python' || lang === 'ruby') {
    const base = indentOf(lines[start1 - 1]!);
    let j = start1; // index of the line after the header
    while (j <= bound && (lines[j]!.trim() === '' || indentOf(lines[j]!) > base)) j++;
    if (lang === 'ruby' && j <= bound && indentOf(lines[j]!) === base && /^\s*end\b/.test(lines[j]!)) j++;
    end = j - 1;
  } else {
    // Balance brackets from the header on. The body ends where depth returns to zero after a `{` opened; a test with
    // no braces at all (`it('x', () => expect(1).toBe(1));`) ends where the first bracket run closes.
    let depth = 0, braceOpened = false, anyOpened = false, inBlock = false;
    let braceEnd: number | null = null, parenEnd: number | null = null;
    scan: for (let j = start1 - 1; j <= bound; j++) {
      const s = lines[j]!;
      let q: string | null = null;
      for (let k = 0; k < s.length; k++) {
        const c = s[k]!;
        if (inBlock) { if (c === '*' && s[k + 1] === '/') { inBlock = false; k++; } continue; }
        if (q) { if (c === '\\') k++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '/' && s[k + 1] === '/') break;
        if (c === '/' && s[k + 1] === '*') { inBlock = true; k++; continue; }
        if (c === '(' || c === '{' || c === '[') { depth++; anyOpened = true; if (c === '{') braceOpened = true; }
        else if (c === ')' || c === '}' || c === ']') {
          depth--;
          if (depth <= 0 && anyOpened) {
            if (braceOpened) { braceEnd = j; break scan; }
            if (parenEnd === null) parenEnd = j;
          }
        }
      }
    }
    end = braceEnd ?? parenEnd ?? bound;
  }
  while (end > i && lines[end]!.trim() === '') end--;
  return { start: i, end };
}

/** Line-level LCS: which lines of `a` are missing from `b` and vice versa. */
export function lineDiff(a: string[], b: string[]): { a: boolean[]; b: boolean[] } {
  const n = a.length, m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i]!.trim() === b[j]!.trim() ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ra = new Array<boolean>(n).fill(true), rb = new Array<boolean>(m).fill(true);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i]!.trim() === b[j]!.trim()) { ra[i] = false; rb[j] = false; i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return { a: ra, b: rb };
}

class TreeReader {
  private files = new Map<string, Promise<string | undefined>>();
  private models = new Map<string, Promise<Awaited<ReturnType<typeof modelFor>>>>();
  constructor(private load: (tree: string, p: string) => Promise<string | undefined>) {}
  file(tree: string, p: string): Promise<string | undefined> {
    const k = `${tree}\0${p}`;
    let v = this.files.get(k);
    if (!v) { v = this.load(tree, p).catch(() => undefined); this.files.set(k, v); }
    return v;
  }
  async model(tree: string, p: string) {
    const k = `${tree}\0${p}`;
    let v = this.models.get(k);
    if (!v) { v = (async () => { const src = await this.file(tree, p); if (src === undefined || src.length > 2 * 1024 * 1024) return null; try { return await modelFor(p, src); } catch { return null; } })(); this.models.set(k, v); }
    return v;
  }
}

async function excerptFor(f: Finding, v: Verdict, r: TreeReader): Promise<Pair | null> {
  const lang = langFor(f.file);
  if (f.test && lang) {
    const side = async (tree: string): Promise<Excerpt | null> => {
      const src = await r.file(tree, f.file);
      if (src === undefined) return null;
      const m = await r.model(tree, f.file);
      const lines = src.split('\n');
      const tests = (m?.tests ?? []).slice().sort((x, y) => x.line - y.line);
      const idx = tests.findIndex((t) => t.name === f.test) >= 0 ? tests.findIndex((t) => t.name === f.test) : tests.findIndex((t) => t.name.endsWith(f.test!) || f.test!.endsWith(t.name));
      if (idx < 0) return { start: 0, lines: [], note: 'no test with this name' };
      const t = tests[idx]!;
      const next = tests.slice(idx + 1).find((x) => x.line > t.line)?.line ?? null;
      const { start, end } = sliceTest(lines, t.line, next, lang);
      return { start: start + 1, lines: lines.slice(start, end + 1) };
    };
    const [before, after] = await Promise.all([side(v.baseTree), side(v.currentTree)]);
    if (!before && !after) return null;
    return { before, after, kind: 'test' };
  }
  if (f.line) {
    const window = async (tree: string): Promise<Excerpt | null> => {
      const src = await r.file(tree, f.file);
      if (src === undefined) return null;
      const lines = src.split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const s = Math.max(0, f.line! - 1 - CONTEXT), e = Math.min(lines.length - 1, f.line! - 1 + CONTEXT);
      return { start: s + 1, lines: lines.slice(s, e + 1) };
    };
    const after = await window(v.currentTree);
    const before = await window(v.baseTree);
    if (!before && !after) return null;
    return { before, after, kind: 'context' };
  }
  return null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pane(title: string, ex: Excerpt | null, marks: boolean[] | null, cls: string, focus: number | null): string {
  if (!ex) return `<div class="pane"><div class="pane-h">${esc(title)}</div><div class="pane-empty">file not in this tree</div></div>`;
  if (ex.note) return `<div class="pane"><div class="pane-h">${esc(title)}</div><div class="pane-empty">${esc(ex.note)}</div></div>`;
  const rows = ex.lines.map((l, i) => {
    const n = ex.start + i;
    const c = [marks && marks[i] ? cls : '', focus === n ? 'focus' : ''].filter(Boolean).join(' ');
    return `<tr${c ? ` class="${c}"` : ''}><td class="ln">${n}</td><td class="code">${esc(l) || '&nbsp;'}</td></tr>`;
  }).join('');
  return `<div class="pane"><div class="pane-h">${esc(title)}</div><table class="src">${rows}</table></div>`;
}

function pairHtml(p: Pair, f: Finding): string {
  const marks = p.before && p.after && !p.before.note && !p.after.note ? lineDiff(p.before.lines, p.after.lines) : null;
  const focus = p.kind === 'context' && f.line ? f.line : null;
  const label = p.kind === 'test' ? `test ${f.test}` : `${f.file}:${f.line}`;
  return `<div class="pair"><div class="pair-h">${esc(label)}</div><div class="panes">${pane('before the session', p.before, marks?.a ?? null, 'del', focus)}${pane('after the session', p.after, marks?.b ?? null, 'add', focus)}</div></div>`;
}

function findingHtml(f: Finding, p: Pair | null, lifted: boolean): string {
  const sev = lifted ? 'allowed' : f.severity;
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  let s = `<article class="finding ${sev}"><header><span class="badge ${sev}">${esc(sev)}</span><code class="rule">${esc(f.rule)}</code><span class="fam">${esc(familyOf(f.rule))}</span><span class="loc">${esc(loc)}</span>${f.test ? `<span class="test">${esc(f.test)}</span>` : ''}</header>`;
  s += `<p class="msg">${esc(f.message)}</p>`;
  if (lifted && f.overridden) s += `<p class="lifted">lifted by ${esc(f.overridden)}</p>`;
  if (f.judge) s += `<p class="judge ${f.judge.verdict}"><b>${f.judge.verdict === 'looks-like-evasion' ? 'looks like evasion' : 'consistent with the task'}</b> ${esc(f.judge.reason)}</p>`;
  if (p) s += pairHtml(p, f);
  else if (f.before || f.after) s += `<div class="oneliner">${f.before ? `<div><span class="k">before</span><code>${esc(f.before)}</code></div>` : ''}${f.after ? `<div><span class="k">after</span><code>${esc(f.after)}</code></div>` : ''}</div>`;
  return s + '</article>';
}

const CSS = `
:root{--bg:#fff;--fg:#1b1b1b;--muted:#5f6368;--line:#e3e3e3;--card:#fafafa;--block:#b3261e;--block-bg:#fdecea;--warn:#8a5a00;--warn-bg:#fff4d6;--pass:#1e7a3c;--pass-bg:#e6f4ea;--allowed:#4a5568;--allowed-bg:#edf2f7;--del:#ffe9e6;--add:#e6ffed;--focus:#fff3bf;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#121212;--fg:#e6e6e6;--muted:#a0a0a0;--line:#2c2c2c;--card:#1a1a1a;--block:#ff8a80;--block-bg:#3a1b19;--warn:#ffcf70;--warn-bg:#3a2e12;--pass:#7fd39a;--pass-bg:#15301f;--allowed:#b8c2cc;--allowed-bg:#232a31;--del:#3a1f1f;--add:#1c3324;--focus:#3a3316}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 20px 60px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 10px;border-bottom:1px solid var(--line);padding-bottom:4px}
.decision{display:inline-block;font-weight:700;padding:4px 12px;border-radius:6px;margin-right:8px}.decision.block{color:var(--block);background:var(--block-bg)}.decision.warn{color:var(--warn);background:var(--warn-bg)}.decision.pass{color:var(--pass);background:var(--pass-bg)}
.meta{color:var(--muted);font-size:13px;margin:6px 0 0}.meta code{font-family:var(--mono);font-size:12px}
.task{margin:14px 0;padding:12px 14px;background:var(--card);border:1px solid var(--line);border-radius:8px;white-space:pre-wrap}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.card{padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--card);min-width:120px}.card b{display:block;font-size:20px}.card span{color:var(--muted);font-size:12px}
.finding{border:1px solid var(--line);border-left-width:4px;border-radius:8px;padding:12px 14px;margin:12px 0;background:var(--card)}.finding.block{border-left-color:var(--block)}.finding.warn{border-left-color:var(--warn)}.finding.allowed{border-left-color:var(--allowed);opacity:.85}
.finding header{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline}.badge{font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:10px}.badge.block{color:var(--block);background:var(--block-bg)}.badge.warn{color:var(--warn);background:var(--warn-bg)}.badge.allowed{color:var(--allowed);background:var(--allowed-bg)}
.rule{font-family:var(--mono);font-weight:600}.fam{color:var(--muted);font-size:12px}.loc,.test{font-family:var(--mono);font-size:12px;color:var(--muted)}.msg{margin:8px 0 4px}.lifted{color:var(--allowed);font-size:13px;margin:4px 0}
.judge{margin:6px 0;padding:8px 10px;border-radius:6px;font-size:13px;background:var(--allowed-bg)}.judge.looks-like-evasion{background:var(--warn-bg)}.judge.consistent-with-task{background:var(--pass-bg)}
.pair{margin-top:10px}.pair-h{font-family:var(--mono);font-size:12px;color:var(--muted);margin-bottom:4px}.panes{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:800px){.panes{grid-template-columns:1fr}}
.pane{border:1px solid var(--line);border-radius:6px;overflow:auto;background:var(--bg)}.pane-h{font-size:12px;color:var(--muted);padding:4px 8px;border-bottom:1px solid var(--line);background:var(--card)}.pane-empty{padding:8px;color:var(--muted);font-style:italic;font-size:13px}
table.src{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:12px}table.src td{padding:0 8px;white-space:pre;vertical-align:top}td.ln{color:var(--muted);text-align:right;user-select:none;width:1%;border-right:1px solid var(--line)}tr.del td{background:var(--del)}tr.add td{background:var(--add)}tr.focus td{background:var(--focus)}
.oneliner{margin-top:8px;font-size:13px}.oneliner .k{display:inline-block;width:56px;color:var(--muted)}.oneliner code{font-family:var(--mono);white-space:pre-wrap}
table.plain{border-collapse:collapse;width:100%;font-size:13px}table.plain th,table.plain td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line)}table.plain th{color:var(--muted);font-weight:600}
pre{font-family:var(--mono);font-size:12px;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-word}details{margin:8px 0}summary{cursor:pointer;color:var(--muted)}
.empty{color:var(--muted);font-style:italic}footer{margin-top:40px;color:var(--muted);font-size:12px}
`;

export async function renderReport(v: Verdict, opts: ReportOptions): Promise<string> {
  const load = opts.loadFile ?? (opts.root ? (tree: string, p: string) => catFile(opts.root!, tree, p) : async () => undefined);
  const reader = new TreeReader(load);
  const all = v.checks.testIntegrity.findings;
  const lifted = all.filter((f) => f.overridden);
  const live = all.filter((f) => !f.overridden);
  const strictBlock = v.decision === 'block' && !live.some((f) => f.severity === 'block');
  const blocks = live.filter((f) => f.severity === 'block' || (strictBlock && f.severity === 'warn'));
  const warns = live.filter((f) => !blocks.includes(f));
  const ordered = [...blocks, ...warns, ...lifted];
  const pairs = new Map<Finding, Pair | null>();
  await Promise.all(ordered.slice(0, MAX_EXCERPTED).map(async (f) => pairs.set(f, await excerptFor(f, v, reader))));
  const head = v.decision === 'block' ? 'Blocked' : v.decision === 'warn' ? 'Passed with warnings' : 'Passed';
  const ti = v.checks.testIntegrity;
  const byFamily = new Map<Family, number>();
  for (const f of live) byFamily.set(familyOf(f.rule), (byFamily.get(familyOf(f.rule)) ?? 0) + 1);
  const out: string[] = [];
  out.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gatekeep: ${esc(head)} ${esc(v.createdAt)}</title><style>${CSS}</style></head><body><main>`);
  out.push(`<h1><span class="decision ${v.decision}">${esc(head)}</span>gatekeep verdict</h1>`);
  const meta: string[] = [`created ${esc(v.createdAt)}`];
  if (v.harness) meta.push(`harness ${esc(v.harness)}`);
  if (v.sessionId) meta.push(`session <code>${esc(v.sessionId)}</code>`);
  meta.push(`base <code>${esc(v.baseTree.slice(0, 12))}</code> → current <code>${esc(v.currentTree.slice(0, 12))}</code>`);
  meta.push(`${(v.durationMs / 1000).toFixed(1)} s`);
  if (v.blockCount) meta.push(`block ${v.blockCount}`);
  if (opts.verdictPath) meta.push(`<code>${esc(opts.verdictPath)}</code>`);
  out.push(`<p class="meta">${meta.join(' · ')}</p>`);
  if (v.task) out.push(`<div class="task"><b>Task</b><br>${esc(v.task)}</div>`);
  out.push('<div class="cards">');
  out.push(`<div class="card"><b>${blocks.length}</b><span>blocking</span></div><div class="card"><b>${warns.length}</b><span>warnings</span></div>${lifted.length ? `<div class="card"><b>${lifted.length}</b><span>lifted by override</span></div>` : ''}`);
  out.push(`<div class="card"><b>${ti.examined.length}</b><span>test files examined</span></div><div class="card"><b>${ti.changedSourceFiles.length}</b><span>source files changed</span></div>`);
  for (const [fam, n] of byFamily) out.push(`<div class="card"><b>${n}</b><span>${esc(fam)}</span></div>`);
  out.push('</div>');

  const ot = v.checks.originalTests;
  if (ot) {
    out.push('<h2>Original tests against the final code</h2>');
    out.push(`<p><b>${esc(ot.status)}</b>${ot.originalExit !== null ? ` · original tests exit ${ot.originalExit}` : ''}${ot.currentExit !== null ? ` · edited tests exit ${ot.currentExit}` : ''}${ot.reason ? ` · ${esc(ot.reason)}` : ''} · ${(ot.durationMs / 1000).toFixed(1)} s${ot.restoredTestFiles.length ? ` · restored ${ot.restoredTestFiles.length} test file(s)` : ''}</p>`);
    if (ot.originalOutput) out.push(`<details><summary>output of the original tests</summary><pre>${esc(ot.originalOutput)}</pre></details>`);
    if (ot.currentOutput) out.push(`<details><summary>output of the edited tests</summary><pre>${esc(ot.currentOutput)}</pre></details>`);
  }
  const jg = v.checks.judge;
  if (jg) {
    out.push('<h2>Model-backed review</h2>');
    const bits = [`<b>${esc(jg.status)}</b>`];
    if (jg.model) bits.push(`model <code>${esc(jg.model)}</code>`);
    if (jg.status === 'ran' || jg.status === 'cached') bits.push(`${jg.emitted} finding(s)`, `${jg.annotated} annotated`, `${jg.filesJudged} file(s) read${jg.truncated.length ? `, ${jg.truncated.length} truncated` : ''}${jg.omittedFiles ? `, ${jg.omittedFiles} omitted` : ''}`);
    if (jg.usage) bits.push(`${jg.usage.input + jg.usage.cacheRead + jg.usage.cacheWrite} in / ${jg.usage.output} out tokens`);
    bits.push(`${(jg.durationMs / 1000).toFixed(1)} s`);
    out.push(`<p>${bits.join(' · ')}</p>`);
    if (jg.reason) out.push(`<p class="empty">${esc(jg.reason)}</p>`);
    if (jg.summary) out.push(`<p>${esc(jg.summary)}</p>`);
    if (jg.promptHash) out.push(`<p class="meta">prompt hash <code>${esc(jg.promptHash)}</code></p>`);
    if (jg.truncated.length) out.push(`<table class="plain"><tr><th>truncated file</th><th>shown</th><th>total</th></tr>${jg.truncated.map((t) => `<tr><td>${esc(t.path)}</td><td>${t.shown}</td><td>${t.total}</td></tr>`).join('')}</table>`);
    if (jg.raw) out.push(`<details><summary>raw model output</summary><pre>${esc(jg.raw)}</pre></details>`);
  }

  const section = (title: string, list: Finding[], isLifted: boolean) => {
    out.push(`<h2>${esc(title)} (${list.length})</h2>`);
    if (list.length === 0) { out.push('<p class="empty">none</p>'); return; }
    for (const f of list) out.push(findingHtml(f, pairs.get(f) ?? null, isLifted));
  };
  section(strictBlock ? 'Blocking (warnings, strict mode)' : 'Blocking', blocks, false);
  section('Warnings', warns, false);
  if (lifted.length) section('Lifted by override', lifted, true);
  if (v.overrides?.length) {
    out.push('<h2>Overrides</h2><table class="plain"><tr><th>rule</th><th>granted by</th><th>source</th><th>reason</th></tr>');
    for (const o of v.overrides) out.push(`<tr><td><code>${esc(o.rule)}</code></td><td>${esc(o.by)}</td><td>${esc(o.source)}</td><td>${esc(o.reason ?? '')}</td></tr>`);
    out.push('</table>');
  }
  out.push('<h2>Files</h2>');
  if (ti.examined.length) {
    out.push('<table class="plain"><tr><th>test file</th><th>status</th><th>tests before</th><th>tests after</th></tr>');
    for (const e of ti.examined) out.push(`<tr><td>${esc(e.path)}</td><td>${esc(e.status)}</td><td>${e.testsBefore}</td><td>${e.testsAfter}</td></tr>`);
    out.push('</table>');
  } else out.push('<p class="empty">no test files changed</p>');
  if (ti.changedSourceFiles.length) out.push(`<p><b>Source files changed:</b> ${ti.changedSourceFiles.map((p) => `<code>${esc(p)}</code>`).join(', ')}</p>`);
  const json = JSON.stringify(v, null, 2);
  if (json.length <= 512 * 1024) out.push(`<details><summary>verdict JSON</summary><pre>${esc(json)}</pre></details>`);
  out.push(`<footer>Generated by gatekeep from a verdict produced at ${esc(v.createdAt)}. The gate decides from the deterministic findings; annotations from the model-backed review never change a severity.${opts.root ? '' : ' File contents were not available when this report was rendered; excerpts show only what the verdict recorded.'}</footer>`);
  out.push('</main></body></html>');
  return out.join('\n');
}
