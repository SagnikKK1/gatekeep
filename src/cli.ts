#!/usr/bin/env node
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { analyze, needsContent, PROTECTED_FILES, type AnalysisResult } from './rules.js';
import { parseConfig, readConfigText, defaultConfigText, CONFIG_FILENAME, type GatekeepConfig } from './config.js';
import { repoRoot, gitDir, headTree, resolveTree, snapshotWorkingTree, diffTrees, catFile, lsTree, isShallow, BlobBatch, GitError, type SnapshotProblems } from './git.js';
import { langFor } from './lang.js';
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
import { spawn } from 'node:child_process';
import type { Finding, FileChange, Severity } from './model.js';

const require = createRequire(import.meta.url);
const VERSION: string = (require('../../package.json') as { version: string }).version;
const BOOL_FLAGS = new Set(['json', 'fail-on-warn', 'version', 'claude', 'codex', 'global', 'shared', 'help', 'quiet', 'no-judge', 'stdout', 'open', 'off', 'dry-run']);
const VALUE_FLAGS = ['session', 'base', 'allow', 'harness', 'id', 'task', 'transcript', 'judge', 'out'];

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
  gatekeep install [--shared | --global] [--codex]
      Wire the hooks. Default: .claude/settings.local.json (machine-local, not committed).
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

/**
 * Test files as they stood at session start. The oracle rule compares new source against what the tests know, and
 * an agent that fits the implementation to the tests does not touch them, so they are not in the diff. Bounded:
 * a repository with thousands of test files is not worth loading for this.
 */
const BASE_TESTS_MAX_FILES = 400, BASE_TESTS_MAX_BYTES = 4 * 1024 * 1024;
async function baseTestFiles(root: string, base: string, cfg: GatekeepConfig, changes: FileChange[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!changes.some((c) => !isTestFile(c.path, cfg.rules) && langFor(c.path) !== null)) return out; // no source changed
  let paths: string[];
  try { paths = await lsTree(root, base); } catch { return out; }
  const inDiff = new Set(changes.filter((c) => isTestFile(c.path, cfg.rules)).map((c) => c.path));
  const want = paths.filter((p) => isTestFile(p, cfg.rules) && !inDiff.has(p)).slice(0, BASE_TESTS_MAX_FILES);
  if (want.length === 0) return out;
  const batch = new BlobBatch(root);
  try {
    let bytes = 0;
    for (const p of want) {
      const b = await batch.read(base, p).catch(() => null);
      if (!b || b.length > 512 * 1024 || b.subarray(0, 8000).includes(0)) continue;
      bytes += b.length;
      if (bytes > BASE_TESTS_MAX_BYTES) break;
      out.set(p, b.toString('utf8'));
    }
  } finally { batch.close(); }
  return out;
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
  const vp = await writeVerdict(root, v);
  if (args.flags.json) console.log(JSON.stringify(v, null, 2));
  else console.log(formatReport(v, { forAgent: false, verdictPath: vp }));
  return v.decision === 'block' ? 1 : 0;
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
    const v = buildVerdict({ sessionId, harness, base: s.baseTree, cur, task: s.prompt, findings, result, originalTests, judge, strict: cfg.strict, blockCount: s.blocks + (decision === 'block' && !overLimit ? 1 : 0), t0, overrides: overridesFromPrompts(s.prompts ?? (s.prompt ? [s.prompt] : [])) });
    const vp = await writeVerdict(root, v);
    s.lastVerdict = vp;
    // One mechanism for both outcomes: exit 0 with JSON on stdout. `decision: "block"` is the documented Stop-hook
    // field and feeds `reason` back to the agent as its next instruction; `systemMessage` is what reaches the human.
    // Exit 2 with stderr blocks too, but cannot carry a message to the user in the same breath.
    if (decision === 'block' && !overLimit) {
      s.blocks += 1;
      await saveSession(root, s, gd);
      console.log(JSON.stringify({
        decision: 'block',
        reason: formatReport(v, { forAgent: true, verdictPath: vp }),
        systemMessage: `gatekeep blocked this stop (block ${s.blocks} of ${cfg.maxBlocks}); see ${vp}`,
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
  if (root) {
    const cfgPath = path.join(root, CONFIG_FILENAME);
    if (!existsSync(cfgPath)) {
      const detected = await detectTestCommand(root);
      await fs.writeFile(cfgPath, defaultConfigText(detected));
      console.log(`Wrote ${CONFIG_FILENAME} (commit it; the agent may not modify it during a session)`);
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
  return 0;
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
