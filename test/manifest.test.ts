import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SEVERITIES } from '../src/rules.js';

// The plugin manifests are what the Claude Code marketplace installs. `claude plugin validate` is the real check;
// these keep the parts that have to agree with the rest of the repository from drifting silently.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')) as Record<string, unknown>;

test('plugin manifest matches the package it installs', () => {
  const plugin = read('.claude-plugin/plugin.json');
  const market = read('.claude-plugin/marketplace.json');
  const pkg = read('package.json');
  assert.equal(plugin.version, pkg.version, 'plugin.json version must track package.json');
  const listed = (market.plugins as { name: string; version: string }[])[0]!;
  assert.equal(listed.version, pkg.version, 'marketplace entry version must track package.json');
  assert.equal(listed.name, plugin.name);
  assert.equal(plugin.license, pkg.license);
});

test('every hook the installer wires is also wired by the plugin, through the resolver', () => {
  const hooks = read('hooks/hooks.json').hooks as Record<string, { hooks: { command: string; timeout?: number }[] }[]>;
  assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
  const events: Record<string, string> = { SessionStart: 'session-start', UserPromptSubmit: 'prompt', Stop: 'stop' };
  for (const [event, arg] of Object.entries(events)) {
    const cmd = hooks[event]![0]!.hooks[0]!.command;
    assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/gatekeep-hook\.sh/, event);
    assert.ok(cmd.trim().endsWith(arg), `${event} must pass "${arg}", got: ${cmd}`);
  }
  const sh = fs.readFileSync(path.join(root, 'hooks/gatekeep-hook.sh'), 'utf8');
  assert.ok((fs.statSync(path.join(root, 'hooks/gatekeep-hook.sh')).mode & 0o111) !== 0, 'resolver must be executable');
  // The pinned fallback has to be a version that exists on the registry, so it tracks package.json too.
  assert.match(sh, new RegExp(`gatekeep-agent@${String(read('package.json').version).replace(/\./g, '\\.')}\\b`));
});

test('the rule table and the README count are generated from DEFAULT_SEVERITIES', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/rules.md'), 'utf8');
  const rows = [...doc.matchAll(/^\| `([a-z0-9-]+)` \| (block|warn|off) \|/gm)].map((m) => [m[1]!, m[2]!] as const);
  const documented = new Map(rows);
  assert.equal(rows.length, documented.size, 'a rule is listed twice in docs/rules.md');
  for (const [rule, severity] of Object.entries(DEFAULT_SEVERITIES)) {
    assert.ok(documented.has(rule), `docs/rules.md has no row for "${rule}"`);
    assert.equal(documented.get(rule), severity, `docs/rules.md gives "${rule}" the wrong default`);
  }
  for (const rule of documented.keys()) assert.ok(rule in DEFAULT_SEVERITIES, `docs/rules.md documents "${rule}", which is not a rule`);

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const claimed = /^(\d+) rules across/m.exec(readme);
  assert.ok(claimed, 'README no longer states a rule count in the form "N rules across …"');
  assert.equal(Number(claimed[1]), Object.keys(DEFAULT_SEVERITIES).length, 'the README rule count is stale');
});
