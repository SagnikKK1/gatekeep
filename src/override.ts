import type { Finding } from './model.js';
import { git } from './git.js';

/**
 * Roadmap item 5a: per-change override with an audit trail.
 * A directive such as `gatekeep: allow test-deleted -- feature removed per ticket 123` lifts one rule for one change.
 * Sources are ranked by who can write them: the human's prompts in a session, commit trailers and the CLI flag when a
 * human or CI runs the gate. Nothing the agent writes on its own (a commit it makes mid-session) counts in a session.
 */

export interface Override {
  rule: string;
  source: 'prompt' | 'commit' | 'cli' | 'env';
  by: string;
  reason?: string;
}

/** Rules no override can lift. */
export const UNLIFTABLE = new Set(['gate-config-changed']);

const DIRECTIVE = /(?:^|\n)\s*(?:gatekeep\s*:\s*allow|gatekeep-allow\s*:|gatekeep\s+allow)\s+([a-z][a-z0-9-]*(?:\s*,\s*[a-z][a-z0-9-]*)*)\s*(?:--\s*(.+?))?\s*(?=\n|$)/gi;

/** Extract `gatekeep: allow rule[, rule] [-- reason]` directives from free text. */
export function parseDirectives(text: string): { rule: string; reason?: string }[] {
  const out: { rule: string; reason?: string }[] = [];
  for (const m of text.matchAll(DIRECTIVE)) {
    const reason = m[2]?.trim();
    for (const r of m[1]!.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) out.push(reason ? { rule: r, reason } : { rule: r });
  }
  return out;
}

export function overridesFromPrompts(prompts: string[], by = 'user'): Override[] {
  return prompts.flatMap((p) => parseDirectives(p).map((d) => ({ rule: d.rule, source: 'prompt' as const, by, ...(d.reason ? { reason: d.reason } : {}) })));
}

export function overridesFromCli(allow: string | undefined, by = 'cli'): Override[] {
  if (!allow) return [];
  return allow.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean).map((rule) => ({ rule, source: 'cli' as const, by }));
}

/** Trailers in the commits between `base` and HEAD, attributed to each commit's author. */
export async function overridesFromCommits(root: string, base: string): Promise<Override[]> {
  let log = '';
  try { log = await git(root, ['log', '--format=%x1e%an <%ae>%x1f%B', `${base}..HEAD`]); } catch { return []; }
  const out: Override[] = [];
  for (const rec of log.split('\x1e').filter((s) => s.trim())) {
    const [by, body] = rec.split('\x1f', 2);
    for (const d of parseDirectives(body ?? '')) out.push({ rule: d.rule, source: 'commit', by: (by ?? '').trim(), ...(d.reason ? { reason: d.reason } : {}) });
  }
  return out;
}

/** Mark findings covered by an override. They stay in the verdict but no longer decide it. Returns the overrides actually used. */
export function applyOverrides(findings: Finding[], overrides: Override[]): Override[] {
  const used: Override[] = [];
  for (const f of findings) {
    if (UNLIFTABLE.has(f.rule)) continue;
    const o = overrides.find((x) => x.rule === f.rule || x.rule === 'all');
    if (!o) continue;
    f.overridden = `${o.by} via ${o.source}${o.reason ? `: ${o.reason}` : ''}`;
    if (!used.includes(o)) used.push(o);
  }
  return used;
}
