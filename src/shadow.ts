import fs from 'node:fs/promises';
import path from 'node:path';
import { repoStateDir, writeAtomic } from './session.js';

/**
 * Shadow mode: a new install reports what it would have blocked instead of blocking, for a fixed window, and then
 * offers to turn blocking on.
 *
 * The reason is the whole adoption problem in one sentence: the first time a gate blocks someone is the moment
 * they decide whether to keep it, and on day one they have no idea whether it is right. `gatekeep calibrate` answers
 * that from history; this answers it from their actual sessions, which is the harder evidence. It is deliberately
 * *not* self-cancelling — when the window ends the gate keeps reporting and asks — because a tool that quietly
 * starts blocking on day eight is a tool that ambushes you on day eight.
 *
 * The window lives in `gatekeep.config.json` so a team shares one; the tally of what happened lives in the state
 * home, because it is an observation of this machine's sessions rather than a decision anyone made.
 */

export interface ShadowConfig {
  /** ISO date the window opened. In the committed config, so a teammate does not silently restart the clock. */
  startedAt: string;
  /** Days of reporting before the offer. Null = no time limit. */
  days: number | null;
  /** Distinct sessions before the offer, whichever comes first. Null = no session limit. */
  sessions: number | null;
}

export interface ShadowState {
  /** Distinct session ids seen at a stop. Ids, not a counter, so a session that stops twice counts once. */
  sessions: string[];
  stops: number;
  wouldHaveBlocked: number;
  /** Commits are what people act on, so rules are counted in stops rather than findings. */
  rules: Record<string, number>;
}

export const DEFAULT_SHADOW_DAYS = 7;
export const DEFAULT_SHADOW_SESSIONS = 10;
/** Enough ids to satisfy any sane session limit without letting the file grow without bound. */
const MAX_TRACKED_SESSIONS = 500;

export function defaultShadow(now = new Date()): ShadowConfig {
  return { startedAt: now.toISOString().slice(0, 10), days: DEFAULT_SHADOW_DAYS, sessions: DEFAULT_SHADOW_SESSIONS };
}

function stateFile(root: string): string { return path.join(repoStateDir(root), 'shadow.json'); }

export function emptyState(): ShadowState { return { sessions: [], stops: 0, wouldHaveBlocked: 0, rules: {} }; }

export async function readShadowState(root: string): Promise<ShadowState> {
  try {
    const j = JSON.parse(await fs.readFile(stateFile(root), 'utf8')) as Partial<ShadowState>;
    return {
      sessions: Array.isArray(j.sessions) ? j.sessions.filter((x) => typeof x === 'string') : [],
      stops: typeof j.stops === 'number' ? j.stops : 0,
      wouldHaveBlocked: typeof j.wouldHaveBlocked === 'number' ? j.wouldHaveBlocked : 0,
      rules: j.rules && typeof j.rules === 'object' && !Array.isArray(j.rules) ? j.rules as Record<string, number> : {},
    };
  } catch { return emptyState(); }
}

export async function writeShadowState(root: string, s: ShadowState): Promise<void> {
  await fs.mkdir(repoStateDir(root), { recursive: true });
  await writeAtomic(stateFile(root), JSON.stringify(s, null, 2) + '\n');
}

/** Record one stop. Returns the state as it now stands, so the caller can report against it in the same breath. */
export async function recordStop(root: string, sessionId: string, wouldBlock: boolean, rules: string[]): Promise<ShadowState> {
  const s = await readShadowState(root);
  s.stops += 1;
  if (!s.sessions.includes(sessionId)) s.sessions = [...s.sessions, sessionId].slice(-MAX_TRACKED_SESSIONS);
  if (wouldBlock) {
    s.wouldHaveBlocked += 1;
    for (const r of new Set(rules)) s.rules[r] = (s.rules[r] ?? 0) + 1;
  }
  await writeShadowState(root, s);
  return s;
}

export interface ShadowStatus {
  /** The window has run its course; the gate still reports, and now asks. */
  elapsed: boolean;
  daysLeft: number | null;
  sessionsLeft: number | null;
  /** Which limit ended it, for a message that says why rather than just that. */
  endedBy: 'days' | 'sessions' | null;
}

export function statusOf(cfg: ShadowConfig, st: ShadowState, now = new Date()): ShadowStatus {
  let daysLeft: number | null = null;
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
export function shadowNote(cfg: ShadowConfig, st: ShadowState, status: ShadowStatus): string {
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
