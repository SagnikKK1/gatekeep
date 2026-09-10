/**
 * Replays real commit history through the deterministic rules and writes down every verdict.
 *
 *   node scripts/corpus-fp.mjs <repo-path> [n]                 one local repository, aggregates to stdout
 *   node scripts/corpus-fp.mjs --set holdout --out out.jsonl   clone and replay a whole set from corpus.json
 *
 * Why it persists now: the previous version cloned, replayed, printed and exited, so there was no dataset and no
 * labels, only gatekeep's own verdicts, which is circular. It writes one JSONL line per commit — including commits
 * with no findings, so the denominator is in the file and not just in a summary someone has to trust — with the
 * repository, the pinned SHA, and a fingerprint of the rule configuration the run used. If the rules change later,
 * the fingerprint no longer matches and the file is visibly a record of a different gate.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { diffTrees, lsTree, BlobBatch } from '../dist/src/git.js';
import { analyze, isTestFile, DEFAULT_RULE_CONFIG, DEFAULT_SEVERITIES } from '../dist/src/rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Mirror what the CLI hands `analyze`: unchanged test files are not in the diff, but the oracle rule needs them.
async function baseTestFiles(repo, tree, changes) {
  const out = new Map();
  if (!changes.some((c) => !isTestFile(c.path, DEFAULT_RULE_CONFIG))) return out;
  let paths;
  try { paths = await lsTree(repo, tree); } catch { return out; }
  const inDiff = new Set(changes.map((c) => c.path));
  const want = paths.filter((p) => isTestFile(p, DEFAULT_RULE_CONFIG) && !inDiff.has(p)).slice(0, 400);
  if (!want.length) return out;
  const batch = new BlobBatch(repo);
  try {
    let bytes = 0;
    for (const p of want) {
      const b = await batch.read(tree, p).catch(() => null);
      if (!b || b.length > 512 * 1024) continue;
      bytes += b.length; if (bytes > 4 * 1024 * 1024) break;
      out.set(p, b.toString('utf8'));
    }
  } finally { batch.close(); }
  return out;
}

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/**
 * The rules a run was measured under. A later severity change or a new rule moves this, which is what makes a
 * stored result honest about what it is: a measurement of one gate, not of gatekeep in general.
 */
function rulesFingerprint() {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const h = createHash('sha256').update(JSON.stringify({ severities: DEFAULT_SEVERITIES, testGlobs: DEFAULT_RULE_CONFIG.testGlobs, ignoreGlobs: DEFAULT_RULE_CONFIG.ignoreGlobs, protectedGlobs: DEFAULT_RULE_CONFIG.protectedGlobs })).digest('hex');
  return { version: pkg.version, rules: Object.keys(DEFAULT_SEVERITIES).length, sha256: h.slice(0, 16) };
}

/** Replay the last `n` first-parent commits. Calls `onCommit` with a record for every commit, findings or not. */
async function replay(repo, n, onCommit) {
  const commits = git(repo, ['rev-list', '--first-parent', '-n', String(n), 'HEAD']).split('\n').filter(Boolean);
  const agg = { commits: 0, skipped: 0, commitsTouchingTests: 0, commitsWithFindings: 0, commitsWithBlocks: 0, blockingCommitsTouchingTests: 0, findings: 0, byRule: {}, blockingByRule: {}, blockingCommitsByRule: {} };
  for (const c of commits) {
    let tree, ptree;
    // The oldest commit in a shallow clone has no parent to diff against; that is a skip, not a clean commit.
    try { tree = git(repo, ['rev-parse', `${c}^{tree}`]); ptree = git(repo, ['rev-parse', `${c}^^{tree}`]); }
    catch { agg.skipped++; continue; }
    const changes = await diffTrees(repo, ptree, tree);
    const touchesTests = changes.some((x) => isTestFile(x.path, DEFAULT_RULE_CONFIG) || (x.oldPath !== undefined && isTestFile(x.oldPath, DEFAULT_RULE_CONFIG)));
    const r = await analyze(changes, undefined, { baseTestFiles: await baseTestFiles(repo, ptree, changes) });
    const findings = r.findings.map((f) => ({ rule: f.rule, severity: f.severity, file: f.file, line: f.line, test: f.test, message: f.message.slice(0, 300) }));
    const blocks = findings.filter((f) => f.severity === 'block');

    agg.commits++;
    if (touchesTests) agg.commitsTouchingTests++;
    if (findings.length) agg.commitsWithFindings++;
    if (blocks.length) { agg.commitsWithBlocks++; if (touchesTests) agg.blockingCommitsTouchingTests++; }
    // Findings cluster hard — one merge can delete eleven tests — so count commits per rule as well as findings.
    for (const rule of new Set(blocks.map((b) => b.rule))) agg.blockingCommitsByRule[rule] = (agg.blockingCommitsByRule[rule] ?? 0) + 1;
    agg.findings += findings.length;
    for (const f of findings) {
      agg.byRule[f.rule] = (agg.byRule[f.rule] ?? 0) + 1;
      if (f.severity === 'block') agg.blockingByRule[f.rule] = (agg.blockingByRule[f.rule] ?? 0) + 1;
    }
    onCommit?.({ commit: c, changedFiles: changes.length, touchesTests, findings });
  }
  return agg;
}

/** Shallow enough to be quick, deep enough that 300 first-parent commits all have a parent to diff against. */
function clone(url, dir, depth) {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--depth', String(depth), '--single-branch', url, dir], { stdio: ['ignore', 'ignore', 'inherit'] });
}

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i === -1 ? dflt : argv[i + 1]; };

if (argv[0] && !argv[0].startsWith('--')) {
  // Single local repository, the original interface.
  const agg = await replay(argv[0], parseInt(argv[1] ?? '200', 10), null);
  console.log(JSON.stringify({ repo: argv[0], ...agg }, null, 1));
} else {
  const setName = flag('set', 'holdout');
  const n = parseInt(flag('n', '300'), 10);
  const cache = flag('cache', path.join(os.homedir(), 'gatekeep-data', 'corpus'));
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'corpus.json'), 'utf8'));
  const repos = manifest[setName];
  if (!repos) throw new Error(`no set "${setName}" in corpus.json (have: ${Object.keys(manifest).join(', ')})`);
  const out = flag('out', path.join(HERE, '..', 'docs', 'corpus', `${setName}-${new Date().toISOString().slice(0, 10)}.jsonl`));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const fp = rulesFingerprint();
  const stream = fs.createWriteStream(out);
  const write = (o) => stream.write(JSON.stringify(o) + '\n');
  write({ kind: 'run', set: setName, commitsPerRepo: n, date: new Date().toISOString(), gatekeep: fp, selection: manifest.rule ?? null });

  const summary = [];
  for (const r of repos) {
    const url = r.url ?? `https://github.com/${r.repo}.git`;
    const dir = path.join(cache, r.repo.replace('/', '__'));
    process.stderr.write(`${r.repo}: cloning\n`);
    clone(url, dir, n + 100);
    const head = git(dir, ['rev-parse', 'HEAD']);
    process.stderr.write(`${r.repo}: replaying ${n} commits from ${head.slice(0, 8)}\n`);
    const agg = await replay(dir, n, (rec) => write({ kind: 'commit', repo: r.repo, ...rec }));
    write({ kind: 'repo', repo: r.repo, lang: r.lang, head, ...agg });
    summary.push({ repo: r.repo, lang: r.lang, head: head.slice(0, 8), ...agg });
    process.stderr.write(`${r.repo}: ${agg.commitsWithBlocks}/${agg.commits} commits would block (${agg.commitsTouchingTests} touched tests)\n`);
  }
  stream.end();

  const totals = summary.reduce((a, s) => ({
    commits: a.commits + s.commits, touching: a.touching + s.commitsTouchingTests,
    withBlocks: a.withBlocks + s.commitsWithBlocks, findings: a.findings + s.findings,
  }), { commits: 0, touching: 0, withBlocks: 0, findings: 0 });
  console.log(JSON.stringify({ set: setName, out, gatekeep: fp, totals, repos: summary }, null, 1));
}
