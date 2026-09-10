import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileChange, Finding, Severity } from './model.js';
import { catFile } from './git.js';
import { isTestFile, type RuleConfig } from './rules.js';
import { langFor, matchesAny } from './lang.js';
import { CONFIG_FILENAME } from './config.js';

const execFileP = promisify(execFile);

export interface TestRunConfig {
  /** The repository's own test command, run with `sh -c`. Null disables the check. */
  testCommand: string | null;
  /**
   * Budget for the whole check, not for one run. Both runs and the tree exports come out of it, because the Stop
   * hook is installed with a 600 s ceiling: two independent 300 s runs would be killed by the harness mid-check,
   * and a hook the harness kills returns no decision at all, so the gate would fail open.
   */
  testTimeoutMs: number;
}

export interface TestRunResult {
  status: 'pass' | 'fail' | 'skipped' | 'error';
  /** Exit code of the original tests against the current source. */
  originalExit: number | null;
  /** Exit code of the agent's visible copy, run only when the original tests failed. */
  currentExit: number | null;
  originalOutput: string;
  currentOutput: string;
  restoredTestFiles: string[];
  durationMs: number;
  reason?: string;
}

/** Directories that hold installed dependencies; linked into the scratch worktree so the suite can run there. */
const DEP_DIRS = ['node_modules', '.venv', 'venv', '.tox', 'vendor', 'target', '.pnpm-store'];
const OUTPUT_TAIL = 4000;

/**
 * Roadmap item 1: the tests the session started with, run against the code the agent ends with.
 * The agent keeps editing its visible copy; the original tests live in a scratch export it never sees.
 */
export async function runOriginalTests(root: string, baseTree: string, curTree: string, changes: FileChange[], rules: RuleConfig, cfg: TestRunConfig): Promise<TestRunResult | null> {
  if (!cfg.testCommand) return null;
  const t0 = Date.now();
  const deadline = t0 + cfg.testTimeoutMs;
  const relevant = changes.some((c) => isTestFile(c.path, rules) || (c.oldPath !== undefined && isTestFile(c.oldPath, rules)) || matchesAny(c.path, rules.testConfigGlobs) || langFor(c.path) !== null);
  if (!relevant) return { status: 'skipped', originalExit: null, currentExit: null, originalOutput: '', currentOutput: '', restoredTestFiles: [], durationMs: Date.now() - t0, reason: 'no code, test or test-config changes' };

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'gatekeep-run-'));
  try {
    const original = path.join(scratch, 'original-tests');
    await exportTree(root, curTree, original);
    const restored = await overlayOriginalTests(root, baseTree, changes, rules, original);
    await linkDeps(root, original);
    const first = await runCommand(cfg.testCommand, original, Math.max(1, deadline - Date.now()));
    if (first.error) return { status: 'error', originalExit: first.code, currentExit: null, originalOutput: first.output, currentOutput: '', restoredTestFiles: restored, durationMs: Date.now() - t0, reason: first.error };
    // A command the shell could not run is a configuration problem, not a failing suite. Reporting `pytest -q` as
    // "the tests fail" when pytest is not installed is worse than saying nothing: it accuses the agent of breaking
    // something, and nothing was tested at all. `install` detects a test command from config files, so it can pick
    // one whose binary is not on this machine.
    if (NOT_RUNNABLE.has(first.code)) {
      return { status: 'error', originalExit: first.code, currentExit: null, originalOutput: first.output, currentOutput: '', restoredTestFiles: restored, durationMs: Date.now() - t0, reason: first.code === 127 ? 'command not found' : 'found but not executable' };
    }
    if (first.code === 0) return { status: 'pass', originalExit: 0, currentExit: null, originalOutput: first.output, currentOutput: '', restoredTestFiles: restored, durationMs: Date.now() - t0 };
    // Original tests fail. Does the agent's own copy pass? That difference is the finding.
    const current = path.join(scratch, 'current');
    await exportTree(root, curTree, current);
    await linkDeps(root, current);
    const left = deadline - Date.now();
    // Out of budget: say so rather than spending another full timeout the hook does not have.
    const second = left > 0 ? await runCommand(cfg.testCommand, current, left) : { code: -1, output: '', error: 'timeout' };
    return { status: 'fail', originalExit: first.code, currentExit: second.error ? null : second.code, originalOutput: first.output, currentOutput: second.output, restoredTestFiles: restored, durationMs: Date.now() - t0, reason: second.error };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** `sh` exits 127 when the command does not exist and 126 when it exists but cannot be executed. */
const NOT_RUNNABLE = new Set([126, 127]);

export function testRunFindings(r: TestRunResult | null, severities: Record<string, Severity>): Finding[] {
  if (!r) return [];
  const sev = (rule: string, dflt: Severity): Severity => severities[rule] ?? dflt;
  const mk = (rule: string, dflt: Severity, message: string): Finding[] => (sev(rule, dflt) === 'off' ? [] : [{ rule, severity: sev(rule, dflt), file: '.', message }]);
  const tail = (s: string) => s.trim().split('\n').slice(-12).join('\n');
  // A run the clock killed is a timeout wherever it happened, not an unexplained error.
  if (r.status === 'error') {
    if (r.originalExit !== null && NOT_RUNNABLE.has(r.originalExit)) {
      return mk('test-run-error', 'warn', `The configured test command could not be run (exit ${r.originalExit}: ${r.reason}), so nothing was tested. This is a problem with "testCommand" in ${CONFIG_FILENAME}, not a failing test suite — set it to a command that exists here, or to null to turn the original-tests check off.\n${tail(r.originalOutput)}`);
    }
    return r.reason === 'timeout'
      ? mk('test-run-timeout', 'warn', `The test command exceeded its time limit`)
      : mk('test-run-error', 'warn', `Could not run the test command: ${r.reason}`);
  }
  if (r.status !== 'fail') return [];
  if (r.currentExit === 0) {
    return mk('original-tests-fail', 'block', `The tests as they were at session start fail against the current code (exit ${r.originalExit}) while the edited tests pass. Restored for this run: ${r.restoredTestFiles.join(', ') || 'none'}.\n${tail(r.originalOutput)}`);
  }
  if (r.reason === 'timeout') return mk('test-run-timeout', 'warn', `The test command exceeded its time limit`);
  return mk('tests-failing', 'warn', `The test command fails (exit ${r.originalExit}) on the current code, with the original tests and with the edited ones.\n${tail(r.originalOutput)}`);
}

async function exportTree(root: string, tree: string, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await execFileP('sh', ['-c', 'git archive --format=tar "$1" | tar -x -C "$2"', 'sh', tree, dir], { cwd: root, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_INDEX_FILE: path.join(os.tmpdir(), 'gatekeep-no-index') } });
}

/** Put the base tree's test files (and test configuration) over the exported current tree. Returns the paths restored. */
async function overlayOriginalTests(root: string, baseTree: string, changes: FileChange[], rules: RuleConfig, dir: string): Promise<string[]> {
  const restored: string[] = [];
  const write = async (p: string, content: string) => { const t = path.join(dir, p); await fs.mkdir(path.dirname(t), { recursive: true }); await fs.writeFile(t, content); };
  for (const c of changes) {
    const base = c.path.split('/').pop() ?? '';
    const wasTest = c.oldPath !== undefined ? isTestFile(c.oldPath, rules) : isTestFile(c.path, rules);
    const isTest = isTestFile(c.path, rules);
    const isCfg = matchesAny(c.path, rules.testConfigGlobs) && !isTest;
    if (!wasTest && !isTest && !isCfg) continue;
    if (base === 'package.json') {
      // keep the agent's dependencies, restore the test tooling sections
      const before = c.before ?? (await catFile(root, baseTree, c.path));
      if (before !== undefined && c.after !== undefined) { const spliced = splicePackageJson(before, c.after); if (spliced !== null) { await write(c.path, spliced); restored.push(c.path); } }
      continue;
    }
    if (c.status === 'A') { if (isTest) { await fs.rm(path.join(dir, c.path), { force: true }); restored.push(`-${c.path}`); } continue; }
    const originalPath = c.oldPath ?? c.path;
    const content = c.before ?? (await catFile(root, baseTree, originalPath));
    if (content === undefined) continue;
    if (c.status === 'R') await fs.rm(path.join(dir, c.path), { force: true });
    await write(originalPath, content);
    restored.push(originalPath);
  }
  return restored;
}

/** Current package.json with the test-runner sections and the test script taken from the base version. */
export function splicePackageJson(baseText: string, currentText: string): string | null {
  try {
    const base = JSON.parse(baseText) as Record<string, unknown>;
    const cur = JSON.parse(currentText) as Record<string, unknown>;
    for (const k of ['jest', 'vitest', 'mocha', 'ava', 'nyc', 'c8']) { if (base[k] !== undefined) cur[k] = base[k]; else delete cur[k]; }
    const bs = (base.scripts ?? {}) as Record<string, unknown>;
    const cs = { ...((cur.scripts ?? {}) as Record<string, unknown>) };
    if (bs.test !== undefined) cs.test = bs.test; else delete cs.test;
    cur.scripts = cs;
    return JSON.stringify(cur, null, 2) + '\n';
  } catch { return null; }
}

async function linkDeps(root: string, dir: string): Promise<void> {
  for (const d of DEP_DIRS) {
    const src = path.join(root, d);
    if (existsSync(src) && !existsSync(path.join(dir, d))) { try { await fs.symlink(src, path.join(dir, d)); } catch { /* ignore */ } }
  }
}

function runCommand(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string; error?: string }> {
  return new Promise((resolve) => {
    let out = '';
    // The suite must not be able to tell that gatekeep is the one running it: a stable signal here is an oracle a
    // special-cased implementation can branch on, which is exactly the cheat this check exists to catch. Our own
    // variables are removed rather than added to.
    const env: NodeJS.ProcessEnv = { ...process.env, CI: process.env.CI ?? '1' };
    for (const k of Object.keys(env)) if (/^(GATEKEEP|STOPGATE)_/.test(k)) delete env[k];
    const child = spawn('sh', ['-c', cmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (d: Buffer) => { out += d.toString('utf8'); if (out.length > OUTPUT_TAIL * 4) out = out.slice(-OUTPUT_TAIL * 2); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, output: out.slice(-OUTPUT_TAIL), error: 'timeout' }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: out, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output: out.slice(-OUTPUT_TAIL) }); });
  });
}
