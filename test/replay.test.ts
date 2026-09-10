/**
 * Coverage for `src/replay.ts` and the `gatekeep calibrate` command built on it.
 *
 * The thing worth testing here is not the arithmetic, it is the promise: calibrate tells a user what the gate would
 * have done to their own history, so the replay has to agree with the live gate rather than approximate it. It also
 * has to keep counting commits it cannot analyse, because a denominator that quietly shrinks is how a blocking rate
 * gets understated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { replay, baseTestFiles } from '../src/replay.js';
import { defaultConfig, parseConfig } from '../src/config.js';
import { headTree } from '../src/git.js';

/**
 * A real AWS-shaped key: `secret-introduced` blocks by default, which makes it the cheap way to force a block.
 * Split across a concatenation on purpose. Written as one literal it matches the rule's own pattern, and gatekeep
 * blocks this file when run on itself — a test corpus that trips the gate it is testing is a bad trade.
 */
const KEY = 'AKIA' + 'QZ7TBRWXYVCDMNPK';

interface Repo { dir: string; write: (p: string, s: string) => Promise<void>; commit: (m: string) => void }
async function tmpRepo(): Promise<Repo> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-replay-'));
  const run = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'T');
  return {
    dir,
    write: async (p: string, s: string) => {
      await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
      await fs.writeFile(path.join(dir, p), s);
    },
    commit: (m: string) => { run('add', '-A'); run('commit', '-qm', m); },
  };
}

test('replay counts every commit, including the root commit it cannot diff', async () => {
  const r = await tmpRepo();
  try {
    await r.write('app/a.py', 'X = 0\n');
    r.commit('base');
    for (let i = 1; i <= 3; i++) { await r.write('app/a.py', `X = ${i}\n`); r.commit(`change ${i}`); }
    const t = await replay(r.dir, defaultConfig(), { n: 100 });
    // Four commits exist; the root has no parent, so it is skipped and *reported*, never dropped from the count.
    assert.equal(t.commits, 3);
    assert.equal(t.skipped, 1);
    assert.equal(t.commitsWithBlocks, 0);
  } finally { await fs.rm(r.dir, { recursive: true, force: true }); }
});

test('replay finds the commits the gate would have blocked, and names the rule', async () => {
  const r = await tmpRepo();
  try {
    await r.write('app/a.py', 'X = 0\n');
    r.commit('base');
    await r.write('app/a.py', 'X = 0\ndef f(): return 1\n');
    r.commit('honest');
    await r.write('app/a.py', `X = 0\ndef f(): return 1\nK = "${KEY}"\n`);
    r.commit('leaks a key');

    const seen: { sha: string; subject: string; decision: string }[] = [];
    const t = await replay(r.dir, defaultConfig(), { n: 100, onCommit: (c) => seen.push({ sha: c.sha, subject: c.subject, decision: c.decision }) });
    assert.equal(t.commits, 2);
    assert.equal(t.commitsWithBlocks, 1);
    assert.equal(t.blockingCommitsByRule['secret-introduced'], 1);
    // Every commit reaches onCommit, not only the blocking ones: the denominator has to be in the stream too.
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((s) => s.decision).sort(), ['block', 'pass']);
    assert.equal(seen.find((s) => s.decision === 'block')?.subject, 'leaks a key');
  } finally { await fs.rm(r.dir, { recursive: true, force: true }); }
});

test('a rule set to warn cannot interrupt anything, so it never counts as a block', async () => {
  const r = await tmpRepo();
  try {
    await r.write('app/a.py', 'X = 0\n');
    r.commit('base');
    await r.write('app/a.py', `X = 0\nK = "${KEY}"\n`);
    r.commit('leaks a key');
    const cfg = defaultConfig();
    cfg.rules.severities['secret-introduced'] = 'warn';
    const t = await replay(r.dir, cfg, { n: 100 });
    assert.equal(t.commitsWithBlocks, 0, 'downgraded rules stop interrupting');
    assert.equal(t.commitsWithFindings, 1, 'but the finding is still reported');
    assert.equal(t.blockingCommitsByRule['secret-introduced'], undefined);
  } finally { await fs.rm(r.dir, { recursive: true, force: true }); }
});

test('strict promotes warnings to interruptions, and credits the rule that did it', async () => {
  const r = await tmpRepo();
  try {
    await r.write('app/a.py', 'X = 0\n');
    r.commit('base');
    await r.write('app/a.py', `X = 0\nK = "${KEY}"\n`);
    r.commit('leaks a key');
    const cfg = defaultConfig();
    cfg.rules.severities['secret-introduced'] = 'warn';
    cfg.strict = true;
    const t = await replay(r.dir, cfg, { n: 100 });
    assert.equal(t.commitsWithBlocks, 1, 'under strict a warning ends the session');
    assert.equal(t.blockingCommitsByRule['secret-introduced'], 1);
  } finally { await fs.rm(r.dir, { recursive: true, force: true }); }
});

test('n bounds the walk, so calibrate on a long history stays a bounded amount of work', async () => {
  const r = await tmpRepo();
  try {
    await r.write('app/a.py', 'X = 0\n');
    r.commit('base');
    for (let i = 1; i <= 6; i++) { await r.write('app/a.py', `X = ${i}\n`); r.commit(`change ${i}`); }
    const t = await replay(r.dir, defaultConfig(), { n: 3 });
    assert.equal(t.commits + t.skipped, 3);
  } finally { await fs.rm(r.dir, { recursive: true, force: true }); }
});

test('baseTestFiles reads the tests the oracle rule needs and skips the ones already in the diff', async () => {
  const r = await tmpRepo();
  try {
    await r.write('app/a.py', 'X = 0\n');
    await r.write('tests/test_a.py', 'def test_a():\n    assert 1 == 1\n');
    await r.write('tests/test_b.py', 'def test_b():\n    assert 2 == 2\n');
    r.commit('base');
    const tree = await headTree(r.dir);
    const cfg = defaultConfig();
    // A source change with one test file already in the diff: the other test still has to be loaded.
    const got = await baseTestFiles(r.dir, tree, cfg, [{ path: 'app/a.py' }, { path: 'tests/test_a.py' }]);
    assert.deepEqual([...got.keys()], ['tests/test_b.py']);
    // No source in the diff means the oracle rule has nothing to do, so nothing is read at all.
    assert.equal((await baseTestFiles(r.dir, tree, cfg, [{ path: 'tests/test_a.py' }])).size, 0);
  } finally { await fs.rm(r.dir, { recursive: true, force: true }); }
});

test('a config written by `calibrate --apply` parses back with the rules downgraded', () => {
  // The applied file has to survive parseConfig, `//` comment key and all, or the next run reports config-invalid.
  const written = JSON.stringify({
    maxBlocks: 3,
    '// rules': 'secret-introduced downgraded to "warn" by `gatekeep calibrate --apply`',
    rules: { 'secret-introduced': 'warn' },
  }, null, 2);
  const { cfg, problems } = parseConfig(written);
  assert.deepEqual(problems, []);
  assert.equal(cfg.rules.severities['secret-introduced'], 'warn');
});
