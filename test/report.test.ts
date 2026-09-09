import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceTest, lineDiff, familyOf, renderReport } from '../src/report.js';
import type { Verdict } from '../src/verdict.js';

const L = (s: string) => s.split('\n');

test('sliceTest: python by indentation, decorators included, bounded by the next test', () => {
  const src = L('import x\n\n@pytest.mark.slow\ndef test_a():\n    x = 1\n\n    assert x\n\n\ndef test_b():\n    assert 2\n');
  assert.deepEqual(sliceTest(src, 4, 10, 'python'), { start: 2, end: 6 });
  assert.deepEqual(sliceTest(src, 10, null, 'python'), { start: 9, end: 10 });
  const cls = L('class T:\n    def test_a(self):\n        assert 1\n    def test_b(self):\n        assert 2\nX = 1\n');
  assert.deepEqual(sliceTest(cls, 2, 4, 'python'), { start: 1, end: 2 });
  assert.deepEqual(sliceTest(cls, 4, null, 'python'), { start: 3, end: 4 });
});

test('sliceTest: brace languages balance brackets across strings and comments', () => {
  const js = L("describe('a', () => {\n  it('x', () => {\n    const s = ') // not a paren';\n    expect(f()).toBe(1); // }\n  });\n\n  it('y', () => {\n    expect(1).toBe(1);\n  });\n});\n");
  assert.deepEqual(sliceTest(js, 2, 7, 'typescript'), { start: 1, end: 4 });
  assert.deepEqual(sliceTest(js, 7, null, 'typescript'), { start: 6, end: 8 });
  const go = L('func TestA(t *testing.T) {\n\tif got := f(); got != 1 {\n\t\tt.Errorf("x")\n\t}\n}\n\nfunc TestB(t *testing.T) {\n}\n');
  assert.deepEqual(sliceTest(go, 1, 7, 'go'), { start: 0, end: 4 });
  const rs = L('#[test]\nfn a() {\n    assert_eq!(1, 1);\n}\n#[test]\nfn b() {}\n');
  assert.deepEqual(sliceTest(rs, 2, 6, 'rust'), { start: 0, end: 3 });
  const rb = L("describe 'x' do\n  it 'a' do\n    expect(1).to eq(1)\n  end\n\n  it 'b' do\n    expect(2).to eq(2)\n  end\nend\n");
  assert.deepEqual(sliceTest(rb, 2, 6, 'ruby'), { start: 1, end: 3 });
  assert.deepEqual(sliceTest(rb, 6, null, 'ruby'), { start: 5, end: 7 });
  const oneLine = L("it('x', () => expect(1).toBe(1));\nit('y', () => {\n});\n");
  assert.deepEqual(sliceTest(oneLine, 1, 2, 'javascript'), { start: 0, end: 0 });
  const java = L('@Test\npublic void a() {\n    assertEquals(1, f("}"));\n}\n\n@Test\npublic void b() {}\n');
  assert.deepEqual(sliceTest(java, 2, 7, 'java'), { start: 0, end: 3 });
  // Never runs past the file or the cap.
  assert.deepEqual(sliceTest(L('it("x", () => {'), 1, null, 'javascript'), { start: 0, end: 0 });
  assert.deepEqual(sliceTest([], 3, null, 'python'), { start: 0, end: -1 });
});

test('lineDiff marks only the lines that differ', () => {
  const d = lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
  assert.deepEqual(d.a, [false, true, false]);
  assert.deepEqual(d.b, [false, true, false, true]);
  assert.deepEqual(lineDiff([], ['a']).b, [true]);
  assert.deepEqual(lineDiff(['  a'], ['a']).a, [false]);
});

test('familyOf groups rules', () => {
  assert.equal(familyOf('test-deleted'), 'test integrity');
  assert.equal(familyOf('ci-weakened'), 'check integrity');
  assert.equal(familyOf('claim-tests-unverified'), 'claims');
  assert.equal(familyOf('secret-introduced'), 'scope');
  assert.equal(familyOf('original-tests-fail'), 'original tests');
  assert.equal(familyOf('judge-task-mismatch'), 'model-backed review');
  assert.equal(familyOf('gate-config-changed'), 'gate');
});

const verdict = (): Verdict => ({
  schema: 'gatekeep.verdict.v1', createdAt: '2026-09-09T00:00:00.000Z', sessionId: 'sess-1234567890', harness: 'claude-code',
  baseTree: 'b'.repeat(40), currentTree: 'c'.repeat(40), task: 'Fix add() <script>alert(1)</script>', decision: 'block',
  checks: {
    testIntegrity: {
      status: 'fail',
      findings: [
        { rule: 'assertion-weakened', severity: 'block', file: 'tests/test_calc.py', line: 4, test: 'test_add', message: '"test_add": 1 specific assertion(s) replaced by <b>truthiness</b>', before: 'assert add(2, 3) == 5', after: 'assert add(2, 3)', judge: { verdict: 'looks-like-evasion', reason: 'nothing in the task changes add(2, 3)' } },
        { rule: 'test-deleted', severity: 'block', file: 'tests/test_calc.py', line: 7, test: 'test_neg', message: 'Test "test_neg" removed', overridden: 'user via prompt' },
        { rule: 'suppression-added', severity: 'warn', file: 'app/calc.py', line: 2, message: 'suppression' },
        { rule: 'claim-tests-unverified', severity: 'warn', file: '.', message: 'says tests pass' },
      ],
      examined: [{ path: 'tests/test_calc.py', status: 'M', testsBefore: 2, testsAfter: 1 }],
      changedSourceFiles: ['app/calc.py'],
    },
    judge: { status: 'ran', model: 'claude-opus-5', promptHash: 'a'.repeat(64), raw: '{"findings":[],"triage":[],"summary":"<s>"}', summary: 'fitted <s>', filesJudged: 2, omittedFiles: 0, truncated: [{ path: 'app/calc.py', shown: 10, total: 20 }], discarded: 0, emitted: 0, annotated: 1, durationMs: 1200 },
  },
  blockCount: 1, durationMs: 300, overrides: [{ rule: 'test-deleted', source: 'prompt', by: 'user via prompt', reason: 'ticket <42>' }],
});

const files: Record<string, string> = {
  [`${'b'.repeat(40)}\0tests/test_calc.py`]: 'from app.calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n\n\ndef test_neg():\n    assert add(-1, 1) == 0\n',
  [`${'c'.repeat(40)}\0tests/test_calc.py`]: 'from app.calc import add\n\ndef test_add():\n    assert add(2, 3)\n',
  [`${'b'.repeat(40)}\0app/calc.py`]: 'def add(a, b):\n    return 0\n',
  [`${'c'.repeat(40)}\0app/calc.py`]: 'def add(a, b):  # type: ignore\n    return 5 if (a, b) == (2, 3) else 0\n',
};
const loadFile = async (tree: string, p: string) => files[`${tree}\0${p}`];

test('renderReport: self-contained, escaped, test bodies before and after with changed lines marked', async () => {
  const html = await renderReport(verdict(), { root: null, verdictPath: '/x/latest.json', loadFile });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!/<script/i.test(html), 'no scripts, ever');
  assert.ok(!/src="http|href="http|@import|url\(/i.test(html), 'no external resources');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;truthiness&lt;/b&gt;'));
  assert.ok(html.includes('ticket &lt;42&gt;'));
  assert.ok(html.includes('fitted &lt;s&gt;'));
  // Test bodies from both trees, the changed assertion marked on both sides.
  assert.match(html, /<tr><td class="ln">3<\/td><td class="code">def test_add\(\):<\/td><\/tr>\s*<tr class="del"><td class="ln">4<\/td><td class="code">    assert add\(2, 3\) == 5<\/td>/);
  assert.match(html, /<tr class="add"><td class="ln">4<\/td><td class="code">    assert add\(2, 3\)<\/td>/);
  // The deleted test: body before, nothing after.
  assert.match(html, /def test_neg\(\):/);
  assert.ok(html.includes('no test with this name'));
  // Context window for a line-level finding without a test name, focus line marked.
  assert.match(html, /<tr class="add focus"><td class="ln">2<\/td><td class="code">    return 5 if \(a, b\) == \(2, 3\) else 0<\/td>/);
  // Sections and annotations.
  assert.ok(html.includes('Blocking (1)') && html.includes('Warnings (2)') && html.includes('Lifted by override (1)'));
  assert.ok(html.includes('looks like evasion'));
  assert.ok(html.includes('lifted by user via prompt'));
  assert.ok(html.includes('prompt hash <code>' + 'a'.repeat(64)));
  assert.ok(html.includes('<summary>raw model output</summary>'));
  assert.ok(html.includes('<summary>verdict JSON</summary>'));
  assert.ok(html.includes('/x/latest.json'));
});

test('renderReport: without file access it falls back to the one-line before/after from the verdict', async () => {
  const html = await renderReport(verdict(), { root: null });
  assert.ok(html.includes('<span class="k">before</span><code>assert add(2, 3) == 5</code>'));
  assert.ok(html.includes('<span class="k">after</span><code>assert add(2, 3)</code>'));
  assert.ok(!html.includes('class="pair"'));
  assert.ok(html.includes('File contents were not available'));
});
