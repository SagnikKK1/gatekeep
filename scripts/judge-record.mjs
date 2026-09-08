#!/usr/bin/env node
// Record live judge responses for the fixtures under test/fixtures/judge/ so `npm test` can replay them offline.
// Usage: node scripts/judge-record.mjs [fixture-name ...]   (needs ANTHROPIC_API_KEY or an `ant auth login` profile; run `npm run build` first)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, promptHash, anthropicProvider, SYSTEM_PROMPT, OUTPUT_SCHEMA, DEFAULT_JUDGE_MODEL } from '../dist/src/judge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'test', 'fixtures', 'judge');
const model = process.env.GATEKEEP_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
const only = process.argv.slice(2);
const names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).filter((n) => only.length === 0 || only.includes(n));
for (const name of names) {
  const input = JSON.parse(await fs.readFile(path.join(dir, name, 'input.json'), 'utf8'));
  const { user } = buildPrompt(input);
  const hash = promptHash(SYSTEM_PROMPT, user, model);
  process.stdout.write(`${name}: calling ${model}… `);
  const t0 = Date.now();
  const res = await anthropicProvider({ model, effort: 'high', system: SYSTEM_PROMPT, user, schema: OUTPUT_SCHEMA });
  const out = { source: 'live', model: res.model, promptHash: hash, recordedAt: new Date().toISOString(), usage: res.usage, raw: res.raw };
  await fs.writeFile(path.join(dir, name, 'response.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s, ${res.raw.length} bytes`);
}
