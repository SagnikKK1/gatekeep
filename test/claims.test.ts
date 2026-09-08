import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, claimFindings } from '../src/claims.js';
import type { FileChange } from '../src/model.js';

const line = (type: 'assistant' | 'user', content: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra });
const text = (t: string) => ({ type: 'text', text: t });
const bash = (command: string) => ({ type: 'tool_use', name: 'Bash', input: { command } });
const edit = (file_path: string) => ({ type: 'tool_use', name: 'Edit', input: { file_path } });
const result = () => ({ type: 'tool_result', tool_use_id: 'x', content: 'ok' });
const changes: FileChange[] = [{ path: 'app/calc.py', status: 'M', before: '', after: '' }, { path: 'tests/test_calc.py', status: 'M', before: '', after: '' }];
const isTest = (p: string) => p.startsWith('tests/');
const run = (lines: string[], ch = changes) => claimFindings(parseTranscript(lines.join('\n')), ch, {}, isTest).map((f) => f.rule + ':' + f.message.slice(0, 160));

test('tests-pass claim with no test run, or a run before the last edit', () => {
  const noRun = [line('user', [text('fix add')]), line('assistant', [edit('app/calc.py')]), line('user', [result()]), line('assistant', [text('Done. All tests pass and app/calc.py, tests/test_calc.py are updated.')])];
  assert.match(run(noRun)[0]!, /claim-tests-unverified:.*no test command/);
  const staleRun = [line('user', [text('fix add')]), line('assistant', [bash('pytest -q')]), line('user', [result()]), line('assistant', [edit('app/calc.py')]), line('user', [result()]), line('assistant', [text('All 12 tests pass. Changed app/calc.py and tests/test_calc.py.')])];
  assert.match(run(staleRun)[0]!, /claim-tests-unverified:.*before the last edit/);
  const fresh = [line('user', [text('fix add')]), line('assistant', [edit('app/calc.py')]), line('user', [result()]), line('assistant', [bash('python -m pytest')]), line('user', [result()]), line('assistant', [text('All tests pass. Changed app/calc.py and tests/test_calc.py.')])];
  assert.deepEqual(run(fresh), []);
});

test('bash heredoc writes count as edits; build and lint claims need matching commands', () => {
  const heredoc = [line('user', [text('go')]), line('assistant', [bash('npm test')]), line('user', [result()]), line('assistant', [bash("cat > app/calc.py <<'EOF'\nx\nEOF")]), line('user', [result()]), line('assistant', [text('Tests pass, the build is clean and lint passes. Files: app/calc.py, tests/test_calc.py')])];
  const out = run(heredoc);
  assert.ok(out.some((x) => /claim-tests-unverified/.test(x)));
  assert.ok(out.some((x) => /claim-checks-unverified:.*build/.test(x)));
  assert.ok(out.some((x) => /claim-checks-unverified:.*lint/.test(x)));
});

test('summary file mismatch: ghost files and unmentioned changes', () => {
  const t = [line('user', [text('go')]), line('assistant', [bash('pytest')]), line('user', [result()]), line('assistant', [text('Updated app/calc.py and app/util.py. Tests pass.')])];
  const out = run(t);
  assert.ok(out.some((x) => /did not change: app\/util.py/.test(x)));
  assert.ok(out.some((x) => /never mentions: tests\/test_calc.py/.test(x)));
  const noFiles = [line('user', [text('go')]), line('assistant', [bash('pytest')]), line('user', [result()]), line('assistant', [text('Done, tests pass.')])];
  assert.deepEqual(run(noFiles).filter((x) => /summary-files/.test(x)), []);
});

test('history rewriting, exclude writes and unrestored stashes block', () => {
  const t = [line('user', [text('go')]), line('assistant', [bash('git commit --amend --no-edit')]), line('user', [result()]), line('assistant', [bash("echo 'tests/' >> .git/info/exclude")]), line('user', [result()]), line('assistant', [bash('git stash')]), line('user', [result()]), line('assistant', [text('Done.')])];
  const out = claimFindings(parseTranscript(t.join('\n')), changes, {}, isTest);
  assert.equal(out.filter((f) => f.rule === 'history-rewritten').length, 3);
  assert.ok(out.every((f) => f.severity === 'block'));
  const restored = [line('user', [text('go')]), line('assistant', [bash('git stash')]), line('user', [result()]), line('assistant', [bash('git stash pop')]), line('user', [result()]), line('assistant', [text('Done.')])];
  assert.deepEqual(run(restored), []);
});

test('sidechain lines and unknown formats are ignored; a human turn resets the final message', () => {
  const t = [line('user', [text('go')]), line('assistant', [text('Tests pass.')], { isSidechain: true }), line('assistant', [text('working')]), line('user', [text('thanks, now refactor')]), line('assistant', [bash('ls')]), line('user', [result()]), line('assistant', [text('Refactored app/calc.py.')])];
  const parsed = parseTranscript(t.join('\n'));
  assert.equal(parsed.finalText, 'Refactored app/calc.py.');
  assert.deepEqual(claimFindings(parseTranscript('not json\n{"foo": 1}'), changes, {}, isTest), []);
  assert.deepEqual(claimFindings(null, changes, {}, isTest), []);
});
