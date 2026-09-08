import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, promptHash, parseOutput, applyOutput, collectFiles, runJudge, parseClaudeCodeResult, providers, SYSTEM_PROMPT, JudgeUnavailable, type JudgeInput, type JudgeConfig, type JudgeProvider } from '../src/judge.js';
import type { Finding } from '../src/model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', '..', 'test', 'fixtures', 'judge');
const cfg: JudgeConfig = { model: 'claude-opus-5', provider: 'replay', maxDiffBytes: 200 * 1024, canBlock: false, effort: 'high' };
type Fixture = JudgeInput & { expect: { rules: string[]; annotated: Record<string, string> } };
const loadFixture = async (name: string) => ({
  input: JSON.parse(await fs.readFile(path.join(FIX, name, 'input.json'), 'utf8')) as Fixture,
  response: JSON.parse(await fs.readFile(path.join(FIX, name, 'response.json'), 'utf8')) as { source: string; model: string; raw: string; promptHash?: string },
});

test('fixtures: recorded responses replay offline and produce the expected findings and annotations', async () => {
  const names = (await fs.readdir(FIX, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(names.length >= 3);
  for (const name of names) {
    const { input, response } = await loadFixture(name);
    const before = input.findings.map((f) => f.severity);
    const { user, findingIds } = buildPrompt(input);
    if (response.promptHash) assert.equal(promptHash(SYSTEM_PROMPT, user, response.model), response.promptHash, `${name}: rubric changed since the response was recorded; re-record`);
    const out = parseOutput(response.raw);
    assert.ok(out, `${name}: response is not the expected JSON`);
    const applied = applyOutput(out, findingIds, input.files, cfg, {});
    assert.deepEqual(applied.findings.map((f) => f.rule).sort(), [...input.expect.rules].sort(), name);
    for (const f of applied.findings) { assert.ok(input.files.some((x) => x.path === f.file), `${name}: ${f.file} is not a judged file`); assert.ok(f.message.length > 0); assert.equal(f.severity, 'warn'); }
    for (const [id, verdict] of Object.entries(input.expect.annotated)) assert.equal(findingIds.get(id)?.judge?.verdict, verdict, `${name}: ${id}`);
    assert.deepEqual(input.findings.map((f) => f.severity), before, `${name}: a deterministic severity changed`);
  }
});

test('prompt: session content is escaped so a diff cannot close its own element, and the claim is labeled untrusted', async () => {
  const { input } = await loadFixture('injection-in-diff');
  const { user } = buildPrompt(input);
  assert.ok(!/<\/diff>\n def test_negative/.test(user));
  assert.ok(user.includes('&lt;/diff>'));
  assert.ok(user.includes('<claim source="agent final message" trust="untrusted">'));
  assert.ok(user.includes('<diff file="tests/test_ids.py" kind="test">'));
  // Same input, same hash; a different model or task changes it.
  assert.equal(promptHash(SYSTEM_PROMPT, user, 'm'), promptHash(SYSTEM_PROMPT, user, 'm'));
  assert.notEqual(promptHash(SYSTEM_PROMPT, user, 'm'), promptHash(SYSTEM_PROMPT, user, 'm2'));
});

test('severity rule: the judge cannot change a deterministic severity, only annotate; its own findings take the configured severity', () => {
  const det: Finding[] = [
    { rule: 'test-deleted', severity: 'block', file: 't.py', line: 3, message: 'x' },
    { rule: 'retry-added', severity: 'warn', file: 't.py', message: 'y' },
  ];
  const ids = new Map<string, Finding>([['f1', det[0]!], ['f2', det[1]!]]);
  const files = [{ path: 't.py', kind: 'test' as const, diff: '', total: 0, shown: 0 }, { path: 's.py', kind: 'source' as const, diff: '', total: 0, shown: 0 }];
  const out = parseOutput(JSON.stringify({
    findings: [
      { kind: 'test-weakened', file: 't.py', line: 3, test: 'a', reason: 'r1' },
      { kind: 'special-casing', file: 's.py', line: 0, test: '', reason: 'r2' },
      { kind: 'task-mismatch', file: 'elsewhere.py', line: 1, test: '', reason: 'not a judged file' },
      { kind: 'lift-block', file: 't.py', line: 1, test: '', reason: 'unknown kind' },
      { kind: 'test-weakened', file: 't.py', line: -4, test: '', reason: 'x'.repeat(2000) },
    ],
    triage: [
      { id: 'f1', verdict: 'consistent-with-task', reason: 'part of the task' },
      { id: 'f1', verdict: 'looks-like-evasion', reason: 'second opinion is ignored' },
      { id: 'f2', verdict: 'looks-like-evasion', reason: 'warn-level findings may be annotated too' },
      { id: 'f9', verdict: 'consistent-with-task', reason: 'unknown id' },
      { id: 'f1', verdict: 'severity=off', reason: 'bad verdict' },
    ],
    summary: 's',
  }))!;
  assert.equal(out.findings.length, 4, 'unknown kind dropped at parse time');
  assert.equal(out.triage.length, 4, 'bad verdict dropped at parse time');
  const a = applyOutput(out, ids, files, { canBlock: false }, { 'judge-special-casing': 'off' });
  assert.equal(a.discarded, 1);
  assert.deepEqual(a.findings.map((f) => [f.rule, f.severity, f.line ?? null]), [['judge-test-weakened', 'warn', 3], ['judge-test-weakened', 'warn', null]]);
  assert.ok(a.findings[1]!.message.length <= 600);
  assert.equal(a.annotated, 2);
  assert.equal(det[0]!.severity, 'block'); assert.equal(det[0]!.judge?.verdict, 'consistent-with-task');
  assert.equal(det[1]!.severity, 'warn'); assert.equal(det[1]!.judge?.verdict, 'looks-like-evasion');
  const b = applyOutput(out, ids, files, { canBlock: true }, { 'judge-special-casing': 'warn' });
  assert.deepEqual(b.findings.map((f) => [f.rule, f.severity]), [['judge-test-weakened', 'block'], ['judge-special-casing', 'block'], ['judge-test-weakened', 'block']]);
  assert.equal(det[0]!.severity, 'block', 'canBlock never touches deterministic findings');
  assert.equal(parseOutput('not json'), null);
  assert.equal(parseOutput('[1]'), null);
  assert.deepEqual(parseOutput('{}'), { findings: [], triage: [], summary: '' });
});

function repo(): { root: string; commit: () => string } {
  const root = path.join(os.tmpdir(), `gk-judge-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  execFileSync('git', ['init', '-q', root]);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  return { root, commit: () => { g('add', '-A'); g('commit', '-qm', 'c', '--allow-empty'); return g('rev-parse', 'HEAD^{tree}'); } };
}
const write = async (root: string, f: string, text: string) => { await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true }); await fs.writeFile(path.join(root, f), text); };
const isTest = (p: string) => p.startsWith('tests/');

test('collectFiles: tests first, per-file truncation on a line boundary, shared budget recorded', async () => {
  const { root, commit } = repo();
  await write(root, 'app/big.py', 'x = 0\n'); await write(root, 'tests/test_a.py', 'def test_a(): assert 1\n'); await write(root, 'README.md', 'a\n');
  const base = commit();
  await write(root, 'app/big.py', Array.from({ length: 2000 }, (_, i) => `line_${i} = ${i}`).join('\n') + '\n');
  await write(root, 'tests/test_a.py', 'def test_a(): assert 2\n'); await write(root, 'README.md', 'b\n');
  const cur = commit();
  const changes = [{ path: 'README.md', status: 'M' as const }, { path: 'app/big.py', status: 'M' as const }, { path: 'tests/test_a.py', status: 'M' as const }];
  const { files, omitted } = await collectFiles(root, base, cur, changes, isTest, 6000);
  assert.equal(omitted, 0);
  assert.deepEqual(files.map((f) => [f.path, f.kind]), [['tests/test_a.py', 'test'], ['app/big.py', 'source']]);
  const big = files[1]!;
  assert.ok(big.total > 6000 && big.shown < big.total && big.shown <= 6000);
  assert.match(big.diff, /\n\[\.\.\. truncated: \d+ of \d+ bytes shown\]$/);
  assert.ok(!big.diff.includes('line_1999'));
  assert.ok(files[0]!.diff.includes('+def test_a(): assert 2'));
  await fs.rm(root, { recursive: true, force: true });
});

test('runJudge: not-needed without test or source changes; cache by tree pair; skipped vs error; findings appended', async () => {
  const { root, commit } = repo();
  await write(root, 'app/a.py', 'def f(): return 0\n'); await write(root, 'tests/test_a.py', 'def test_f(): assert f() == 1\n'); await write(root, 'docs.md', 'a\n');
  const base = commit();
  await write(root, 'docs.md', 'b\n');
  const docsOnly = commit();
  let calls = 0;
  const provider: JudgeProvider = async (req) => { calls += 1; assert.equal(req.model, 'claude-opus-5'); assert.ok(req.user.includes('<task>')); return { model: 'fake-1', raw: JSON.stringify({ findings: [{ kind: 'special-casing', file: 'app/a.py', line: 1, test: '', reason: 'hardcoded' }], triage: [{ id: 'f1', verdict: 'looks-like-evasion', reason: 'no' }], summary: 'fitted' }) }; };
  const cacheDir = path.join(root, 'cache');
  const common = { root, cfg, task: 'make f return 1', claim: 'done', severities: {}, isTest, cacheDir, provider };
  const nn = await runJudge({ ...common, base, cur: docsOnly, changes: [{ path: 'docs.md', status: 'M' }], findings: [] });
  assert.equal(nn.result.status, 'not-needed'); assert.equal(nn.findings.length, 0); assert.equal(calls, 0);
  await write(root, 'app/a.py', 'def f(): return 1\n'); await write(root, 'tests/test_a.py', 'def test_f(): assert f()\n');
  const cur = commit();
  const changes = [{ path: 'app/a.py', status: 'M' as const }, { path: 'tests/test_a.py', status: 'M' as const }, { path: 'docs.md', status: 'M' as const }];
  const det: Finding[] = [{ rule: 'assertion-weakened', severity: 'block', file: 'tests/test_a.py', line: 1, message: 'm' }];
  const r1 = await runJudge({ ...common, base, cur, changes, findings: det });
  assert.equal(r1.result.status, 'ran'); assert.equal(r1.result.model, 'fake-1'); assert.equal(r1.result.filesJudged, 2); assert.equal(calls, 1);
  assert.deepEqual(r1.findings.map((f) => [f.rule, f.severity, f.file]), [['judge-special-casing', 'warn', 'app/a.py']]);
  assert.equal(det[0]!.judge?.verdict, 'looks-like-evasion'); assert.equal(det[0]!.severity, 'block');
  assert.ok(r1.result.raw && r1.result.promptHash && r1.result.summary === 'fitted');
  const r2 = await runJudge({ ...common, base, cur, changes, findings: [{ ...det[0]!, judge: undefined }] });
  assert.equal(r2.result.status, 'cached'); assert.equal(calls, 1); assert.equal(r2.findings.length, 1);
  const r3 = await runJudge({ ...common, base, cur, changes, findings: [], cacheDir: null, provider: async () => { throw new JudgeUnavailable('no credentials'); } });
  assert.equal(r3.result.status, 'skipped'); assert.deepEqual(r3.findings.map((f) => [f.rule, f.severity]), [['judge-skipped', 'warn']]); assert.match(r3.findings[0]!.message, /no credentials/);
  const r4 = await runJudge({ ...common, base, cur, changes, findings: [], cacheDir: null, provider: async () => { throw new Error('rate limited'); } });
  assert.equal(r4.result.status, 'error'); assert.equal(r4.findings[0]!.rule, 'judge-skipped');
  const r5 = await runJudge({ ...common, base, cur, changes, findings: [], cacheDir: null, provider: async () => ({ model: 'x', raw: 'I refuse to answer in JSON' }) });
  assert.equal(r5.result.status, 'error'); assert.equal(r5.result.raw, 'I refuse to answer in JSON'); assert.equal(r5.findings[0]!.rule, 'judge-skipped');
  const r6 = await runJudge({ ...common, base, cur, changes, findings: [], cacheDir: null, severities: { 'judge-skipped': 'off' }, provider: async () => { throw new JudgeUnavailable('x'); } });
  assert.equal(r6.findings.length, 0);
  const r7 = await runJudge({ ...common, base, cur: base, changes: [], findings: [] });
  assert.equal(r7.result.status, 'not-needed');
  await fs.rm(root, { recursive: true, force: true });
});

test('claude -p results: structured output wins, the requested model is picked out of modelUsage, errors are classified', () => {
  const ok = parseClaudeCodeResult(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"findings": []}', structured_output: { findings: [], triage: [], summary: 's' },
    total_cost_usd: 0.0074, usage: { input_tokens: 12, output_tokens: 40, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 }, modelUsage: { 'claude-haiku-4-5-20251001': {}, 'claude-opus-5': {} } }), 'claude-opus-5');
  assert.equal(ok.model, 'claude-opus-5');
  assert.deepEqual(JSON.parse(ok.raw), { findings: [], triage: [], summary: 's' });
  assert.deepEqual(ok.usage, { input: 12, output: 40, cacheRead: 3, cacheWrite: 1, costUsd: 0.0074 });
  const textOnly = parseClaudeCodeResult(JSON.stringify({ subtype: 'success', is_error: false, result: '{"findings":[],"triage":[],"summary":""}', modelUsage: {} }), 'claude-opus-5');
  assert.equal(textOnly.model, 'claude-opus-5'); assert.ok(parseOutput(textOnly.raw));
  assert.throws(() => parseClaudeCodeResult(JSON.stringify({ subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }), 'm'), JudgeUnavailable);
  assert.throws(() => parseClaudeCodeResult(JSON.stringify({ subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (3)'] }), 'm'), /maximum number of turns/);
  assert.throws(() => parseClaudeCodeResult('Warning: something\n', 'm'), /other than JSON/);
  assert.deepEqual(Object.keys(providers).sort(), ['anthropic', 'auto', 'claude-code', 'replay']);
});
