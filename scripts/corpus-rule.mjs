import { execFileSync } from 'node:child_process';
import { diffTrees } from '../dist/src/git.js';
import { analyze } from '../dist/src/rules.js';
const repo = process.argv[2]; const n = parseInt(process.argv[3] ?? '300', 10); const rules = new Set(process.argv[4].split(','));
const commits = execFileSync('git', ['rev-list', '--first-parent', '-n', String(n), 'HEAD'], { cwd: repo }).toString().trim().split('\n');
for (const c of commits) {
  let t, p; try { t = execFileSync('git', ['rev-parse', `${c}^{tree}`], { cwd: repo }).toString().trim(); p = execFileSync('git', ['rev-parse', `${c}^^{tree}`], { cwd: repo }).toString().trim(); } catch { continue; }
  const r = await analyze(await diffTrees(repo, p, t));
  for (const f of r.findings) if (rules.has(f.rule)) console.log(`${c.slice(0,8)} ${f.rule} ${f.file}:${f.line ?? ''} [${f.test ?? ''}] ${f.message.slice(0,120)}${f.before ? '\n   before: ' + f.before.slice(0,150) : ''}${f.after ? '\n   after:  ' + f.after.slice(0,150) : ''}`);
}
