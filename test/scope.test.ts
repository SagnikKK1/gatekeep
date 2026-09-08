import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeFindings, typosquat, defNames, dependencyDiff, DEFAULT_PROTECTED_GLOBS } from '../src/scope.js';

const isTest = (p: string) => /tests?\//.test(p);
test('typosquat detection: one edit or swap from a well-known package, never the package itself', () => {
  assert.equal(typosquat('lodahs'), 'lodash');
  assert.equal(typosquat('reqeusts'), 'requests');
  assert.equal(typosquat('expresss'), 'express');
  assert.equal(typosquat('lodash'), null);
  assert.equal(typosquat('left-pad'), null);
  assert.equal(typosquat('@types/node'), null);
});
test('defNames finds top-level definitions across languages', () => {
  assert.deepEqual(defNames('def add(a):\n  pass\nclass Foo:\n  pass\n'), ['add', 'Foo']);
  assert.deepEqual(defNames('export function verify() {}\nconst x = 1;\nconst app = express();\nconst handler = async (req) => {};\nmodule.exports.login = () => {};\n'), ['verify', 'handler', 'login']);
});
test('dependency diff across manifest formats', () => {
  const pj = dependencyDiff('package.json', { path: 'package.json', status: 'M', before: '{"dependencies":{"a":"1.0.0","b":"^2.0.0"}}', after: '{"dependencies":{"a":"*","b":"^2.1.0","c":"1.0.0"},"devDependencies":{"d":"1"}}' });
  assert.deepEqual(pj.addedDeps, ['c', 'd']); assert.deepEqual(pj.loosened, ['a: 1.0.0 -> *']);
  const req = dependencyDiff('requirements.txt', { path: 'requirements.txt', status: 'M', before: 'flask==3.0.0\nrequests>=2\n', after: 'flask==2.0.0\nrequests>=2\nhttpx\n' });
  assert.deepEqual(req.addedDeps, ['httpx']); assert.match(req.loosened[0]!, /flask/);
  const gomod = dependencyDiff('go.mod', { path: 'go.mod', status: 'M', before: 'module x\ngo 1.22\nrequire github.com/a/b v1.2.0\n', after: 'module x\ngo 1.22\nrequire (\n\tgithub.com/a/b v1.2.0\n\tgithub.com/c/d v0.1.0\n)\n' });
  assert.deepEqual(gomod.addedDeps, ['github.com/c/d']);
});
test('task-scoped changes: only when the task names files', () => {
  const changes = [{ path: 'app/calc.py', status: 'M' as const, before: '', after: '' }, { path: 'app/mailer.py', status: 'M' as const, before: '', after: '' }];
  const named = scopeFindings(changes, {}, { protectedGlobs: DEFAULT_PROTECTED_GLOBS, task: 'Fix the rounding bug in app/calc.py', isTest });
  assert.equal(named.filter((f) => f.rule === 'out-of-scope-change').length, 1);
  assert.match(named[0]!.message, /app\/mailer.py/);
  const vague = scopeFindings(changes, {}, { protectedGlobs: DEFAULT_PROTECTED_GLOBS, task: 'Fix the rounding bug in the calculator', isTest });
  assert.equal(vague.length, 0);
});
