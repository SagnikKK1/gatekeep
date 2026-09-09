#!/bin/sh
# Plugin entry point for gatekeep's Claude Code hooks. Usage: gatekeep-hook.sh <session-start|prompt|stop>
#
# Resolution order, fastest first. `npx` is the fallback rather than the default because it costs about two seconds
# per call even with a warm cache, and UserPromptSubmit runs on every prompt the human types.
#   1. a `gatekeep` already on PATH (npm i -g gatekeep-agent)
#   2. the plugin's own build, when the checkout has one and its dependencies are installed
#   3. npx against the published package
set -u
event=${1:?usage: gatekeep-hook.sh <session-start|prompt|stop>}
pinned=gatekeep-agent@0.1.0

if command -v gatekeep >/dev/null 2>&1; then
  exec gatekeep hook "$event" --harness claude-code
fi

root=${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
if [ -f "$root/dist/src/cli.js" ] && [ -d "$root/node_modules/@vscode/tree-sitter-wasm" ]; then
  exec node "$root/dist/src/cli.js" hook "$event" --harness claude-code
fi

exec npx -y "$pinned" hook "$event" --harness claude-code
