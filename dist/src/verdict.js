import path from 'node:path';
import { familyOf } from './rules.js';
import { verdictDir, writeAtomic } from './session.js';
export function decide(findings, strict) {
    const live = findings.filter((f) => !f.overridden);
    if (live.some((f) => f.severity === 'block'))
        return 'block';
    if (live.some((f) => f.severity === 'warn'))
        return strict ? 'block' : 'warn';
    return 'pass';
}
export async function writeVerdict(root, v) {
    const dir = verdictDir(root);
    const name = `${v.createdAt.replace(/[:.]/g, '-')}${v.sessionId ? '-' + v.sessionId.slice(0, 8) : ''}.json`;
    const p = path.join(dir, name);
    const text = JSON.stringify(v, null, 2) + '\n';
    await writeAtomic(p, text);
    await writeAtomic(path.join(dir, 'latest.json'), text);
    return p;
}
/** What to do about a block, by the family that raised it. "Restore the tests" is wrong advice for two thirds of them. */
const REMEDIATION = {
    'test integrity': [
        'Restore the tests to their original strength and make the implementation satisfy them. Do not skip, delete,',
        'weaken, or mock away a test to get a green run.',
    ],
    'check integrity': [
        'Restore the check you weakened: the CI step, the linter or type-checker setting, the pre-commit hook, or the',
        'suppression comment. A check that no longer runs is not a check that passes.',
    ],
    claims: [
        'Your final message claims something this session does not show. Run the command you said you ran, or correct',
        'the message to say what actually happened.',
    ],
    scope: [
        'This change reaches outside what the task asked for. Revert the unrelated files, or name them and their reason',
        'in your final message.',
    ],
    'source fitted to the tests': [
        'The implementation branches on values that only the tests use. Implement the behaviour the specification',
        'describes, not the cases the tests happen to check.',
    ],
    'original tests': [
        'The tests as they stood at the start of this session fail against your implementation. Fix the implementation.',
        'Changing the tests until they pass is the thing this gate exists to catch.',
    ],
    'model-backed review': [
        'The model-backed review found the change fitted to the tests rather than to the task.',
    ],
    gate: [
        "gatekeep's own configuration, hook wiring and session state may not be changed during a session. Restore them.",
        'This one cannot be lifted by an override directive.',
    ],
};
const MAX_LISTED = 40;
/** Human/agent-readable report. Written to stderr on block so the agent sees it as its next instruction. */
export function formatReport(v, opts) {
    const all = v.checks.testIntegrity.findings;
    const lifted = all.filter((x) => x.overridden);
    const f = all.filter((x) => !x.overridden);
    const blocking = v.decision === 'block';
    // Under strict mode warnings block; count by what actually decided.
    const blocks = f.filter((x) => x.severity === 'block' || (blocking && x.severity === 'warn' && !f.some((y) => y.severity === 'block')));
    const warns = f.filter((x) => !blocks.includes(x));
    const lines = [];
    const head = v.decision === 'block' ? 'BLOCKED' : v.decision === 'warn' ? 'PASSED WITH WARNINGS' : 'PASSED';
    const ex = v.checks.testIntegrity.examined.length, src = v.checks.testIntegrity.changedSourceFiles.length;
    // Name the families that actually fired. "test integrity: 1 blocking, 0 test file(s) examined" for a scope finding
    // reads as a bug in the gate rather than a finding about the change.
    const fams = [...new Set([...blocks, ...warns].map((x) => familyOf(x.rule)))];
    const scope = fams.length === 0 ? 'no findings' : fams.join(', ');
    const examined = fams.includes('test integrity') || ex > 0 ? `; ${ex} test file(s) examined, ${src} source file(s) changed` : `; ${src} source file(s) changed`;
    lines.push(`GATEKEEP ${head} — ${scope}: ${blocks.length} blocking, ${warns.length} warning(s)${examined}.`);
    const ot = v.checks.originalTests;
    if (ot)
        lines.push(`  original tests vs current code: ${ot.status}${ot.originalExit !== null ? ` (exit ${ot.originalExit}${ot.currentExit !== null ? `, edited tests exit ${ot.currentExit}` : ''})` : ''}${ot.reason ? ` — ${ot.reason}` : ''}, ${(ot.durationMs / 1000).toFixed(1)}s`);
    const jg = v.checks.judge;
    if (jg) {
        const u = jg.usage ? `, ${jg.usage.input + jg.usage.cacheRead + jg.usage.cacheWrite} in / ${jg.usage.output} out tokens${jg.usage.costUsd !== undefined ? ` (~$${jg.usage.costUsd.toFixed(3)} est.)` : ''}` : '';
        const detail = jg.status === 'ran' || jg.status === 'cached' ? `${jg.model}${jg.status === 'cached' ? ' (cached)' : ''}: ${jg.emitted} finding(s), ${jg.annotated} annotated, ${jg.filesJudged} file(s)${jg.truncated.length ? `, ${jg.truncated.length} truncated` : ''}${jg.omittedFiles ? `, ${jg.omittedFiles} omitted` : ''}${u}` : `${jg.status}${jg.reason ? ` — ${jg.reason}` : ''}`;
        lines.push(`  model-backed review: ${detail}, ${(jg.durationMs / 1000).toFixed(1)}s`);
        if (jg.summary)
            lines.push(`      ${jg.summary.slice(0, 300)}`);
    }
    const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
    const fmt = (x) => {
        const loc = clip(x.line ? `${x.file}:${x.line}` : x.file, 200);
        const t = x.test ? ` [${clip(x.test, 120)}]` : '';
        let s = `  [${x.severity}] ${x.rule}  ${loc}${t}\n      ${clip(x.message, 400)}`;
        if (x.before)
            s += `\n      before: ${x.before.slice(0, 160)}`;
        if (x.after)
            s += `\n      after:  ${x.after.slice(0, 160)}`;
        if (x.judge)
            s += `\n      judge: ${x.judge.verdict === 'looks-like-evasion' ? 'looks like evasion' : 'consistent with the task'} — ${clip(x.judge.reason, 300)}`;
        return s;
    };
    const ordered = [...blocks, ...warns];
    for (const x of ordered.slice(0, MAX_LISTED))
        lines.push(fmt(x));
    if (ordered.length > MAX_LISTED) {
        const rest = ordered.slice(MAX_LISTED);
        const byRule = new Map();
        for (const x of rest)
            byRule.set(x.rule, (byRule.get(x.rule) ?? 0) + 1);
        lines.push(`  ... and ${rest.length} more: ${[...byRule].map(([r, n]) => `${r} ×${n}`).join(', ')} (see the verdict file)`);
    }
    for (const x of lifted)
        lines.push(`  [allowed] ${x.rule}  ${clip(x.line ? `${x.file}:${x.line}` : x.file, 200)}${x.test ? ` [${clip(x.test, 120)}]` : ''} — lifted by ${x.overridden}`);
    if (v.decision === 'block' && opts.forAgent) {
        lines.push('');
        lines.push('You may not finish yet.');
        for (const fam of [...new Set(blocks.map((x) => familyOf(x.rule)))])
            lines.push(...REMEDIATION[fam]);
        lines.push('If a finding is genuinely wrong for this change, leave the code as it is, explain exactly why in your final message, and let the user decide.');
        if (v.blockCount >= 2)
            lines.push(`(This is block ${v.blockCount}. After the configured limit the gate will stop blocking and hand these findings to the user.)`);
    }
    if (opts.verdictPath)
        lines.push(`verdict: ${opts.verdictPath}`);
    const text = lines.join('\n');
    const BUDGET = 48 * 1024;
    return text.length > BUDGET ? text.slice(0, BUDGET) + `\n  … report truncated at ${BUDGET} bytes; see the verdict file` : text;
}
//# sourceMappingURL=verdict.js.map