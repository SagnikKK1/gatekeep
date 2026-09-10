import fs from 'node:fs/promises';
import path from 'node:path';
import { repoStateDir, writeAtomic } from './session.js';
export const DEFAULT_SHADOW_DAYS = 7;
export const DEFAULT_SHADOW_SESSIONS = 10;
/** Enough ids to satisfy any sane session limit without letting the file grow without bound. */
const MAX_TRACKED_SESSIONS = 500;
export function defaultShadow(now = new Date()) {
    return { startedAt: now.toISOString().slice(0, 10), days: DEFAULT_SHADOW_DAYS, sessions: DEFAULT_SHADOW_SESSIONS };
}
function stateFile(root) { return path.join(repoStateDir(root), 'shadow.json'); }
export function emptyState() { return { sessions: [], stops: 0, wouldHaveBlocked: 0, rules: {} }; }
export async function readShadowState(root) {
    try {
        const j = JSON.parse(await fs.readFile(stateFile(root), 'utf8'));
        return {
            sessions: Array.isArray(j.sessions) ? j.sessions.filter((x) => typeof x === 'string') : [],
            stops: typeof j.stops === 'number' ? j.stops : 0,
            wouldHaveBlocked: typeof j.wouldHaveBlocked === 'number' ? j.wouldHaveBlocked : 0,
            rules: j.rules && typeof j.rules === 'object' && !Array.isArray(j.rules) ? j.rules : {},
        };
    }
    catch {
        return emptyState();
    }
}
export async function writeShadowState(root, s) {
    await fs.mkdir(repoStateDir(root), { recursive: true });
    await writeAtomic(stateFile(root), JSON.stringify(s, null, 2) + '\n');
}
/** Record one stop. Returns the state as it now stands, so the caller can report against it in the same breath. */
export async function recordStop(root, sessionId, wouldBlock, rules) {
    const s = await readShadowState(root);
    s.stops += 1;
    if (!s.sessions.includes(sessionId))
        s.sessions = [...s.sessions, sessionId].slice(-MAX_TRACKED_SESSIONS);
    if (wouldBlock) {
        s.wouldHaveBlocked += 1;
        for (const r of new Set(rules))
            s.rules[r] = (s.rules[r] ?? 0) + 1;
    }
    await writeShadowState(root, s);
    return s;
}
export function statusOf(cfg, st, now = new Date()) {
    let daysLeft = null;
    if (cfg.days !== null) {
        const started = Date.parse(cfg.startedAt + 'T00:00:00Z');
        // An unparseable start date must not silently mean "never expires": treat it as expired and let the user re-arm.
        daysLeft = Number.isNaN(started) ? 0 : Math.ceil(cfg.days - (now.getTime() - started) / 86_400_000);
    }
    const sessionsLeft = cfg.sessions === null ? null : cfg.sessions - st.sessions.length;
    const byDays = daysLeft !== null && daysLeft <= 0;
    const bySessions = sessionsLeft !== null && sessionsLeft <= 0;
    return {
        elapsed: byDays || bySessions,
        daysLeft: daysLeft === null ? null : Math.max(0, daysLeft),
        sessionsLeft: sessionsLeft === null ? null : Math.max(0, sessionsLeft),
        endedBy: bySessions ? 'sessions' : byDays ? 'days' : null,
    };
}
/** The line the human sees under a report that shadow mode kept from blocking. */
export function shadowNote(cfg, st, status) {
    if (!status.elapsed) {
        const left = [
            status.daysLeft !== null ? `${status.daysLeft} day(s)` : null,
            status.sessionsLeft !== null ? `${status.sessionsLeft} session(s)` : null,
        ].filter(Boolean).join(' or ');
        return `gatekeep is in shadow mode: this would have blocked the stop, and did not. ${left ? `${left} left in the window; ` : ''}`
            + `${st.wouldHaveBlocked} of ${st.stops} stop(s) so far would have been blocked. Turn blocking on now with \`gatekeep shadow --off\`.`;
    }
    const top = Object.entries(st.rules).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`).join(', ');
    const because = status.endedBy === 'sessions' ? `${cfg.sessions} sessions` : `${cfg.days} days`;
    return `Shadow mode has run its course (${because}). Across ${st.sessions.length} session(s) and ${st.stops} stop(s) it would have blocked ${st.wouldHaveBlocked}`
        + `${top ? `, most often: ${top}` : ''}. It is still only reporting. Turn blocking on with \`gatekeep shadow --off\`, `
        + 'keep reporting with `gatekeep shadow --extend`, or trim the noisy rules with `gatekeep calibrate --apply`.';
}
//# sourceMappingURL=shadow.js.map