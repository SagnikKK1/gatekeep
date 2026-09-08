import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/rules.js';
import type { FileChange, Finding } from '../src/model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', '..', 'fixtures');

async function walk(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let entries: import('node:fs').Dirent[] = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, await walk(path.join(dir, e.name), rel));
    else out[rel] = await fs.readFile(path.join(dir, e.name), 'utf8');
  }
  return out;
}

/** Build FileChange[] from before/after directories, detecting a rename when a deleted file's content reappears at a new path. */
export function diffDirs(before: Record<string, string>, after: Record<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  const added = Object.keys(after).filter((p) => !(p in before));
  const deleted = Object.keys(before).filter((p) => !(p in after));
  const renamed = new Set<string>();
  for (const d of deleted) {
    const match = added.find((a) => after[a] === before[d] && !renamed.has(a));
    if (match) { renamed.add(match); changes.push({ path: match, oldPath: d, status: 'R', before: before[d], after: after[match] }); }
    else changes.push({ path: d, status: 'D', before: before[d] });
  }
  for (const a of added) if (!renamed.has(a)) changes.push({ path: a, status: 'A', after: after[a] });
  for (const p of Object.keys(before)) if (p in after && before[p] !== after[p]) changes.push({ path: p, status: 'M', before: before[p], after: after[p] });
  return changes;
}

interface Expected { rule: string; file: string; test?: string; severity?: string }
const key = (f: Expected | Finding) => `${f.rule}|${f.file}|${f.test ?? ''}`;

const names = (await fs.readdir(FIXTURES, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
for (const name of names) {
  test(`fixture ${name}`, async () => {
    const dir = path.join(FIXTURES, name);
    const before = await walk(path.join(dir, 'before'));
    const after = await walk(path.join(dir, 'after'));
    const expected = JSON.parse(await fs.readFile(path.join(dir, 'expected.json'), 'utf8')) as { findings: Expected[] };
    const result = await analyze(diffDirs(before, after), undefined, { exists: (p) => p in after });
    const got = result.findings.map(key).sort();
    const want = expected.findings.map(key).sort();
    assert.deepEqual(got, want, `findings mismatch\n got: ${JSON.stringify(result.findings, null, 1)}`);
    for (const e of expected.findings) {
      if (!e.severity) continue;
      const f = result.findings.find((x) => key(x) === key(e));
      assert.equal(f?.severity, e.severity, `severity of ${key(e)}`);
    }
  });
}
