import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_RULE_CONFIG, DEFAULT_SEVERITIES, type RuleConfig } from './rules.js';
import type { Severity } from './model.js';

export interface GatekeepConfig {
  rules: RuleConfig;
  /** How many times the Stop hook may block one session before it gives up and lets the human decide. */
  maxBlocks: number;
  /** Treat warnings as blocking. */
  strict: boolean;
}

export const CONFIG_FILENAME = 'gatekeep.config.json';

export function defaultConfig(): GatekeepConfig {
  return { rules: { ...DEFAULT_RULE_CONFIG, severities: { ...DEFAULT_RULE_CONFIG.severities } }, maxBlocks: 3, strict: false };
}

/**
 * Parse config text. Never throws and never disables the gate: a broken file yields the defaults plus a list of problems
 * the caller surfaces as findings. Unknown rule names are reported rather than silently ignored.
 */
export function parseConfig(raw: string | null | undefined): { cfg: GatekeepConfig; problems: string[] } {
  const cfg = defaultConfig();
  const problems: string[] = [];
  if (raw === null || raw === undefined || raw.trim() === '') return { cfg, problems };
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw) as Record<string, unknown>; }
  catch (e) { problems.push(`invalid JSON (${(e as Error).message}); using defaults`); return { cfg, problems }; }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) { problems.push('top level must be an object; using defaults'); return { cfg, problems }; }
  const strs = (k: string): string[] | null => Array.isArray(j[k]) && (j[k] as unknown[]).every((x) => typeof x === 'string') ? (j[k] as string[]) : (j[k] !== undefined ? (problems.push(`"${k}" must be an array of strings`), null) : null);
  const tg = strs('testGlobs'); if (tg) cfg.rules.testGlobs = tg;
  const etg = strs('extraTestGlobs'); if (etg) cfg.rules.testGlobs = [...cfg.rules.testGlobs, ...etg];
  const tcg = strs('testConfigGlobs'); if (tcg) cfg.rules.testConfigGlobs = tcg;
  const ig = strs('ignore'); if (ig) cfg.rules.ignoreGlobs = [...cfg.rules.ignoreGlobs, ...ig];
  if (j.assertionDropTolerance !== undefined) { if (typeof j.assertionDropTolerance === 'number') cfg.rules.assertionDropTolerance = j.assertionDropTolerance; else problems.push('"assertionDropTolerance" must be a number'); }
  if (j.maxBlocks !== undefined) { if (typeof j.maxBlocks === 'number' && j.maxBlocks >= 0) cfg.maxBlocks = j.maxBlocks; else problems.push('"maxBlocks" must be a non-negative number'); }
  if (j.strict !== undefined) { if (typeof j.strict === 'boolean') cfg.strict = j.strict; else problems.push('"strict" must be a boolean'); }
  if (j.rules !== undefined) {
    if (j.rules && typeof j.rules === 'object' && !Array.isArray(j.rules)) {
      for (const [k, v] of Object.entries(j.rules as Record<string, unknown>)) {
        if (!(k in DEFAULT_SEVERITIES)) { problems.push(`unknown rule "${k}"`); continue; }
        if (v === 'block' || v === 'warn' || v === 'off') cfg.rules.severities[k] = v as Severity;
        else problems.push(`rule "${k}" must be "block", "warn" or "off"`);
      }
    } else problems.push('"rules" must be an object');
  }
  const known = new Set(['$schema', 'testGlobs', 'extraTestGlobs', 'testConfigGlobs', 'ignore', 'assertionDropTolerance', 'maxBlocks', 'strict', 'rules']);
  for (const k of Object.keys(j)) if (!known.has(k)) problems.push(`unknown key "${k}"`);
  return { cfg, problems };
}

export async function readConfigText(root: string): Promise<string | null> {
  try { return await fs.readFile(path.join(root, CONFIG_FILENAME), 'utf8'); } catch { return null; }
}

export function defaultConfigText(): string {
  return JSON.stringify({
    maxBlocks: 3,
    strict: false,
    extraTestGlobs: [],
    ignore: [],
    rules: { ...DEFAULT_RULE_CONFIG.severities },
  }, null, 2) + '\n';
}
