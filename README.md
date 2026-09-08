# gatekeep

An independent verification gate for AI coding agents. It runs when the agent tries to say "done" and blocks it when the work was faked instead of finished: tests tampered with, checks weakened, claims that nothing in the session backs up.

## Quick start

Requires Node 20+ and git.

```bash
npm install -g gatekeep-agent           # or: npx gatekeep-agent install
cd /path/to/your/project
gatekeep install                        # wires Claude Code hooks into .claude/settings.local.json
gatekeep status                         # confirms the hooks and shows the state directory
```

That is the whole setup. Start a Claude Code session as usual. When the agent tries to finish after weakening a test, it sees this instead and has to fix the implementation:

```
GATEKEEP BLOCKED — test integrity: 2 blocking, 0 warning(s); 1 test file(s) examined, 1 source file(s) changed.
  [block] test-deleted  tests/test_calc.py:6 [test_add_neg]
      Test "test_add_neg" removed (had 1 assertion(s))
  [block] assertion-weakened  tests/test_calc.py:4 [test_add]
      "test_add": 1 specific assertion(s) replaced by truthiness/existence/broad checks
      before: assert add(2, 3) == 5
      after:  assert add(2, 3)
```

Honest work passes silently. Warnings reach you, not the agent. After three blocks in one session the agent is allowed to finish and the findings are handed to you.

On pull requests, the same check runs from the diff in CI:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: SagnikKK1/gatekeep@main
```

`install` also writes `gatekeep.config.json`; commit it. `--shared` writes `.claude/settings.json` for the whole team (everyone needs `gatekeep` on PATH), `--global` writes `~/.claude/settings.json`, and `gatekeep uninstall` removes the hooks. From source: clone, then `npm install && npm run build && npm link`. Any other agent: `gatekeep session start --task "..."` before the work, `gatekeep verify --session <id>` after.

## Why

Agents under pressure to get a green run delete tests, skip them, weaken `==` into truthiness, return before the assertions, or mock away the module they just changed. ImpossibleBench measured frontier models doing this in up to 76% of runs where the spec and the tests conflicted. Lock the tests down and they go after whatever else grades them: a `@ts-ignore`, `continue-on-error` in CI, a strict flag turned off. gatekeep catches all of it deterministically from the diff, with no model call, and reads the agent's own summary only to check it for contradictions.

**gatekeep does not replace your test suite.** It is a diff gate: did the tests and checks that existed at the start of the session survive intact. Coverage cannot answer that: a skipped test, an `.only`, or `expect(true).toBe(true)` keeps every line executed while the test stops testing.

## How it works

- `SessionStart` snapshots the working tree as a git tree object and captures the gate's own config.
- `UserPromptSubmit` records the first prompt as the task statement.
- `Stop` diffs the working tree against the snapshot, parses every changed test file with tree-sitter, runs every rule family over the diff, and exits 2 with the report when it finds blocking tampering. Claude Code feeds that report back to the agent as its next instruction. After `maxBlocks` blocks (default 3) it lets the agent finish and hands the findings to you instead.

State lives in `~/.gatekeep/`, mirrored under the repository's own `.git/gatekeep/`, so the agent cannot edit its own block counter. The config is the copy captured at session start: editing `gatekeep.config.json` or the hook settings mid-session is itself a blocking finding.

## What it checks

62 rules in four deterministic families, plus two opt-in layers:

| Family | Blocks when |
|---|---|
| **Test integrity** | An existing test is deleted, skipped, focused, made vacuous, given an early exit, or its assertions are removed, weakened (`==` to truthiness, `raises(ValueError)` to `raises(Exception)`), made unreachable, swallowed in a `try`, shadowed, or mocked away on the module under test. Renames and moves are paired by body similarity first. Python, JS/TS, Go, Java, Rust, Ruby |
| **Check integrity** | CI steps removed or `continue-on-error` added, linter or type-checker config loosened, pre-commit hooks removed, suppression directives added, errors swallowed or validation removed in source, `.gitignore` made to hide tests |
| **Claims** | The final message says tests pass but none ran after the last edit; files it names did not change; git history was rewritten during the session |
| **Scope** | Protected paths edited (migrations, auth, payments, infra), new or loosened dependencies, registry changes, typosquats, secrets, a feature deleted together with its tests |
| **Original tests against final code** (opt-in `testCommand`) | The tests the session started with, kept where the agent cannot touch them, fail on the final code while the agent's edited tests pass |
| **Model-backed review** (opt-in `judge`) | A model reads the diff with the task in hand: weakened-but-passing tests, special-cased inputs, task mismatch, text addressed to the reviewer. It can add findings and annotate blocks; it can never lift one. Runs on an API key or your Claude subscription through Claude Code |

Every rule and its default severity: [docs/rules.md](docs/rules.md). The two opt-in layers in detail: [docs/checks.md](docs/checks.md) and [docs/judge.md](docs/judge.md).

## Run it yourself

```bash
gatekeep run                    # working tree vs HEAD
gatekeep run --base main        # working tree vs a branch; the config is read from that base
gatekeep run --json             # machine-readable verdict on stdout
gatekeep run --fail-on-warn     # treat warnings as blocking
gatekeep report --open          # the latest verdict as one HTML file, test bodies before and after next to each finding
```

Exit codes: `0` pass, `1` blocked, `3` error. Every run writes a verdict JSON under `~/.gatekeep/`, printed at the end of each report.

A block that is right in general and wrong for one change is lifted for that change only, with an audit trail, by a directive in your prompt or a commit trailer: `gatekeep: allow test-deleted -- CSV exporter removed per ticket 482`. `gate-config-changed` can never be lifted.

The GitHub Action posts findings as check annotations on the changed lines. Codex CLI hooks are wired but untested. Adapters, the override rules, the Action's inputs, and the verdict format: [docs/integrations.md](docs/integrations.md).

## Configuration

`gatekeep.config.json` at the repo root, all keys optional:

```json
{
  "maxBlocks": 3,
  "strict": false,
  "testCommand": "npm test --silent",
  "judge": { "model": "claude-opus-5" },
  "extraProtectedPaths": ["services/ledger/**"],
  "extraTestGlobs": ["**/qa/**/*.py"],
  "ignore": ["**/generated/**"],
  "rules": { "retry-added": "off", "test-conditionally-skipped": "block" }
}
```

Unknown keys and rule names are reported as `config-invalid` warnings rather than silently ignored.

## Development

```bash
npm test          # builds, then replays fixtures/ and runs unit tests
scripts/e2e.sh    # hook protocol, state layout, installer, tamper resistance, CLI edge cases
```

Fixtures are `before/` and `after/` trees plus `expected.json`, generated by `scripts/gen_fixtures.py`: per-language detections, three red-team passes of evasion techniques, and legitimate refactors that must not block.

`scripts/corpus-fp.mjs <repo> 300` replays the last 300 commits of any repository through the rules. On flask, express, zod, cobra, clap, gson and sinatra the blocking residual is almost entirely tests that were genuinely removed with the feature they covered, which is the intended block and what the override directive is for. Full tables, and why the ImpossibleBench catch rate is not yet publishable: [docs/replay.md](docs/replay.md).

## Known limits

- Assertion-level analysis covers Python, JS/TS, Go, Java, Rust and Ruby. Other languages get the file-level rules and the check-integrity, scope and claim families.
- An implementation that special-cases the test inputs passes the original tests too. The deterministic gate cannot see it; the model-backed review can, and mutation testing on the changed lines is the planned full answer.
- The claim rules read the Claude Code transcript format and cannot be replayed over commit history, so they rest on fixtures.
- `test-deleted` blocks legitimate removals. The override directive lifts it for one change; per-rule severity and the block limit are the repo-wide alternatives.
- A verdict from the Stop hook is produced on the agent's machine. A merge check should trust only the GitHub Action, which recomputes it in CI.
- Every `Stop` snapshots the whole working tree: 0.3 s for a one-file change in a 6,000-file repository, about 10 s when 3,000 files change; a large monorepo has not been measured.
- Codex hooks are untested against a live install. Cursor, Copilot agent mode and Gemini CLI use the generic protocol. Windows is untested.

## Roadmap

In order: a wider false-positive replay and a transcript corpus for the claim rules; a published catch rate once a benchmark release preserves the agents' test edits; GitLab CI and a pull-request label as a second override source; native adapters for Cursor, Gemini CLI, OpenCode and Aider; C# and Kotlin; a large-monorepo measurement and Windows CI; then incremental mutation testing on the lines the agent changed, holdout tests generated out of the agent's sight, and a hosted PR check for organizations.

Every new rule family ships with its own false-positive fixtures and a column in the replay table before any of its rules defaults to block. Nothing leaves the machine: the gate writes only to `~/.gatekeep/` and `.git/gatekeep/`, the original-tests run happens in a temporary export, and the model-backed review is off unless you turn it on. Apache-2.0, no telemetry, no paid tier.
