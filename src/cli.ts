#!/usr/bin/env node
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { analyze, needsContent, PROTECTED_FILES, type AnalysisResult } from './rules.js';
import { parseConfig, readConfigText, defaultConfigText, CONFIG_FILENAME, type GatekeepConfig } from './config.js';
import { repoRoot, gitDir, headTree, resolveTree, snapshotWorkingTree, diffTrees, catFile, GitError } from './git.js';
import { loadSession, saveSession, newSession, listSessions, repoStateDir, verdictDir, withSessionLock, type SessionState } from './session.js';
import { decide, writeVerdict, formatReport, type Verdict } from './verdict.js';
import { installClaudeCode, uninstallClaudeCode, installCodex, installedHooks } from './install.js';
import type { Finding } from './model.js';

const require = createRequire(import.meta.url);
const VERSION: string = (require('../../package.json') as { version: string }).version;
const BOOL_FLAGS = new Set(['json', 'fail-on-warn', 'version', 'claude', 'codex', 'global', 'shared', 'help', 'quiet']);

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
  gatekeep run [--base <ref>] [--session <id>] [--json] [--fail-on-warn]
      Check the working tree against a baseline (default: HEAD, or the session's start snapshot).
      Exit 0 = pass, 1 = blocked, 3 = error.
  gatekeep hook session-start|prompt|stop [--harness claude-code|codex]
      Entry points wired into the agent's hooks. Reads the hook JSON on stdin.
  gatekeep install [--shared | --global] [--codex]
      Wire the hooks. Default: .claude/settings.local.json (machine-local, not committed).
      --shared writes .claude/settings.json and expects \`gatekeep\` on PATH (npm link / npm i -g).
  gatekeep uninstall [--shared | --global]
  gatekeep status
      Show where hooks are wired, the state directory, recent sessions and the last verdict.
  gatekeep init
      Write a ${CONFIG_FILENAME} with default rule severities.
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

async function runAnalysis(root: string, base: string, cfg: GatekeepConfig, sessionMode: boolean): Promise<{ cur: string; result: AnalysisResult }> {
  const cur = await snapshotWorkingTree(root);
  const changes = await diffTrees(root, base, cur, { shouldLoad: (p) => needsContent(p, cfg.rules), maxBytes: 2 * 1024 * 1024 });
  const result = await analyze(changes, cfg.rules, { exists: (p) => existsSync(path.join(root, p)), sessionMode });
  return { cur, result };
}

/** Protected files hashed straight from disk, so gitignored ones (the default settings.local.json) are covered too. */
async function protectedHashes(root: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const f of PROTECTED_FILES) {
    try { out[f] = createHash('sha1').update(await fs.readFile(path.join(root, f))).digest('hex'); } catch { out[f] = null; }
  }
  return out;
}

function buildVerdict(p: { sessionId: string | null; harness: string | null; base: string; cur: string; task: string | null; findings: Finding[]; result: AnalysisResult; strict: boolean; blockCount: number; t0: number }): Verdict {
  const decision = decide(p.findings, p.strict);
  return {
    schema: 'gatekeep.verdict.v1', createdAt: new Date().toISOString(), sessionId: p.sessionId, harness: p.harness,
    baseTree: p.base, currentTree: p.cur, task: p.task, decision,
    checks: { testIntegrity: { status: decision === 'block' ? 'fail' : decision === 'warn' ? 'warn' : 'pass', findings: p.findings, examined: p.result.examined, changedSourceFiles: p.result.changedSourceFiles } },
    blockCount: p.blockCount, durationMs: Date.now() - p.t0,
  };
}

async function cmdRun(args: Args, cwd: string): Promise<number> {
  const root = await repoRoot(cwd);
  if (!root) throw new UserError('not inside a git repository');
  for (const k of ['session', 'base']) if (args.flags[k] === true) throw new UserError(`--${k} requires a value`);
  const sessionId = typeof args.flags.session === 'string' ? args.flags.session : null;
  const gd = await gitDir(root).catch(() => null);
  const session = sessionId ? await loadSession(root, sessionId, gd) : null;
  if (sessionId && !session) throw new UserError(`no session "${sessionId}" recorded for this repository (see \`gatekeep status\`)`);
  let base: string, baseForConfig: string | null = null;
  if (typeof args.flags.base === 'string') {
    try { base = await resolveTree(root, args.flags.base); } catch { throw new UserError(`--base ${args.flags.base}: not a commit, branch or tag in this repository`); }
    baseForConfig = base;
  } else base = session?.baseTree ?? await headTree(root);
  const t0 = Date.now();
  const { cfg, findings: cfgFindings } = await configFor(root, baseForConfig, session);
  const { cur, result } = await runAnalysis(root, base, cfg, session !== null);
  const strict = cfg.strict || args.flags['fail-on-warn'] === true;
  const v = buildVerdict({ sessionId, harness: session?.harness ?? null, base, cur, task: session?.prompt ?? null, findings: [...cfgFindings, ...result.findings], result, strict, blockCount: session?.blocks ?? 0, t0 });
  const vp = await writeVerdict(root, v);
  if (args.flags.json) console.log(JSON.stringify(v, null, 2));
  else console.log(formatReport(v, { forAgent: false, verdictPath: vp }));
  return v.decision === 'block' ? 1 : 0;
}

async function cmdHook(args: Args, cwd: string): Promise<number> {
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
    const source = typeof input.source === 'string' ? input.source : '';
    // On resume/compact keep the original baseline; on a fresh start take a new one.
    if (existing && (source === 'resume' || source === 'compact')) { if (existing.recovered) await saveSession(root, existing, gd); }
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
      if (!s.prompt && typeof input.prompt === 'string') { s.prompt = input.prompt.slice(0, 4000); await saveSession(root, s, gd); }
    });
    return 0;
  }
  if (event === 'stop') return withSessionLock(root, sessionId, () => stopHook(root, sessionId, harness, input, gd));
  throw new UserError(`unknown hook event "${event}"`);
}

async function stopHook(root: string, sessionId: string, harness: string, input: Record<string, unknown>, gd: string | null): Promise<number> {
  {
    let s = await loadSession(root, sessionId, gd);
    const stateFindings: Finding[] = [];
    if (!s) {
      // No baseline at all: either the hook was installed mid-session, or the session state was deleted. Fall back to HEAD and say so.
      s = await newSession(root, sessionId, harness, await headTree(root), await readConfigText(root), gd);
      stateFindings.push({ rule: 'session-state-missing', severity: 'warn', file: '.', message: 'No session baseline was found for this session (hook installed mid-session, or the state directory was deleted); compared against HEAD instead. Changes already committed during the session were not checked.' });
    } else if (s.recovered) {
      stateFindings.push({ rule: 'session-state-missing', severity: 'warn', file: '.', message: `Session state under ${repoStateDir(root)} was missing; baseline recovered from the .git mirror` });
      await saveSession(root, s, gd);
    }
    const t0 = Date.now();
    const { cfg, findings: cfgFindings } = await configFor(root, null, s);
    const { cur, result } = await runAnalysis(root, s.baseTree, cfg, true);
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
    const findings = [...stateFindings.filter(() => (cfg.rules.severities['session-state-missing'] ?? 'warn') !== 'off').map((f) => ({ ...f, severity: cfg.rules.severities['session-state-missing'] ?? 'warn' })), ...cfgFindings, ...result.findings];
    const decision = decide(findings, cfg.strict);
    void input;
    const overLimit = decision === 'block' && s.blocks >= cfg.maxBlocks;
    const v = buildVerdict({ sessionId, harness, base: s.baseTree, cur, task: s.prompt, findings, result, strict: cfg.strict, blockCount: s.blocks + (decision === 'block' && !overLimit ? 1 : 0), t0 });
    const vp = await writeVerdict(root, v);
    s.lastVerdict = vp;
    if (decision === 'block' && !overLimit) {
      s.blocks += 1;
      await saveSession(root, s, gd);
      console.error(formatReport(v, { forAgent: true, verdictPath: vp }));
      return 2; // exit 2 = block; stderr is fed back to the agent
    }
    await saveSession(root, s, gd);
    if (decision !== 'pass') {
      // Stop-hook stdout is discarded on exit 0; the documented channel to reach the human is a systemMessage.
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
    const r = await installCodex(cwd);
    console.log(`Codex: wrote ${r.file}. ${r.note}`);
  }
  const root = await repoRoot(cwd);
  if (root) {
    const cfgPath = path.join(root, CONFIG_FILENAME);
    if (!existsSync(cfgPath)) { await fs.writeFile(cfgPath, defaultConfigText()); console.log(`Wrote ${CONFIG_FILENAME} (commit it; the agent may not modify it during a session)`); }
  } else console.log('Note: not inside a git repository; hooks were written but gatekeep only runs inside git repositories.');
  return 0;
}

async function cmdUninstall(args: Args, cwd: string): Promise<number> {
  const target = args.flags.global === true ? 'global' : args.flags.shared === true ? 'project-shared' : 'project-local';
  const r = await uninstallClaudeCode(target, cwd);
  console.log(r.removed ? `Removed ${r.removed} gatekeep hook(s) from ${r.file}` : `No gatekeep hooks in ${r.file}`);
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
    case 'hook': return cmdHook(args, cwd);
    case 'install': return cmdInstall(args, cwd);
    case 'uninstall': return cmdUninstall(args, cwd);
    case 'status': return cmdStatus(cwd);
    case 'init': {
      const root = (await repoRoot(cwd)) ?? cwd;
      await fs.writeFile(path.join(root, CONFIG_FILENAME), defaultConfigText());
      console.log(`Wrote ${path.join(root, CONFIG_FILENAME)}`);
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
