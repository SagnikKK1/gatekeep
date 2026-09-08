import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectives, applyOverrides, overridesFromPrompts, overridesFromCli } from '../src/override.js';
import { decide } from '../src/verdict.js';
import type { Finding } from '../src/model.js';

test('directive syntax: rule lists, reasons, trailer form, case', () => {
  assert.deepEqual(parseDirectives('gatekeep: allow test-deleted -- feature removed per #123'), [{ rule: 'test-deleted', reason: 'feature removed per #123' }]);
  assert.deepEqual(parseDirectives('Please refactor.\nGatekeep-Allow: test-deleted, assertions-reduced\n'), [{ rule: 'test-deleted' }, { rule: 'assertions-reduced' }]);
  assert.deepEqual(parseDirectives('GATEKEEP ALLOW mock-on-changed-module'), [{ rule: 'mock-on-changed-module' }]);
  assert.deepEqual(parseDirectives('the gatekeeper allows nothing here'), []);
});

test('overrides lift matching findings but never gate-config-changed, and the verdict records who', () => {
  const findings: Finding[] = [
    { rule: 'test-deleted', severity: 'block', file: 't.py', message: 'x' },
    { rule: 'gate-config-changed', severity: 'block', file: 'gatekeep.config.json', message: 'x' },
    { rule: 'retry-added', severity: 'warn', file: 't.py', message: 'x' },
  ];
  const used = applyOverrides(findings, overridesFromPrompts(['Remove the CSV exporter.\ngatekeep: allow test-deleted, gate-config-changed -- exporter is gone'], 'sagnik'));
  assert.equal(findings[0]!.overridden, 'sagnik via prompt: exporter is gone');
  assert.equal(findings[1]!.overridden, undefined);
  assert.equal(used.length, 1);
  assert.equal(decide(findings, false), 'block', 'gate-config-changed still blocks');
  findings.splice(1, 1);
  assert.equal(decide(findings, false), 'warn', 'lifted block leaves only the warning');
  assert.equal(decide(findings, true), 'block');
  const cli = overridesFromCli('retry-added, TEST-DELETED', 'ci');
  assert.deepEqual(cli.map((o) => o.rule), ['retry-added', 'test-deleted']);
  assert.equal(applyOverrides(findings, cli).length, 2);
});
