/**
 * Coverage for shadow mode: the window, the tally it keeps, and the two ways it must not fail open.
 *
 * The important cases here are not the arithmetic. They are (1) a window that cannot end must be reported rather
 * than silently becoming "this gate never blocks", and (2) shadow mode must never cover the gate's own integrity,
 * because a window in which an agent may rewrite `gatekeep.config.json` is a window in which it can extend itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { statusOf, shadowNote, recordStop, readShadowState, emptyState, defaultShadow, DEFAULT_SHADOW_DAYS, DEFAULT_SHADOW_SESSIONS, type ShadowConfig } from '../src/shadow.js';
import { parseConfig, defaultConfigText } from '../src/config.js';
import { familyOf } from '../src/rules.js';

const cfg = (o: Partial<ShadowConfig> = {}): ShadowConfig => ({ startedAt: '2026-09-01', days: 7, sessions: 10, ...o });
const at = (iso: string) => new Date(iso);

test('the window ends on whichever limit runs out first', () => {
  const fresh = { ...emptyState(), sessions: ['a', 'b'] };
  const early = statusOf(cfg(), fresh, at('2026-09-03T00:00:00Z'));
  assert.equal(early.elapsed, false);
  assert.equal(early.daysLeft, 5);
  assert.equal(early.sessionsLeft, 8);

  // Days run out first.
  const byDays = statusOf(cfg(), fresh, at('2026-09-09T00:00:00Z'));
  assert.equal(byDays.elapsed, true);
  assert.equal(byDays.endedBy, 'days');
  assert.equal(byDays.daysLeft, 0, 'never negative: the message says "0 left", not "-2 left"');

  // Sessions run out first.
  const many = { ...emptyState(), sessions: Array.from({ length: 10 }, (_, i) => `s${i}`) };
  const bySessions = statusOf(cfg(), many, at('2026-09-02T00:00:00Z'));
  assert.equal(bySessions.elapsed, true);
  assert.equal(bySessions.endedBy, 'sessions');
});

test('a limit set to null is no limit, and an unparseable start date expires rather than never ending', () => {
  const noDays = statusOf(cfg({ days: null }), { ...emptyState(), sessions: ['a'] }, at('2030-01-01T00:00:00Z'));
  assert.equal(noDays.daysLeft, null);
  assert.equal(noDays.elapsed, false, 'sessions still has room');
  // A start date nobody can parse must not read as "the window never closes".
  const broken = statusOf(cfg({ startedAt: 'not-a-date' }), emptyState(), at('2026-09-02T00:00:00Z'));
  assert.equal(broken.elapsed, true);
});

test('a shadow window with no limit at all is reported as a problem, not accepted quietly', () => {
  const { cfg: parsed, problems } = parseConfig(JSON.stringify({ shadow: { startedAt: '2026-09-01', days: null, sessions: null } }));
  assert.ok(parsed.shadow, 'still parsed');
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /never end/);
});

test('config parsing rejects nonsense limits and unknown keys by name', () => {
  const { problems } = parseConfig(JSON.stringify({ shadow: { days: -1, sessions: 'ten', mode: 'quiet' } }));
  assert.ok(problems.some((p) => /"shadow.days"/.test(p)), problems.join('|'));
  assert.ok(problems.some((p) => /"shadow.sessions"/.test(p)), problems.join('|'));
  assert.ok(problems.some((p) => /shadow.mode/.test(p)), problems.join('|'));
  // Null is how blocking is turned on, and it must parse without complaint.
  assert.deepEqual(parseConfig(JSON.stringify({ shadow: null })).problems, []);
  assert.equal(parseConfig(JSON.stringify({ shadow: null })).cfg.shadow, null);
});

test('a config written for a new install starts in shadow mode', () => {
  const { cfg: parsed, problems } = parseConfig(defaultConfigText(null));
  assert.deepEqual(problems, []);
  assert.ok(parsed.shadow, 'new installs report before they block');
  assert.equal(parsed.shadow?.days, DEFAULT_SHADOW_DAYS);
  assert.equal(parsed.shadow?.sessions, DEFAULT_SHADOW_SESSIONS);
});

test('the tally counts distinct sessions, and stops that would have blocked', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-shadow-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gk-shadowhome-'));
  const prev = process.env.GATEKEEP_HOME;
  process.env.GATEKEEP_HOME = home;
  try {
    await recordStop(root, 's1', true, ['test-deleted']);
    await recordStop(root, 's1', false, []);            // same session stopping twice counts once
    const st = await recordStop(root, 's2', true, ['test-deleted', 'assertion-weakened']);
    assert.equal(st.stops, 3);
    assert.deepEqual(st.sessions, ['s1', 's2']);
    assert.equal(st.wouldHaveBlocked, 2);
    assert.equal(st.rules['test-deleted'], 2);
    assert.equal(st.rules['assertion-weakened'], 1);
    assert.deepEqual(await readShadowState(root), st, 'it survives a round trip to disk');
  } finally {
    if (prev === undefined) delete process.env.GATEKEEP_HOME; else process.env.GATEKEEP_HOME = prev;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('the note carries the tally, and changes its offer once the window has run out', () => {
  const st = { ...emptyState(), sessions: ['a'], stops: 4, wouldHaveBlocked: 2, rules: { 'test-deleted': 2 } };
  const during = shadowNote(cfg(), st, statusOf(cfg(), st, at('2026-09-03T00:00:00Z')));
  assert.match(during, /2 of 4/);
  assert.match(during, /shadow --off/);
  const after = shadowNote(cfg(), st, statusOf(cfg(), st, at('2026-09-30T00:00:00Z')));
  assert.match(after, /run its course/);
  assert.match(after, /test-deleted \(2\)/);
  assert.match(after, /shadow --extend/);
});

test('the gate-integrity family is what shadow mode must never cover', () => {
  // The exemption in src/cli.ts is keyed on this family, so it is the thing worth pinning down.
  for (const rule of ['gate-config-changed', 'state-tampered', 'session-state-missing', 'index-flags-set', 'paths-hidden-from-snapshot']) {
    assert.equal(familyOf(rule), 'gate', rule);
  }
  // A finding about the work is not in it, or shadow mode would cover nothing at all.
  assert.notEqual(familyOf('test-deleted'), 'gate');
  assert.notEqual(familyOf('secret-introduced'), 'gate');
});

test('defaultShadow dates the window from today, so the clock starts at install', () => {
  const d = defaultShadow(at('2026-09-10T13:00:00Z'));
  assert.equal(d.startedAt, '2026-09-10');
  assert.equal(statusOf(d, emptyState(), at('2026-09-10T23:00:00Z')).elapsed, false);
});
