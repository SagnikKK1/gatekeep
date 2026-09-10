import type { FileChange, Finding, Severity, TestCase, TestFileModel, Mock } from './model.js';
import { TEST_FIXTURE_GLOBS, langFor, matchesAny, pythonTargetHits, jsTargetHits, jsCandidatePaths, pythonCandidatePaths, mockedSymbol, isCollectedName, DEFAULT_TEST_GLOBS, DEFAULT_TEST_CONFIG_GLOBS } from './lang.js';
import { tokens, ParseTimeout } from './parser.js';
import { extractPython } from './extract/python.js';
import { extractJS } from './extract/js.js';
import { extractGo } from './extract/go.js';
import { extractRust, hasInlineTests } from './extract/rust.js';
import { extractJava } from './extract/java.js';
import { extractRuby } from './extract/ruby.js';
import { integrityFindings, INTEGRITY_GLOBS, INTEGRITY_SEVERITIES } from './integrity.js';
import { CLAIM_SEVERITIES } from './claims.js';
import { oracleFindings, ORACLE_SEVERITIES } from './oracle.js';
import { scopeFindings, SCOPE_SEVERITIES, SCOPE_GLOBS, LOCKFILE_GLOBS, DEFAULT_PROTECTED_GLOBS } from './scope.js';

export interface RuleConfig {
  testGlobs: string[];
  testConfigGlobs: string[];
  ignoreGlobs: string[];
  severities: Record<string, Severity>;
  /** Fraction of assertions that may be dropped from an existing test before it is reported (0 = any drop). */
  assertionDropTolerance: number;
  /** Paths an agent may not edit without an override. */
  protectedGlobs: string[];
}

export const DEFAULT_SEVERITIES: Record<string, Severity> = {
  'gate-config-changed': 'block',
  'config-invalid': 'warn',
  'session-state-missing': 'warn',
  'state-tampered': 'block',
  'index-flags-set': 'block',
  'paths-hidden-from-snapshot': 'block',
  'original-tests-fail': 'block',
  'tests-failing': 'warn',
  'test-run-timeout': 'warn',
  'test-run-error': 'warn',
  'test-config-narrowed': 'warn',
  'mock-on-source-module': 'block',
  'test-file-deleted': 'block',
  'test-support-file-deleted': 'warn',
  'test-file-moved-out': 'block',
  'test-file-unreadable': 'block',
  'test-file-unparseable': 'warn',
  'test-deleted': 'block',
  'test-skipped': 'block',
  'test-conditionally-skipped': 'warn',
  'test-focused': 'block',
  'test-vacuous': 'block',
  'file-skipped': 'block',
  'assertions-removed': 'block',
  'assertions-reduced': 'warn',
  'assertion-weakened': 'block',
  'assertion-unreachable': 'block',
  'assertion-swallowed': 'block',
  'assertion-shadowed': 'block',
  'assertion-helper-noop': 'warn',
  'assertion-free-test': 'warn',
  'early-exit-added': 'block',
  'mock-on-changed-module': 'block',
  'mock-unrelated-to-change': 'warn',
  'constant-override-on-changed-module': 'warn',
  'mock-on-module-under-test': 'warn',
  'retry-added': 'warn',
  'tolerance-loosened': 'warn',
  'timeout-increased': 'off',
  'test-config-changed': 'warn',
  ...INTEGRITY_SEVERITIES,
  ...CLAIM_SEVERITIES,
  ...SCOPE_SEVERITIES,
  ...ORACLE_SEVERITIES,
  'gitignore-hides-tests': 'block',
  'export-attributes-changed': 'block',
  // Model-backed review (opt-in via `judge` in the config). Severities are enforced here, never by the model.
  'judge-test-weakened': 'warn',
  'judge-special-casing': 'warn',
  'judge-task-mismatch': 'warn',
  'judge-review-manipulation': 'warn',
  'judge-skipped': 'warn',
};

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  testGlobs: DEFAULT_TEST_GLOBS,
  testConfigGlobs: DEFAULT_TEST_CONFIG_GLOBS,
  ignoreGlobs: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.venv/**', '**/venv/**', '**/vendor/**', '**/__pycache__/**', '**/.gatekeep/**'],
  severities: DEFAULT_SEVERITIES,
  assertionDropTolerance: 0,
  protectedGlobs: DEFAULT_PROTECTED_GLOBS,
};

/** Files the agent must not touch: the gate's own configuration and the hook wiring. */
export const PROTECTED_FILES = ['gatekeep.config.json', '.claude/settings.json', '.claude/settings.local.json'];

export function isTestFile(p: string, cfg: RuleConfig): boolean {
  return !matchesAny(p, cfg.ignoreGlobs) && !matchesAny(p, TEST_FIXTURE_GLOBS) && matchesAny(p, cfg.testGlobs);
}
export function isProtectedFile(p: string): boolean {
  return PROTECTED_FILES.some((f) => p === f || p.endsWith('/' + f));
}
/** Which changed paths the rules need the contents of. */
export function needsContent(p: string, cfg: RuleConfig): boolean {
  if (matchesAny(p, cfg.ignoreGlobs) || matchesAny(p, LOCKFILE_GLOBS)) return false;
  return isTestFile(p, cfg) || matchesAny(p, cfg.testConfigGlobs) || isProtectedFile(p) || langFor(p) !== null || matchesAny(p, INTEGRITY_GLOBS) || matchesAny(p, SCOPE_GLOBS) || /(^|\/)\.gitignore$/.test(p);
}

export async function modelFor(p: string, source: string): Promise<TestFileModel | null> {
  const lang = langFor(p);
  if (lang === 'python') return extractPython(p, source);
  if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') return extractJS(p, source, lang);
  if (lang === 'go') return extractGo(p, source);
  if (lang === 'rust') return extractRust(p, source);
  if (lang === 'java') return extractJava(p, source);
  if (lang === 'ruby') return extractRuby(p, source);
  return null;
}

export interface AnalysisResult {
  findings: Finding[];
  examined: { path: string; status: string; testsBefore: number; testsAfter: number }[];
  changedSourceFiles: string[];
}

/** Which family a rule belongs to. Used to name the families that actually fired and to address the agent about them. */
export type Family = 'test integrity' | 'check integrity' | 'claims' | 'scope' | 'source fitted to the tests' | 'original tests' | 'model-backed review' | 'gate';

export function familyOf(rule: string): Family {
  if (rule.startsWith('judge-')) return 'model-backed review';
  if (rule === 'test-oracle-in-source') return 'source fitted to the tests';
  if (rule in INTEGRITY_SEVERITIES) return 'check integrity';
  if (rule in CLAIM_SEVERITIES) return 'claims';
  if (rule in SCOPE_SEVERITIES) return 'scope';
  if (['original-tests-fail', 'tests-failing', 'test-run-timeout', 'test-run-error'].includes(rule)) return 'original tests';
  if (['gate-config-changed', 'config-invalid', 'session-state-missing', 'state-tampered', 'index-flags-set', 'paths-hidden-from-snapshot'].includes(rule)) return 'gate';
  return 'test integrity';
}

export interface AnalyzeOptions {
  /** Does this repo path exist in the current tree? Used to tell first-party modules from packages. */
  exists?: (p: string) => boolean;
  /** True inside an agent session: protected-file edits are tampering. False for a human-driven `run` where config edits are legitimate. */
  sessionMode?: boolean;
  /** The task statement, for the out-of-scope check. */
  task?: string | null;
  /** Test files as they stood at session start. Unchanged ones are not in the diff, and the oracle rule needs them. */
  baseTestFiles?: Map<string, string>;
  /** True when no session baseline existed and the comparison fell back to HEAD, so "added" only means "not committed". */
  noBaseline?: boolean;
}

interface Examined { c: FileChange; before: TestFileModel | null; after: TestFileModel | null }

export async function analyze(changes: FileChange[], cfg: RuleConfig = DEFAULT_RULE_CONFIG, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const findings: Finding[] = [];
  const examined: AnalysisResult['examined'] = [];
  const sev = (rule: string): Severity => cfg.severities[rule] ?? DEFAULT_SEVERITIES[rule] ?? 'warn';
  const emit = (f: Omit<Finding, 'severity'>, override?: Severity) => {
    const s = override ?? sev(f.rule);
    if (s !== 'off') findings.push({ ...f, severity: s });
  };
  const exists = opts.exists ?? (() => false);
  const sessionMode = opts.sessionMode ?? true;

  // A rename *out of* a test path into an ignored directory must stay visible.
  const visible = changes.filter((c) => !matchesAny(c.path, cfg.ignoreGlobs) || (c.oldPath !== undefined && isTestFile(c.oldPath, cfg)));
  const changedSource = visible.filter((c) => c.status !== 'D' && !isTestFile(c.path, cfg) && !isProtectedFile(c.path) && langFor(c.path) !== null).map((c) => c.path);
  const changedSourceSet = new Set(changedSource);
  const sources = new Map<string, { before: string; after: string }>();
  for (const c of visible) if (changedSourceSet.has(c.path) && (c.before !== undefined || c.after !== undefined)) sources.set(c.path, { before: c.before ?? '', after: c.after ?? '' });

  // 1. Protected files and test configuration
  const conftests: FileChange[] = [];
  for (const c of visible) {
    if (isProtectedFile(c.path) || (c.oldPath && isProtectedFile(c.oldPath))) {
      // Installing gatekeep from inside a session leaves its own untracked config and hook settings. Against a HEAD
      // fallback those look "created", but a file with no baseline cannot have been changed during the session.
      const installArtifact = opts.noBaseline === true && c.status === 'A';
      if (sessionMode && !installArtifact) emit({ rule: 'gate-config-changed', file: c.path, message: `${c.status === 'D' ? 'Deleted' : c.status === 'A' ? 'Created' : 'Modified'} ${c.path}: the gate's configuration and hook wiring may not be changed by the agent` });
      continue;
    }
    if (matchesAny(c.path, cfg.testConfigGlobs) && !isTestFile(c.path, cfg)) {
      const relevant = configChangeIsRelevant(c);
      if (relevant) {
        const narrowed = configNarrowsCollection(c);
        if (narrowed) emit({ rule: 'test-config-narrowed', file: c.path, message: `Test collection narrowed: ${narrowed}` });
        else emit({ rule: 'test-config-changed', file: c.path, message: `Test configuration ${c.status === 'A' ? 'added' : 'changed'}: ${relevant}` });
      }
      if ((c.path.split('/').pop() ?? '') === 'conftest.py' && c.after !== undefined) conftests.push(c);
    }
  }
  // conftest.py fixtures that patch first-party code apply to every test: treat their new mocks like test-file mocks
  for (const c of conftests) {
    try {
      const before = c.before !== undefined ? await extractPython(c.oldPath ?? c.path, c.before) : null;
      const after = await extractPython(c.path, c.after!);
      for (const m of [...after.fileMocks, ...after.tests.flatMap((t) => t.mocks)]) {
        if (before && [...before.fileMocks, ...before.tests.flatMap((t) => t.mocks)].some((b) => b.target === m.target)) continue;
        mockFinding(m, c.path, undefined, true);
      }
    } catch { /* unparseable conftest: the config-changed finding already covers it */ }
  }

  // 2. Build models for every test file touched
  const files: Examined[] = [];
  for (const c of visible) {
    // Rust keeps unit tests inside source files: a .rs file with #[test] is a test file as well as a source file
    const inlineRust = langFor(c.path) === 'rust' && (hasInlineTests(c.before ?? '') || hasInlineTests(c.after ?? ''));
    const wasTest = (c.oldPath ? isTestFile(c.oldPath, cfg) : isTestFile(c.path, cfg)) || inlineRust;
    const isTest = isTestFile(c.path, cfg) || inlineRust;
    if (!isTest && !wasTest) continue;
    if (c.unreadable) {
      emit({ rule: 'test-file-unreadable', file: c.path, message: `Test file could not be analyzed (${c.unreadable === 'after' ? 'current version' : c.unreadable === 'before' ? 'previous version' : 'both versions'} too large or binary); treat as tampered until it is readable` });
      continue;
    }
    if (c.status === 'R' && wasTest && (!isTest || (isCollectedName(c.oldPath!) && !isCollectedName(c.path)))) {
      const n = countTestsQuick(c.before ?? '');
      if (n > 0) emit({ rule: 'test-file-moved-out', file: c.path, message: `Test file ${c.oldPath} (${n} tests) renamed to a path the test runner will not collect` });
      continue;
    }
    const lang = langFor(c.oldPath ?? c.path);
    if (lang === null) {
      if (c.status === 'D' && wasTest) {
        const n = countTestsQuick(c.before ?? '');
        emit({ rule: n > 0 ? 'test-file-deleted' : 'test-support-file-deleted', file: c.path, message: n > 0 ? `Test file deleted (${n} tests)` : 'File under a test directory deleted (no tests inside)' });
      }
      continue;
    }
    let before: TestFileModel | null, after: TestFileModel | null;
    try {
      before = c.before !== undefined && c.status !== 'A' ? await modelFor(c.oldPath ?? c.path, c.before) : null;
      after = c.after !== undefined && c.status !== 'D' ? await modelFor(c.path, c.after) : null;
    } catch (e) {
      if (e instanceof ParseTimeout) { emit({ rule: 'test-file-unreadable', file: c.path, message: `Test file could not be analyzed: ${e.message} (hostile or pathological input); treat as tampered until it is readable` }); continue; }
      throw e;
    }
    examined.push({ path: c.path, status: c.status, testsBefore: before?.tests.length ?? 0, testsAfter: after?.tests.length ?? 0 });
    if (before) dedupeNames(before.tests);
    if (after) dedupeNames(after.tests);
    files.push({ c, before, after });
  }

  // 3. Global pairing of disappeared and appeared tests (renames and moves, across files)
  interface Slot { file: Examined; t: TestCase }
  const disappeared: Slot[] = [], appeared: Slot[] = [];
  for (const f of files) {
    const bn = new Set((f.before?.tests ?? []).map((t) => t.name));
    const an = new Set((f.after?.tests ?? []).map((t) => t.name));
    for (const t of f.before?.tests ?? []) if (!an.has(t.name)) disappeared.push({ file: f, t });
    for (const t of f.after?.tests ?? []) if (!bn.has(t.name)) appeared.push({ file: f, t });
  }
  const pairedBefore = new Map<TestCase, TestCase>(); // after test -> before test
  const pairedAfter = new Set<TestCase>();
  const candidates: { d: Slot; a: Slot; score: number }[] = [];
  const gramCache = new Map<TestCase, Map<string, number>>();
  const tooMany = disappeared.length * appeared.length > 250000;
  for (const d of disappeared) for (const a of appeared) {
    if (tooMany && d.file !== a.file) continue; // keep the pairing quadratic only within a file on huge refactors
    const score = pairScore(d.t, a.t, d.file === a.file, gramCache);
    if (score > 0) candidates.push({ d, a, score });
  }
  candidates.sort((x, y) => y.score - x.score);
  const usedD = new Set<TestCase>();
  for (const cnd of candidates) {
    if (usedD.has(cnd.d.t) || pairedAfter.has(cnd.a.t)) continue;
    usedD.add(cnd.d.t); pairedAfter.add(cnd.a.t); pairedBefore.set(cnd.a.t, cnd.d.t);
  }

  // 4. File-level findings and per-test comparisons
  for (const f of files) {
    const { c, before, after } = f;
    const path = c.path;
    if (!after) {
      // deleted test file: report only the tests that did not move elsewhere
      const gone = (before?.tests ?? []).filter((t) => !usedD.has(t));
      if (!before || before.tests.length === 0) emit({ rule: 'test-support-file-deleted', file: path, message: 'File under a test directory deleted (no tests inside)' });
      else if (gone.length === before.tests.length) emit({ rule: 'test-file-deleted', file: path, message: `Test file deleted (${before.tests.length} tests)` });
      else for (const t of gone) emit({ rule: 'test-deleted', file: path, line: t.line, test: t.name, message: `Test "${t.name}" removed with its file (had ${t.assertions.length} assertion(s)); the other tests moved elsewhere`, before: summarize(t) || t.name });
      continue;
    }
    if (after.parseErrors > 0) {
      // A file that parsed cleanly and now does not had its syntax broken during the session, and the break stands
      // down every count-based rule below (`countsReliable`). That is a way to disable the gate, not a grammar gap,
      // so it blocks. Errors that were already there are a limitation of our grammar build and stay at warn.
      const introduced = (before?.parseErrors ?? 0) === 0;
      emit({
        rule: 'test-file-unparseable', file: path,
        message: introduced
          ? `${after.parseErrors} syntax error(s) introduced in this test file; it parsed cleanly at session start, and the count-based rules cannot run on a file that does not parse`
          : `${after.parseErrors} syntax error(s) in test file after change; some rules could not run`,
      }, introduced && sev('test-file-unparseable') !== 'off' ? 'block' : undefined);
    }
    if (after.fileSkip && !before?.fileSkip) emit({ rule: 'file-skipped', file: path, line: after.fileSkip.line, message: `Whole test module marked skip/xfail: ${after.fileSkip.marker}` });
    if (after.fileRetry && !before?.fileRetry) emit({ rule: 'retry-added', file: path, line: after.fileRetry.line, message: `File-level retry added: ${after.fileRetry.text}` });
    for (const s of after.shadowed) {
      if (before?.shadowed.some((b) => b.name === s.name)) continue;
      if (/^(expect|assert|should)$|^(global|globalThis|window)\./.test(s.name)) emit({ rule: 'assertion-shadowed', file: path, line: s.line, message: `"${s.name}" is redefined locally in the test file; assertions through it prove nothing` });
      else emit({ rule: 'assertion-helper-noop', file: path, line: s.line, message: `Helper "${s.name}" is named like an assertion but contains none; calls to it are not counted as assertions` });
    }
    for (const m of after.fileMocks) {
      if (before?.fileMocks.some((b) => b.target === m.target)) continue;
      mockFinding(m, path, undefined);
    }

    const beforeByName = new Map((before?.tests ?? []).map((t) => [t.name, t] as const));
    const newDataDriven = after.tests.filter((t) => t.parametrized && (!beforeByName.has(t.name) || !beforeByName.get(t.name)!.parametrized) && t.assertions.some((a) => a.strength === 'strong' && a.reachable));

    for (const t of before?.tests ?? []) {
      if (beforeByName.has(t.name) && after.tests.some((x) => x.name === t.name)) continue;
      if (usedD.has(t)) continue;
      const msg = `Test "${t.name}" removed (had ${t.assertions.length} assertion(s))`;
      // Consolidated into a new data-driven test whose table carries this test's literals?
      const consolidated = newDataDriven.some((p) => literalContainment(t, p) >= 0.6);
      if (consolidated) emit({ rule: 'test-deleted', file: path, line: t.line, test: t.name, message: `${msg}; a new data-driven test appeared in this file and total assertions did not drop, so this may be a consolidation`, before: summarize(t) || t.name }, 'warn');
      else emit({ rule: 'test-deleted', file: path, line: t.line, test: t.name, message: msg, before: summarize(t) || t.name });
    }

    for (const at of after.tests) {
      const bt = beforeByName.get(at.name) ?? pairedBefore.get(at) ?? null;
      if (at.only && !(bt?.only)) emit({ rule: 'test-focused', file: path, line: at.only.line, test: at.name, message: `Test focused with ${at.only.marker}; all other tests in the run are silently skipped` });
      for (const m of at.mocks) {
        if (bt?.mocks.some((b) => b.target === m.target)) continue;
        mockFinding(m, path, at.name);
      }
      if (!bt) {
        if (reachableCount(at) === 0 && !at.skip && !at.vacuous) emit({ rule: 'assertion-free-test', file: path, line: at.line, test: at.name, message: `New test "${at.name}" contains no assertions that can execute` });
        if (at.vacuous) emit({ rule: 'test-vacuous', file: path, line: at.line, test: at.name, message: `New test "${at.name}" is data-driven over an empty data set: it runs zero cases` }, 'warn');
        if (at.swallowed.length > 0) emit({ rule: 'assertion-swallowed', file: path, line: at.swallowed[0]!.line, test: at.name, message: `${at.swallowed.length} assertion(s) in new test are inside a try block whose handler neither asserts nor re-raises` });
        continue;
      }
      // Existing (or renamed) test: compare against its previous version
      const countsReliable = (before?.parseErrors ?? 0) === 0 && after.parseErrors === 0;
      if (at.skip && !bt.skip) {
        if (at.skip.conditional) emit({ rule: 'test-conditionally-skipped', file: path, line: at.skip.line, test: at.name, message: `Existing test "${at.name}" now skips under a condition: ${at.skip.marker}` });
        else emit({ rule: 'test-skipped', file: path, line: at.skip.line, test: at.name, message: `Existing test "${at.name}" marked skipped: ${at.skip.marker}` });
      }
      if (at.vacuous && !bt.vacuous) emit({ rule: 'test-vacuous', file: path, line: at.line, test: at.name, message: `"${at.name}" is now data-driven over an empty data set: it runs zero cases` });
      if (at.earlyExits > bt.earlyExits) emit({ rule: 'early-exit-added', file: path, line: at.line, test: at.name, message: `"${at.name}" gained ${at.earlyExits - bt.earlyExits} return statement(s) before its first assertion; the assertions may never run` });
      const deadNow = at.assertions.filter((a) => !a.reachable && bt.assertions.some((b) => b.reachable && b.text === a.text));
      if (deadNow.length > 0) emit({ rule: 'assertion-unreachable', file: path, line: deadNow[0]!.line, test: at.name, message: `${deadNow.length} assertion(s) in "${at.name}" can no longer execute (dead branch, after an unconditional exit, in a function that is never called, or an unawaited promise assertion that the test never waits for)`, after: deadNow.map((a) => a.text).join(' | ') });
      const nb = reachableCount(bt), na = reachableCount(at);
      if (!countsReliable) continue; // syntax errors make assertion counts meaningless; test-file-unparseable already warned
      if (nb > 0 && na === 0) emit({ rule: 'assertions-removed', file: path, line: at.line, test: at.name, message: `All ${nb} assertion(s) removed from "${at.name}"`, before: summarize(bt), after: summarize(at) });
      else if (na < nb && (nb - na) / nb > cfg.assertionDropTolerance) emit({ rule: 'assertions-reduced', file: path, line: at.line, test: at.name, message: `Assertions in "${at.name}" reduced from ${nb} to ${na}`, before: summarize(bt), after: summarize(at) });
      // Per-assertion weakening: a specific check that disappeared while a weak check on the same subject appeared.
      const afterTexts = new Set(at.assertions.map((a) => a.text));
      const beforeTexts = new Set(bt.assertions.map((a) => a.text));
      const removedStrong = bt.assertions.filter((a) => a.strength === 'strong' && a.reachable && !afterTexts.has(a.text));
      const addedWeak = at.assertions.filter((a) => a.strength === 'weak' && a.reachable && !beforeTexts.has(a.text));
      if (removedStrong.length > 0 && addedWeak.length > 0) {
        const sameSubject = (x: string, y: string) => x === y || x.startsWith(y + '.') || y.startsWith(x + '.') || x.startsWith(y + '[') || y.startsWith(x + '[');
        const bySubject = addedWeak.filter((w) => w.subject && removedStrong.some((s) => sameSubject(s.subject, w.subject)));
        const strongBefore = bt.assertions.filter((a) => a.strength === 'strong' && a.reachable).length;
        const strongAfter = at.assertions.filter((a) => a.strength === 'strong' && a.reachable).length;
        const flagged = bySubject.length > 0 ? bySubject : (strongAfter < strongBefore ? addedWeak : []);
        if (flagged.length > 0) emit({ rule: 'assertion-weakened', file: path, line: flagged[0]!.line, test: at.name, message: `"${at.name}": ${Math.min(removedStrong.length, flagged.length)} specific assertion(s) replaced by truthiness/existence/broad checks`, before: removedStrong.map((a) => a.text).join(' | '), after: flagged.map((a) => a.text).join(' | ') });
      }
      if (at.swallowed.length > bt.swallowed.length) emit({ rule: 'assertion-swallowed', file: path, line: at.swallowed[0]!.line, test: at.name, message: `${at.swallowed.length - bt.swallowed.length} assertion(s) in "${at.name}" moved inside a try block whose handler neither asserts nor re-raises` });
      if (at.retry && !bt.retry) emit({ rule: 'retry-added', file: path, line: at.retry.line, test: at.name, message: `Retry added to "${at.name}": ${at.retry.text}` });
      for (const ta of at.tolerances) {
        const tb = bt.tolerances.find((x) => x.key === ta.key && x.kind === ta.kind) ?? (bt.tolerances.length === 1 && at.tolerances.length === 1 ? bt.tolerances[0] : undefined);
        if (tb && tb.kind === ta.kind && ta.looseness > tb.looseness * 1.0001) emit({ rule: 'tolerance-loosened', file: path, line: ta.line, test: at.name, message: `Numeric tolerance loosened from ${tb.looseness} to ${ta.looseness}`, before: tb.text, after: ta.text });
      }
      if (at.timeout && bt.timeout && at.timeout.ms > bt.timeout.ms) emit({ rule: 'timeout-increased', file: path, line: at.timeout.line, test: at.name, message: `Timeout increased from ${bt.timeout.ms} to ${at.timeout.ms} ms` });
    }
  }
  findings.push(...integrityFindings(visible, cfg.severities, (p) => isTestFile(p, cfg)));
  findings.push(...scopeFindings(visible, cfg.severities, { protectedGlobs: cfg.protectedGlobs ?? DEFAULT_PROTECTED_GLOBS, task: opts.task, isTest: (p) => isTestFile(p, cfg) }));
  findings.push(...oracleFindings(visible, cfg.severities, { isTest: (p) => isTestFile(p, cfg), baseTestFiles: opts.baseTestFiles }));
  // .gitignore patterns that would hide test files from the snapshot (git add -A honors them)
  for (const c of visible) {
    // `git archive` honours `export-ignore`, and the original-tests check exports the tree with it. A path marked
    // export-ignore during the session vanishes from the tree those tests run against.
    if (/(^|\/)\.gitattributes$/.test(c.path) && c.after !== undefined) {
      const was = new Set((c.before ?? '').split('\n').map((l) => l.trim()));
      const added = c.after.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !was.has(l) && /\bexport-ignore\b/.test(l));
      if (added.length > 0 && sev('export-attributes-changed') !== 'off') findings.push({ rule: 'export-attributes-changed', severity: sev('export-attributes-changed'), file: c.path, message: `.gitattributes now marks paths export-ignore, which removes them from the tree the original tests are run against: ${added.slice(0, 3).join(', ')}` });
    }
    if (!/(^|\/)\.gitignore$/.test(c.path) || c.after === undefined) continue;
    const before = new Set((c.before ?? '').split('\n').map((l) => l.trim()));
    const hiding = c.after.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !before.has(l) && /(^|\/)(tests?|__tests__|spec|specs)\/?(\*\*)?$|test_\*|_test\.|\.(test|spec)\.|\*\.py$|\*\.(ts|js)$|^\*$/.test(l));
    if (hiding.length > 0 && sev('gitignore-hides-tests') !== 'off') findings.push({ rule: 'gitignore-hides-tests', severity: sev('gitignore-hides-tests'), file: c.path, message: `.gitignore now hides test paths from the snapshot: ${hiding.slice(0, 3).join(', ')}` });
  }
  return { findings, examined, changedSourceFiles: changedSource };

  function mockFinding(m: Mock, testPath: string, testName: string | undefined, fromConftest = false): void {
    const hit = hitsChanged(m.target, testPath, changedSource);
    const base = { file: testPath, line: m.line, test: testName, after: m.text };
    if (hit) {
      if (m.literal) { emit({ ...base, rule: 'constant-override-on-changed-module', message: `${m.text} overrides a constant in ${hit}, which was also changed in this session` }); return; }
      const sym = m.wholeModule ? '' : mockedSymbol(m.target);
      const src = sources.get(hit);
      const related = m.wholeModule || !src || sym === '' || symbolTouched(sym, src.before, src.after, langFor(hit) === 'python' || langFor(hit) === 'ruby');
      if (related) emit({ ...base, rule: 'mock-on-changed-module', message: `New mock ${m.text} targets ${hit}, which was also changed in this session${sym ? ` (the change touches "${sym}")` : ''}` });
      else emit({ ...base, rule: 'mock-unrelated-to-change', message: `New mock ${m.text} targets ${hit}, which was changed in this session, but the change does not touch "${sym}"` });
      return;
    }
    // Mocking the module this file is testing, without editing it: the honest path is to fix the code; stubbing it is the tell.
    if (langFor(testPath) === 'go') {
      // an unqualified target in a _test.go file is a symbol of the package under test
      if (!m.target.includes('.')) emit({ ...base, rule: 'mock-on-module-under-test', message: `New patch ${m.text} replaces ${m.target} from the package this file tests` });
      return;
    }
    const cands = langFor(testPath) === 'python' ? pythonCandidatePaths(m.target) : langFor(testPath) === 'ruby' ? rubyCandidatePaths(m.target) : langFor(testPath) === 'java' ? javaCandidatePaths(m.target, changes) : jsCandidatePaths(m.target, testPath);
    const existing = cands.find((p) => exists(p));
    if (!existing || isTestFile(existing, cfg)) return;
    if (fromConftest) emit({ ...base, rule: 'mock-on-source-module', message: `New mock ${m.text} in ${testPath} replaces first-party module ${existing} for every test` });
    else if (isModuleUnderTest(existing, testPath)) emit({ ...base, rule: 'mock-on-module-under-test', message: `New mock ${m.text} replaces ${existing}, the module this file tests, instead of exercising it` });
  }
}

/** Share of the removed test's distinctive tokens (literals, else identifiers) that appear in the new test's body or data table. */
function literalContainment(removed: TestCase, into: TestCase): number {
  const hay = new Set(tokens(into.body + '\n' + into.data + '\n' + into.data.replace(/["'`]/g, ' ')));
  const all = tokens(removed.body);
  const noise = new Set(['assert', 'self', 'expect', 'it', 'test', 'true', 'false', 'True', 'False', 'None', 'null', 'undefined', 'const', 'let', 'var', 'return', 'await', 'async', 'def', 'in', 'for', 'is', 'not', 'and', 'or', 'toBe', 'toEqual', 'assertEqual']);
  let lits = all.filter((x) => /^(\d|["'`])/.test(x));
  if (lits.length === 0) lits = all.filter((x) => !noise.has(x) && x.length > 1);
  const uniq = [...new Set(lits)];
  if (uniq.length === 0) return 0;
  return uniq.filter((x) => hay.has(x)).length / uniq.length;
}

function reachableCount(t: TestCase): number {
  return t.assertions.filter((a) => a.reachable).length;
}

/** Give duplicate test names within a file a stable ordinal suffix so they can be paired. */
function dedupeNames(tests: TestCase[]): void {
  const seen = new Map<string, number>();
  for (const t of tests) {
    const n = seen.get(t.name) ?? 0;
    seen.set(t.name, n + 1);
    if (n > 0) t.name = `${t.name} #${n + 1}`;
  }
}

/** Sørensen–Dice over character bigrams (names). */
function dice(a: string, b: string): number {
  const grams = (s: string) => { const m = new Map<string, number>(); const t = s.toLowerCase(); for (let i = 0; i + 1 < t.length; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  return diceMaps(grams(a), grams(b));
}

function bodyGrams(s: string): Map<string, number> {
  const t = tokens(s); const m = new Map<string, number>();
  for (let i = 0; i + 1 < t.length; i++) { const g = `${t[i]} ${t[i + 1]}`; m.set(g, (m.get(g) ?? 0) + 1); }
  if (t.length === 1) m.set(t[0]!, 1);
  return m;
}

/** Sørensen–Dice over token bigrams (bodies), with per-test memoized grams. */
function tokenSim(a: TestCase, b: TestCase, cache: Map<TestCase, Map<string, number>>): number {
  if (!a.body || !b.body) return 0;
  if (a.body === b.body) return 1;
  let ga = cache.get(a); if (!ga) { ga = bodyGrams(a.body); cache.set(a, ga); }
  let gb = cache.get(b); if (!gb) { gb = bodyGrams(b.body); cache.set(b, gb); }
  return diceMaps(ga, gb);
}

function diceMaps(A: Map<string, number>, B: Map<string, number>): number {
  let inter = 0, na = 0, nb = 0;
  for (const [g, n] of A) { na += n; inter += Math.min(n, B.get(g) ?? 0); }
  for (const n of B.values()) nb += n;
  return na + nb === 0 ? 0 : (2 * inter) / (na + nb);
}

function shortName(n: string): string { return n.split(' > ').pop()!.split('.').pop()!.replace(/^test_?/i, '').replace(/_test$/i, '').toLowerCase(); }

/** How likely `a` is the same test as `d` under a new name/location. 0 = no. */
function pairScore(d: TestCase, a: TestCase, sameFile: boolean, cache: Map<TestCase, Map<string, number>> = new Map()): number {
  const body = tokenSim(d, a, cache);
  const name = dice(shortName(d.name), shortName(a.name));
  const dn = shortName(d.name), an = shortName(a.name);
  const contained = dn.length >= 3 && an.length >= 3 && (dn.includes(an) || an.includes(dn));
  const dAsserts = d.assertions.map((x) => x.text), aAsserts = new Set(a.assertions.map((x) => x.text));
  const assertSuperset = dAsserts.length > 0 && dAsserts.every((x) => aAsserts.has(x));
  const sharedAssert = dAsserts.some((x) => aAsserts.has(x));
  if (body >= 0.9) return 1 + body;
  if (assertSuperset && body >= 0.3) return 0.9 + body / 10;
  if (!sameFile) {
    // Across files the body shape alone is not enough: structurally similar tests of different things score high.
    if (sharedAssert && body >= 0.5) return body;
    if (name >= 0.6 && body >= 0.5) return (name + body) / 2;
    return 0;
  }
  if (body >= 0.7) return body;
  if (name >= 0.6 && body >= 0.35) return (name + body) / 2;
  if (contained && body >= 0.25) return 0.5 + body / 10;
  if (body >= 0.45) return 0.4 + body / 10; // rewritten in place under a new name
  return 0;
}

function summarize(t: TestCase): string {
  return t.assertions.map((a) => a.text).join(' | ').slice(0, 300);
}

function hitsChanged(target: string, testFile: string, changed: string[]): string | null {
  const lang = langFor(testFile);
  if (lang === 'java') {
    const cls = target.replace(/#.*$/, '').split('.').pop() ?? '';
    return changed.find((f) => f.endsWith('.java') && (f.split('/').pop() ?? '') === `${cls}.java`) ?? null;
  }
  if (lang === 'ruby') {
    // Calc / Billing::Invoice -> calc.rb / billing/invoice.rb
    const cls = target.replace(/#.*$/, '').replace(/^"|"$/g, '');
    const snake = cls.split('::').map((seg) => seg.replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase()).join('/');
    return changed.find((f) => f.endsWith('.rb') && (f === `${snake}.rb` || f.endsWith(`/${snake}.rb`) || (f.split('/').pop() ?? '') === `${snake.split('/').pop()}.rb`)) ?? null;
  }
  for (const f of changed) {
    if (lang === 'python' && langFor(f) === 'python' && pythonTargetHits(target, f)) return f;
    if (lang !== 'python' && langFor(f) !== 'python' && jsTargetHits(target, testFile, f)) return f;
  }
  return null;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Ruby constant -> file candidates: Calc -> lib/calc.rb, app/models/calc.rb ...; Billing::Invoice -> lib/billing/invoice.rb */
function rubyCandidatePaths(target: string): string[] {
  const cls = target.replace(/#.*$/, '').replace(/^"|"$/g, '');
  if (!/^[A-Z]/.test(cls)) return [];
  const snake = cls.split('::').map((seg) => seg.replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase()).join('/');
  return [`lib/${snake}.rb`, `${snake}.rb`, `app/models/${snake}.rb`, `app/services/${snake}.rb`, `app/lib/${snake}.rb`, `app/controllers/${snake}.rb`, `app/jobs/${snake}.rb`, `src/${snake}.rb`];
}
/** Java class -> the changed or existing file named after it (any package). */
function javaCandidatePaths(target: string, changes: FileChange[]): string[] {
  const cls = target.replace(/#.*$/, '').split('.').pop() ?? '';
  return changes.map((c) => c.path).filter((f) => (f.split('/').pop() ?? '') === `${cls}.java`);
}

/** tests/test_auth.py tests app/auth.py; auth.test.ts tests src/auth.ts. */
function isModuleUnderTest(sourcePath: string, testPath: string): boolean {
  const base = (p: string) => (p.split('/').pop() ?? '').replace(/\.(py|pyi|js|jsx|ts|tsx|mjs|cjs|mts|cts|go|rs|java|kt|rb)$/, '');
  const t = base(testPath).replace(/^test_/, '').replace(/_test$/, '').replace(/_spec$/, '').replace(/\.(test|spec)$/, '').replace(/(Test|Tests|IT)$/, '').replace(/^Test(?=[A-Z])/, '').toLowerCase();
  if (sourcePath.endsWith('.go') && testPath.endsWith('_test.go')) return sourcePath.replace(/\/[^/]+$/, '') === testPath.replace(/\/[^/]+$/, '') && base(sourcePath).toLowerCase() === t;
  const s = base(sourcePath).toLowerCase();
  return t !== '' && (t === s || (s === 'index' && (sourcePath.split('/').slice(-2, -1)[0] ?? '').toLowerCase() === t));
}

/** Source text of `sym`'s definition (function/class/const) or '' when not found. Indentation-based for Python, brace-based for JS. */
function definitionOf(src: string, sym: string, isPython: boolean): string {
  const lines = src.split('\n');
  const re = new RegExp(`^(\\s*)(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:def|function\\*?|class|const|let|var|func|fn|pub\\s+fn|pub(?:\\(crate\\))?\\s+fn)\\s+(?:self\\.)?${escapeRe(sym)}\\b|^(\\s*)${escapeRe(sym)}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function|\\w)`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return '';
  const indent = (lines[start]!.match(/^\s*/)?.[0].length) ?? 0;
  const out = [lines[start]!];
  let depth = 0;
  const braces = (l: string) => { for (const ch of l) { if (ch === '{') depth++; else if (ch === '}') depth--; } };
  // JS: a multi-line signature may not open its brace on the first line; keep reading until it does
  let opened = false;
  braces(lines[start]!); opened = /\{/.test(lines[start]!);
  if (!isPython && opened && depth <= 0) return out[0]!;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (isPython) {
      const ind = l.match(/^\s*/)?.[0].length ?? 0;
      if (l.trim() !== '' && ind <= indent && !/^\s*[)\]}]/.test(l)) break;
      out.push(l);
    } else {
      out.push(l);
      braces(l);
      if (/\{/.test(l)) opened = true;
      if (opened && depth <= 0) break;
      if (!opened && /;\s*$/.test(l)) break; // declaration without a body
    }
  }
  return out.join('\n');
}

/** Did the change touch the definition of `sym`? Falls back to "symbol named in a changed line" when no definition is found. */
function symbolTouched(sym: string, before: string, after: string, isPython: boolean): boolean {
  const db = definitionOf(before, sym, isPython), da = definitionOf(after, sym, isPython);
  if (db || da) return db !== da;
  const re = new RegExp(`\\b${escapeRe(sym)}\\b`);
  return [...changedLines(before, after)].some((l) => re.test(l));
}

function countTestsQuick(src: string): number {
  return (src.match(/^\s*(async\s+)?def\s+test|^\s*(it|test)\s*\(|^\s*(it|test)\.\w+\s*\(|^\s*func\s+Test[A-Z_]|#\[\s*(\w+::)*test\b|@(\w+\.)*(Test|ParameterizedTest|RepeatedTest)\b|^\s*(it|specify)\s+['"]|^\s*def\s+test_/gm) ?? []).length;
}

/** Lines present in only one of the two versions (order-insensitive). */
function changedLines(b: string, a: string): Set<string> {
  const B = new Set(b.split('\n').map((l) => l.trim()).filter(Boolean));
  const A = new Set(a.split('\n').map((l) => l.trim()).filter(Boolean));
  const out = new Set<string>();
  for (const l of A) if (!B.has(l)) out.add(l);
  for (const l of B) if (!A.has(l)) out.add(l);
  return out;
}

const CONFIG_KEYS = /(^|[{,;]\s*)\s*['"]?(testpaths|addopts|markers|filterwarnings|xfail_strict|norecursedirs|python_files|python_functions|python_classes|fail_under|testMatch|testPathIgnorePatterns|testRegex|roots|coverageThreshold|modulePathIgnorePatterns|testTimeout|include|exclude|skip_covered|collect_ignore|collect_ignore_glob|reruns|retries|retry|timeout|bail|passWithNoTests|forceExit|only|spec|ignore|require|exit|allowOnly|allow-only)\b\s*[=:]/i;
const CONFIG_FLAGS = /(^|\s|["'])(--ignore|--ignore-glob|--deselect|-k|-m|--co|--maxfail|--reruns|--timeout|--testPathIgnorePatterns|--testNamePattern|--testPathPattern|-t|--grep|--invert|--fgrep|--bail|--exit|--passWithNoTests|--onlyChanged|--changedSince)\b/;
const CONFIG_KEYWORDS = { test: (l: string) => CONFIG_KEYS.test(l) || CONFIG_FLAGS.test(l) };

const NARROWING = /(^|[{,;]\s*)\s*['"]?(testpaths|testPathIgnorePatterns|modulePathIgnorePatterns|collect_ignore|collect_ignore_glob|python_files|python_functions|python_classes|testMatch|testRegex|exclude|ignore)\b\s*[=:]|(^|\s|["'])(--ignore|--ignore-glob|--deselect|-k|--testPathIgnorePatterns|--testNamePattern|--testPathPattern|-t|--grep|--invert|--fgrep)(\s|=|["']|$)/;

/** A config edit that removes tests from the run: new or changed deselect/ignore/path settings. */
function configNarrowsCollection(c: FileChange): string | null {
  const b = c.before ?? '', a = c.after ?? '';
  const base = c.path.split('/').pop() ?? '';
  if (base === 'package.json') {
    try {
      const pb = JSON.parse(b || '{}'), pa = JSON.parse(a || '{}');
      const t = String(pa.scripts?.test ?? '');
      if (t !== String(pb.scripts?.test ?? '') && NARROWING.test(' ' + t)) return `scripts.test: ${t}`;
      for (const k of ['testPathIgnorePatterns', 'modulePathIgnorePatterns', 'testMatch', 'testRegex', 'roots']) if (JSON.stringify(pa.jest?.[k]) !== JSON.stringify(pb.jest?.[k]) && pa.jest?.[k] !== undefined) return `jest.${k}`;
      return null;
    } catch { return null; }
  }
  const added = a.split('\n').map((l) => l.trim()).filter((l) => l && !b.split('\n').map((x) => x.trim()).includes(l));
  const hit = added.find((l) => NARROWING.test(l) && !/^\s*#/.test(l));
  return hit ? hit.slice(0, 100) : null;
}

/** For config files, only report when the change touches test/coverage settings. Looks at removed lines too. */
function configChangeIsRelevant(c: FileChange): string | null {
  const b = c.before ?? '', a = c.after ?? '';
  if (b === a) return null;
  const base = c.path.split('/').pop() ?? '';
  if (base === 'package.json') {
    try {
      const pb = JSON.parse(b || '{}'), pa = JSON.parse(a || '{}');
      const keys = ['jest', 'vitest', 'mocha', 'ava', 'nyc', 'c8'];
      for (const k of keys) if (JSON.stringify(pb[k]) !== JSON.stringify(pa[k])) return `"${k}" section`;
      if (JSON.stringify(pb.scripts?.test) !== JSON.stringify(pa.scripts?.test)) return `scripts.test (${pb.scripts?.test ?? 'none'} -> ${pa.scripts?.test ?? 'none'})`;
      return null;
    } catch { return null; }
  }
  if (base === 'pyproject.toml' || base === 'setup.cfg') {
    const sect = (s: string) => (s.match(/\[(tool[.:])?(pytest|coverage)[^\]]*\][\s\S]*?(?=\n\[|$)/g) ?? []).join('\n');
    return sect(b) !== sect(a) ? 'pytest/coverage section' : null;
  }
  const diff = [...changedLines(b, a)];
  if (base === 'conftest.py') {
    const hit = diff.find((l) => /^(collect_ignore|collect_ignore_glob|pytestmark)\s*=|^def pytest_(collection_modifyitems|ignore_collect|configure|runtest_setup)\b|\.setattr\(|\bpatch\(|monkeypatch/.test(l));
    return hit ? hit.slice(0, 100) : null;
  }
  const hit = diff.find((l) => CONFIG_KEYWORDS.test(l));
  return hit ? hit.trim().slice(0, 100) : null;
}
