#!/usr/bin/env node
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { analyze, needsContent, familyOf, PROTECTED_FILES, type AnalysisResult } from './rules.js';
import { parseConfig, readConfigText, defaultConfigText, CONFIG_FILENAME, type GatekeepConfig } from './config.js';
import { git, repoRoot, gitDir, headTree, resolveTree, snapshotWorkingTree, diffTrees, catFile, isShallow, GitError, type SnapshotProblems } from './git.js';
import { loadSession, loadSessionChecked, saveSession, newSession, listSessions, repoStateDir, verdictDir, withSessionLock, appendToolEvent, readToolEvents, type SessionState, type RecordedTool } from './session.js';
import { decide, writeVerdict, formatReport, type Verdict } from './verdict.js';
import { installClaudeCode, uninstallClaudeCode, installCodex, installedHooks, detectTestCommand, claudeSettingsFile, hookCommandPrefix } from './install.js';
import { discoverTestTree, applyProtect, removeProtect, readProtectRecord, decideProtect, protectedIn } from './protect.js';
import { runOriginalTests, testRunFindings, type TestRunResult } from './testrun.js';
import { readTranscript, claimFindings, transcriptFromTools, type Transcript } from './claims.js';
import { applyOverrides, overridesFromPrompts, overridesFromCli, overridesFromCommits, type Override } from './override.js';
import { isTestFile } from './rules.js';
import { runJudge, type JudgeResult } from './judge.js';
import { renderReport } from './report.js';
import { replay, baseTestFiles, type ReplayedCommit, type ReplayTotals } from './replay.js';
import { recordStop, statusOf, shadowNote, readShadowState, defaultShadow, DEFAULT_SHADOW_DAYS, DEFAULT_SHADOW_SESSIONS } from './shadow.js';
import { rawLiterals } from './oracle.js';
import { redactFiles, fixtureName, issueUrl, type FpFile, type FpFixture, type ExpectedFinding, type RedactionLevel } from './reportfp.js';
import { spawn } from 'node:child_process';
import type { Finding, FileChange, Severity } from './model.js';

const require = createRequire(import.meta.url);
const VERSION: string = (require('../../package.json') as { version: string }).version;
const BOOL_FLAGS = new Set(['json', 'fail-on-warn', 'version', 'claude', 'codex', 'global', 'shared', 'help', 'quiet', 'no-judge', 'stdout', 'open', 'off', 'dry-run', 'apply', 'no-calibrate', 'extend', 'on', 'verbatim', 'no-open']);
const VALUE_FLAGS = ['session', 'base', 'allow', 'harness', 'id', 'task', 'transcript', 'judge', 'out', 'commits', 'threshold', 'days', 'sessions', 'rule', 'verdict'];

interface Args { _: string[]; flags: Record<string, string | boolean> }
function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out.flags[k!] = v;
      else if (!BOOL_FLAGS.has(k!) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) out.flags[k!] = argv[++i]!;
      else out.flags[k!] = true;
    } else out._.push(a);
  }
  return out;
}

async function readStdinJSON(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8').trim();
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function usage(): string {
  return `gatekeep ${VERSION} — independent verification gate for AI coding agents

Usage:
  gatekeep run [--base <ref>] [--session <id>] [--json] [--fail-on-warn] [--allow <rule,...>] [--judge <model> | --no-judge]
      Check the working tree against a baseline (default: HEAD, or the session's start snapshot).
      Exit 0 = pass, 1 = blocked, 3 = error. --allow lifts rules for this run (recorded in the verdict);
      commit trailers "gatekeep: allow <rule> -- reason" between --base and HEAD do the same.
      --judge <model> runs the model-backed review for this run; --no-judge skips the configured one.
  gatekeep hook session-start|prompt|tool-use|stop [--harness claude-code|codex]
      Entry points wired into the agent's hooks. Reads the hook JSON on stdin.
  gatekeep install [--shared | --global] [--codex] [--no-calibrate]
      Wire the hooks. Default: .claude/settings.local.json (machine-local, not committed).
      On the install that writes the config, replays recent history and reports what the gate would have
      interrupted; --no-calibrate skips that.
      --shared writes .claude/settings.json and expects \`gatekeep\` on PATH (npm link / npm i -g).
  gatekeep session start [--id <id>] [--task "<task statement>"] [--json]
      Snapshot the working tree as a baseline for any agent framework (prints the session id).
  gatekeep verify --session <id> [--transcript <path>] [--allow <rule,...>] [--json] [--fail-on-warn]
      Evaluate the working tree against that baseline: the last step any harness calls before "done".
      Exit 0 = pass, 1 = blocked, 3 = error.
  gatekeep protect-tests [--shared | --global] [--dry-run] [--off]
      Prevention rather than detection: make the test tree read-only for the agent. Writes permission denials,
      a sandbox write-deny list and a PreToolUse hook that refuses the write and says why. Opt-in, and
      independent of the gate — neither one needs the other.
  gatekeep uninstall [--shared | --global]
  gatekeep status
      Show where hooks are wired, the state directory, recent sessions and the last verdict.
  gatekeep report [<verdict.json>] [--session <id>] [--out <file.html>] [--stdout] [--open]
      Render a verdict (default: the latest for this repository) as one self-contained HTML file with the
      test bodies before and after the session next to each finding. Written beside the verdict unless --out.
  gatekeep calibrate [<commits>] [--commits <n>] [--threshold <n>] [--apply] [--json]
      Replay this repository's own history through the gate and print how many commits it would have
      interrupted, which ones, and which rules did it. Default: the last ${DEFAULT_CALIBRATE_COMMITS} commits.
      --apply downgrades to "warn" every rule that interrupted --threshold or more commits (default 2).
  gatekeep shadow [--off | --on | --extend] [--days <n>] [--sessions <n>]
      Shadow mode reports what would have blocked instead of blocking. New installs start in it for
      ${DEFAULT_SHADOW_DAYS} days or ${DEFAULT_SHADOW_SESSIONS} sessions. --off turns blocking on. With no flag, shows the tally so far.
  gatekeep report-fp [--rule <rule>] [--session <id>] [--verdict <path>] [--out <dir>] [--no-open] [--verbatim]
      Reduce a wrong finding to a redacted fixture and open a prefilled issue. The redaction is verified: if
      the finding stops reproducing, nothing is written rather than your source being sent unredacted.
  gatekeep init
      Write a ${CONFIG_FILENAME} with default rule severities and the repository's detected test command.
  gatekeep --version

State (sessions, verdicts) lives in ~/.gatekeep (override with GATEKEEP_HOME), never inside the repository.
`;
}

class UserError extends Error {}

/**
 * Config source by command: a session reads the copy captured at SessionStart (null = there was none: defaults, never the
 * working tree the agent controls); `run --base` reads the base tree; plain `run` reads the working tree (a human is asking).
 */
async function configFor(root: string, baseTree: string | null, session: SessionState | null): Promise<{ cfg: GatekeepConfig; findings: Finding[] }> {
  let text: string | null | undefined;
  if (session) text = session.configText ?? null;
  else if (baseTree) text = (await catFile(root, baseTree, CONFIG_FILENAME)) ?? null;
  else text = await readConfigText(root);
  const { cfg, problems } = parseConfig(text);
  const sevOff = cfg.rules.severities['config-invalid'] === 'off';
  const findings: Finding[] = sevOff ? [] : problems.map((p) => ({ rule: 'config-invalid', severity: cfg.rules.severities['config-invalid'] ?? 'warn', file: CONFIG_FILENAME, message: p }));
  return { cfg, findings };
}

interface Analysis {
  cur: string; changes: FileChange[]; result: AnalysisResult; originalTests: TestRunResult | null; claim: string | null;
  /** Set when the agent made a claim the gate had no recorded tool calls or transcript to check it against. */
  claimsGap: 'none' | null;
}

interface AnalysisOpts {
  transcriptPath?: string;
  task?: string | null;
  finalText?: string;
  noBaseline?: boolean;
  /** Tool calls recorded by our own PostToolUse hook. Preferred over any transcript: see src/session.ts. */
  tools?: RecordedTool[];
  harness?: string;
  /** False once this session has already been told the claims family is not running. */
  warnClaims?: boolean;
}

async function runAnalysis(root: string, base: string, cfg: GatekeepConfig, sessionMode: boolean, opts: AnalysisOpts = {}): Promise<Analysis> {
  const { transcriptPath, task, finalText, noBaseline } = opts;
  const snapshot: SnapshotProblems = { indexFlags: [], hidden: [] };
  const cur = await snapshotWorkingTree(root, snapshot);
  const changes = await diffTrees(root, base, cur, { shouldLoad: (p) => needsContent(p, cfg.rules), maxBytes: 2 * 1024 * 1024 });
  const result = await analyze(changes, cfg.rules, { exists: (p) => existsSync(path.join(root, p)), sessionMode, task, noBaseline, baseTestFiles: await baseTestFiles(root, base, cfg, changes) });
  const originalTests = base === cur ? null : await runOriginalTests(root, base, cur, changes, cfg.rules, { testCommand: cfg.testCommand, testTimeoutMs: cfg.testTimeoutMs });
  result.findings.push(...testRunFindings(originalTests, cfg.rules.severities));
  // Both of these keep files out of `git add -A`, and neither lives in the tree, so no diff can show them changing.
  const snapSev = (rule: string): Severity => cfg.rules.severities[rule] ?? 'block';
  if (snapshot.indexFlags.length && snapSev('index-flags-set') !== 'off') {
    result.findings.push({ rule: 'index-flags-set', severity: snapSev('index-flags-set'), file: snapshot.indexFlags[0]!, message: `${snapshot.indexFlags.length} path(s) carry skip-worktree or assume-unchanged, which keeps their edits out of \`git add\`: ${snapshot.indexFlags.slice(0, 5).join(', ')}. The snapshot cleared the bits and read the files anyway.` });
  }
  if (snapshot.hidden.length && snapSev('paths-hidden-from-snapshot') !== 'off') {
    result.findings.push({ rule: 'paths-hidden-from-snapshot', severity: snapSev('paths-hidden-from-snapshot'), file: snapshot.hidden[0]!, message: `${snapshot.hidden.length} untracked path(s) are hidden by .git/info/exclude or core.excludesFile rather than by a committed .gitignore: ${snapshot.hidden.slice(0, 5).join(', ')}` });
  }
  // Two possible sources for the claim rules, in order of preference. Our own recorder works on every harness and
  // its format is ours; the transcript is a Claude Code specific fallback for sessions started before the recorder
  // was wired. The transcript file is also written asynchronously and can be missing the turn that triggered this
  // hook, so when the harness hands us the final message directly, that is the authoritative text either way.
  const read = transcriptPath ? await readTranscript(transcriptPath) : null;
  const recorded = opts.tools ?? [];
  let transcript: Transcript | null = null;
  if (recorded.length > 0) transcript = transcriptFromTools(recorded, finalText ?? read?.finalText ?? '');
  else if (read?.recognized) transcript = finalText !== undefined ? { ...read, finalText } : read;
  if (transcript) result.findings.push(...claimFindings(transcript, changes, cfg.rules.severities, (p) => isTestFile(p, cfg.rules)));
  // Silence here used to be indistinguishable from "nothing to report": on every harness but Claude Code the claims
  // family had no input at all and returned [], and nobody could tell that from a pass.
  //
  // It says so only when the agent actually made a claim there was no way to check — a final message, against a
  // session that changed something, with no recorded tool calls and no readable transcript. No final message means
  // no claim, and silence there is the right answer rather than a hidden gap. Reported once per session: this is a
  // gap in the gate's own wiring, not a finding about the work, and repeating it every stop is how warnings get
  // ignored. `gatekeep status` says whether the recorder is wired at all.
  const words = (finalText ?? read?.finalText ?? '').trim();
  const claimsGap: 'none' | null = transcript === null && words !== '' && changes.length > 0 ? 'none' : null;
  const claimSev = cfg.rules.severities['claims-not-recorded'] ?? 'warn';
  if (sessionMode && claimSev !== 'off' && claimsGap !== null && opts.warnClaims !== false) {
    const h = opts.harness ? ` on ${opts.harness}` : '';
    result.findings.push({ rule: 'claims-not-recorded', severity: claimSev, file: '.', message: `The agent's final message was not checked against what it actually did${h}: no tool calls were recorded for this session and no readable transcript was given, so the four claims rules did not run. Wire the recorder with \`gatekeep install\` (a PostToolUse hook), or call \`gatekeep hook tool-use\` with the tool call on stdin from your own framework.` });
  }
  return { cur, changes, result, originalTests, claim: transcript?.finalText ?? null, claimsGap };
}

/**
 * Model-backed review, after every deterministic finding is in and before overrides are applied. Appends its own
 * findings and annotates the blocking ones in place; `runJudge` enforces that it can change nothing else.
 */
async function judgeStep(root: string, base: string, a: Analysis, cfg: GatekeepConfig, task: string | null, findings: Finding[], flags: Args['flags']): Promise<JudgeResult | null> {
  if (flags['no-judge'] === true) return null;
  const jc = typeof flags.judge === 'string' ? { ...(cfg.judge ?? { provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxDiffBytes: 200 * 1024, canBlock: false, effort: 'high' as const }), model: flags.judge } : cfg.judge;
  if (!jc) return null;
  const { result, findings: extra } = await runJudge({ root, base, cur: a.cur, changes: a.changes, cfg: jc, task, claim: a.claim, findings, severities: cfg.rules.severities, isTest: (p) => isTestFile(p, cfg.rules), cacheDir: path.join(repoStateDir(root), 'judge') });
  findings.push(...extra);
  return result;
}

/** Protected files hashed straight from disk, so gitignored ones (the default settings.local.json) are covered too. */
async function protectedHashes(root: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const f of PROTECTED_FILES) {
    try { out[f] = createHash('sha1').update(await fs.readFile(path.join(root, f))).digest('hex'); } catch { out[f] = null; }
  }
  return out;
}

function buildVerdict(p: { sessionId: string | null; harness: string | null; base: string; cur: string; task: string | null; findings: Finding[]; result: AnalysisResult; originalTests?: TestRunResult | null; judge?: JudgeResult | null; strict: boolean; blockCount: number; t0: number; overrides?: Override[] }): Verdict {
  const used = applyOverrides(p.findings, p.overrides ?? []);
  const decision = decide(p.findings, p.strict);
  return {
    schema: 'gatekeep.verdict.v1', createdAt: new Date().toISOString(), sessionId: p.sessionId, harness: p.harness,
    baseTree: p.base, currentTree: p.cur, task: p.task, decision,
    checks: { testIntegrity: { status: decision === 'block' ? 'fail' : decision === 'warn' ? 'warn' : 'pass', findings: p.findings, examined: p.result.examined, changedSourceFiles: p.result.changedSourceFiles }, ...(p.originalTests ? { originalTests: p.originalTests } : {}), ...(p.judge ? { judge: p.judge } : {}) },
    blockCount: p.blockCount, durationMs: Date.now() - p.t0, ...(used.length ? { overrides: used } : {}),
  };
}

async function cmdRun(args: Args, cwd: string): Promise<number> {
  const root = await repoRoot(cwd);
  if (!root) throw new UserError('not inside a git repository');
  for (const k of VALUE_FLAGS) if (args.flags[k] === true) throw new UserError(`--${k} requires a value`);
  const sessionId = typeof args.flags.session === 'string' ? args.flags.session : null;
  const gd = await gitDir(root).catch(() => null);
  const session = sessionId ? await loadSession(root, sessionId, gd) : null;
  if (sessionId && !session) throw new UserError(`no session "${sessionId}" recorded for this repository (see \`gatekeep status\`)`);
  let base: string, baseForConfig: string | null = null;
  if (typeof args.flags.base === 'string') {
    try { base = await resolveTree(root, args.flags.base); }
    catch {
      throw new UserError(await isShallow(root)
        ? `--base ${args.flags.base}: this is a shallow clone, so that commit is not present. Run \`git fetch --unshallow\`, or set \`fetch-depth: 0\` on actions/checkout.`
        : `--base ${args.flags.base}: not a commit, branch or tag in this repository`);
    }
    baseForConfig = base;
  } else base = session?.baseTree ?? await headTree(root);
  const t0 = Date.now();
  const { cfg, findings: cfgFindings } = await configFor(root, baseForConfig, session);
  const tools = sessionId ? (await readToolEvents(root, sessionId, gd)).events : [];
  const a = await runAnalysis(root, base, cfg, session !== null, { task: session?.prompt ?? null, tools, harness: session?.harness, warnClaims: !session?.claimsWarned });
  if (session && a.claimsGap !== null && !session.claimsWarned) { session.claimsWarned = true; await saveSession(root, session, gd); }
  const { cur, result, originalTests } = a;
  const findings = [...cfgFindings, ...result.findings];
  const judge = await judgeStep(root, base, a, cfg, session?.prompt ?? null, findings, args.flags);
  const strict = cfg.strict || args.flags['fail-on-warn'] === true;
  const overrides: Override[] = [
    ...overridesFromCli(typeof args.flags.allow === 'string' ? args.flags.allow : undefined, process.env.USER ?? 'cli'),
    ...overridesFromCli(process.env.GATEKEEP_ALLOW, 'env').map((o) => ({ ...o, source: 'env' as const })),
    ...(typeof args.flags.base === 'string' ? await overridesFromCommits(root, args.flags.base) : []),
    ...overridesFromPrompts(session?.prompts ?? (session?.prompt ? [session.prompt] : [])),
  ];
  const v = buildVerdict({ sessionId, harness: session?.harness ?? null, base, cur, task: session?.prompt ?? null, findings, result, originalTests, judge, strict, blockCount: session?.blocks ?? 0, t0, overrides });
  const vp = await writeVerdict(root, v);
  if (args.flags.json) console.log(JSON.stringify(v, null, 2));
  else console.log(formatReport(v, { forAgent: false, verdictPath: vp }));
  return v.decision === 'block' ? 1 : 0;
}

/** Framework-agnostic adapter: `session start` then `verify`, no hook system required. */
async function cmdSession(args: Args, cwd: string): Promise<number> {
  if (args._[1] !== 'start') throw new UserError('usage: gatekeep session start [--id <id>] [--task "<task>"]');
  const root = await repoRoot(cwd);
  if (!root) throw new UserError('not inside a git repository');
  for (const k of VALUE_FLAGS) if (args.flags[k] === true) throw new UserError(`--${k} requires a value`);
  const id = typeof args.flags.id === 'string' ? args.flags.id : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const gd = await gitDir(root).catch(() => null);
  const s = await newSession(root, id, typeof args.flags.harness === 'string' ? args.flags.harness : 'generic', await snapshotWorkingTree(root), await readConfigText(root), gd, await protectedHashes(root));
  if (typeof args.flags.task === 'string') { s.prompt = args.flags.task.slice(0, 4000); s.prompts = [s.prompt]; await saveSession(root, s, gd); }
  if (args.flags.json) console.log(JSON.stringify({ session: id, baseTree: s.baseTree, startedAt: s.startedAt }));
  else console.log(id);
  return 0;
}

async function cmdVerify(args: Args, cwd: string): Promise<number> {
  const root = await repoRoot(cwd);
  if (!root) throw new UserError('not inside a git repository');
  for (const k of VALUE_FLAGS) if (args.flags[k] === true) throw new UserError(`--${k} requires a value`);
  if (typeof args.flags.session !== 'string') throw new UserError('verify needs --session <id> (from `gatekeep session start`)');
  const gd = await gitDir(root).catch(() => null);
  const s = await loadSession(root, args.flags.session, gd);
  if (!s) throw new UserError(`no session "${args.flags.session}" recorded for this repository`);
  const t0 = Date.now();
  const { cfg, findings: cfgFindings } = await configFor(root, null, s);
  const a = await runAnalysis(root, s.baseTree, cfg, true, {
    transcriptPath: typeof args.flags.transcript === 'string' ? args.flags.transcript : undefined,
    task: s.prompt,
    tools: (await readToolEvents(root, s.id, gd)).events,
    harness: s.harness,
    warnClaims: !s.claimsWarned,
  });
  if (a.claimsGap !== null && !s.claimsWarned) { s.claimsWarned = true; await saveSession(root, s, gd); }
  const { cur, result, originalTests } = a;
  const findings = [...cfgFindings, ...result.findings];
  const judge = await judgeStep(root, s.baseTree, a, cfg, s.prompt, findings, args.flags);
  const overrides: Override[] = [...overridesFromCli(typeof args.flags.allow === 'string' ? args.flags.allow : undefined, process.env.USER ?? 'cli'), ...overridesFromPrompts(s.prompts ?? (s.prompt ? [s.prompt] : []))];
  const strict = cfg.strict || args.flags['fail-on-warn'] === true;
  const v = buildVerdict({ sessionId: s.id, harness: s.harness, base: s.baseTree, cur, task: s.prompt, findings, result, originalTests, judge, strict, blockCount: s.blocks, t0, overrides });
  // `verify` is the same gate as the Stop hook for harnesses without hooks, so shadow mode has to hold here too, or
  // the window means one thing on Claude Code and nothing on Devin.
  const decidingRules = [...new Set(findings.filter((f) => !f.overridden && (f.severity === 'block' || strict)).map((f) => f.rule))];
  const shadowState = cfg.shadow ? await recordStop(root, s.id, v.decision === 'block', decidingRules) : null;
  const shadowed = cfg.shadow !== null && v.decision === 'block' && !decidingRules.some((r) => familyOf(r) === 'gate');
  if (shadowed) v.shadowed = true;
  const vp = await writeVerdict(root, v);
  if (args.flags.json) console.log(JSON.stringify(v, null, 2));
  else {
    console.log(formatReport(v, { forAgent: false, verdictPath: vp }));
    if (shadowed) console.log('\n' + shadowNote(cfg.shadow!, shadowState!, statusOf(cfg.shadow!, shadowState!)));
  }
  return v.decision === 'block' && !shadowed ? 1 : 0;
}

/** SessionStart reasons that continue work already under way; anything else is a fresh session and a new baseline. */
const CONTINUES_SESSION = new Set(['resume', 'compact', 'clear', 'fork']);

async function cmdHook(args: Args, cwd: string): Promise<number> {
  // The judge may run Claude Code headless; that child loads no settings, but if it ever did, its hooks must not re-enter the gate.
  if (process.env.GATEKEEP_JUDGE_CHILD === '1') return 0;
  const event = args._[1];
  const harness = typeof args.flags.harness === 'string' ? args.flags.harness : 'claude-code';
  const input = await readStdinJSON();
  const hookCwd = typeof input.cwd === 'string' ? input.cwd : cwd;
  const root = await repoRoot(hookCwd);
  if (!root) return 0; // not a repo: never block
  const sessionId = typeof input.session_id === 'string' ? input.session_id : 'default';
  const gd = await gitDir(root).catch(() => null);

  if (event === 'session-start') {
    const existing = await loadSession(root, sessionId, gd);
    // Claude Code renamed this field to `how`; read both so the gate works on either version.
    const source = typeof input.how === 'string' ? input.how : typeof input.source === 'string' ? input.source : '';
    // Only a genuinely fresh start takes a new baseline. Resuming, compacting, clearing the context or forking all
    // continue work already done, so re-snapshotting there would launder every change made before that point.
    if (existing && CONTINUES_SESSION.has(source)) { if (existing.recovered) await saveSession(root, existing, gd); }
    else {
      const base = await snapshotWorkingTree(root);
      await newSession(root, sessionId, harness, base, await readConfigText(root), gd, await protectedHashes(root));
    }
    // SessionStart stdout is added to the agent's context: say the gate is on before it is tempted.
    console.log('gatekeep is active for this session: tests that are deleted, skipped, weakened, made unreachable, or mocked away will block completion. Make the implementation satisfy the existing tests.');
    return 0;
  }
  if (event === 'prompt') {
    await withSessionLock(root, sessionId, async () => {
      const s = await loadSession(root, sessionId, gd) ?? await newSession(root, sessionId, harness, await snapshotWorkingTree(root), await readConfigText(root), gd, await protectedHashes(root));
      // Claude Code renamed this field to `prompt_text`; read both. Without it there is no task statement, which
      // silently turns off the scope check and every override the user typed in their own prompt.
      const prompt = typeof input.prompt_text === 'string' ? input.prompt_text : typeof input.prompt === 'string' ? input.prompt : null;
      if (prompt !== null) {
        if (!s.prompt) s.prompt = prompt.slice(0, 4000);
        s.prompts = [...(s.prompts ?? []), prompt.slice(0, 4000)].slice(-50);
        await saveSession(root, s, gd);
      }
    });
    return 0;
  }
  if (event === 'tool-use') {
    // PostToolUse. Fires on every call, so it does the least possible: normalise, append, exit. No lock, no diff.
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : typeof input.tool === 'string' ? input.tool : '';
    if (!toolName) return 0;
    const ti = input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input) ? input.tool_input as Record<string, unknown> : {};
    // A `command` is a shell call whatever the harness calls the tool; Codex passes it as an argv array.
    const cmd = typeof ti.command === 'string' ? ti.command : Array.isArray(ti.command) ? (ti.command as unknown[]).filter((x) => typeof x === 'string').join(' ') : undefined;
    const file = ['file_path', 'notebook_path', 'path', 'filename'].map((k) => ti[k]).find((v) => typeof v === 'string') as string | undefined;
    if (cmd === undefined && file === undefined) return 0; // nothing the claim rules can use
    // Whether the call failed, but only when the harness states it. A guess here would discount a real test run.
    const resp = input.tool_response && typeof input.tool_response === 'object' && !Array.isArray(input.tool_response) ? input.tool_response as Record<string, unknown> : {};
    const failed = resp.is_error === true || resp.interrupted === true || (typeof resp.exit_code === 'number' && resp.exit_code !== 0) ? true : undefined;
    await appendToolEvent(root, sessionId, { tool: toolName, ...(file !== undefined ? { file } : {}), ...(cmd !== undefined ? { command: cmd } : {}), ...(failed !== undefined ? { failed } : {}) }, gd);
    return 0;
  }
  if (event === 'pre-tool-use') {
    // The prevention lane. Fails open in every unclear case: a permission hook that misfires is worse than one that misses.
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
    const ti = input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input) ? input.tool_input as Record<string, unknown> : {};
    const s = await loadSession(root, sessionId, gd);
    const { cfg } = parseConfig(s?.configText ?? await readConfigText(root));
    const d = decideProtect(root, hookCwd, toolName, ti, cfg.rules);
    // `hookSpecificOutput` is the current PreToolUse contract; `decision`/`reason` is the older one. Emitting both
    // costs nothing and keeps the lane working across Claude Code versions.
    if (d.deny) console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason },
      decision: 'block',
      reason: d.reason,
    }));
    return 0;
  }
  if (event === 'stop') return withSessionLock(root, sessionId, () => stopHook(root, sessionId, harness, input, gd));
  throw new UserError(`unknown hook event "${event}"`);
}

async function stopHook(root: string, sessionId: string, harness: string, input: Record<string, unknown>, gd: string | null): Promise<number> {
  {
    const loaded = await loadSessionChecked(root, sessionId, gd);
    let s = loaded.state;
    const noBaseline = s === null;
    const stateFindings: Finding[] = [];
    if (!s) {
      // No baseline at all: either the hook was installed mid-session, or the session state was deleted. Fall back to HEAD and say so.
      // A baseline that exists but verifies against nothing is worse than a missing one, so that case blocks.
      s = await newSession(root, sessionId, harness, await headTree(root), await readConfigText(root), gd);
      stateFindings.push(loaded.unverifiable
        ? { rule: 'session-state-missing', severity: 'block', file: '.', message: `Every stored copy of this session's baseline failed its signature check; nothing about the session can be trusted, so it was compared against HEAD instead. State lives under ${repoStateDir(root)} and in .git/gatekeep.` }
        : { rule: 'session-state-missing', severity: 'warn', file: '.', message: 'No session baseline was found for this session (hook installed mid-session, or the state directory was deleted); compared against HEAD instead. Changes already committed during the session were not checked.' });
    } else {
      if (s.tampered === 'key-missing') stateFindings.push({ rule: 'state-tampered', severity: 'block', file: '.', message: `This session's state is signed, but the key under ${repoStateDir(root)} is gone, so the baseline cannot be shown to be the one the session started with. It was used anyway and the findings below stand, but treat them as a floor.` });
      else if (s.tampered) stateFindings.push({ rule: 'state-tampered', severity: 'block', file: '.', message: `The ${s.tampered === 'mirror' ? '.git/gatekeep mirror' : 'state-home copy'} of this session's baseline failed its signature check and was ignored; the ${s.tampered === 'mirror' ? 'state-home copy' : 'mirror'} was used instead. Session state may not be edited during a session.` });
      if (s.recovered) stateFindings.push({ rule: 'session-state-missing', severity: 'warn', file: '.', message: `Session state under ${repoStateDir(root)} was missing; baseline recovered from the .git mirror` });
      if (s.recovered || s.tampered) await saveSession(root, s, gd);
    }
    const t0 = Date.now();
    const { cfg, findings: cfgFindings } = await configFor(root, null, s);
    // `last_assistant_message` is Claude Code's spelling; the other two are what harnesses that carry the final
    // message at all tend to call it. Without one of them the claim rules have no text to check.
    const finalText = ['last_assistant_message', 'last_message', 'final_message'].map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined;
    const a = await runAnalysis(root, s.baseTree, cfg, true, {
      transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : undefined,
      task: s.prompt,
      finalText,
      noBaseline,
      tools: (await readToolEvents(root, sessionId, gd)).events,
      harness,
      warnClaims: !s.claimsWarned,
    });
    if (a.claimsGap !== null) s.claimsWarned = true; // saved with the rest of the session state below
    const { cur, result, originalTests } = a;
    // Protected files compared from disk: catches gitignored hook settings the tree diff cannot see.
    if (s.protectedHashes) {
      const now = await protectedHashes(root);
      for (const [f, h] of Object.entries(s.protectedHashes)) {
        if (now[f] !== h && !result.findings.some((x) => x.rule === 'gate-config-changed' && x.file === f)) {
          const sev = cfg.rules.severities['gate-config-changed'] ?? 'block';
          if (sev !== 'off') result.findings.push({ rule: 'gate-config-changed', severity: sev, file: f, message: `${h === null ? 'Created' : now[f] === null ? 'Deleted' : 'Modified'} ${f} during the session: the gate's configuration and hook wiring may not be changed by the agent` });
        }
      }
    }
    const stateSev = (f: Finding): Finding | null => {
      const sev = cfg.rules.severities[f.rule] ?? f.severity;
      // A configured severity may lower session-state-missing, but not the unverifiable case: that one is tampering.
      if (sev === 'off') return f.rule === 'session-state-missing' && f.severity === 'block' ? f : null;
      return { ...f, severity: f.severity === 'block' ? 'block' : sev };
    };
    const findings = [...stateFindings.map(stateSev).filter((f): f is Finding => f !== null), ...cfgFindings, ...result.findings];
    const judge = await judgeStep(root, s.baseTree, a, cfg, s.prompt, findings, {});
    applyOverrides(findings, overridesFromPrompts(s.prompts ?? (s.prompt ? [s.prompt] : [])));
    const decision = decide(findings, cfg.strict);
    void input;
    const overLimit = decision === 'block' && s.blocks >= cfg.maxBlocks;
    // Shadow mode. Every stop is recorded, not only the blocking ones, because "3 of 40" is the number that tells
    // someone whether to turn blocking on and "3" on its own is not.
    const decidingRules = [...new Set(findings.filter((f) => !f.overridden && (f.severity === 'block' || cfg.strict)).map((f) => f.rule))];
    const shadowState = cfg.shadow ? await recordStop(root, sessionId, decision === 'block', decidingRules) : null;
    const shadowStatus = cfg.shadow && shadowState ? statusOf(cfg.shadow, shadowState) : null;
    // Shadow mode covers the gate's judgement of the work. It deliberately does not cover the gate's own integrity:
    // `gate-config-changed` is documented as the one finding no override can lift, and a window in which an agent
    // may rewrite `gatekeep.config.json` unopposed is a window in which it can extend the window. Same reasoning for
    // a tampered baseline and for index flags that hide edits from the snapshot.
    const gateIntegrity = decidingRules.filter((r) => familyOf(r) === 'gate');
    const shadowed = cfg.shadow !== null && decision === 'block' && gateIntegrity.length === 0;
    const v = buildVerdict({ sessionId, harness, base: s.baseTree, cur, task: s.prompt, findings, result, originalTests, judge, strict: cfg.strict, blockCount: s.blocks + (decision === 'block' && !overLimit && !shadowed ? 1 : 0), t0, overrides: overridesFromPrompts(s.prompts ?? (s.prompt ? [s.prompt] : [])) });
    if (shadowed) v.shadowed = true;
    const vp = await writeVerdict(root, v);
    s.lastVerdict = vp;
    // One mechanism for both outcomes: exit 0 with JSON on stdout. `decision: "block"` is the documented Stop-hook
    // field and feeds `reason` back to the agent as its next instruction; `systemMessage` is what reaches the human.
    // Exit 2 with stderr blocks too, but cannot carry a message to the user in the same breath.
    if (shadowed) {
      // The gate decided block and did not act on it. The report still goes to the human, with the tally and the offer.
      await saveSession(root, s, gd);
      console.log(JSON.stringify({
        systemMessage: `${shadowNote(cfg.shadow!, shadowState!, shadowStatus!)}\n\n${formatReport(v, { forAgent: false, verdictPath: vp })}`,
      }));
      return 0;
    }
    if (decision === 'block' && !overLimit) {
      s.blocks += 1;
      await saveSession(root, s, gd);
      const shadowExempt = cfg.shadow !== null
        ? ` Shadow mode is on, but it does not cover the gate's own integrity (${gateIntegrity.join(', ')}), so this one blocked.`
        : '';
      console.log(JSON.stringify({
        decision: 'block',
        reason: formatReport(v, { forAgent: true, verdictPath: vp }),
        systemMessage: `gatekeep blocked this stop (block ${s.blocks} of ${cfg.maxBlocks}); see ${vp}.${shadowExempt}`,
      }));
      return 0;
    }
    await saveSession(root, s, gd);
    if (decision !== 'pass') {
      const note = overLimit ? `gatekeep: block limit (${cfg.maxBlocks}) reached; the agent was allowed to finish. Review these findings before merging.\n` : '';
      console.log(JSON.stringify({ systemMessage: note + formatReport(v, { forAgent: false, verdictPath: vp }) }));
    }
    return 0;
  }
}

async function cmdInstall(args: Args, cwd: string): Promise<number> {
  const target = args.flags.global === true ? 'global' : args.flags.shared === true ? 'project-shared' : 'project-local';
  if (!args.flags.codex || args.flags.claude) {
    const r = await installClaudeCode(target, cwd);
    const parts = [r.added.length ? `added ${r.added.join(', ')}` : '', r.updated.length ? `updated ${r.updated.join(', ')}` : ''].filter(Boolean);
    console.log(`Claude Code: ${parts.length ? parts.join('; ') : 'hooks already up to date'} in ${r.file}`);
    if (target === 'project-shared') console.log('  (shared settings use the `gatekeep` command; make sure it is on PATH for everyone, e.g. `npm i -g gatekeep` or `npm link`)');
  }
  if (args.flags.codex === true) {
    const r = await installCodex(cwd, target);
    console.log(`Codex: wrote ${r.file}. ${r.note}`);
  }
  const root = await repoRoot(cwd);
  let wroteConfig = false;
  if (root) {
    const cfgPath = path.join(root, CONFIG_FILENAME);
    if (!existsSync(cfgPath)) {
      wroteConfig = true;
      const detected = await detectTestCommand(root);
      await fs.writeFile(cfgPath, defaultConfigText(detected));
      console.log(`Wrote ${CONFIG_FILENAME} (commit it; the agent may not modify it during a session)`);
      console.log(`  shadow mode: for ${DEFAULT_SHADOW_DAYS} days or ${DEFAULT_SHADOW_SESSIONS} sessions gatekeep reports what it would have blocked and blocks nothing.`);
      console.log('  `gatekeep shadow` shows the tally; `gatekeep shadow --off` turns blocking on whenever you are ready.');
      if (detected) {
        console.log(`  testCommand: ${detected.command}  (detected from ${detected.from})`);
        console.log('  At Stop, the tests as they stood at session start are restored and run against the final code.');
        console.log('  Wrong command, or too slow to run every stop? Set "testCommand" to null.');
      } else {
        console.log('  testCommand: null — no test command detected, so the original-tests check is off.');
        console.log(`  Set "testCommand" in ${CONFIG_FILENAME} to turn it on; it is the check that catches tests edited to fit the code.`);
      }
    }
  } else console.log('Note: not inside a git repository; hooks were written but gatekeep only runs inside git repositories.');
  if (root) await calibrateAtInstall(root, wroteConfig, args.flags['no-calibrate'] === true);
  return 0;
}

/**
 * The first thing a new install should do is tell the user what it is about to cost them, on their own code.
 * Being blocked is the worst possible first impression, and the second worst is being blocked with no idea how
 * often it will happen again. Only on the install that created the config: `gatekeep install` is also how hooks
 * get re-wired, and a minute of replay every time is its own kind of rude.
 */
const CALIBRATE_MIN_HISTORY = 20;
async function calibrateAtInstall(root: string, wroteConfig: boolean, off: boolean): Promise<void> {
  if (off) return;
  if (!wroteConfig) { console.log(''); console.log('Run `gatekeep calibrate` to replay this repository\'s history and see what the gate would have interrupted.'); return; }
  const count = parseInt((await git(root, ['rev-list', '--count', '--first-parent', 'HEAD']).catch(() => '0')).trim(), 10) || 0;
  if (count < CALIBRATE_MIN_HISTORY) {
    console.log('');
    console.log(`Only ${count} commit(s) of history, too few to calibrate against. Run \`gatekeep calibrate\` once this repository has more.`);
    return;
  }
  console.log('');
  console.log(`Replaying the last ${Math.min(count, DEFAULT_CALIBRATE_COMMITS)} commits to show what this would have done to work already in this repository.`);
  console.log('');
  const { cfg } = await configFor(root, null, null);
  const c = await runCalibration(root, cfg, DEFAULT_CALIBRATE_COMMITS, process.stderr.isTTY === true);
  printCalibration(c, cfg, 2);
}

function settingsFiles(root: string): string[] {
  return (['project-local', 'project-shared', 'global'] as const).map((k) => claudeSettingsFile(k, root));
}

async function cmdProtectTests(args: Args, cwd: string): Promise<number> {
  const target = args.flags.global === true ? 'global' : args.flags.shared === true ? 'project-shared' : 'project-local';
  const root = await repoRoot(cwd);
  if (!root) throw new UserError('not inside a git repository; protect-tests needs the repository to find the test tree');
  // Permission patterns are repository-relative, so they belong beside the repository root, not beside the cwd.
  const file = claudeSettingsFile(target, root);
  const { cfg } = parseConfig(await readConfigText(root));
  const plan = await discoverTestTree(root, cfg.rules);
  if (args.flags.off === true) {
    const r = await removeProtect(root, file, plan.patterns);
    console.log(r.removed || r.hookRemoved
      ? `protect-tests off: removed ${r.removed} deny entr${r.removed === 1 ? 'y' : 'ies'}${r.hookRemoved ? ' and the PreToolUse hook' : ''} from ${file}`
      : `protect-tests was not on in ${file}`);
    for (const other of await protectedIn(root, settingsFiles(root).filter((f) => f !== file))) {
      console.log(`  still wired in ${other.file}; run protect-tests --off there too`);
    }
    return 0;
  }
  if (plan.patterns.length === 0) {
    console.log('No test files found, so there is nothing to protect. gatekeep classifies tests by path; add "extraTestGlobs" to gatekeep.config.json if yours live somewhere unusual.');
    return 0;
  }
  const header = `${plan.files.length} test file(s) under ${plan.patterns.length} pattern(s):`;
  if (args.flags['dry-run'] === true) {
    console.log(`protect-tests would write to ${file}`);
    console.log(header);
    for (const p of plan.patterns) console.log(`  ${p}`);
    if (plan.truncated) console.log('  … more patterns than the cap; narrow the test globs or protect a directory instead');
    return 0;
  }
  const prefix = await hookCommandPrefix(target === 'project-shared');
  await applyProtect(root, file, plan.patterns, `${prefix} hook pre-tool-use --harness claude-code`);
  console.log(`protect-tests on in ${file}. ${header}`);
  for (const p of plan.patterns) console.log(`  ${p}`);
  if (plan.truncated) console.log('  … more patterns than the cap; narrow the test globs or protect a directory instead');
  console.log('The agent can no longer edit these; the refusal tells it to fix the implementation instead. Turn it off with `gatekeep protect-tests --off`.');
  console.log('Re-run this after adding a test directory: the patterns are a snapshot, not a live query.');
  return 0;
}

/**
 * `gatekeep calibrate` — replay this repository's own history through the gate and show what it would have done,
 * before it is ever in a position to do it.
 *
 * The gate's cost is invisible until it interrupts someone, and by then the interruption is the first impression.
 * A user's own commits are the only honest-work corpus that is actually about them: our measured 11-12% blocking
 * rate on public repositories is a fact about other people's code. So this prints their number, the commits behind
 * it, and the rules responsible, and offers to downgrade the noisy ones.
 *
 * The offer's premise is that the replayed history is honest work. That is usually true and occasionally not, and
 * a rule that blocks a lot is either noisy or is the one rule that caught something — so the commits are listed
 * rather than summarised, and `--apply` never runs without the user having been shown them.
 */
const CALIBRATE_LIST_MAX = 20;
const DEFAULT_CALIBRATE_COMMITS = 200;

/** Rules that only warn cannot interrupt anything, so they are not candidates however often they fire. */
function downgradable(totals: ReplayTotals, cfg: GatekeepConfig, threshold: number): string[] {
  return Object.entries(totals.blockingCommitsByRule)
    .filter(([rule, n]) => n >= threshold && (cfg.rules.severities[rule] ?? 'block') === 'block')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([rule]) => rule);
}

async function applyDowngrades(root: string, rules: string[]): Promise<string> {
  const file = path.join(root, CONFIG_FILENAME);
  const raw = await readConfigText(root);
  // JSON.parse keeps insertion order for string keys, so re-serialising preserves the generated file's layout and
  // its `//` comment keys. A file too broken to parse is not silently replaced.
  let j: Record<string, unknown>;
  if (raw === null) j = JSON.parse(defaultConfigText(await detectTestCommand(root))) as Record<string, unknown>;
  else {
    try { j = JSON.parse(raw) as Record<string, unknown>; }
    catch (e) { throw new UserError(`${CONFIG_FILENAME} is not valid JSON (${(e as Error).message}); fix it before applying downgrades`); }
    if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new UserError(`${CONFIG_FILENAME} must contain a JSON object`);
  }
  const existing = (j.rules && typeof j.rules === 'object' && !Array.isArray(j.rules)) ? j.rules as Record<string, unknown> : {};
  j.rules = { ...existing, ...Object.fromEntries(rules.map((r) => [r, 'warn'])) };
  j['// rules'] = `${rules.join(', ')} downgraded to "warn" by \`gatekeep calibrate --apply\` on ${new Date().toISOString().slice(0, 10)}: they interrupted this repository's own history. Set one back to "block" to restore it.`;
  await fs.writeFile(file, JSON.stringify(j, null, 2) + '\n');
  return file;
}

interface Calibration { totals: ReplayTotals; blocked: ReplayedCommit[]; requested: number; shallow: boolean }

async function runCalibration(root: string, cfg: GatekeepConfig, n: number, progress: boolean): Promise<Calibration> {
  const blocked: ReplayedCommit[] = [];
  const shallow = await isShallow(root);
  let last = 0;
  const totals = await replay(root, cfg, {
    n,
    onCommit: (c) => { if (c.decision === 'block') blocked.push(c); },
    onProgress: progress ? (done, total) => {
      if (done !== total && done - last < 10) return;
      last = done;
      process.stderr.write(`\r  replaying ${done}/${total} commits…`);
      if (done === total) process.stderr.write('\r' + ' '.repeat(34) + '\r');
    } : undefined,
  });
  return { totals, blocked, requested: n, shallow };
}

function printCalibration(c: Calibration, cfg: GatekeepConfig, threshold: number, applying = false): void {
  const { totals, blocked } = c;
  const skipped = totals.skipped ? ` (${totals.skipped} had no parent to diff against)` : '';
  console.log(`Replayed ${totals.commits} commit(s) of this repository's own history${skipped}.`);
  if (c.shallow) console.log('  This is a shallow clone, so the history available is shorter than it looks.');
  console.log('');
  const pct = totals.commits ? ` (${(100 * totals.commitsWithBlocks / totals.commits).toFixed(1)}%)` : '';
  console.log(`  ${totals.commitsWithBlocks} of ${totals.commits} would have been interrupted${pct}.`);
  console.log('');

  if (blocked.length) {
    for (const b of blocked.slice(0, CALIBRATE_LIST_MAX)) {
      const rules = [...new Set(b.findings.filter((f) => f.severity === 'block' || cfg.strict).map((f) => f.rule))];
      console.log(`  ${b.sha.slice(0, 8)}  ${b.subject.slice(0, 52).padEnd(52)}  ${rules.join(', ')}`);
    }
    if (blocked.length > CALIBRATE_LIST_MAX) console.log(`  … and ${blocked.length - CALIBRATE_LIST_MAX} more (--json lists all of them)`);
    console.log('');
    const ranked = Object.entries(totals.blockingCommitsByRule).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    console.log('Interruptions by rule, counted in commits rather than findings:');
    for (const [rule, n] of ranked) console.log(`  ${rule.padEnd(30)} ${String(n).padStart(3)}`);
    console.log('');
    const cands = downgradable(totals, cfg, threshold);
    if (cands.length && !applying) {
      console.log(`${cands.length} rule(s) interrupted ${threshold} or more commits. Downgrading them to "warn" keeps the finding in the`);
      console.log('report and stops it ending a session:');
      console.log('');
      console.log(`  gatekeep calibrate --apply${threshold === 2 ? '' : ` --threshold ${threshold}`}`);
      console.log('');
      console.log('That reads the commits above as honest work. If an agent has already faked something in them, the rule that');
      console.log('caught it is the one this turns off, so read the list before applying.');
    } else if (!cands.length) {
      console.log(`No rule interrupted ${threshold} or more commits, so there is nothing worth downgrading wholesale.`);
    }
  } else if (totals.commits) {
    console.log('Nothing in this history would have been interrupted. The gate should be silent on work like this.');
  } else {
    console.log('No commits were replayed, so there is nothing to say yet.');
  }
  console.log('');
  console.log('Not replayed: the original-tests lane (it runs your suite), the claims family (it needs a live session)');
  console.log('and the model-backed judge. This covers the rules that read the diff.');
}

async function cmdCalibrate(args: Args, cwd: string): Promise<number> {
  const root = await repoRoot(cwd);
  if (!root) throw new UserError('not inside a git repository; calibrate replays this repository\'s own commits');
  const n = Math.max(1, parseInt(String(args.flags.commits ?? args._[1] ?? DEFAULT_CALIBRATE_COMMITS), 10) || DEFAULT_CALIBRATE_COMMITS);
  const threshold = Math.max(1, parseInt(String(args.flags.threshold ?? 2), 10) || 2);
  const { cfg } = await configFor(root, null, null);
  const json = args.flags.json === true;
  const c = await runCalibration(root, cfg, n, !json && process.stderr.isTTY === true);

  if (json) {
    console.log(JSON.stringify({
      repo: root, requested: n, shallow: c.shallow, ...c.totals,
      downgradable: downgradable(c.totals, cfg, threshold),
      blocked: c.blocked.map((b) => ({ sha: b.sha, subject: b.subject, date: b.date, changedFiles: b.changedFiles, touchesTests: b.touchesTests, rules: [...new Set(b.findings.filter((f) => f.severity === 'block' || cfg.strict).map((f) => f.rule))], findings: b.findings })),
    }, null, 2));
    return 0;
  }
  printCalibration(c, cfg, threshold, args.flags.apply === true);
  if (args.flags.apply === true) {
    const rules = downgradable(c.totals, cfg, threshold);
    if (!rules.length) { console.log(''); console.log('Nothing to apply.'); return 0; }
    const file = await applyDowngrades(root, rules);
    console.log('');
    console.log(`Downgraded ${rules.length} rule(s) to "warn" in ${file}:`);
    for (const r of rules) console.log(`  ${r}`);
    console.log('Commit it; the agent may not modify it during a session. `git diff` shows exactly what changed.');
  }
  return 0;
}

/**
 * `gatekeep shadow` — see, end, or extend the reporting window.
 *
 * Ending it is the interesting direction: `--off` is how a user turns blocking on, which is the one decision the
 * whole window exists to inform. It writes `"shadow": null` rather than deleting the key, so the file still says
 * out loud that this repository considered shadow mode and chose against it.
 */
async function writeShadowConfig(root: string, value: unknown, note: string): Promise<string> {
  const file = path.join(root, CONFIG_FILENAME);
  const raw = await readConfigText(root);
  let j: Record<string, unknown>;
  if (raw === null) j = JSON.parse(defaultConfigText(await detectTestCommand(root))) as Record<string, unknown>;
  else {
    try { j = JSON.parse(raw) as Record<string, unknown>; }
    catch (e) { throw new UserError(`${CONFIG_FILENAME} is not valid JSON (${(e as Error).message}); fix it before changing shadow mode`); }
    if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new UserError(`${CONFIG_FILENAME} must contain a JSON object`);
  }
  j['// shadow'] = note;
  j.shadow = value;
  await fs.writeFile(file, JSON.stringify(j, null, 2) + '\n');
  return file;
}

async function cmdShadow(args: Args, cwd: string): Promise<number> {
  const root = await repoRoot(cwd);
  if (!root) throw new UserError('not inside a git repository');
  const { cfg } = await configFor(root, null, null);
  const st = await readShadowState(root);

  if (args.flags.off === true) {
    const file = await writeShadowConfig(root, null, `blocking turned on ${new Date().toISOString().slice(0, 10)} after ${st.stops} stop(s) in shadow mode, ${st.wouldHaveBlocked} of which would have been blocked.`);
    console.log(`Blocking is on. gatekeep will now stop the agent when it finds a blocking finding.`);
    console.log(`  ${file} — commit it so the rest of the team gets the same gate.`);
    if (st.stops) console.log(`  Shadow mode saw ${st.stops} stop(s); ${st.wouldHaveBlocked} would have been blocked.`);
    return 0;
  }
  if (args.flags.extend === true || args.flags.on === true) {
    const days = parseInt(String(args.flags.days ?? DEFAULT_SHADOW_DAYS), 10) || DEFAULT_SHADOW_DAYS;
    const sessions = parseInt(String(args.flags.sessions ?? DEFAULT_SHADOW_SESSIONS), 10) || DEFAULT_SHADOW_SESSIONS;
    const next = { ...defaultShadow(), days, sessions };
    const file = await writeShadowConfig(root, next, `reporting only until ${days} day(s) or ${sessions} session(s) from ${next.startedAt}. Turn blocking on with \`gatekeep shadow --off\`.`);
    console.log(`Shadow mode ${args.flags.extend === true ? 'extended' : 'on'}: reporting, not blocking, for ${days} day(s) or ${sessions} session(s) from ${next.startedAt}.`);
    console.log(`  ${file}`);
    return 0;
  }

  if (!cfg.shadow) {
    console.log('Shadow mode is off: gatekeep blocks when it finds a blocking finding.');
    if (st.stops) console.log(`  It ran in shadow mode for ${st.stops} stop(s) before that, ${st.wouldHaveBlocked} of which would have been blocked.`);
    console.log('  Turn it back on with `gatekeep shadow --on`.');
    return 0;
  }
  const status = statusOf(cfg.shadow, st);
  console.log(`Shadow mode is on since ${cfg.shadow.startedAt}: findings are reported, nothing is blocked.`);
  console.log(`  window: ${cfg.shadow.days ?? '—'} day(s) or ${cfg.shadow.sessions ?? '—'} session(s)` +
    (status.elapsed ? '  — elapsed' : `, ${status.daysLeft ?? '—'} day(s) / ${status.sessionsLeft ?? '—'} session(s) left`));
  console.log(`  seen: ${st.sessions.length} session(s), ${st.stops} stop(s), ${st.wouldHaveBlocked} would have been blocked`);
  const ranked = Object.entries(st.rules).sort((a, b) => b[1] - a[1]);
  for (const [rule, n] of ranked.slice(0, 10)) console.log(`    ${rule.padEnd(30)} ${String(n).padStart(3)}`);
  console.log('');
  console.log(status.elapsed
    ? 'The window has run its course. Turn blocking on with `gatekeep shadow --off`, or extend it with `gatekeep shadow --extend`.'
    : 'Turn blocking on early with `gatekeep shadow --off`.');
  if (ranked.length) console.log('Rules firing more than you want? `gatekeep calibrate` replays your history and can downgrade them.');
  return 0;
}

/** Where the issue goes. Read from package.json so a fork reports to the fork, not to us. */
const REPO_SLUG: string = (() => {
  const url = (require('../../package.json') as { repository?: { url?: string } | string }).repository;
  const raw = typeof url === 'string' ? url : url?.url ?? '';
  return /github\.com[/:]([^/]+\/[^/.]+)/.exec(raw)?.[1] ?? 'SagnikKK1/gatekeep';
})();

/** The verdict a bare `report-fp` is about: this session's latest, or the repository's. */
async function latestVerdictPath(root: string, session?: string): Promise<string | null> {
  const dir = verdictDir(root);
  if (session !== undefined) {
    const sid = session.slice(0, 8);
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(`-${sid}.json`)).sort();
    return names.length ? path.join(dir, names[names.length - 1]!) : null;
  }
  const p = path.join(dir, 'latest.json');
  return existsSync(p) ? p : null;
}

/**
 * `gatekeep report-fp` — turn "this finding is wrong" into a fixture someone can act on, in one command.
 *
 * A false positive is only worth anything to the maintainer as a reproducer, and reducing one by hand from a private
 * repository is an afternoon's work that nobody does, which is why the issue tracker is empty and the rules are
 * tuned on public code that looks nothing like the code people actually get blocked on.
 *
 * The command reads the last verdict, takes the files the finding names, redacts them, and — the part that matters —
 * re-runs the rules over the redacted pair. If the finding no longer fires, the redaction destroyed the evidence and
 * a weaker one is tried. If none reproduces it, nothing is sent: the alternative is shipping the reporter's real
 * source under a command whose name promised otherwise.
 */
const REDACTION_LADDER: Exclude<RedactionLevel, 'none'>[] = ['full', 'light'];

function findingsOf(v: Verdict): Finding[] { return v.checks.testIntegrity.findings.filter((f) => !f.overridden); }

/** Run the rules over a redacted before/after pair exactly as `test/fixtures.test.ts` does, so the fixture is honest. */
async function analyzeFixture(before: Record<string, string>, after: Record<string, string>, cfg: GatekeepConfig): Promise<Finding[]> {
  const changes: FileChange[] = [];
  for (const p of Object.keys(before)) {
    if (!(p in after)) changes.push({ path: p, status: 'D', before: before[p]! });
    else if (before[p] !== after[p]) changes.push({ path: p, status: 'M', before: before[p]!, after: after[p]! });
  }
  for (const p of Object.keys(after)) if (!(p in before)) changes.push({ path: p, status: 'A', after: after[p]! });
  const baseTestFiles = new Map(Object.entries(before).filter(([p]) => isTestFile(p, cfg.rules)));
  const r = await analyze(changes, cfg.rules, { exists: (p) => p in after, baseTestFiles });
  return r.findings;
}

const asExpected = (f: Finding): ExpectedFinding => ({ rule: f.rule, file: f.file, ...(f.test ? { test: f.test } : {}), severity: f.severity });

async function cmdReportFp(args: Args, cwd: string): Promise<number> {
  const root = await repoRoot(cwd);
  if (!root) throw new UserError('not inside a git repository');
  const { cfg } = await configFor(root, null, null);

  const vpath = typeof args.flags.verdict === 'string' ? args.flags.verdict : await latestVerdictPath(root, typeof args.flags.session === 'string' ? args.flags.session : undefined);
  if (!vpath) throw new UserError('no verdict found for this repository yet; run `gatekeep run` or finish a session first');
  let v: Verdict;
  try { v = JSON.parse(await fs.readFile(vpath, 'utf8')) as Verdict; }
  catch { throw new UserError(`could not read a verdict from ${vpath}`); }
  if (v.schema !== 'gatekeep.verdict.v1') throw new UserError(`${vpath} is not a gatekeep verdict`);

  const all = findingsOf(v);
  if (!all.length) throw new UserError(`${vpath} has no findings, so there is no false positive to report`);
  const rule = typeof args.flags.rule === 'string' ? args.flags.rule : null;
  const wrong = rule ? all.filter((f) => f.rule === rule) : all.filter((f) => f.severity === 'block');
  if (!wrong.length) {
    const have = [...new Set(all.map((f) => f.rule))].join(', ');
    throw new UserError(rule ? `no "${rule}" finding in ${vpath}; it has: ${have}` : `no blocking findings in ${vpath}; pick one with --rule <rule> (it has: ${have})`);
  }
  const target = wrong[0]!;
  if (!rule && wrong.length > 1) console.log(`${wrong.length} blocking findings; reporting "${target.rule}". Use --rule to pick another.`);

  // The files the finding names, plus the test files it was compared against: the oracle rule's evidence is a
  // source file *and* the tests whose literals it matched, and a fixture with only one of them proves nothing.
  const involved = new Set<string>([target.file]);
  for (const f of all) if (f.rule === target.rule && isTestFile(f.file, cfg.rules)) involved.add(f.file);
  // A few of the test files the run examined, for context. Capped: a session that touched forty test files would
  // otherwise produce a fixture nobody reads, and the finding is about one of them.
  for (const e of v.checks.testIntegrity.examined.slice(0, 3)) if (isTestFile(e.path, cfg.rules)) involved.add(e.path);
  const files: FpFile[] = [];
  for (const p of involved) {
    if (p === '.' || p === '') continue;
    files.push({ path: p, before: await catFile(root, v.baseTree, p), after: await catFile(root, v.currentTree, p) });
  }
  // The oracle rule's evidence is a source line *and* the unchanged test file whose literal it matched. That test
  // file is not in the diff and not in `examined`, so a fixture built from the finding alone contains no tests, the
  // rule has nothing to compare against, and the reproduction fails for a reason that has nothing to do with
  // redaction. Pull in the test files that actually carry the literals the finding named, and only those.
  if (target.rule === 'test-oracle-in-source' && target.after) {
    const wanted = new Set(rawLiterals(target.after));
    const changes: FileChange[] = files.filter((f) => f.after !== undefined).map((f) => ({ path: f.path, status: 'M' as const, before: f.before, after: f.after! }));
    const baseTests = await baseTestFiles(root, v.baseTree, cfg, changes);
    let added = 0;
    for (const [p, text] of baseTests) {
      if (involved.has(p) || added >= 3) continue;
      if (![...wanted].some((l) => l && text.includes(l))) continue;
      files.push({ path: p, before: text, after: text });   // unchanged in both trees: context, not a deletion
      involved.add(p);
      added++;
    }
  }
  if (!files.length) throw new UserError(`the "${target.rule}" finding does not name a file that exists in either tree, so there is nothing to reduce`);

  const name = fixtureName(target.rule, files);
  let fixture: FpFixture | null = null;
  const tried: string[] = [];
  const levels: RedactionLevel[] = args.flags.verbatim === true ? ['none'] : REDACTION_LADDER;
  for (const level of levels) {
    const { before, after } = level === 'none'
      ? { before: Object.fromEntries(files.filter((f) => f.before !== undefined).map((f) => [f.path, f.before!])), after: Object.fromEntries(files.filter((f) => f.after !== undefined).map((f) => [f.path, f.after!])) }
      : await redactFiles(files, level);
    const got = await analyzeFixture(before, after, cfg);
    const reproduced = got.some((f) => f.rule === target.rule);
    tried.push(`${level}: ${reproduced ? 'reproduces' : 'does not reproduce'}`);
    if (!reproduced) continue;
    fixture = {
      name, level, before, after, reproduced,
      findings: got.map(asExpected),
      // The point of the fixture is that it fails today: everything the pair produces *except* the rule being
      // reported. It goes green the moment the false positive is fixed, and no sooner.
      expected: { findings: got.filter((f) => f.rule !== target.rule).map(asExpected) },
    };
    break;
  }
  if (!fixture) {
    console.error(`gatekeep: the "${target.rule}" finding did not survive redaction (${tried.join('; ')}).`);
    console.error('Nothing was written. A fixture that no longer triggers the rule would waste the maintainer\'s time, and');
    console.error('shipping your real source under a command called report-fp would be worse. Re-run with --verbatim if you');
    console.error('have read the files and are willing to publish them as they are.');
    return 3;
  }

  const dir = typeof args.flags.out === 'string' ? path.resolve(cwd, args.flags.out) : path.join(repoStateDir(root), 'fp', name);
  await fs.rm(dir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(fixture.before)) { await fs.mkdir(path.dirname(path.join(dir, 'before', rel)), { recursive: true }); await fs.writeFile(path.join(dir, 'before', rel), text); }
  for (const [rel, text] of Object.entries(fixture.after)) { await fs.mkdir(path.dirname(path.join(dir, 'after', rel)), { recursive: true }); await fs.writeFile(path.join(dir, 'after', rel), text); }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'expected.json'), JSON.stringify(fixture.expected, null, 2) + '\n');

  const url = issueUrl(REPO_SLUG, { rule: target.rule, version: VERSION, level: fixture.level, message: target.message, fixture, dir });
  if (args.flags.json === true) { console.log(JSON.stringify({ rule: target.rule, level: fixture.level, dir, name, url, expected: fixture.expected, tried }, null, 2)); return 0; }

  console.log(`Reduced "${target.rule}" to a fixture: ${dir}`);
  console.log(`  redaction: ${fixture.level}${fixture.level === 'none' ? ' — your source, unredacted, because you asked for --verbatim' : ' (identifiers, paths and comments pseudonymised' + (fixture.level === 'full' ? ', string contents too' : '; string contents kept, because the rule stopped firing without them') + ')'}`);
  console.log(`  the rule still fires on the redacted pair, and expected.json says it should not — so this fixture fails until it is fixed.`);
  console.log(`  files: ${Object.keys({ ...fixture.before, ...fixture.after }).join(', ')}`);
  console.log('');
  console.log('Read it before you send it. Redaction is mechanical and cannot know what is sensitive in your codebase.');
  console.log('');
  if (args.flags['no-open'] === true) { console.log(url); return 0; }
  const opened = await openUrl(url);
  console.log(opened ? 'Opened a prefilled issue in your browser.' : 'Open this to file it:');
  if (!opened) console.log(url);
  return 0;
}

/** Best-effort browser open; printing the URL is a fine outcome and the only one on a headless box. */
async function openUrl(url: string): Promise<boolean> {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  return new Promise((resolve) => {
    try {
      const c = spawn(cmd, [url], { stdio: 'ignore', detached: true });
      c.on('error', () => resolve(false));
      c.on('spawn', () => { c.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

async function cmdUninstall(args: Args, cwd: string): Promise<number> {
  const target = args.flags.global === true ? 'global' : args.flags.shared === true ? 'project-shared' : 'project-local';
  const r = await uninstallClaudeCode(target, cwd);
  console.log(r.removed ? `Removed ${r.removed} gatekeep hook(s) from ${r.file}` : `No gatekeep hooks in ${r.file}`);
  // The protect lane is opt-in and separate, but leaving it wired after an uninstall would strand deny entries
  // nobody can explain, so it comes out too — only ever the entries protect-tests recorded as its own.
  const root = await repoRoot(cwd);
  if (root && (await readProtectRecord(root))) {
    const p = await removeProtect(root, claudeSettingsFile(target, root), []);
    if (p.removed || p.hookRemoved) console.log(`Also removed the protect-tests lane (${p.removed} deny entr${p.removed === 1 ? 'y' : 'ies'})`);
  }
  return 0;
}

async function cmdReport(args: Args, cwd: string): Promise<number> {
  for (const k of VALUE_FLAGS) if (args.flags[k] === true) throw new UserError(`--${k} requires a value`);
  const root = await repoRoot(cwd);
  let vp: string;
  if (args._[1]) vp = path.resolve(cwd, args._[1]);
  else {
    if (!root) throw new UserError('not inside a git repository; pass the verdict file as an argument');
    const dir = verdictDir(root);
    if (typeof args.flags.session === 'string') {
      const sid = args.flags.session.slice(0, 8);
      const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(`-${sid}.json`)).sort();
      if (names.length === 0) throw new UserError(`no verdict for session "${args.flags.session}" under ${dir}`);
      vp = path.join(dir, names[names.length - 1]!);
    } else vp = path.join(dir, 'latest.json');
  }
  let v: Verdict;
  try { v = JSON.parse(await fs.readFile(vp, 'utf8')) as Verdict; } catch (e) { throw new UserError(`cannot read verdict ${vp}: ${(e as Error).message}`); }
  if (v.schema !== 'gatekeep.verdict.v1' || !v.checks?.testIntegrity) throw new UserError(`${vp} is not a gatekeep verdict`);
  const html = await renderReport(v, { root, verdictPath: vp });
  if (args.flags.stdout) { process.stdout.write(html); return 0; }
  const out = typeof args.flags.out === 'string' ? path.resolve(cwd, args.flags.out) : vp.replace(/\.json$/, '') + '.html';
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, html, { mode: 0o600 });
  console.log(out);
  if (args.flags.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [out], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => { /* printing the path is enough */ }).unref();
  }
  return 0;
}

async function cmdStatus(cwd: string): Promise<number> {
  const hooks = await installedHooks(cwd);
  console.log(`gatekeep ${VERSION}`);
  console.log(hooks.length ? 'Hooks:' : 'Hooks: none found (run `gatekeep install`)');
  for (const h of hooks) console.log(`  ${h.file}: ${h.events.join(', ')}`);
  const root = await repoRoot(cwd);
  if (!root) { console.log('Repository: not inside a git repository'); return 0; }
  console.log(`Repository: ${root}`);
  console.log(`Config: ${existsSync(path.join(root, CONFIG_FILENAME)) ? CONFIG_FILENAME : 'none (defaults)'}`);
  const recorder = hooks.some((h) => h.events.includes('PostToolUse'));
  console.log(recorder ? 'Claims recorder: wired (PostToolUse)' : 'Claims recorder: not wired — the four claims rules cannot run. `gatekeep install` adds it.');
  const prot = await protectedIn(root, settingsFiles(root));
  console.log(prot.length ? `protect-tests: on — ${prot.map((p) => `${p.file} (${p.deny} deny entries)`).join(', ')}` : 'protect-tests: off (run `gatekeep protect-tests` to make the test tree read-only)');
  // Whether the gate can actually stop anything is the first thing someone reading `status` needs to know.
  {
    const { cfg } = await configFor(root, null, null);
    if (!cfg.shadow) console.log('Blocking: on');
    else {
      const st = await readShadowState(root);
      const status = statusOf(cfg.shadow, st);
      console.log(`Blocking: off — shadow mode since ${cfg.shadow.startedAt}${status.elapsed ? ', window elapsed' : `, ${status.daysLeft ?? '—'} day(s) / ${status.sessionsLeft ?? '—'} session(s) left`}`);
      console.log(`  ${st.wouldHaveBlocked} of ${st.stops} stop(s) would have been blocked. \`gatekeep shadow --off\` turns blocking on.`);
    }
  }
  const { problems } = parseConfig(await readConfigText(root));
  for (const p of problems) console.log(`  config problem: ${p}`);
  console.log(`State: ${repoStateDir(root)}`);
  const sessions = await listSessions(root);
  console.log(`Sessions: ${sessions.length}`);
  for (const s of sessions.slice(-5)) console.log(`  ${s.id.slice(0, 12)}  ${s.startedAt}  ${s.harness}  blocks=${s.blocks}  base=${s.baseTree.slice(0, 10)}${s.prompt ? `  "${s.prompt.slice(0, 50).replace(/\s+/g, ' ')}"` : ''}`);
  const latest = path.join(verdictDir(root), 'latest.json');
  if (existsSync(latest)) {
    const v = JSON.parse(await fs.readFile(latest, 'utf8')) as Verdict;
    console.log(`Last verdict: ${v.decision.toUpperCase()} at ${v.createdAt} (${v.checks.testIntegrity.findings.length} finding(s)) — ${latest}`);
  } else console.log('Last verdict: none');
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  if (args.flags.version || args._[0] === 'version') { console.log(VERSION); return 0; }
  if (args.flags.help) { console.log(usage()); return 0; }
  switch (args._[0]) {
    case 'run': return cmdRun(args, cwd);
    case 'session': return cmdSession(args, cwd);
    case 'verify': return cmdVerify(args, cwd);
    case 'hook': return cmdHook(args, cwd);
    case 'install': return cmdInstall(args, cwd);
    case 'protect-tests': return cmdProtectTests(args, cwd);
    case 'calibrate': return cmdCalibrate(args, cwd);
    case 'shadow': return cmdShadow(args, cwd);
    case 'report-fp': return cmdReportFp(args, cwd);
    case 'uninstall': return cmdUninstall(args, cwd);
    case 'status': return cmdStatus(cwd);
    case 'report': return cmdReport(args, cwd);
    case 'init': {
      const root = (await repoRoot(cwd)) ?? cwd;
      const detected = await detectTestCommand(root);
      await fs.writeFile(path.join(root, CONFIG_FILENAME), defaultConfigText(detected));
      console.log(`Wrote ${path.join(root, CONFIG_FILENAME)}`);
      if (detected) console.log(`  testCommand: ${detected.command}  (detected from ${detected.from})`);
      return 0;
    }
    default:
      if (args._[0]) { console.error(`gatekeep: unknown command "${args._[0]}"\n`); console.log(usage()); return 3; }
      console.log(usage()); return 0;
  }
}

main().then((code) => { process.exitCode = code; }, (err: Error) => {
  const isHook = process.argv[2] === 'hook';
  const msg = err instanceof UserError || err instanceof GitError ? err.message : (err?.stack ?? String(err));
  console.error(`gatekeep: ${msg}`);
  // Hooks fail open (never trap the agent) but exit 1 so Claude Code shows the error to the user instead of discarding it.
  process.exitCode = isHook ? 1 : 3;
});
