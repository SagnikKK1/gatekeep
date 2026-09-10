# gatekeep

**An independent verification gate for AI coding agents.** It runs when the agent tries to say "done" and blocks it
when the work was faked instead of finished: tests tampered with, checks weakened, claims that nothing in the
session backs up.

![The agent reports "Done — all tests pass." gatekeep blocks the stop with three findings: two tests deleted and one assertion replaced with a truthiness check](assets/block.svg)

<sub>Real output from the Stop hook, not a mockup.</sub>

Apache-2.0. No telemetry, no paid tier, no account. Nothing leaves your machine unless you turn on the optional
model-backed review and give it your own API key.

> **A new install does not block anything for its first week.** It reports what it *would* have blocked, on your own
> code, and then asks. See [Your first week](#your-first-week).

## Contents

| Getting started | Using it | Reference |
|---|---|---|
| [Install](#install) | [When it blocks you](#when-it-blocks-you) | [Commands](#commands) |
| [Your first week](#your-first-week) | [What it checks](#what-it-checks) | [Configuration](#configuration) |
| [See the cost first](#see-the-cost-first) | [When a finding is wrong](#when-a-finding-is-wrong) | [Known limits](#known-limits) |
| [Why this exists](#why-this-exists) | [Lock the tests instead](#lock-the-tests-instead) | [How it works](#how-it-works) |
| | [CI and other agents](#ci-and-other-agents) | [What has been measured](#what-has-been-measured) |

## Install

Requires Node 20+ and git.

```bash
npm install -g gatekeep-agent      # or run it once with: npx gatekeep-agent install
cd /path/to/your/project
gatekeep install
```

Or as a Claude Code plugin, which wires the same hooks for every project without touching any repository:

```bash
claude plugin marketplace add SagnikKK1/gatekeep
claude plugin install gatekeep@gatekeep
```

The plugin runs a `gatekeep` already on your PATH, falls back to its own build, and only then to `npx` — install the
npm package too if you want the fast path.

That is the whole setup. Start a Claude Code session as usual.

`gatekeep install` does three things worth knowing about:

- **Wires four hooks** into `.claude/settings.local.json` (machine-local, not committed). `--shared` writes
  `.claude/settings.json` for the whole team instead; `--global` writes `~/.claude/settings.json`.
- **Writes `gatekeep.config.json`** and fills in `testCommand` from whatever your repo already uses — `package.json`
  `scripts.test`, `Cargo.toml`, `go.mod`, a pytest config, a `test:` target in a Makefile — printing what it matched.
  Commit this file.
- **Replays your last 200 commits** and tells you how many it would have interrupted, before it is in a position to
  interrupt one. `--no-calibrate` skips it.

Useful right after installing:

```bash
gatekeep status       # where the hooks are wired, and whether blocking is on
gatekeep calibrate    # what the gate would have done to your last 200 commits
gatekeep shadow       # how much of the no-blocking window is left, and what it caught
```

## Your first week

A new install starts in **shadow mode**: for 7 days or 10 sessions, gatekeep reports what it would have blocked and
blocks nothing. Then it asks.

At a stop inside the window the agent is not interrupted. You get the finding instead:

```
gatekeep is in shadow mode: this would have blocked the stop, and did not. 6 day(s) or 9 session(s) left in
the window; 1 of 1 stop(s) so far would have been blocked. Turn blocking on now with `gatekeep shadow --off`.

GATEKEEP WOULD HAVE BLOCKED — test integrity: 1 blocking, 0 warning(s)
  [block] test-deleted  tests/test_calc.py:6 [test_two]
```

```bash
gatekeep shadow            # the window, and what it would have stopped so far
gatekeep shadow --off      # turn blocking on
gatekeep shadow --extend   # keep reporting for another window
```

When the window runs out the gate **does not start blocking on its own.** It keeps reporting and repeats the offer at
every stop. A tool that quietly begins interrupting you on day eight is a tool that ambushes you on day eight.

Two things shadow mode deliberately does not do:

- **It does not cover the gate's own integrity.** `gate-config-changed`, a tampered baseline, and index flags that
  hide edits from the snapshot all still block inside the window — a window in which an agent may rewrite
  `gatekeep.config.json` unopposed is a window in which it can extend itself.
- **It does not touch `gatekeep run`**, so CI blocks from day one. The window is about the person at the terminal.

Skip it entirely with `gatekeep shadow --off` right after installing, or set `"shadow": null` in the config.

**Upgrading?** Only a config that `install` writes starts in shadow mode. An existing `gatekeep.config.json` has no
`shadow` key and keeps blocking exactly as it did — `gatekeep shadow --on` opts in if you want the window.

## See the cost first

A gate you cannot predict is a gate nobody installs. `gatekeep calibrate` replays your own history through the rules
and tells you what they would have done to work you already shipped.

```bash
gatekeep calibrate                 # the last 200 commits
gatekeep calibrate 500 --json      # further back, machine-readable
gatekeep calibrate --apply         # downgrade to "warn" every rule that interrupted 2+ of those commits
```

```
Replayed 200 commit(s) of this repository's own history.

  7 of 200 would have been interrupted (3.5%).

  4f21a9c3  Retry uploads on 502                             test-oracle-in-source
  9ac0117e  Drop the legacy CSV path                         feature-deleted

Interruptions by rule, counted in commits rather than findings:
  test-oracle-in-source              5
  feature-deleted                    2
```

Our own measured blocking rate on public repositories is a fact about other people's code. This one is about yours.

`--apply` writes the downgrades into `gatekeep.config.json` with a comment saying where they came from, so `git diff`
shows exactly what was traded away and a later reader can put it back. It reads your history as honest work, which is
the assumption to check: a rule that fires a lot is either noisy or is the one rule that caught something. That is why
the commits are listed rather than summarised, and why nothing is downgraded until you have seen them.

A replay covers the rules that read the diff. It cannot cover the original-tests lane (that one runs your suite), the
claims family (no live session, so nothing was claimed) or the model-backed judge — and it says so every time rather
than letting silence imply coverage.

## Why this exists

Agents under pressure to get a green run delete tests, skip them, weaken `==` into truthiness, return before the
assertions, or mock away the module they just changed. ImpossibleBench measured frontier models doing this in up to
76% of runs where the spec and the tests conflicted. On its LiveCodeBench half, Claude Opus 5 in Claude Code never
touched a test file but fitted the implementation to a wrong assertion in 54% of runs (measured here, see
[docs/replay.md](docs/replay.md)). Lock the tests down and they go after whatever else grades them: a `@ts-ignore`,
`continue-on-error` in CI, a strict flag turned off.

gatekeep catches all of it deterministically from the diff, with no model call, and reads the agent's own summary only
to check it for contradictions.

**It does not replace your test suite.** It is a diff gate, and it answers one question: did the tests and checks that
existed at the start of the session survive intact? Coverage cannot answer that — a skipped test, an `.only`, or
`expect(true).toBe(true)` keeps every line executed while the test stops testing.

## When it blocks you

Once blocking is on, an agent that tries to finish after weakening a test sees this instead, and has to fix the
implementation:

```
GATEKEEP BLOCKED — test integrity: 2 blocking, 0 warning(s); 1 test file(s) examined, 1 source file(s) changed.
  [block] test-deleted  tests/test_calc.py:6 [test_add_neg]
      Test "test_add_neg" removed (had 1 assertion(s))
  [block] assertion-weakened  tests/test_calc.py:4 [test_add]
      "test_add": 1 specific assertion(s) replaced by truthiness/existence/broad checks
      before: assert add(2, 3) == 5
      after:  assert add(2, 3)
```

Honest work passes silently. Warnings reach you, not the agent. After three blocks in one session (`maxBlocks`) the
agent is allowed to finish and the findings are handed to you.

**If the block is right,** the agent fixes the implementation and stops again. Nothing for you to do.

**If the block is right in general but wrong for this one change** — you really did delete that test on purpose — lift
it for that change only, with an audit trail. Put the directive in your prompt, or in a commit message between the
base and HEAD:

```
gatekeep: allow test-deleted -- CSV exporter removed per ticket 482
```

`--allow test-deleted` does the same for one `gatekeep run`. Every lift is recorded in the verdict with who granted it
and why. `gate-config-changed` can never be lifted.

**If the rule is wrong for your repository in general,** turn it down once instead of arguing with it every session:

```json
{ "rules": { "test-deleted": "warn" } }
```

`gatekeep calibrate --apply` picks those out of your history for you.

**If the finding is simply wrong,** see [When a finding is wrong](#when-a-finding-is-wrong) — one command turns it into
a bug report.

Every run writes a verdict JSON under `~/.gatekeep/`. `gatekeep report --open` renders the latest one as a single HTML
file with the test bodies before and after the session next to each finding.

## What it checks

The check that does not depend on recognising a tampering pattern comes first, and `install` turns it on whenever it
can detect your test command: **the tests as they stood at session start are restored and the suite is run against the
final code.** An agent that edited a test to fit its implementation fails against the tests it was given.

70 rules across five deterministic families then read the diff itself, and a model-backed review you turn on reads it
once more with the task in hand.

| Family | Blocks when |
|---|---|
| **Original tests vs final code** | The tests the session started with, kept where the agent cannot touch them, fail on the final code while the agent's edited tests pass |
| **Test integrity** | An existing test is deleted, skipped, focused, made vacuous, given an early exit, or its assertions are removed, weakened (`==` to truthiness, `raises(ValueError)` to `raises(Exception)`), made unreachable, swallowed in a `try`, shadowed, or mocked away on the module under test. Renames and moves are paired by body similarity first |
| **Check integrity** | CI steps removed or `continue-on-error` added, linter or type-checker config loosened, pre-commit hooks removed, suppression directives added, errors swallowed or validation removed in source, `.gitignore` made to hide tests |
| **Claims** | The final message says tests pass but none ran after the last edit; files it names did not change; git history was rewritten during the session |
| **Scope** | Protected paths edited (migrations, auth, payments, infra), new or loosened dependencies, registry changes, typosquats, secrets, a feature deleted together with its tests |
| **Source fitted to the tests** | A new branch compares against a value only the tests used, its constants are those of one test case, a table is keyed by test values, or the implementation reads the test runner's own environment |
| **Model-backed review** (opt-in) | A model reads the diff with the task in hand: weakened-but-passing tests, special-cased inputs, task mismatch, text addressed to the reviewer. **Advisory** — it never decides the verdict or lifts a block, and runs only on an API key you set |

Assertion-level analysis covers **Python, JavaScript/TypeScript, Go, Java, Rust and Ruby**. Other languages get the
file-level rules and the check-integrity, scope and claim families.

Every rule and its default severity: [docs/rules.md](docs/rules.md). The original-tests lane and the model-backed
review in detail: [docs/checks.md](docs/checks.md) and [docs/judge.md](docs/judge.md).

<details>
<summary><b>What the defaults stop, and what they do not</b></summary>

Out of the box the gate blocks a session that weakened the tests or the checks that grade it, and — wherever
`install` found a test command — re-runs the original tests against the final code.

Source-side fitting is only partly covered. On
[Impossible-LiveCodeBench](docs/replay.md#catch-rate-on-impossible-livecodebench) Claude Opus 5 never touched a test
file in 304 runs and fitted the implementation instead in 55 of them. `test-oracle-in-source` reads 19 of those, at
`warn`, so by default they are reported rather than stopped. The other 36 hide an off-by-one inside ordinary
arithmetic, where only the specification says the code is wrong. The model-backed review flagged all 55, and it is
advisory and off unless you turn it on. Turn it on for work where that matters.

</details>

## Commands

| Command | What it does |
|---|---|
| `gatekeep install` | Wire the hooks, write the config, calibrate. `--shared`, `--global`, `--codex`, `--no-calibrate` |
| `gatekeep status` | Where hooks are wired, whether blocking is on, recent sessions, the last verdict |
| `gatekeep shadow` | The no-blocking window and its tally. `--off` turns blocking on; `--on`, `--extend`, `--days`, `--sessions` |
| `gatekeep calibrate` | Replay your own history and report what would have been interrupted. `--apply` downgrades noisy rules |
| `gatekeep run` | Check the working tree against a baseline. Exit `0` pass, `1` blocked, `3` error. `--base`, `--json`, `--fail-on-warn`, `--allow` |
| `gatekeep report` | Render a verdict as one self-contained HTML file. `--open`, `--out`, `--stdout`, `--session` |
| `gatekeep report-fp` | Turn a wrong finding into a redacted fixture and a prefilled issue |
| `gatekeep protect-tests` | Make the test tree read-only for the agent. `--dry-run`, `--off` |
| `gatekeep session start` / `verify` | The two-step adapter for any agent framework, no hook system required |
| `gatekeep init` | Write a `gatekeep.config.json` without touching hooks |
| `gatekeep uninstall` | Remove the hooks |

`gatekeep --help` prints the full flag list. State lives in `~/.gatekeep` (override with `GATEKEEP_HOME`), never inside
the repository.

## Configuration

`gatekeep.config.json` at the repo root. Every key is optional:

```json
{
  "maxBlocks": 3,
  "strict": false,
  "testCommand": "npm test --silent",
  "shadow": { "startedAt": "2026-09-10", "days": 7, "sessions": 10 },
  "judge": { "model": "claude-opus-5" },
  "extraProtectedPaths": ["services/ledger/**"],
  "extraTestGlobs": ["**/qa/**/*.py"],
  "ignore": ["**/generated/**"],
  "rules": { "retry-added": "off", "test-conditionally-skipped": "block" }
}
```

| Key | Meaning |
|---|---|
| `maxBlocks` | How many times one session may be blocked before the agent is let through and the findings go to you |
| `strict` | Treat warnings as blocking |
| `testCommand` | Your suite, for the original-tests check. `null` turns that check off |
| `shadow` | `null` means the gate blocks. An object means it reports for that window and then asks |
| `judge` | Model-backed review. `null` (the default) means off |
| `rules` | Per-rule severity: `"block"`, `"warn"` or `"off"` |

Commit this file — the agent may not modify it during a session. Unknown keys and rule names are reported as
`config-invalid` warnings rather than silently ignored. A shadow window with both limits set to `null` would never
end, so that is reported as a problem rather than accepted quietly.

## When a finding is wrong

One command reduces it to a fixture the maintainer can act on, without publishing your code:

```bash
gatekeep report-fp                                 # the last verdict's blocking finding
gatekeep report-fp --rule test-oracle-in-source    # pick the rule
gatekeep report-fp --no-open --json                # print the URL instead of opening a browser
```

It takes the files the finding names — plus, for `test-oracle-in-source`, the test file whose literal it matched —
pseudonymises the identifiers, string contents, comments and paths, and writes a `before/`, `after/` and
`expected.json` triple in the same layout as [`fixtures/`](fixtures/). `expected.json` lists everything the pair
produces *except* the rule you are reporting, so the fixture fails today and goes green when it is fixed. Then it
opens a prefilled issue.

**The redaction is checked rather than assumed.** After redacting, the rules are re-run over the result. If the finding
no longer fires, the redaction destroyed the evidence and a weaker level is tried; if none reproduces it, nothing is
written and nothing is sent — shipping your real source from a command called `report-fp` would be the worse failure.
`--verbatim` is there if you have read the files and want to send them as they are.

The pseudonyms are consistent and keep the shapes the rules read: `test_charge_vat` stays a pytest test,
`rate_card_test.go` stays a Go test file, an extension still picks the grammar. What survives looks like this:

```python
def na3d8b2(ncc8321):
    if ncc8321 == "redacted/990d75":
        return 1299
```

Two things to know before you send one:

- **A credential is replaced by a synthetic of the same shape** — same length, same character classes, the published
  vendor prefix (`AKIA`, `ghp_`, `sk-ant-`) restored so the pattern still matches, and none of the entropy kept. A
  `secret-introduced` finding's evidence *is* the secret, so it is never carried through as-is.
- **Numbers are not redacted**, deliberately: almost every rule counts, compares or thresholds on them, and replacing
  them is the fastest way to make a fixture stop reproducing. If your finding involves a number you cannot publish,
  edit the fixture by hand — the files are written to disk first and the issue is only opened afterwards.

Read it before you send it. Redaction is mechanical and cannot know what is sensitive in your codebase.

## Lock the tests instead

Everything above is a gate: it reads what happened and decides afterwards. `protect-tests` is the other half — it takes
the option away, so there is nothing to catch.

```bash
gatekeep protect-tests --dry-run   # what it would protect
gatekeep protect-tests             # deny writes to the test tree in this project
gatekeep protect-tests --off
```

It collapses your test files into globs (`tests/**`, `**/*.test.ts`, `**/*_test.go`) and writes three layers into
`.claude/settings.local.json`: `permissions.deny` entries so the file tools refuse, `sandbox.filesystem.denyWrite` so
the write is refused even when it comes from a shell command, and a `PreToolUse` hook that turns the refusal into
something the agent can act on — *fix the implementation; if the test is genuinely wrong, say so instead of editing
it.*

Opt-in and independent of the gate: `gatekeep install` does not turn it on, neither one needs the other, and `--off`
removes exactly the entries it added. Details and limits: [docs/protect.md](docs/protect.md).

## CI and other agents

On pull requests, the same check runs from the diff:

```yaml
permissions: { contents: read, checks: write }
steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 }          # gatekeep needs the base commit; depth 1 cannot see it
  - uses: SagnikKK1/gatekeep@v1
```

Findings are posted as check annotations on the changed lines. A merge check should trust only the Action: a verdict
from the Stop hook is produced on the agent's machine.

| Harness | Setup |
|---|---|
| **Claude Code** | `gatekeep install`, or the plugin |
| **Claude Agent SDK** | Nothing beyond `gatekeep install` — `query()` loads `.claude/settings.json` and its hooks from the filesystem unless you pass `settingSources: []` |
| **Devin CLI** | Nothing beyond `gatekeep install` — it reads Claude Code's settings files too |
| **Codex** | `gatekeep install --codex` (wired, untested against a live install) |
| **Anything else** | `gatekeep session start --task "..."` before the work, `gatekeep verify --session <id>` after |

Caveats for each: [docs/integrations.md](docs/integrations.md).

## Known limits

- **An implementation that special-cases the test inputs passes the original tests too.** The deterministic gate cannot
  see it: on Impossible-LiveCodeBench, Opus 5 never edited a test and fitted the implementation instead in 55 runs,
  every one of which only the model-backed review flagged. Mutation testing on the changed lines would be the
  deterministic answer, and it is not on the roadmap.
- **`test-deleted` blocks legitimate removals.** The override directive lifts it for one change; per-rule severity and
  the block limit are the repo-wide alternatives.
- **A Stop-hook verdict is computed on the agent's machine.** Trust the GitHub Action for anything gating a merge.
- **The claim rules rest on fixtures**, not on replayed history — they read a `PostToolUse` log gatekeep writes itself,
  which no commit history contains. If you installed before that landed, re-run `gatekeep install`; `gatekeep status`
  says whether the recorder is wired.
- **Windows is untested.** Cursor, Copilot agent mode and Gemini CLI use the generic protocol.

**Not planned, so nobody waits on them:** GitLab CI, a pull-request label as a second override source, native adapters
for Cursor, Gemini CLI, OpenCode and Aider, C# and Kotlin, Windows CI, generated holdout tests, and a hosted check for
organisations. 70 rules is already more than anyone will read, and each new one adds more false-positive surface than
it catches.

<details>
<summary><b>Performance</b></summary>

Every `Stop` snapshots the whole working tree, but the cost scales with what changed, not with the size of the
repository. On react (7,222 tracked files) a one-file change verifies in 0.65 s, and 3,000 changed files take about
21 s — roughly 7 ms per changed file on top of a fixed ~0.6 s. A session that touches a handful of files pays the
fixed cost and little else.

Those numbers are the diff analysis alone. Where `install` detected a `testCommand`, add your own suite: the original
tests run in a temporary export, and a second run against the agent's copy happens only if the first fails.
`testTimeoutMs` (5 minutes by default) is the ceiling for that whole check, not for one run.

</details>

## How it works

| Hook | What it does |
|---|---|
| `SessionStart` | Snapshots the working tree as a git tree object and captures the gate's own config. Resuming, compacting, clearing or forking keeps the original snapshot, so work done before that point is still in the diff |
| `UserPromptSubmit` | Records the first prompt as the task statement |
| `PostToolUse` | Appends the tool call — the file it wrote, the command it ran — to a log signed with the session's key. This is what the claims rules read: parsing a harness's own transcript file only ever worked on Claude Code, and its format is nobody's stable interface |
| `Stop` | Diffs the working tree against the snapshot, parses every changed test file with tree-sitter, runs every rule family, and returns a blocking decision with the report. Claude Code feeds that report back to the agent as its next instruction |

State lives in `~/.gatekeep/`, mirrored under the repository's own `.git/gatekeep/` and signed with a per-repo key, so
the agent cannot edit its own block counter. The config used is the copy captured at session start: editing
`gatekeep.config.json` or the hook settings mid-session is itself a blocking finding.

## What has been measured

The numbers, the run records and the corrections are in [docs/replay.md](docs/replay.md). The short version:

- **Every false-positive number published before 2026-09-10 was in-sample**, measured on the seven repositories the
  rules were narrowed against. A second set of seven, chosen mechanically by
  [`scripts/corpus-select.mjs`](scripts/corpus-select.mjs) and measured once, held the blocking rate up — 5.1% of
  held-out commits carry a blocking finding against 4.1% in-sample — but broke the precision claim.
- **`test-oracle-in-source` was published at 0 false positives in 2,100 commits. That is retracted.** It produced 12
  on the held-out set, all 12 on source that branches on domain vocabulary the tests happen to share.
- **A third corpus** was drawn the same way, with both earlier sets excluded, to measure the fix for that defect —
  fixing a rule against the held-out set would only have made it a second tuning set. On 2,100 fresh commits the fix
  takes the rule from **9 findings to 8**, and the blocking rate does not move at all, because the rule is `warn`.
  Those 8 are 8 false alarms, and that is the number for this rule now.
- **Ten rules that never fired once in-sample fire out of sample**, eight of them blocking. Read the other zeros as
  "this corpus never exercised the rule" until a second corpus says otherwise.
- **These are false-alarm rates, not precision.** A corpus of human commits contains no agent cheats, so there is no
  true-positive count to divide by. What a human corpus can tell you is how often the gate interrupts honest work.
  What it cannot tell you is how good the gate is at its actual job.

Every new rule family ships with its own false-positive fixtures and a column in the replay table before any of its
rules defaults to `block`.

## Development

```bash
npm test          # builds, then replays fixtures/ and runs unit tests
scripts/e2e.sh    # hook protocol, state layout, installer, tamper resistance, CLI edge cases
```

From source: clone, then `npm install && npm run build && npm link`.

Fixtures are `before/` and `after/` trees plus `expected.json`, generated by `scripts/gen_fixtures.py`: per-language
detections, three red-team passes of evasion techniques, and legitimate refactors that must not block.
`scripts/corpus-fp.mjs <repo> 300` replays the last 300 commits of any repository through the rules — the same replay
engine `gatekeep calibrate` runs, so a number measured there is a number a user would see.

<details>
<summary><b>Releasing</b></summary>

`gh workflow run ci.yml --ref main` publishes whatever `main` holds, once the full matrix is green. Every push to
`main` reports in its run summary whether a release is owed, so nothing drifts silently. The version comes from
`package.json` when the registry does not already have it, and otherwise from the next free patch, so a deliberate
minor bump is respected and a forgotten one still ships. The same number is written into `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json` and the `npx` fallback pinned in `hooks/gatekeep-hook.sh`, committed back, and
tagged `vX.Y.Z` with `v1` moved to it so `uses: SagnikKK1/gatekeep@v1` never goes stale.
`node dist/src/release.js next` prints what the next release would publish. npm authenticates by OIDC through trusted
publishing, so there is no token to leak or rotate.

Two failure modes shaped this. npm once sat 57 commits behind `main` and the Action 22, with all three channels
calling themselves `0.1.0`, which is why publishing is automated at all. Then publishing on every push put a blocking
regression on npm within minutes of the commit, which is why it is no longer a push. Staging to a `next` dist-tag
would be the usual answer, but `npm dist-tag` is not supported under trusted publishing, so promoting later would mean
reintroducing the long-lived token.

</details>

## License

Apache-2.0. No telemetry: the gate writes only to `~/.gatekeep/` and `.git/gatekeep/`, the original-tests run happens
in a temporary export, and the model-backed review is off unless you turn it on and give it your own key.
