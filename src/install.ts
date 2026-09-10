import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot } from './git.js';

const execFileP = promisify(execFile);

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Command used inside hook config. `shared` assumes a global `gatekeep` on PATH; otherwise an absolute node invocation. */
export async function hookCommandPrefix(shared: boolean): Promise<string> {
  if (shared) return 'gatekeep';
  try { await execFileP('gatekeep', ['--version']); return 'gatekeep'; } catch { /* not on PATH */ }
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
  return `node ${shellQuote(cli)}`;
}

type HookCmd = { type: 'command'; command: string; timeout?: number };
type HookEntry = { matcher?: string; hooks: HookCmd[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

export const GATEKEEP_HOOK_RE = /(gatekeep|cli\.js)['"]?\s+hook\s+(session-start|prompt|stop)\b/;

export interface InstallTarget { kind: 'project-local' | 'project-shared' | 'global'; file: string }

export function claudeSettingsFile(target: InstallTarget['kind'], cwd: string): string {
  if (target === 'global') return path.join(process.env.HOME ?? process.env.USERPROFILE ?? '~', '.claude', 'settings.json');
  return path.join(cwd, '.claude', target === 'project-shared' ? 'settings.json' : 'settings.local.json');
}

async function readSettings(file: string): Promise<Settings> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return {}; }
  try { return JSON.parse(raw) as Settings; }
  catch (e) { throw new Error(`${file} exists but is not valid JSON (${(e as Error).message}). Fix it by hand; gatekeep will not overwrite it.`); }
}

export async function installClaudeCode(target: InstallTarget['kind'], cwd: string): Promise<{ file: string; added: string[]; updated: string[] }> {
  const file = claudeSettingsFile(target, cwd);
  const settings = await readSettings(file);
  settings.hooks = settings.hooks ?? {};
  const prefix = await hookCommandPrefix(target === 'project-shared');
  const wanted: Record<string, { command: string; timeout: number }> = {
    SessionStart: { command: `${prefix} hook session-start --harness claude-code`, timeout: 120 },
    UserPromptSubmit: { command: `${prefix} hook prompt --harness claude-code`, timeout: 10 },
    Stop: { command: `${prefix} hook stop --harness claude-code`, timeout: 600 },
  };
  const added: string[] = [], updated: string[] = [];
  for (const [event, h] of Object.entries(wanted)) {
    const list = settings.hooks[event] ?? [];
    let found = false;
    for (const entry of list) {
      for (const cmd of entry.hooks ?? []) {
        if (GATEKEEP_HOOK_RE.test(cmd.command)) {
          if (!found) { if (cmd.command !== h.command || cmd.timeout !== h.timeout) { cmd.command = h.command; cmd.timeout = h.timeout; updated.push(event); } found = true; }
          else cmd.command = ''; // duplicate from an earlier non-idempotent install
        }
      }
      entry.hooks = (entry.hooks ?? []).filter((c) => c.command !== '');
    }
    const cleaned = list.filter((e) => e.hooks.length > 0);
    if (!found) { cleaned.push({ hooks: [{ type: 'command', command: h.command, timeout: h.timeout }] }); added.push(event); }
    settings.hooks[event] = cleaned;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, added, updated };
}

export async function uninstallClaudeCode(target: InstallTarget['kind'], cwd: string): Promise<{ file: string; removed: number }> {
  const file = claudeSettingsFile(target, cwd);
  const settings = await readSettings(file);
  let removed = 0;
  for (const [event, list] of Object.entries(settings.hooks ?? {})) {
    for (const entry of list) {
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((c) => !GATEKEEP_HOOK_RE.test(c.command));
      removed += before - entry.hooks.length;
    }
    settings.hooks![event] = list.filter((e) => e.hooks.length > 0);
    if (settings.hooks![event]!.length === 0) delete settings.hooks![event];
  }
  if (removed > 0) await fs.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, removed };
}

/** Which Claude Code settings files currently carry gatekeep hooks. */
export async function installedHooks(cwd: string): Promise<{ file: string; events: string[] }[]> {
  const out: { file: string; events: string[] }[] = [];
  for (const kind of ['project-local', 'project-shared', 'global'] as const) {
    const file = claudeSettingsFile(kind, cwd);
    let s: Settings;
    try { s = await readSettings(file); } catch { out.push({ file, events: ['(unparseable)'] }); continue; }
    const events = Object.entries(s.hooks ?? {}).filter(([, list]) => list.some((e) => e.hooks?.some((c) => GATEKEEP_HOOK_RE.test(c.command)))).map(([ev]) => ev);
    if (events.length) out.push({ file, events });
  }
  return out;
}

/**
 * Codex reads `<repo>/.codex/hooks.json` as well as `~/.codex/hooks.json`. The repo-level file is the one a team
 * can commit, so it is the default here, matching the Claude Code side which also defaults to the project.
 */
export async function installCodex(cwd: string, target: InstallTarget['kind'] = 'project-local'): Promise<{ file: string; note: string }> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
  const file = target === 'global'
    ? path.join(home, '.codex', 'hooks.json')
    : path.join((await repoRoot(cwd)) ?? cwd, '.codex', 'hooks.json');
  const prefix = await hookCommandPrefix(target === 'project-shared');
  const settings = await readSettings(file);
  settings.hooks = settings.hooks ?? {};
  const wanted: Record<string, string> = {
    SessionStart: `${prefix} hook session-start --harness codex`,
    UserPromptSubmit: `${prefix} hook prompt --harness codex`,
    Stop: `${prefix} hook stop --harness codex`,
  };
  for (const [event, command] of Object.entries(wanted)) {
    const list = settings.hooks[event] ?? [];
    const existing = list.flatMap((e) => e.hooks).find((c) => GATEKEEP_HOOK_RE.test(c.command));
    if (existing) existing.command = command;
    else list.push({ hooks: [{ type: 'command', command, timeout: 300 }] });
    settings.hooks[event] = list;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  return { file, note: 'Codex hook support varies by version and hooks must be trusted per Codex policy; this path is untested against a live Codex install.' };
}
