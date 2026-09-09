import { execFileSync } from 'node:child_process';
import { diffTrees, lsTree, BlobBatch } from '../dist/src/git.js';
import { analyze, isTestFile, DEFAULT_RULE_CONFIG } from '../dist/src/rules.js';

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
const repo = process.argv[2]; const n = parseInt(process.argv[3] ?? '200', 10);
const commits = execFileSync('git', ['rev-list', '--first-parent', '-n', String(n), 'HEAD'], { cwd: repo }).toString().trim().split('\n');
const byRule = {}; let total = 0, commitsWithFindings = 0, commitsTouchingTests = 0;
const samples = [];
for (const c of commits) {
  let parent; try { parent = execFileSync('git', ['rev-parse', `${c}^{tree}`], { cwd: repo }).toString().trim(); } catch { continue; }
  let ptree; try { ptree = execFileSync('git', ['rev-parse', `${c}^^{tree}`], { cwd: repo }).toString().trim(); } catch { continue; }
  const changes = await diffTrees(repo, ptree, parent);
  if (changes.some((x) => /test/i.test(x.path))) commitsTouchingTests++;
  const r = await analyze(changes, undefined, { baseTestFiles: await baseTestFiles(repo, ptree, changes) });
  if (r.findings.length) commitsWithFindings++;
  for (const f of r.findings) {
    total++; byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
    if (samples.length < 60) samples.push({ commit: c.slice(0, 8), ...f, message: f.message.slice(0, 140), before: undefined, after: undefined });
  }
}
console.log(JSON.stringify({ repo, commits: commits.length, commitsTouchingTests, commitsWithFindings, total, byRule }, null, 1));
for (const s of samples) console.log(`${s.commit} [${s.severity}] ${s.rule} ${s.file}${s.line ? ':' + s.line : ''} ${s.test ? '[' + s.test + ']' : ''} — ${s.message}`);
