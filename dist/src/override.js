import { git } from './git.js';
/** Rules no override can lift. */
export const UNLIFTABLE = new Set(['gate-config-changed']);
const DIRECTIVE = /(?:^|\n)\s*(?:gatekeep\s*:\s*allow|gatekeep-allow\s*:|gatekeep\s+allow)\s+([a-z][a-z0-9-]*(?:\s*,\s*[a-z][a-z0-9-]*)*)\s*(?:--\s*(.+?))?\s*(?=\n|$)/gi;
/** Extract `gatekeep: allow rule[, rule] [-- reason]` directives from free text. */
export function parseDirectives(text) {
    const out = [];
    for (const m of text.matchAll(DIRECTIVE)) {
        const reason = m[2]?.trim();
        for (const r of m[1].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))
            out.push(reason ? { rule: r, reason } : { rule: r });
    }
    return out;
}
export function overridesFromPrompts(prompts, by = 'user') {
    return prompts.flatMap((p) => parseDirectives(p).map((d) => ({ rule: d.rule, source: 'prompt', by, ...(d.reason ? { reason: d.reason } : {}) })));
}
export function overridesFromCli(allow, by = 'cli') {
    if (!allow)
        return [];
    return allow.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean).map((rule) => ({ rule, source: 'cli', by }));
}
/** Trailers in the commits between `base` and HEAD, attributed to each commit's author. */
export async function overridesFromCommits(root, base) {
    let log = '';
    try {
        log = await git(root, ['log', '--format=%x1e%an <%ae>%x1f%B', `${base}..HEAD`]);
    }
    catch {
        return [];
    }
    const out = [];
    for (const rec of log.split('\x1e').filter((s) => s.trim())) {
        const [by, body] = rec.split('\x1f', 2);
        for (const d of parseDirectives(body ?? ''))
            out.push({ rule: d.rule, source: 'commit', by: (by ?? '').trim(), ...(d.reason ? { reason: d.reason } : {}) });
    }
    return out;
}
/** Mark findings covered by an override. They stay in the verdict but no longer decide it. Returns the overrides actually used. */
export function applyOverrides(findings, overrides) {
    const used = [];
    for (const f of findings) {
        if (UNLIFTABLE.has(f.rule))
            continue;
        const o = overrides.find((x) => x.rule === f.rule || x.rule === 'all');
        if (!o)
            continue;
        f.overridden = `${o.by} via ${o.source}${o.reason ? `: ${o.reason}` : ''}`;
        if (!used.includes(o))
            used.push(o);
    }
    return used;
}
//# sourceMappingURL=override.js.map