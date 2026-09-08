#!/usr/bin/env node
// Turn a gatekeep verdict into GitHub Actions annotations and a job summary.
// Usage: node scripts/annotate.mjs <verdict.json>   (prints `decision=<x>` for $GITHUB_OUTPUT)
import fs from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: annotate.mjs <verdict.json>'); process.exit(2); }
let v;
try { v = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { console.error(`gatekeep: cannot read verdict: ${e.message}`); process.exit(2); }

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
const findings = v.checks?.testIntegrity?.findings ?? [];
const live = findings.filter((f) => !f.overridden);
const lifted = findings.filter((f) => f.overridden);

for (const f of live) {
  const level = f.severity === 'block' ? 'error' : 'warning';
  const where = [f.file && f.file !== '.' ? `file=${prop(f.file)}` : '', f.line ? `line=${f.line}` : '', `title=${prop(`gatekeep ${f.rule}`)}`].filter(Boolean).join(',');
  const text = f.test ? `[${f.test}] ${f.message}` : f.message;
  process.stderr.write(`::${level} ${where}::${esc(text)}\n`);
}
for (const f of lifted) process.stderr.write(`::notice ${f.file && f.file !== '.' ? `file=${prop(f.file)},` : ''}title=${prop(`gatekeep ${f.rule} (allowed)`)}::${esc(`lifted by ${f.overridden}`)}\n`);

const icon = v.decision === 'block' ? '🛑' : v.decision === 'warn' ? '⚠️' : '✅';
const rows = live.map((f) => `| ${f.severity} | \`${f.rule}\` | ${f.file}${f.line ? `:${f.line}` : ''}${f.test ? ` (${f.test})` : ''} | ${f.message.split('\n')[0].replace(/\|/g, '\\|').slice(0, 200)} |`);
const ot = v.checks?.originalTests;
const summary = [
  `## ${icon} gatekeep: ${v.decision.toUpperCase()}`,
  '',
  `${live.filter((f) => f.severity === 'block').length} blocking, ${live.filter((f) => f.severity === 'warn').length} warning(s), ${lifted.length} lifted by override. ${v.checks?.testIntegrity?.examined?.length ?? 0} test file(s) examined, ${v.checks?.testIntegrity?.changedSourceFiles?.length ?? 0} source file(s) changed.`,
  ot ? `\nOriginal tests against the new code: **${ot.status}**${ot.originalExit !== null ? ` (exit ${ot.originalExit}${ot.currentExit !== null ? `, edited tests exit ${ot.currentExit}` : ''})` : ''}.` : '',
  rows.length ? '\n| Severity | Rule | Where | Finding |\n|---|---|---|---|\n' + rows.join('\n') : '\nNo findings.',
  lifted.length ? '\n### Overrides\n' + lifted.map((f) => `- \`${f.rule}\` at ${f.file}: lifted by ${f.overridden}`).join('\n') : '',
  v.overrides?.length ? '\nAudit: ' + v.overrides.map((o) => `${o.rule} by ${o.by} via ${o.source}${o.reason ? ` ("${o.reason}")` : ''}`).join('; ') : '',
].filter((s) => s !== '').join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
else process.stderr.write(summary + '\n');
process.stdout.write(`decision=${v.decision}\n`);
