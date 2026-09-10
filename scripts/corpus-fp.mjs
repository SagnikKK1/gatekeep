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
import { replay as replayCommits } from '../dist/src/replay.js';
import { DEFAULT_RULE_CONFIG, DEFAULT_SEVERITIES } from '../dist/src/rules.js';
import { defaultConfig } from '../dist/src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Replay the last `n` first-parent commits. The loop itself lives in `src/replay.ts` and is the same code the
 * shipped `gatekeep calibrate` runs, so a number measured here is a number a user would see on their own history.
 * Measured under the *default* configuration, never a repository's own `gatekeep.config.json`: the corpus is a
 * measurement of the gate we ship, not of whatever each repository would have configured.
 */
async function replay(repo, n, onCommit) {
  const cfg = defaultConfig();
  const t = await replayCommits(repo, cfg, {
    n,
    onCommit: (c) => onCommit?.({
      commit: c.sha, changedFiles: c.changedFiles, touchesTests: c.touchesTests,
      findings: c.findings.map((f) => ({ rule: f.rule, severity: f.severity, file: f.file, line: f.line, test: f.test, message: f.message.slice(0, 300) })),
    }),
  });
  // The stored schema predates src/replay.ts and docs/corpus/*.jsonl is written against it; keep the key names.
  return {
    commits: t.commits, skipped: t.skipped, commitsTouchingTests: t.commitsTouchingTests,
    commitsWithFindings: t.commitsWithFindings, commitsWithBlocks: t.commitsWithBlocks,
    blockingCommitsTouchingTests: t.blockingCommitsTouchingTests, findings: t.findings,
    byRule: t.findingsByRule, blockingByRule: t.blockingFindingsByRule, blockingCommitsByRule: t.blockingCommitsByRule,
  };
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
