import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseConfig, defaultConfigText } from '../src/config.js';
import { analyze } from '../src/rules.js';
import { installClaudeCode, uninstallClaudeCode, detectTestCommand, GATEKEEP_HOOK_RE } from '../src/install.js';
import { patternFor, bashWriteTargets, decideProtect, denyEntries, writeTargets } from '../src/protect.js';
import { transcriptFromTools, classifyTool, claimFindings, CLAIM_SEVERITIES } from '../src/claims.js';
import { appendToolEvent, readToolEvents } from '../src/session.js';
import { DEFAULT_RULE_CONFIG } from '../src/rules.js';
import { jsTargetHits, jsSpecifierStem, pythonTargetHits } from '../src/lang.js';
import { formatReport, decide, type Verdict } from '../src/verdict.js';
import { splicePackageJson, testRunFindings, runOriginalTests } from '../src/testrun.js';
import type { FileChange } from '../src/model.js';
import { nextVersion, syncVersion, VERSION_FILES } from '../src/release.js';

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
  assert.deepEqual(r1.added.sort(), ['PostToolUse', 'SessionStart', 'UserPromptSubmit']);
  assert.deepEqual(r1.updated, ['Stop']);
  assert.ok(s1.permissions, 'unrelated settings preserved');
  const stopCmds = s1.hooks.Stop!.flatMap((e) => e.hooks.map((h) => h.command));
  assert.equal(stopCmds.filter((c) => GATEKEEP_HOOK_RE.test(c)).length, 1, 'duplicate collapsed');
  assert.ok(stopCmds.includes('echo other'), 'foreign hook preserved');
  const r2 = await installClaudeCode('project-local', dir);
  assert.deepEqual([r2.added, r2.updated], [[], []]);
  const u = await uninstallClaudeCode('project-local', dir);
  assert.equal(u.removed, 4);
  const s2 = JSON.parse(await fs.readFile(file, 'utf8')) as { hooks: Record<string, unknown[]> };
  assert.equal(s2.hooks.Stop!.length, 1);
  await fs.writeFile(file, '{"oops": ,}');
  await assert.rejects(installClaudeCode('project-local', dir), /not valid JSON/);
  assert.equal(await fs.readFile(file, 'utf8'), '{"oops": ,}', 'malformed file untouched');
});

test('install detects the repository\'s own test command, and writes null when there is none', async () => {
  const mk = async (files: Record<string, string>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-detect-'));
    for (const [f, body] of Object.entries(files)) await fs.writeFile(path.join(dir, f), body);
    return dir;
  };
  const cases: [Record<string, string>, string | null, RegExp | null][] = [
    [{ 'package.json': '{"scripts":{"test":"vitest run"}}' }, 'npm test --silent', /scripts\.test/],
    [{ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' }, null, null],
    [{ 'package.json': 'not json at all' }, null, null],
    [{ 'Cargo.toml': '[package]\nname = "x"\n' }, 'cargo test', /Cargo\.toml/],
    [{ 'go.mod': 'module example.com/x\n' }, 'go test ./...', /go\.mod/],
    [{ 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n' }, 'pytest -q', /pyproject/],
    [{ 'setup.cfg': '[tool:pytest]\n' }, 'pytest -q', /setup\.cfg/],
    [{ 'pytest.ini': '[pytest]\n' }, 'pytest -q', /pytest\.ini/],
    [{ 'Makefile': '.PHONY: test\nbuild:\n\tcc x.c\ntest:\n\t./run\n' }, 'make test', /Makefile/],
    [{ 'Makefile': 'CFLAGS := -O2\n%.o: %.c\n\tcc $<\n' }, null, null],
    [{ 'README.md': 'nothing here' }, null, null],
  ];
  for (const [files, want, from] of cases) {
    const got = await detectTestCommand(await mk(files));
    assert.equal(got?.command ?? null, want, JSON.stringify(Object.keys(files)));
    if (from) assert.match(got!.from, from);
  }
  // package.json wins over a Makefile in the same repo, and the detection reaches the generated config.
  const both = await mk({ 'package.json': '{"scripts":{"test":"jest"}}', 'Makefile': 'test:\n\t./run\n' });
  const detected = await detectTestCommand(both);
  assert.equal(detected?.command, 'npm test --silent');
  const text = defaultConfigText(detected);
  const parsed = parseConfig(text);
  assert.equal(parsed.cfg.testCommand, 'npm test --silent');
  assert.deepEqual(parsed.problems, [], 'the "//" comment key is not an unknown-key problem');
  assert.match(text, /"\/\/ testCommand": "detected from package\.json scripts\.test/);
  assert.equal(parseConfig(defaultConfigText(null)).cfg.testCommand, null);
  assert.deepEqual(parseConfig(defaultConfigText(null)).problems, []);
});

test('protect-tests derives one pattern per family of test file', () => {
  assert.equal(patternFor('tests/test_calc.py'), 'tests/**');
  assert.equal(patternFor('a/b/tests/deep/test_x.py'), 'a/b/tests/**');
  assert.equal(patternFor('src/test/java/com/X.java'), 'src/test/**');
  assert.equal(patternFor('pkg/__tests__/x.js'), 'pkg/__tests__/**');
  assert.equal(patternFor('src/calc.test.ts'), '**/*.test.ts');
  assert.equal(patternFor('src/calc.spec.tsx'), '**/*.spec.tsx');
  assert.equal(patternFor('pkg/handler_test.go'), '**/*_test.go');
  assert.equal(patternFor('lib/test_helpers.rb'), '**/test_*.rb');
  assert.equal(patternFor('lib/thing_spec.rb'), '**/*_spec.rb');
  assert.equal(patternFor('src/main/java/FooTest.java'), '**/*Test*.java');
  // Nothing recognisable: the file itself, never a pattern that would sweep in its neighbours.
  assert.equal(patternFor('weird/oddity.py'), 'weird/oddity.py');
  assert.deepEqual(denyEntries(['tests/**']), ['Edit(tests/**)', 'Write(tests/**)']);
});

test('the prevention hook denies writes to tests, and only writes', () => {
  const cfg = DEFAULT_RULE_CONFIG;
  const root = '/repo';
  const deny = (tool: string, input: Record<string, unknown>) => decideProtect(root, root, tool, input, cfg);
  assert.equal(deny('Edit', { file_path: 'tests/test_a.py' }).deny, true);
  assert.match(deny('Edit', { file_path: 'tests/test_a.py' }).reason!, /test-write-denied/);
  assert.equal(deny('Write', { file_path: '/repo/src/a.test.ts' }).deny, true);
  assert.equal(deny('NotebookEdit', { notebook_path: 'tests/nb.ipynb' }).deny, false, 'notebooks are not test files by path');
  assert.equal(deny('Edit', { file_path: 'src/a.ts' }).deny, false);
  assert.equal(deny('Read', { file_path: 'tests/test_a.py' }).deny, false, 'reading a test is fine');
  assert.equal(deny('Edit', { file_path: '/etc/hosts' }).deny, false, 'outside the repository is not our business');
  assert.equal(deny('Edit', {}).deny, false, 'a malformed tool_input fails open');
  // cwd-relative paths resolve against the cwd the hook was given, not the repo root.
  assert.equal(decideProtect(root, '/repo/pkg', 'Edit', { file_path: '../tests/test_a.py' }, cfg).deny, true);
  assert.deepEqual(writeTargets('Grep', { pattern: 'x' }), []);
});

test('the prevention hook resolves symlinked paths before deciding what is inside the repository', async () => {
  // /tmp and /var are symlinks on macOS: a hook cwd of /var/... against a git root of /private/var/... used to
  // make every path look external, so the lane permitted everything without saying anything.
  const real = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-prot-'));
  await fs.mkdir(path.join(real, 'tests'), { recursive: true });
  await fs.writeFile(path.join(real, 'tests', 'test_a.py'), 'def test_a():\n    assert 1\n');
  const link = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gk-link-')), 'repo');
  await fs.symlink(real, link, 'dir');
  const gitRoot = await fs.realpath(real);
  const d = decideProtect(gitRoot, link, 'Edit', { file_path: 'tests/test_a.py' }, DEFAULT_RULE_CONFIG);
  assert.equal(d.deny, true, 'a symlinked cwd must still resolve inside the repository');
  assert.equal(d.file, 'tests/test_a.py');
  // A file that does not exist yet still resolves: only the existing part of the path is followed.
  assert.equal(decideProtect(gitRoot, link, 'Write', { file_path: 'tests/test_new.py' }, DEFAULT_RULE_CONFIG).deny, true);
  assert.equal(decideProtect(gitRoot, link, 'Edit', { file_path: 'src/a.py' }, DEFAULT_RULE_CONFIG).deny, false);
});

test('the shell scan spots writes to a test path and leaves reads alone', () => {
  const has = (cmd: string, p: string) => bashWriteTargets(cmd).includes(p);
  assert.ok(has('rm -f tests/test_a.py', 'tests/test_a.py'));
  assert.ok(has('mv tests/test_a.py /tmp/x', 'tests/test_a.py'));
  assert.ok(has('echo pass > tests/test_a.py', 'tests/test_a.py'));
  assert.ok(has('echo pass >> tests/test_a.py', 'tests/test_a.py'));
  assert.ok(has('cat x > tests/test_a.py', 'tests/test_a.py'), 'a redirect writes whatever the command is');
  assert.ok(has('sed -i.bak s/a/b/ tests/test_a.py', 'tests/test_a.py'));
  assert.ok(has('git rm tests/test_a.py', 'tests/test_a.py'));
  assert.ok(has('cd x && rm tests/test_a.py', 'tests/test_a.py'), 'each segment is scanned');
  assert.ok(has('FOO=1 rm tests/test_a.py', 'tests/test_a.py'), 'leading assignments are skipped');
  assert.ok(!has('cat tests/test_a.py', 'tests/test_a.py'));
  assert.ok(!has('python -m pytest tests/test_a.py -q', 'tests/test_a.py'));
  assert.ok(!has('grep -r assert tests/test_a.py', 'tests/test_a.py'));
  assert.deepEqual(bashWriteTargets(''), []);
});

test('the recorder drives the claim rules the same way a transcript does', () => {
  assert.equal(classifyTool('Edit'), 'edit');
  assert.equal(classifyTool('Read'), 'read');
  assert.equal(classifyTool('apply_patch'), 'edit');
  assert.equal(classifyTool('write_file'), 'edit');
  assert.equal(classifyTool('view_file'), 'read');
  assert.equal(classifyTool('some_unknown_tool'), 'read', 'an unknown tool must not be credited with an edit');

  const changes = [{ path: 'app/calc.py', status: 'M' as const }];
  const isTest = () => false;
  // A test run, then an edit, then "tests pass": the run is stale whichever source recorded it.
  const stale = transcriptFromTools(
    [{ tool: 'shell', command: 'python -m pytest -q' }, { tool: 'apply_patch', file: 'app/calc.py' }],
    'Done, all tests pass.',
  );
  const f = claimFindings(stale, changes, CLAIM_SEVERITIES, isTest);
  assert.ok(f.some((x) => x.rule === 'claim-tests-unverified' && /before the last edit/.test(x.message)));
  // The other order is honest and says nothing.
  const fresh = transcriptFromTools(
    [{ tool: 'apply_patch', file: 'app/calc.py' }, { tool: 'shell', command: 'python -m pytest -q' }],
    'Done, all tests pass.',
  );
  assert.ok(!claimFindings(fresh, changes, CLAIM_SEVERITIES, isTest).some((x) => x.rule === 'claim-tests-unverified'));
  // A shell redirect is an edit here exactly as it is in the transcript parser.
  const redirected = transcriptFromTools(
    [{ tool: 'shell', command: 'python -m pytest -q' }, { tool: 'shell', command: 'echo x > app/calc.py' }],
    'Done, all tests pass.',
  );
  assert.ok(redirected.events.some((e) => e.kind === 'edit'));
  // A blocking rule that needs no final message at all still fires from recorded shell calls.
  const rewritten = transcriptFromTools([{ tool: 'shell', command: 'git reset --hard HEAD~1' }], '');
  assert.ok(claimFindings(rewritten, changes, CLAIM_SEVERITIES, isTest).some((x) => x.rule === 'history-rewritten' && x.severity === 'block'));
});

test('recorded tool calls are signed, so a forged line is dropped', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-repo-'));
  const prev = process.env.GATEKEEP_HOME;
  process.env.GATEKEEP_HOME = home;
  try {
    await appendToolEvent(repo, 's1', { tool: 'Bash', command: 'pytest -q' });
    await appendToolEvent(repo, 's1', { tool: 'Edit', file: 'app/calc.py' });
    const ok = await readToolEvents(repo, 's1');
    assert.deepEqual(ok.events.map((e) => e.tool), ['Bash', 'Edit']);
    assert.equal(ok.dropped, 0);
    // An agent appending a test run it never made cannot sign it.
    const { repoStateDir } = await import('../src/session.js');
    const log = path.join(repoStateDir(repo), 'sessions', 's1.events.jsonl');
    await fs.appendFile(log, JSON.stringify({ e: { tool: 'Bash', command: 'pytest -q' }, sig: 'f'.repeat(64) }) + '\n');
    const after = await readToolEvents(repo, 's1');
    assert.equal(after.events.length, 2, 'the forged line is not counted');
    assert.equal(after.dropped, 1);
  } finally { if (prev === undefined) delete process.env.GATEKEEP_HOME; else process.env.GATEKEEP_HOME = prev; }
});

test('the release picks a version npm does not already have', () => {
  // A deliberate bump wins: 0.2.0 for a release with new commands is published as 0.2.0.
  assert.equal(nextVersion('0.2.0', ['0.1.0']), '0.2.0');
  // An already-published version is immutable, so the push takes the next free patch rather than failing.
  assert.equal(nextVersion('0.1.0', ['0.1.0']), '0.1.1');
  assert.equal(nextVersion('0.1.0', ['0.1.0', '0.1.1', '0.1.2']), '0.1.3');
  assert.equal(nextVersion('1.4.9', []), '1.4.9');
  assert.throws(() => nextVersion('0.2.0-rc.1', []), /not a plain x\.y\.z/);
});

test('the release writes one version into every file that has to carry it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-rel-'));
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await fs.mkdir(path.join(dir, 'hooks'), { recursive: true });
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const rel of VERSION_FILES) await fs.copyFile(path.join(src, rel), path.join(dir, rel));

  assert.deepEqual((await syncVersion(dir, '9.8.7')).sort(), [...VERSION_FILES].sort());
  const plugin = JSON.parse(await fs.readFile(path.join(dir, '.claude-plugin/plugin.json'), 'utf8')) as { version: string };
  const market = JSON.parse(await fs.readFile(path.join(dir, '.claude-plugin/marketplace.json'), 'utf8')) as { plugins: { version: string }[] };
  const sh = await fs.readFile(path.join(dir, 'hooks/gatekeep-hook.sh'), 'utf8');
  assert.equal(plugin.version, '9.8.7');
  assert.equal(market.plugins[0]!.version, '9.8.7');
  assert.match(sh, /pinned=gatekeep-agent@9\.8\.7\b/);
  assert.deepEqual(await syncVersion(dir, '9.8.7'), [], 'running it twice changes nothing');
  await assert.rejects(syncVersion(dir, 'v9.8.7'), /not a plain x\.y\.z/);
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
  // A first run the clock kills is a timeout, not an unexplained error.
  const f4 = testRunFindings({ ...base, status: 'error', originalExit: -1, currentExit: null, reason: 'timeout' }, {});
  assert.equal(f4[0]?.rule, 'test-run-timeout');
  const f5 = testRunFindings({ ...base, status: 'error', originalExit: -1, currentExit: null, reason: 'spawn ENOENT' }, {});
  assert.equal(f5[0]?.rule, 'test-run-error');
});

/**
 * The Stop hook is installed with a 600 s ceiling, so the two runs may not each take `testTimeoutMs`: a hook the
 * harness kills returns no decision and the gate passes silently. Both runs come out of one budget.
 */
test('the original-tests check spends one budget across both runs', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-budget-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  await fs.mkdir(path.join(repo, 'tests'), { recursive: true });
  await fs.writeFile(path.join(repo, 'a.py'), 'def add(a, b):\n    return a + b\n');
  await fs.writeFile(path.join(repo, 'tests/test_a.py'), 'def test_add():\n    assert add(1, 2) == 3\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const baseTree = git('rev-parse', 'HEAD^{tree}');
  await fs.writeFile(path.join(repo, 'a.py'), 'def add(a, b):\n    return 3\n');
  git('add', '-A'); git('commit', '-qm', 'after');
  const curTree = git('rev-parse', 'HEAD^{tree}');

  // Burns most of the budget where the original tests were restored, then hangs on the agent's own copy. The
  // first run has to be slow for this to discriminate: if it returned instantly, a per-run timeout would look
  // the same as a shared one.
  const budget = 4000;
  const cmd = 'case "$(/bin/pwd)" in *original-tests*) sleep 3.5; exit 1;; *) sleep 30; exit 1;; esac';
  const changes: FileChange[] = [{ path: 'a.py', status: 'M' }];
  const r = await runOriginalTests(repo, baseTree, curTree, changes, DEFAULT_RULE_CONFIG, { testCommand: cmd, testTimeoutMs: budget });
  await fs.rm(repo, { recursive: true, force: true });

  assert.equal(r?.status, 'fail');
  assert.equal(r?.reason, 'timeout');
  // With one shared budget this lands near 4 s. With a timeout per run it was 3.5 s + 4 s, and a real suite at the
  // 300 s default made it 600 s, which is the Stop hook's whole limit.
  assert.ok((r?.durationMs ?? 0) < budget * 1.4, `took ${r?.durationMs} ms against a ${budget} ms budget`);
  assert.equal(testRunFindings(r, {})[0]?.rule, 'test-run-timeout');
});

test('a claimed test run needs a command that actually ran, and one that did not fail', () => {
  const changes: FileChange[] = [{ path: 'app/calc.py', status: 'M' }];
  const claim = 'Done, all tests pass.';
  const rules = (tools: Parameters<typeof transcriptFromTools>[0]) =>
    claimFindings(transcriptFromTools(tools, claim), changes, {}, (p) => /test/.test(p)).map((f) => f.rule);

  // Printing a command is not running it: this was a one-line bypass of the whole claims family.
  assert.deepEqual(rules([{ tool: 'Bash', command: 'echo "npm test"' }]), ['claim-tests-unverified']);
  assert.deepEqual(rules([{ tool: 'Bash', command: 'printf "npm test\n"' }]), ['claim-tests-unverified']);
  // A real run clears the claim.
  assert.deepEqual(rules([{ tool: 'Bash', command: 'npm test' }]), []);
  // A run the harness reported as failed does not.
  assert.deepEqual(rules([{ tool: 'Bash', command: 'npm test', failed: true }]), ['claim-tests-unverified']);
  // An echoed string alongside a real run must not suppress the real one.
  assert.deepEqual(rules([{ tool: 'Bash', command: 'echo "skipping"; npm test' }]), []);
});

test('a new test file that does not parse warns; only breaking an existing one blocks', async () => {
  // Regression for 0.2.0: `before?.parseErrors ?? 0` read as 0 for a file that never existed, so every new test
  // file counted as having its syntax broken during the session. Our grammar build also rejects valid TypeScript
  // import types, so writing one correct new test file was enough to be blocked.
  const importType = "import { test } from 'node:test';\nlet x: import('node:fs').Dirent[] = [];\ntest('t', () => { if (x.length !== 0) throw new Error('x'); });\n";
  const clean = "import { test } from 'node:test';\ntest('t', () => { if (1 !== 1) throw new Error('x'); });\n";

  const added = await analyze([{ path: 'test/new.test.ts', status: 'A', after: importType }], undefined, {});
  const addedSev = added.findings.find((f) => f.rule === 'test-file-unparseable')?.severity;
  assert.equal(addedSev, 'warn', 'a brand-new file has no earlier tests to protect');

  const broken = await analyze([{ path: 'test/a.test.ts', status: 'M', before: clean, after: importType }], undefined, {});
  const brokenSev = broken.findings.find((f) => f.rule === 'test-file-unparseable')?.severity;
  assert.equal(brokenSev, 'block', 'breaking a file that parsed at session start still blocks');
});

test('every fixture file is tracked by git (a fixture .gitignore must not hide its own files from CI)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  let out = '';
  try { out = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', 'fixtures/'], { cwd: root, encoding: 'utf8' }); }
  catch { return; } // not a git checkout (e.g. an npm tarball): nothing to check
  assert.equal(out.trim(), '', `ignored fixture files, add them with git add -f:\n${out}`);
});
