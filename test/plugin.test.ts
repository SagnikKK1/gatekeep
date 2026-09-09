import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
