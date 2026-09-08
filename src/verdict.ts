import path from 'node:path';
import type { Finding } from './model.js';
import type { AnalysisResult } from './rules.js';
import type { TestRunResult } from './testrun.js';
import type { Override } from './override.js';
import { verdictDir, writeAtomic } from './session.js';

export interface Verdict {
  schema: 'gatekeep.verdict.v1';
  createdAt: string;
  sessionId: string | null;
  harness: string | null;
  baseTree: string;
  currentTree: string;
  task: string | null;
  decision: 'pass' | 'block' | 'warn';
  checks: {
    testIntegrity: {
      status: 'pass' | 'fail' | 'warn';
      findings: Finding[];
      examined: AnalysisResult['examined'];
      changedSourceFiles: string[];
    };
    originalTests?: TestRunResult;
  };
  blockCount: number;
  durationMs: number;
  /** Overrides that lifted at least one finding, with who granted them. */
  overrides?: Override[];
}

export function decide(findings: Finding[], strict: boolean): Verdict['decision'] {
  const live = findings.filter((f) => !f.overridden);
  if (live.some((f) => f.severity === 'block')) return 'block';
  if (live.some((f) => f.severity === 'warn')) return strict ? 'block' : 'warn';
  return 'pass';
}

export async function writeVerdict(root: string, v: Verdict): Promise<string> {
  const dir = verdictDir(root);
  const name = `${v.createdAt.replace(/[:.]/g, '-')}${v.sessionId ? '-' + v.sessionId.slice(0, 8) : ''}.json`;
  const p = path.join(dir, name);
  const text = JSON.stringify(v, null, 2) + '\n';
  await writeAtomic(p, text);
  await writeAtomic(path.join(dir, 'latest.json'), text);
  return p;
}

const MAX_LISTED = 40;

/** Human/agent-readable report. Written to stderr on block so the agent sees it as its next instruction. */
export function formatReport(v: Verdict, opts: { forAgent: boolean; verdictPath?: string }): string {
  const all = v.checks.testIntegrity.findings;
  const lifted = all.filter((x) => x.overridden);
  const f = all.filter((x) => !x.overridden);
  const blocking = v.decision === 'block';
  // Under strict mode warnings block; count by what actually decided.
  const blocks = f.filter((x) => x.severity === 'block' || (blocking && x.severity === 'warn' && !f.some((y) => y.severity === 'block')));
  const warns = f.filter((x) => !blocks.includes(x));
  const lines: string[] = [];
  const head = v.decision === 'block' ? 'BLOCKED' : v.decision === 'warn' ? 'PASSED WITH WARNINGS' : 'PASSED';
  const ex = v.checks.testIntegrity.examined.length, src = v.checks.testIntegrity.changedSourceFiles.length;
  lines.push(`GATEKEEP ${head} — test integrity: ${blocks.length} blocking, ${warns.length} warning(s); ${ex} test file(s) examined, ${src} source file(s) changed.`);
  const ot = v.checks.originalTests;
  if (ot) lines.push(`  original tests vs current code: ${ot.status}${ot.originalExit !== null ? ` (exit ${ot.originalExit}${ot.currentExit !== null ? `, edited tests exit ${ot.currentExit}` : ''})` : ''}${ot.reason ? ` — ${ot.reason}` : ''}, ${(ot.durationMs / 1000).toFixed(1)}s`);
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const fmt = (x: Finding) => {
    const loc = clip(x.line ? `${x.file}:${x.line}` : x.file, 200);
    const t = x.test ? ` [${clip(x.test, 120)}]` : '';
    let s = `  [${x.severity}] ${x.rule}  ${loc}${t}\n      ${clip(x.message, 400)}`;
    if (x.before) s += `\n      before: ${x.before.slice(0, 160)}`;
    if (x.after) s += `\n      after:  ${x.after.slice(0, 160)}`;
    return s;
  };
  const ordered = [...blocks, ...warns];
  for (const x of ordered.slice(0, MAX_LISTED)) lines.push(fmt(x));
  if (ordered.length > MAX_LISTED) {
    const rest = ordered.slice(MAX_LISTED);
    const byRule = new Map<string, number>();
    for (const x of rest) byRule.set(x.rule, (byRule.get(x.rule) ?? 0) + 1);
    lines.push(`  ... and ${rest.length} more: ${[...byRule].map(([r, n]) => `${r} ×${n}`).join(', ')} (see the verdict file)`);
  }
  for (const x of lifted) lines.push(`  [allowed] ${x.rule}  ${clip(x.line ? `${x.file}:${x.line}` : x.file, 200)}${x.test ? ` [${clip(x.test, 120)}]` : ''} — lifted by ${x.overridden}`);
  if (v.decision === 'block' && opts.forAgent) {
    lines.push('');
    lines.push('You may not finish yet. Restore the tests to their original strength and make the implementation satisfy them.');
    lines.push('Do not skip, delete, weaken, or mock away tests to get a green run. If a test is genuinely obsolete because the');
    lines.push('task changed the required behavior, leave it in place, explain exactly why in your final message, and let the user decide.');
    if (v.blockCount >= 2) lines.push(`(This is block ${v.blockCount}. After the configured limit the gate will stop blocking and hand these findings to the user.)`);
  }
  if (opts.verdictPath) lines.push(`verdict: ${opts.verdictPath}`);
  const text = lines.join('\n');
  const BUDGET = 48 * 1024;
  return text.length > BUDGET ? text.slice(0, BUDGET) + `\n  … report truncated at ${BUDGET} bytes; see the verdict file` : text;
}
