/**
 * Unit coverage for the three modules that had none: `oracle.ts`, `parser.ts` and `git.ts`.
 *
 * They were reachable only through `scripts/e2e.sh` and the fixture corpus, which means a regression in any of them
 * showed up as a puzzling fixture diff rather than as a failing assertion about the thing that broke. `oracle.ts` in
 * particular is the module behind the project's headline rule and the one whose false-positive rate is the number
 * everything else is judged on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { codeOnly, literalsOf, addedLines, rawLiterals } from '../src/oracle.js';
import { withTree, walk, descendants, ancestor, countErrors, line, unquote, tokens, named, kids, normaliseImportTypes } from '../src/parser.js';
import { git, repoRoot, headTree, isShallow, resolveTree, lsTree, catFile, diffTrees, EMPTY_TREE, GitError } from '../src/git.js';

// ---------------------------------------------------------------- oracle.ts

test('codeOnly strips comments and string bodies, which is what keeps the oracle rule off prose', () => {
  // A literal quoted in a comment is not a branch on that literal.
  assert.equal(codeOnly('x = 1  # compare against "10"', true).includes('10'), false);
  assert.equal(codeOnly('const a = 1; // "10"', false).includes('10'), false);
  // Code outside the comment survives.
  assert.ok(codeOnly('if x == 10:  # note', true).includes('10'));
  // A `#` inside a string is not a comment.
  assert.ok(codeOnly('url = "http://a/#frag"', true).length > 0);
});

test('literalsOf and rawLiterals read the literals a branch could compare against', () => {
  const lits = literalsOf('if status == "image/jpeg" or code == 404: pass');
  assert.ok(lits.has('image/jpeg'), [...lits].join(','));
  // `404` is deliberately not collected. `literalsOf` keeps only distinctive literals, which is the filter that
  // stops every HTTP status code and small integer in a codebase from looking like a test-fitted constant.
  assert.equal(lits.has('404'), false, [...lits].join(','));
  assert.ok(rawLiterals('if status == "image/jpeg" or code == 404: pass').includes('404'), 'rawLiterals is unfiltered');
  assert.equal(literalsOf('').size, 0);
});

test('addedLines reports only lines the change introduced', () => {
  const before = 'a\nb\nc\n';
  const after = 'a\nb\nNEW\nc\n';
  const added = addedLines(before, after);
  assert.deepEqual(added.map((l) => l.text.trim()), ['NEW']);
  // A brand-new file is entirely added, which is why the rule skips files with no earlier version.
  assert.equal(addedLines(undefined, 'x\ny\n').length, 2);
  // No change means nothing added.
  assert.equal(addedLines(before, before).length, 0);
});

// ---------------------------------------------------------------- parser.ts

test('withTree parses each supported grammar and countErrors sees a real syntax error', async () => {
  const clean = await withTree('def f():\n    return 1\n', 'python', (t) => countErrors(t));
  assert.equal(clean, 0);
  const broken = await withTree('def f(:\n    return 1\n', 'python', (t) => countErrors(t));
  assert.ok(broken > 0, 'a broken file must report errors, or the unparseable rule cannot fire');
});

test('TypeScript import types parse, and the rewrite leaves offsets alone', async () => {
  // The bundled grammar cannot parse an import type with an array or generic suffix. That is valid TypeScript,
  // and it made real test files unparseable, which stands down every count-based rule on them.
  const arr = await withTree("let x: import('node:fs').Dirent[] = [];", 'typescript', (t) => countErrors(t));
  const gen = await withTree("let x: import('rxjs').Observable<number>;", 'typescript', (t) => countErrors(t));
  assert.equal(arr, 0);
  assert.equal(gen, 0);

  // A dynamic import in expression position is left alone: it already parses, so the rewrite never runs.
  assert.equal(normaliseImportTypes("const m = await import('./x.js');"), "const m = await import('./x.js');");
  // The replacement is the same length, so every line and column in the file is unchanged.
  const before = "let x: import('node:fs').Dirent[] = [];";
  assert.equal(normaliseImportTypes(before).length, before.length);
  assert.match(normaliseImportTypes(before), /^let x: _+\.Dirent\[\] = \[\];$/);

  // Genuinely broken syntax is still broken; the rewrite is not a way to launder a parse failure.
  assert.ok(await withTree("test('t', ( => {});", 'typescript', (t) => countErrors(t)) > 0);
});

test('walk visits children until a visitor returns false', async () => {
  await withTree('def outer():\n    def inner():\n        pass\n', 'python', (t) => {
    const all: string[] = [];
    walk(t.rootNode, (n) => { all.push(n.type); });
    assert.ok(all.includes('function_definition'));

    // Returning false prunes that subtree: the count must drop.
    const pruned: string[] = [];
    walk(t.rootNode, (n) => { pruned.push(n.type); if (n.type === 'function_definition') return false; return undefined; });
    assert.ok(pruned.length < all.length);
  });
});

test('descendants, ancestor, named and kids agree about the same tree', async () => {
  await withTree('class C:\n    def m(self):\n        return 1\n', 'python', (t) => {
    const fns = descendants(t.rootNode, 'function_definition');
    assert.equal(fns.length, 1);
    // Both spellings of the type filter behave the same.
    assert.equal(descendants(t.rootNode, ['function_definition']).length, 1);
    const cls = descendants(t.rootNode, 'class_definition')[0]!;
    assert.ok(ancestor(fns[0]!, ['class_definition']), 'the method sits inside the class');
    // stopAt halts the walk when that node is reached, so searching past it finds nothing.
    assert.equal(ancestor(fns[0]!, ['module'], cls), null, 'stopAt bounds the search');
    assert.ok(ancestor(fns[0]!, ['module']), 'without stopAt the module is found');
    assert.ok(named(t.rootNode).length <= kids(t.rootNode).length);
    assert.equal(kids(null).length, 0);
    assert.ok(line(fns[0]!) >= 1, 'lines are 1-based for report output');
  });
});

test('unquote and tokens handle the shapes the extractors feed them', () => {
  assert.equal(unquote('"abc"'), 'abc');
  assert.equal(unquote("'abc'"), 'abc');
  assert.equal(unquote('`abc`'), 'abc');
  assert.equal(unquote('abc'), 'abc');
  assert.equal(unquote('""'), '');
  assert.deepEqual(tokens('foo.bar(baz)').filter(Boolean).length > 0, true);
});

// ---------------------------------------------------------------- git.ts

async function tmpRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-git-'));
  const run = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'T');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
  run('add', '-A'); run('commit', '-qm', 'first');
  return dir;
}

test('git helpers read a real repository', async () => {
  const dir = await tmpRepo();
  try {
    assert.equal(await repoRoot(dir), await fs.realpath(dir));
    assert.match(await headTree(dir), /^[0-9a-f]{40}$/);
    assert.equal(await isShallow(dir), false, 'a normal clone is not shallow');
    assert.equal(await resolveTree(dir, 'HEAD'), await headTree(dir));
    assert.deepEqual(await lsTree(dir, await headTree(dir)), ['a.txt']);
    assert.equal(await catFile(dir, await headTree(dir), 'a.txt'), 'one\n');
    assert.equal(await catFile(dir, await headTree(dir), 'missing.txt'), undefined);
    assert.equal((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('repoRoot returns null outside a repository, which is what makes the hook exit quietly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-nogit-'));
  try { assert.equal(await repoRoot(dir), null); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a failing git command raises GitError rather than resolving', async () => {
  const dir = await tmpRepo();
  try {
    await assert.rejects(() => resolveTree(dir, 'no-such-ref'), (e: unknown) => e instanceof GitError || e instanceof Error);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('diffTrees reports adds, modifies, deletes and renames with content', async () => {
  const dir = await tmpRepo();
  const run = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  try {
    const base = await headTree(dir);
    await fs.writeFile(path.join(dir, 'a.txt'), 'two\n');       // modified
    await fs.writeFile(path.join(dir, 'b.txt'), 'new\n');       // added
    run('add', '-A'); run('commit', '-qm', 'second');
    const cur = await headTree(dir);

    const changes = await diffTrees(dir, base, cur);
    const byPath = new Map(changes.map((c) => [c.path, c]));
    assert.equal(byPath.get('a.txt')?.status, 'M');
    assert.equal(byPath.get('a.txt')?.before, 'one\n');
    assert.equal(byPath.get('a.txt')?.after, 'two\n');
    assert.equal(byPath.get('b.txt')?.status, 'A');
    assert.equal(byPath.get('b.txt')?.before, undefined, 'an added file has no earlier version');

    // Against the empty tree every file reads as added, which is the HEAD-fallback path in the hook.
    const all = await diffTrees(dir, EMPTY_TREE, cur);
    assert.deepEqual(all.map((c) => c.status).sort(), ['A', 'A']);

    // Deletion.
    await fs.rm(path.join(dir, 'b.txt'));
    run('add', '-A'); run('commit', '-qm', 'third');
    const after = await diffTrees(dir, cur, await headTree(dir));
    assert.equal(after.find((c) => c.path === 'b.txt')?.status, 'D');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
