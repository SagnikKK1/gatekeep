import { execFileSync } from 'node:child_process';
import { diffTrees, lsTree, BlobBatch } from '../dist/src/git.js';
import { analyze, isTestFile, DEFAULT_RULE_CONFIG } from '../dist/src/rules.js';

async function baseTestFiles(repo, tree, changes) {
  const out = new Map();
  if (!changes.some((c) => !isTestFile(c.path, DEFAULT_RULE_CONFIG))) return out;
  let paths; try { paths = await lsTree(repo, tree); } catch { return out; }
  const inDiff = new Set(changes.map((c) => c.path));
  const want = paths.filter((p) => isTestFile(p, DEFAULT_RULE_CONFIG) && !inDiff.has(p)).slice(0, 400);
  if (!want.length) return out;
  const batch = new BlobBatch(repo);
  try { let bytes = 0; for (const p of want) { const b = await batch.read(tree, p).catch(() => null); if (!b || b.length > 512 * 1024) continue; bytes += b.length; if (bytes > 4 * 1024 * 1024) break; out.set(p, b.toString('utf8')); } } finally { batch.close(); }
  return out;
}
const repo = process.argv[2]; const n = parseInt(process.argv[3] ?? '300', 10); const rules = new Set(process.argv[4].split(','));
const commits = execFileSync('git', ['rev-list', '--first-parent', '-n', String(n), 'HEAD'], { cwd: repo }).toString().trim().split('\n');
for (const c of commits) {
  let t, p; try { t = execFileSync('git', ['rev-parse', `${c}^{tree}`], { cwd: repo }).toString().trim(); p = execFileSync('git', ['rev-parse', `${c}^^{tree}`], { cwd: repo }).toString().trim(); } catch { continue; }
  const changes = await diffTrees(repo, p, t);
  const r = await analyze(changes, undefined, { baseTestFiles: await baseTestFiles(repo, p, changes) });
  for (const f of r.findings) if (rules.has(f.rule)) console.log(`${c.slice(0,8)} ${f.rule} ${f.file}:${f.line ?? ''} [${f.test ?? ''}] ${f.message.slice(0,120)}${f.before ? '\n   before: ' + f.before.slice(0,150) : ''}${f.after ? '\n   after:  ' + f.after.slice(0,150) : ''}`);
}
