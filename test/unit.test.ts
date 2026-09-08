import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.js';
import { analyze } from '../src/rules.js';
import { installClaudeCode, uninstallClaudeCode, GATEKEEP_HOOK_RE } from '../src/install.js';
import { jsTargetHits, jsSpecifierStem, pythonTargetHits } from '../src/lang.js';
import { formatReport, decide, type Verdict } from '../src/verdict.js';
import { splicePackageJson, testRunFindings } from '../src/testrun.js';

test('parseConfig never throws and reports problems', () => {
  assert.equal(parseConfig(null).problems.length, 0);
  const bad = parseConfig('nope');
  assert.equal(bad.cfg.maxBlocks, 3);
  assert.match(bad.problems[0]!, /invalid JSON/);
  const p = parseConfig('{"rules": {"assertions_removed": "off", "test-deleted": "maybe"}, "bogus": 1, "maxBlocks": -1}');
  assert.deepEqual(p.problems.map((x) => x.split(' ')[0]), ['"maxBlocks"', 'unknown', 'rule', 'unknown']);
  assert.equal(p.cfg.rules.severities['test-deleted'], 'block');
  const ok = parseConfig('{"rules": {"test-deleted": "warn"}, "strict": true}');
  assert.equal(ok.problems.length, 0);
  assert.equal(ok.cfg.rules.severities['test-deleted'], 'warn');
  assert.equal(ok.cfg.strict, true);
});

test('unreadable test files block and a file whose tests all vanish is never a pass', async () => {
  const r = await analyze([{ path: 'tests/test_a.py', status: 'M', unreadable: 'after' }]);
  assert.equal(r.findings[0]?.rule, 'test-file-unreadable');
  assert.equal(r.findings[0]?.severity, 'block');
  const r2 = await analyze([{ path: 'tests/test_a.py', status: 'M', before: 'def test_a():\n    assert 1 == 2\n', after: '# nothing\n' }]);
  assert.ok(r2.findings.some((f) => f.rule === 'test-deleted' && f.severity === 'block'));
});

test('protected files are blocked even when the agent tries to disable the rule', async () => {
  const r = await analyze([{ path: 'gatekeep.config.json', status: 'M', before: '{}', after: '{"rules":{}}' }], { ...(await import('../src/rules.js')).DEFAULT_RULE_CONFIG, severities: { 'gate-config-changed': 'off' } });
  // severities can turn it off only via the *snapshot* config; the rule itself honors the config it is given
  assert.equal(r.findings.length, 0);
  const r2 = await analyze([{ path: '.claude/settings.json', status: 'D', before: '{}' }]);
  assert.equal(r2.findings[0]?.rule, 'gate-config-changed');
});

test('JS target resolution ignores packages, globals and unresolved identifiers', () => {
  assert.equal(jsSpecifierStem('axios', 'tests/a.test.ts'), null);
  assert.equal(jsSpecifierStem('@scope/pkg', 'tests/a.test.ts'), null);
  assert.equal(jsSpecifierStem('node:fs', 'tests/a.test.ts'), null);
  assert.deepEqual(jsSpecifierStem('../src/auth', 'tests/a.test.ts'), { stem: 'src/auth', kind: 'relative' });
  assert.deepEqual(jsSpecifierStem('@/lib/auth', 'tests/a.test.ts'), { stem: 'lib/auth', kind: 'alias' });
  assert.equal(jsTargetHits('axios', 'tests/a.test.ts', 'src/lib/axios.ts'), false);
  assert.equal(jsTargetHits('global:Date.now', 'tests/a.test.ts', 'src/date.ts'), false);
  assert.equal(jsTargetHits('ident:auth.verify', 'tests/a.test.ts', 'src/auth.ts'), false);
  assert.equal(jsTargetHits('../src/auth#verify', 'tests/a.test.ts', 'src/auth.ts'), true);
  assert.equal(jsTargetHits('../src/auth', 'tests/a.test.ts', 'src/auth/index.ts'), true);
  assert.equal(pythonTargetHits('app.auth.verify', 'app/auth.py'), true);
  assert.equal(pythonTargetHits('app.api.requests.get', 'app/api.py'), false);
});

test('installer is idempotent, repairs duplicates, refuses malformed settings, and uninstalls', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-inst-'));
  const file = path.join(dir, '.claude', 'settings.local.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [
    { hooks: [{ type: 'command', command: 'node "/old/cli.js" hook stop --harness claude-code' }, { type: 'command', command: 'node "/old/cli.js" hook stop --harness claude-code' }] },
    { hooks: [{ type: 'command', command: 'echo other' }] },
  ] } }));
  const r1 = await installClaudeCode('project-local', dir);
  const s1 = JSON.parse(await fs.readFile(file, 'utf8')) as { permissions: unknown; hooks: Record<string, { hooks: { command: string }[] }[]> };
  assert.deepEqual(r1.added.sort(), ['SessionStart', 'UserPromptSubmit']);
  assert.deepEqual(r1.updated, ['Stop']);
  assert.ok(s1.permissions, 'unrelated settings preserved');
  const stopCmds = s1.hooks.Stop!.flatMap((e) => e.hooks.map((h) => h.command));
  assert.equal(stopCmds.filter((c) => GATEKEEP_HOOK_RE.test(c)).length, 1, 'duplicate collapsed');
  assert.ok(stopCmds.includes('echo other'), 'foreign hook preserved');
  const r2 = await installClaudeCode('project-local', dir);
  assert.deepEqual([r2.added, r2.updated], [[], []]);
  const u = await uninstallClaudeCode('project-local', dir);
  assert.equal(u.removed, 3);
  const s2 = JSON.parse(await fs.readFile(file, 'utf8')) as { hooks: Record<string, unknown[]> };
  assert.equal(s2.hooks.Stop!.length, 1);
  await fs.writeFile(file, '{"oops": ,}');
  await assert.rejects(installClaudeCode('project-local', dir), /not valid JSON/);
  assert.equal(await fs.readFile(file, 'utf8'), '{"oops": ,}', 'malformed file untouched');
});

test('report caps the listing and counts by decision', () => {
  const findings = Array.from({ length: 60 }, (_, i) => ({ rule: 'test-deleted', severity: 'block' as const, file: `t${i}.py`, message: 'x' }));
  const v: Verdict = { schema: 'gatekeep.verdict.v1', createdAt: 'now', sessionId: null, harness: null, baseTree: 'a', currentTree: 'b', task: null, decision: decide(findings, false), checks: { testIntegrity: { status: 'fail', findings, examined: [], changedSourceFiles: [] } }, blockCount: 0, durationMs: 0 };
  const text = formatReport(v, { forAgent: true });
  assert.match(text, /and 20 more: test-deleted ×20/);
  assert.ok(text.length < 8000);
  const warnOnly = [{ rule: 'retry-added', severity: 'warn' as const, file: 'a', message: 'x' }];
  const v2 = { ...v, decision: decide(warnOnly, true), checks: { testIntegrity: { ...v.checks.testIntegrity, findings: warnOnly } } };
  assert.match(formatReport(v2, { forAgent: false }), /BLOCKED — test integrity: 1 blocking, 0 warning/);
});

test('package.json splice keeps the agent dependencies but restores the test tooling', () => {
  const base = JSON.stringify({ name: 'x', scripts: { test: 'jest', build: 'tsc' }, jest: { testMatch: ['**/*.test.ts'] }, dependencies: { a: '1' } });
  const cur = JSON.stringify({ name: 'x', scripts: { test: 'jest --testPathIgnorePatterns auth', build: 'tsc', lint: 'eslint' }, jest: { testMatch: ['**/*.test.ts'], testPathIgnorePatterns: ['auth'] }, dependencies: { a: '1', b: '2' } });
  const out = JSON.parse(splicePackageJson(base, cur)!) as { scripts: Record<string, string>; jest: Record<string, unknown>; dependencies: Record<string, string> };
  assert.equal(out.scripts.test, 'jest');
  assert.equal(out.scripts.lint, 'eslint');
  assert.deepEqual(out.jest, { testMatch: ['**/*.test.ts'] });
  assert.deepEqual(out.dependencies, { a: '1', b: '2' });
  assert.equal(splicePackageJson('nope', cur), null);
});

test('test-run findings map results to rules', () => {
  const base = { originalOutput: 'FAILED', currentOutput: '', restoredTestFiles: ['tests/test_a.py'], durationMs: 1 };
  assert.equal(testRunFindings(null, {}).length, 0);
  assert.equal(testRunFindings({ ...base, status: 'pass', originalExit: 0, currentExit: null }, {}).length, 0);
  const f1 = testRunFindings({ ...base, status: 'fail', originalExit: 1, currentExit: 0 }, {});
  assert.equal(f1[0]?.rule, 'original-tests-fail'); assert.equal(f1[0]?.severity, 'block');
  const f2 = testRunFindings({ ...base, status: 'fail', originalExit: 1, currentExit: 1 }, {});
  assert.equal(f2[0]?.rule, 'tests-failing'); assert.equal(f2[0]?.severity, 'warn');
  const f3 = testRunFindings({ ...base, status: 'fail', originalExit: -1, currentExit: null, reason: 'timeout' }, {});
  assert.equal(f3[0]?.rule, 'test-run-timeout');
  assert.equal(testRunFindings({ ...base, status: 'fail', originalExit: 1, currentExit: 0 }, { 'original-tests-fail': 'off' }).length, 0);
});
