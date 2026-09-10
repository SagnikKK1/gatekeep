# gatekeep

An independent verification gate for AI coding agents. It runs when the agent tries to say "done" and blocks it when the work was faked instead of finished: tests tampered with, checks weakened, claims that nothing in the session backs up.

![The agent reports "Done — all tests pass." gatekeep blocks the stop with three findings: two tests deleted and one assertion replaced with a truthiness check](assets/block.svg)

<sub>Real output from the Stop hook, not a mockup.</sub>

## Quick start

Requires Node 20+ and git.

```bash
npm install -g gatekeep-agent           # or: npx gatekeep-agent install
cd /path/to/your/project
gatekeep install                        # wires Claude Code hooks into .claude/settings.local.json
gatekeep status                         # confirms the hooks and shows the state directory
```

As a Claude Code plugin instead, which wires the same three hooks for every project without touching any repository:

```bash
claude plugin marketplace add SagnikKK1/gatekeep
claude plugin install gatekeep@gatekeep
```

The plugin runs a `gatekeep` already on your PATH, falls back to the plugin's own build, and only then to `npx`.
Install the npm package too if you want the fast path.

`install` also writes `gatekeep.config.json` and fills in `testCommand` from whatever the repository already uses — `package.json` `scripts.test`, `Cargo.toml`, `go.mod`, a pytest config, a `test:` target in a Makefile — printing what it matched. That turns on the strongest check here: **at every stop, the test files as they stood at session start are restored and the suite is run against the final code.** An agent that edited a test to fit its implementation fails against the tests it was given. Set `"testCommand": null` if the detected command is wrong, or too slow to run on every stop.

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
permissions: { contents: read, checks: write }
steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 }          # gatekeep needs the base commit; depth 1 cannot see it
  - uses: SagnikKK1/gatekeep@v1
```

The **Claude Agent SDK** needs nothing beyond this: `query()` loads `.claude/settings.json` and its hooks from the
filesystem unless you pass `settingSources: []`. The **Devin CLI** reads Claude Code's settings files too, so
`gatekeep install` is the whole setup there as well. Both, with the caveats: [docs/integrations.md](docs/integrations.md).

Commit `gatekeep.config.json`. `--shared` writes `.claude/settings.json` for the whole team (everyone needs `gatekeep` on PATH), `--global` writes `~/.claude/settings.json`, and `gatekeep uninstall` removes the hooks. From source: clone, then `npm install && npm run build && npm link`. Any other agent: `gatekeep session start --task "..."` before the work, `gatekeep verify --session <id>` after.

## Why

Agents under pressure to get a green run delete tests, skip them, weaken `==` into truthiness, return before the assertions, or mock away the module they just changed. ImpossibleBench measured frontier models doing this in up to 76% of runs where the spec and the tests conflicted; on its LiveCodeBench half, Claude Opus 5 in Claude Code never touched a test file but fitted the implementation to a wrong assertion in 54% of runs (measured here, see [docs/replay.md](docs/replay.md)). Lock the tests down and they go after whatever else grades them: a `@ts-ignore`, `continue-on-error` in CI, a strict flag turned off. gatekeep catches all of it deterministically from the diff, with no model call, and reads the agent's own summary only to check it for contradictions.

**gatekeep does not replace your test suite.** It is a diff gate: did the tests and checks that existed at the start of the session survive intact. Coverage cannot answer that: a skipped test, an `.only`, or `expect(true).toBe(true)` keeps every line executed while the test stops testing.

## How it works

- `SessionStart` snapshots the working tree as a git tree object and captures the gate's own config. Resuming, compacting, clearing or forking a session keeps the original snapshot, so work done before that point is still in the diff.
- `UserPromptSubmit` records the first prompt as the task statement.
- `Stop` diffs the working tree against the snapshot, parses every changed test file with tree-sitter, runs every rule family over the diff, and exits 2 with the report when it finds blocking tampering. Claude Code feeds that report back to the agent as its next instruction. After `maxBlocks` blocks (default 3) it lets the agent finish and hands the findings to you instead.

State lives in `~/.gatekeep/`, mirrored under the repository's own `.git/gatekeep/`, so the agent cannot edit its own block counter. The config is the copy captured at session start: editing `gatekeep.config.json` or the hook settings mid-session is itself a blocking finding.

## What it checks

The check that does not depend on recognising a tampering pattern comes first, and `install` turns it on whenever
it can detect your test command: the tests as they stood at session start are restored and the suite is run against
the final code.

68 rules across five deterministic families then read the diff itself, and a model-backed review you turn on reads
it once more with the task in hand.

| Family | Blocks when |
|---|---|
| **Original tests against final code** (`testCommand`, filled in by `install` when it can detect one) | The tests the session started with, kept where the agent cannot touch them, fail on the final code while the agent's edited tests pass. This is the check that does not depend on recognising a tampering pattern: it re-runs the original oracle |
| **Test integrity** | An existing test is deleted, skipped, focused, made vacuous, given an early exit, or its assertions are removed, weakened (`==` to truthiness, `raises(ValueError)` to `raises(Exception)`), made unreachable, swallowed in a `try`, shadowed, or mocked away on the module under test. Renames and moves are paired by body similarity first. Python, JS/TS, Go, Java, Rust, Ruby |
| **Check integrity** | CI steps removed or `continue-on-error` added, linter or type-checker config loosened, pre-commit hooks removed, suppression directives added, errors swallowed or validation removed in source, `.gitignore` made to hide tests |
| **Claims** | The final message says tests pass but none ran after the last edit; files it names did not change; git history was rewritten during the session |
| **Scope** | Protected paths edited (migrations, auth, payments, infra), new or loosened dependencies, registry changes, typosquats, secrets, a feature deleted together with its tests |
| **Source fitted to the tests** | A new branch compares against a value only the tests used, its constants are those of one test case, a table is keyed by test values, or the implementation reads the test runner's own environment. This is the half of source-side cheating a diff can see |
| **Model-backed review** (opt-in `judge`) | A model reads the diff with the task in hand: weakened-but-passing tests, special-cased inputs, task mismatch, text addressed to the reviewer. **Advisory** — it adds suggestions and annotates blocks, and never decides the verdict or lifts a block. Off unless you turn it on: it runs only when you set the API key it names, on your key, and never picks up an ambient login |

Every rule and its default severity: [docs/rules.md](docs/rules.md). The original-tests lane and the model-backed review in detail: [docs/checks.md](docs/checks.md) and [docs/judge.md](docs/judge.md).

**What the default configuration stops, and what it does not.** Out of the box the gate blocks a session that weakened
the tests or the checks that grade it, and — wherever `install` found a test command — re-runs the original tests
against the final code. Source-side fitting is only partly covered: on
[Impossible-LiveCodeBench](docs/replay.md#catch-rate-on-impossible-livecodebench) Claude Opus 5 never touched a test
file in 304 runs and fitted the implementation instead in 55 of them, and `test-oracle-in-source` reads 19 of those —
at `warn`, so by default they are reported rather than stopped. The other 36 hide an off-by-one inside ordinary
arithmetic, where only the specification says the code is wrong. The model-backed review flagged all 55, and it is
advisory and off unless you turn it on. Turn it on for work where that matters.

## Prevention: make the test tree read-only

Everything above is a gate — it reads what happened and decides afterwards. `protect-tests` is the other half: it
takes the option away, so there is nothing to catch.

```bash
gatekeep protect-tests --dry-run   # what it would protect
gatekeep protect-tests             # deny writes to the test tree in this project
gatekeep protect-tests --off
```

It collapses your test files into globs (`tests/**`, `**/*.test.ts`, `**/*_test.go`) and writes three layers into
`.claude/settings.local.json`: `permissions.deny` entries so the file tools refuse, `sandbox.filesystem.denyWrite`
so the write is refused even when it comes from a shell command, and a `PreToolUse` hook that turns the refusal
into something the agent can act on — *fix the implementation; if the test is genuinely wrong, say so instead of
editing it.*

Opt-in and independent of the gate: `gatekeep install` does not turn it on, neither one needs the other, and
`--off` removes exactly the entries it added. Details and limits: [docs/protect.md](docs/protect.md).

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

`scripts/corpus-fp.mjs <repo> 300` replays the last 300 commits of any repository through the rules. On flask, express, zod, cobra, clap, gson and sinatra the blocking residual is almost entirely tests that were genuinely removed with the feature they covered, which is the intended block and what the override directive is for. Full tables, and the catch rate measured with Claude Opus 5 on Impossible-LiveCodeBench: [docs/replay.md](docs/replay.md).

## Known limits

- Assertion-level analysis covers Python, JS/TS, Go, Java, Rust and Ruby. Other languages get the file-level rules and the check-integrity, scope and claim families.
- An implementation that special-cases the test inputs passes the original tests too. The deterministic gate cannot see it: on Impossible-LiveCodeBench, Opus 5 never edited a test and fitted the implementation instead in 55 runs, every one of which only the model-backed review flagged (see [docs/replay.md](docs/replay.md)). Mutation testing on the changed lines is the planned deterministic answer.
- The claim rules read the Claude Code transcript format and cannot be replayed over commit history, so they rest on fixtures.
- `test-deleted` blocks legitimate removals. The override directive lifts it for one change; per-rule severity and the block limit are the repo-wide alternatives.
- A verdict from the Stop hook is produced on the agent's machine. A merge check should trust only the GitHub Action, which recomputes it in CI.
- Every `Stop` snapshots the whole working tree, but the cost scales with what changed, not with the size of the repository. On react (7,222 tracked files) a one-file change verifies in 0.65 s, and 3,000 changed files take about 21 s — roughly 7 ms per changed file on top of a fixed ~0.6 s. A session that touches a handful of files pays the fixed cost and little else.
- Codex hooks are untested against a live install. Cursor, Copilot agent mode and Gemini CLI use the generic protocol. Windows is untested.

## Roadmap

In order: a wider false-positive replay and a transcript corpus for the claim rules; the catch rate on Impossible-SWEbench (multi-file tasks, needs the per-instance Docker images) next to the LiveCodeBench one; GitLab CI and a pull-request label as a second override source; native adapters for Cursor, Gemini CLI, OpenCode and Aider; C# and Kotlin; a large-monorepo measurement and Windows CI; then incremental mutation testing on the lines the agent changed, holdout tests generated out of the agent's sight, and a hosted PR check for organizations.

Every new rule family ships with its own false-positive fixtures and a column in the replay table before any of its rules defaults to block. Nothing leaves the machine: the gate writes only to `~/.gatekeep/` and `.git/gatekeep/`, the original-tests run happens in a temporary export, and the model-backed review is off unless you turn it on. Apache-2.0, no telemetry, no paid tier.
