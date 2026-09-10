/**
 * Coverage for the redaction behind `gatekeep report-fp`.
 *
 * Redaction has exactly two ways to fail and they pull in opposite directions: leak something, or destroy the
 * evidence. The command's own safety net is that it re-runs the rules and refuses to ship a fixture that no longer
 * reproduces, so what is worth pinning here is the property that makes that net catch anything at all — the
 * pseudonyms are consistent, and the naming conventions the rules read a test file by survive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pseudonym, pseudonymPath, pseudoString, redactSource, redactFiles, fixtureName, issueUrl } from '../src/reportfp.js';
import { isTestFile, DEFAULT_RULE_CONFIG } from '../src/rules.js';
import { langFor } from '../src/lang.js';

test('pseudonyms are stable, and keep the conventions the rules read names by', () => {
  assert.equal(pseudonym('rateCard'), pseudonym('rateCard'), 'same name, same pseudonym, every time');
  assert.notEqual(pseudonym('rateCard'), pseudonym('rateCards'));
  // A pytest test has to stay a pytest test, or every test-integrity rule stands down and the fixture proves nothing.
  assert.match(pseudonym('test_charges_vat'), /^test_/);
  assert.match(pseudonym('billing_test'), /_test$/);
  assert.match(pseudonym('TestLedger'), /^Test/);
  assert.match(pseudonym('_private'), /^_/);
  assert.match(pseudonym('RateCard'), /^[A-Z]/, 'a type stays a type');
  // Framework and language vocabulary is not the reporter's business logic, and renaming it breaks the fixture.
  for (const keep of ['describe', 'it', 'expect', 'assert', 'pytest', 'self', 'testing', '__init__']) {
    assert.equal(pseudonym(keep), keep, keep);
  }
  assert.ok(/^[A-Za-z_]/.test(pseudonym('rateCard')), 'still a valid identifier');
});

test('paths keep their extension and their test-ness, and lose everything else', () => {
  const p = pseudonymPath('src/acme/billing/rate_card.py');
  assert.match(p, /^src\//, 'structural segments survive');
  assert.ok(p.endsWith('.py'), 'the extension picks the grammar');
  assert.ok(!p.includes('acme') && !p.includes('billing') && !p.includes('rate_card'), p);
  assert.equal(langFor(p), 'python');
  // A test path has to still look like a test path to isTestFile, or the fixture changes meaning.
  const t = pseudonymPath('tests/billing/test_rate_card.py');
  assert.ok(isTestFile(t, DEFAULT_RULE_CONFIG), t);
  assert.ok(isTestFile(pseudonymPath('internal/billing/rate_card_test.go'), DEFAULT_RULE_CONFIG));
  assert.ok(isTestFile(pseudonymPath('src/billing/rateCard.test.ts'), DEFAULT_RULE_CONFIG));
});

test('redacting python keeps it parseable, drops the comment, and pseudonymises consistently', async () => {
  const src = [
    '# rate cards are keyed by the acme contract id',
    'def charge_customer(contract_id):',
    '    if contract_id == "ACME-GOLD-2019":',
    '        return 1299',
    '    return None',
    '',
  ].join('\n');
  const full = await redactSource('src/billing.py', src, 'full');
  assert.ok(!full.includes('acme') && !full.includes('ACME-GOLD-2019'), full);
  assert.ok(!full.includes('charge_customer'), full);
  assert.match(full, /^# redacted/m, 'the comment marker and the line stay, the sentence goes');
  assert.match(full, /^def \w+\(\w+\):$/m, 'still Python');
  // The same identifier is the same pseudonym in both places, which is what lets cross-file rules still fire.
  const name = /def (\w+)\(/.exec(full)![1]!;
  assert.equal(name, pseudonym('charge_customer'));

  // `light` keeps string contents, for the rules that are about the literal itself.
  const light = await redactSource('src/billing.py', src, 'light');
  assert.ok(light.includes('ACME-GOLD-2019'), 'light keeps literals');
  assert.ok(!light.includes('charge_customer'), 'but not identifiers');
});

test('redacting typescript keeps the syntax, including template strings', async () => {
  const src = 'const rate = 5;\nexport function priceFor(sku: string): string {\n  // internal pricing table\n  return `sku ${sku} at ${rate}`;\n}\n';
  const out = await redactSource('src/price.ts', src, 'full');
  assert.ok(!out.includes('priceFor'), out);
  assert.ok(out.includes('${'), 'the interpolation survives, or the file stops parsing');
  assert.match(out, /export function \w+\(\w+: string\): string \{/, out);
  assert.ok(!/internal pricing table/.test(out), out);
});

test('a file with no grammar keeps its structural vocabulary so the integrity rules still see it', async () => {
  const yml = 'on:\n  push:\n    branches: [main]\njobs:\n  build:\n    steps:\n      - run: npm test\n      - run: ./acmedeploy --tenant prod\n';
  const out = await redactSource('.github/workflows/ci.yml', yml, 'full');
  for (const kw of ['on', 'push', 'jobs', 'steps', 'run', 'npm', 'test']) assert.ok(out.includes(kw), `${kw} missing from ${out}`);
  assert.ok(!out.includes('acmedeploy'), out);
});

test('redactFiles renames the paths as well as the contents, in both trees', async () => {
  const { before, after } = await redactFiles([
    { path: 'src/billing.py', before: 'def charge(x):\n    return 1\n', after: 'def charge(x):\n    return 2\n' },
  ], 'full');
  const [bp] = Object.keys(before), [ap] = Object.keys(after);
  assert.equal(bp, ap, 'one file, one redacted path in both trees');
  assert.notEqual(bp, 'src/billing.py');
  assert.ok(bp!.endsWith('.py'));
});

test('pseudoString and fixtureName are stable and safe to put in a path', () => {
  assert.equal(pseudoString('hello'), pseudoString('hello'));
  assert.notEqual(pseudoString('hello'), pseudoString('hell0'));
  assert.equal(pseudoString(''), '', 'an empty string has nothing to hide');
  const n = fixtureName('test-oracle-in-source', [{ path: 'src/acme/rate_card.py' }]);
  assert.match(n, /^fp-test-oracle-in-source-/);
  assert.ok(!/[^a-z0-9-]/.test(n), n);
  assert.ok(!n.includes('rate'), n);
});

test('the issue URL carries the fixture, and falls back to a pointer when it is too big', () => {
  const fixture = { name: 'fp-x', level: 'full' as const, before: { 'a.py': 'x = 1\n' }, after: { 'a.py': 'x = 2\n' }, expected: { findings: [] }, reproduced: true, findings: [] };
  const small = issueUrl('SagnikKK1/gatekeep', { rule: 'test-oracle-in-source', version: '0.2.3', level: 'full', message: 'm', fixture, dir: '/tmp/x' });
  assert.match(small, /^https:\/\/github\.com\/SagnikKK1\/gatekeep\/issues\/new\?/);
  assert.match(decodeURIComponent(small), /before\/a\.py/);
  assert.match(decodeURIComponent(small), /false-positive/);

  const big = { ...fixture, after: { 'a.py': 'x = 2\n'.repeat(4000) } };
  const url = issueUrl('SagnikKK1/gatekeep', { rule: 'r', version: '0.2.3', level: 'full', message: 'm', fixture: big, dir: '/tmp/big' });
  assert.ok(url.length < 8000, `url was ${url.length}`);
  assert.match(decodeURIComponent(url), /too large to inline/);
});
