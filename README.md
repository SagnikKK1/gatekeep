# gatekeep

An independent verification gate for AI coding agents. It runs when the agent tries to say "done" and blocks it when the work was faked instead of finished: tests tampered with, checks weakened, claims that nothing in the session backs up.

Agents under pressure to get a green run will delete tests, mark them skipped, weaken `==` into truthiness, return early before the assertions, wrap assertions in `try/except`, mock away the module they just changed, or loosen numeric tolerances. Published measurements put this between 46% and 93% of runs depending on the model and task. When the tests are locked down, they go after whatever else grades them: a `@ts-ignore`, `continue-on-error` in CI, a strict flag turned off, a pre-commit hook removed. gatekeep detects all of it deterministically from the diff, with no model call, and reads the agent's own summary only to check it for contradictions. An opt-in model-backed review covers what a parser cannot: semantic weakening, implementations fitted to the test inputs, and diffs that do not match the task.

**gatekeep does not replace your test suite.** It is a diff gate first: did the tests and checks that existed at the start of the session survive intact. With one opt-in addition, it also keeps the tests the session started with where the agent cannot touch them and runs them against the code the session ended with.

## How it works

- `SessionStart` snapshots the working tree (tracked and untracked, honoring `.gitignore`) as a git tree object. The index and `git status` are untouched. The gate's own config is captured at this moment.
- `UserPromptSubmit` records the first prompt as the task statement for the verdict.
- `Stop` diffs the current working tree against the snapshot, parses every changed test file with tree-sitter and compares the before and after test models, runs the check-integrity, scope and claim rules over the rest of the diff, optionally runs the original tests against the new code, and:
  - exits 2 with the report on stderr when it finds blocking tampering. Claude Code feeds that text back to the agent as its next instruction;
  - after `maxBlocks` blocks in one session (default 3) lets the agent finish and delivers the findings to you through the hook's `systemMessage` channel;
  - on warnings only, lets the agent finish and delivers the warnings the same way.

State (sessions, verdicts) lives in `~/.gatekeep/`, never inside the repository, with a mirror of each session's baseline under the repository's own `.git/gatekeep/`. The mirror is authoritative: wiping `~/.gatekeep` mid-session recovers the baseline and is reported. The config is the copy captured at session start (or the defaults if there was none), so writing or editing `gatekeep.config.json` mid-session is a blocking finding and is never honored. The hook settings files are hashed from disk at session start and compared at stop, so a gitignored `settings.local.json` is covered too.

The gate runs as the same user as the agent. An agent that edits files under `.git/` can still corrupt its own baseline; that is outside what a hook can defend against and is noted as a `session-state-missing` finding when detected.

## Original tests against final code

Opt in by setting `testCommand` in `gatekeep.config.json`:

```json
{ "testCommand": "python -m pytest -q", "testTimeoutMs": 300000 }
```

At stop, gatekeep exports the current tree to a scratch directory, puts back every test file and test-config file exactly as it was at session start (deleted ones included, added ones removed, `package.json` test sections restored on top of the agent's dependencies), links `node_modules` or the virtualenv in, and runs the command there. The agent keeps iterating on its visible copy; the original tests live where it cannot reach them.

| Outcome | Finding |
|---|---|
| Original tests pass on the new code | nothing |
| Original tests fail, the agent's edited tests pass | `original-tests-fail` (block): the tests were changed to fit the code |
| Both fail | `tests-failing` (warn): the work is not done, but nothing was hidden |
| Command times out or cannot start | `test-run-timeout` / `test-run-error` (warn) |

The second run only happens when the first fails. The suite runs in a temporary export, never in the working tree. Because this runs your whole test command, it is off by default; the hook's installed timeout is 10 minutes and `testTimeoutMs` defaults to 5.

## Claim verification

The Stop hook receives the session transcript. gatekeep reads the agent's final message and compares it to what actually happened: whether a test, build, lint or type-check command ran after the last edit when the message says they pass, whether the files it names are the files that changed, and whether git history was rewritten or changes hidden along the way. Claude Code transcripts today; other harnesses when their adapters land. Nothing in the transcript is trusted as evidence of correctness; it is only checked for contradictions.

## Model-backed review

Everything above is deterministic, and deterministic cannot cover everything: a test rewritten to check a weaker property with the same structure, an implementation that special-cases the test inputs, or a deleted test that was genuinely part of the task. Opt in to a second layer that reads the diff with the task statement in hand:

It is optional and off by default. The deterministic gate runs the same with or without it; turn the judge on when you want reasoning about intent on top of the rules, using an API key or your Claude subscription:

```json
{ "judge": { "model": "claude-opus-5" } }
```

One hard rule, enforced in code and not in the prompt: **the judge can add findings, annotate them and escalate its own. It can never lift a block, and it cannot change the severity of anything the parser found.** The agent cannot argue with a parser, and the judge is not allowed to argue on its behalf.

What it adds, all at `warn` by default:

- `judge-test-weakened`: an existing test whose new body still passes but no longer checks what the task requires, or a mock that leaves it meaningless.
- `judge-special-casing`: an implementation that hardcodes expected values, branches on test inputs, or overloads operators to satisfy assertions. This is the gap the original-tests run cannot close.
- `judge-task-mismatch`: a diff that does something other than the task, or leaves it undone while the final message claims completion.
- `judge-review-manipulation`: text in the diff written for the reviewer or a model rather than the program: a comment saying the change is approved, asking for no findings, or trying to close the diff element. The prompt treats such text as data; this rule makes the attempt itself visible.
- A one-line triage on every blocking finding, `consistent with the task` or `looks like evasion`, with a reason. The block stands either way; the annotation is for the human. `"canBlock": true` turns the judge's own warnings into blocks.

How it is kept honest:

- Inputs are the task statement, the deterministic findings as JSON, and bounded unified diffs of the changed test and source files. The agent's final message is passed labeled as an untrusted claim to check, never as context. Everything from the session is escaped inside its element, and the system prompt says all of it is data.
- The reply is forced through a JSON schema, so an instruction injected in a comment can at most produce a malformed observation. A finding that names a file outside the diff is discarded and counted; a triage entry for an unknown finding is ignored; a duplicate is ignored.
- The verdict records the model id, a hash of the full prompt and the raw output under `checks.judge`, with the per-file truncation, so a run is auditable even though it is not reproducible.

Mechanics: it runs at stop only, only when test or source files changed, and is cached under the state directory by prompt and provider, so a repeated stop with the same diff costs nothing. `judge.maxDiffBytes` (default 200 KB) bounds the input; a larger diff is truncated per file, tests first, with the truncation recorded in the verdict. `judge.effort` (default `high`) is passed to the model. When the judge cannot run at all it is skipped and the verdict says so as `judge-skipped`, warn; the gate still decides on the deterministic findings.

Where the model comes from is `judge.provider`:

| Provider | Uses | Needs |
|---|---|---|
| `auto` (default) | the Anthropic SDK when `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set; otherwise Claude Code if the `claude` command is installed; otherwise the SDK's own profile lookup | one of the below |
| `anthropic` | the Messages API through the SDK: adaptive thinking, the rubric under a cache breakpoint, the reply forced through the schema | an API key, or an `ant auth login` profile |
| `claude-code` | Claude Code headless (`claude -p`) with the rubric as its entire system prompt, no settings loaded (so no hooks), no tools, structured output through `--json-schema`. Runs on your Claude subscription | Claude Code installed and logged in, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (that token is for Claude Code only; it is not accepted by the API directly) |

A subscription token in the environment of the agent is enough: hooks inherit it, and the judge's own Claude Code child is marked so gatekeep's hooks never re-enter it. Cost: with the SDK, a typical stop is a few cents and a 200 KB diff at effort `high` is on the order of a quarter to half a dollar; through Claude Code it draws on the subscription instead, and the verdict carries Claude Code's own cost estimate.


## Adapters

| Harness | Status | How |
|---|---|---|
| Claude Code | supported | `gatekeep install` wires SessionStart, UserPromptSubmit and Stop hooks; the transcript is read for claim verification |
| Codex CLI | wired, untested | `gatekeep install --codex` writes the same three hooks to `~/.codex/hooks.json` |
| Anything else | supported via the generic protocol | two commands, below |

Any framework, script or CI job can use the generic protocol with no hook system:

```bash
sid=$(gatekeep session start --task "Fix the rounding bug in app/calc.py")   # snapshot + task statement
# ... the agent works ...
gatekeep verify --session "$sid" --json     # exit 0 pass, 1 block; verdict on stdout
```

`verify` applies every rule in session mode: the config is the copy captured at `session start`, protected files are hashed from disk, the task statement drives the scope check, and `--transcript <path>` adds claim verification when the framework can hand over a Claude Code style transcript. `--allow <rule>` on `verify` is treated as a human override and recorded. The state layout and `.git` mirror are the same as for the hooks, so `gatekeep status` shows these sessions too.

## Overriding a rule for one change

Some blocks are right in general and wrong for this change: the task is to remove a feature, so its tests go too. A directive lifts one rule for one change and is recorded in the verdict with who granted it:

```
gatekeep: allow test-deleted -- CSV exporter removed per ticket 482
```

Where it can come from depends on who could have written it:

| Source | Counts in | Recorded as |
|---|---|---|
| Your own prompt in the session (typed by you, captured by the hook) | Stop hook | `user via prompt` |
| A commit trailer between `--base` and HEAD | `gatekeep run --base` | the commit author |
| `gatekeep run --allow <rule,...>` or `GATEKEEP_ALLOW` | `gatekeep run` | your username |

A trailer the agent writes into a commit during the session does not count: in a session, only prompts are trusted. `gate-config-changed` can never be lifted. Lifted findings stay in the report as `[allowed]` lines and in the verdict JSON under `overrides`, so the audit trail survives.

## Rules

| Rule | Default | Fires when |
|---|---|---|
| `gate-config-changed` | block | `gatekeep.config.json` or `.claude/settings*.json` changed during the session (session mode only; a human running `gatekeep run` may edit them) |
| `session-state-missing` | warn | No baseline was found at stop, or it had to be recovered from the `.git` mirror |
| `original-tests-fail` | block | With `testCommand` set: the session's original tests fail on the current code while the edited tests pass |
| `tests-failing` | warn | With `testCommand` set: the suite fails with the original tests and with the edited ones |
| `test-file-deleted` | block | A test file with tests in it is removed and its tests do not reappear elsewhere |
| `test-support-file-deleted` | warn | A file under a test directory with no tests in it is removed |
| `test-file-moved-out` | block | A test file is renamed to a path or name the runner will not collect: an ignored directory, or `tests/zzz_calc.py` in place of `tests/test_calc.py` |
| `test-file-unreadable` | block | A changed test file is too large, binary, or takes longer than the parse timeout (default 8 s, `GATEKEEP_PARSE_TIMEOUT_MS`) |
| `test-file-unparseable` | warn | The test file has syntax errors after the change |
| `test-deleted` | block | An existing test disappears. Renames and moves between files are paired by body similarity first. Demoted to warn when a new data-driven test appears in the same file and total assertions did not drop |
| `test-skipped` | block | An existing test gains an unconditional `skip`, `xfail`, `it.skip`, `xit`, `describe.skip`, `this.skip()`, a class-level `pytestmark`, a `setUp` that raises `SkipTest`, or a `skipif` whose condition is always true |
| `test-conditionally-skipped` | warn | The skip has a runtime condition (`skipif(sys.platform...)`, `xfail(strict=True)`, `skipIf`, skip inside `except ImportError`) |
| `test-focused` | block | `it.only` / `fit` / `describe.only` appears |
| `test-vacuous` | block | An existing test becomes data-driven over an empty data set (`parametrize(..., [])`, `it.each([])`) |
| `file-skipped` | block | `pytestmark = pytest.mark.skip` at module level |
| `early-exit-added` | block | An existing test gains a `return` before its first assertion (unconditional or env-gated) |
| `assertion-unreachable` | block | Assertions that used to run are now under a constant-false condition (`if False`, `if (0)`, `if 1 == 2`, `false && ...`), in the `else` of a constant-true one, in a loop over an empty literal, after an unconditional exit, or inside a function that is never called |
| `assertions-removed` | block | An existing test loses all of its executable assertions |
| `assertions-reduced` | warn | An existing test loses some of its assertions |
| `assertion-weakened` | block | A specific assertion is replaced by one that cannot fail: `==` to truthiness, `toEqual` to `toBeTruthy`, `raises(ValueError, match=...)` to `raises(Exception)`, `x == x`, `expected = f(x); assert f(x) == expected`, `approx(abs=1e9)`, `toBeCloseTo(x, -10)`, `{ asymmetricMatch: () => true }`, or an assertion about constants only (`assert 1 + 1 == 2`). Adding a filler assertion does not hide it |
| `assertion-swallowed` | block | Assertions moved inside a `try` whose handler neither asserts, re-raises, fails, nor skips; or the test is wrapped by a local decorator that does that |
| `assertion-shadowed` | block | `expect` or `assert` is redefined in the test file |
| `assertion-helper-noop` | warn | A local function named like an assertion helper (`check...`, `verify...`) contains no specific assertion and no throw (`assert a == b or True` does not count); calls to it are not counted |
| `assertion-free-test` | warn | A new test has no executable assertions |
| `mock-on-changed-module` | block | A new mock targets a first-party module changed in this session, and the change touches the mocked symbol's definition (or the whole module is mocked) |
| `mock-unrelated-to-change` | warn | Same, but the change does not touch the mocked symbol |
| `constant-override-on-changed-module` | warn | The mock overrides an `UPPER_CASE` constant with a literal |
| `mock-on-module-under-test` | warn | A new mock replaces the module this test file is named after, without that module being edited. Includes `module.attr = ...` assignments and `sys.modules[...] = ...` |
| `mock-on-source-module` | block | A `conftest.py` fixture newly patches a first-party module for every test |
| `retry-added` | warn | `@pytest.mark.flaky`, `jest.retryTimes`, `{ retry: n }` added |
| `tolerance-loosened` | warn | The same assertion's `approx(rel=...)`, `assertAlmostEqual(places=...)`, `toBeCloseTo(x, digits)` got looser |
| `test-config-narrowed` | block | Test collection was narrowed: a new or changed `testpaths`, `--ignore`, `--deselect`, `-k`, `testPathIgnorePatterns`, `collect_ignore`, `testMatch`, including a newly added config file |
| `test-config-changed` | warn | Other test or coverage settings changed: `addopts`, `coverageThreshold`, reruns, a `conftest.py` that patches, and the like. Removed lines count too |
| `config-invalid` | warn | `gatekeep.config.json` has problems; defaults are used for the bad parts |
| `suppression-added` | warn | Check-suppression directives added to source: `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `# noqa`, `# type: ignore`, `# pylint: disable`, `# pragma: no cover`, `#[allow(...)]`, `@SuppressWarnings`, `//nolint` |
| `ci-weakened` | block | A CI workflow gains `continue-on-error`, `allow_failure`, `\|\| true`, `if: false`, `--no-verify`, or a timeout more than doubled |
| `ci-check-removed` | block | A CI step that runs tests, lint, type checks or security scans is removed, or a workflow file is deleted |
| `lint-config-loosened` | warn | `strict` flags turned off in `tsconfig.json`, eslint rules set to `off`, ignores or `ignore_errors` added to mypy, pyright, ruff or flake8 config |
| `hooks-removed` | block | `.pre-commit-config.yaml` or a husky hook deleted or emptied, hook entries removed, husky or lint-staged configuration dropped from `package.json` |
| `snapshots-regenerated` | warn | Three or more snapshot files rewritten alongside source changes |
| `error-swallowing-added` | warn | New `except: pass`, empty `catch {}`, or `.catch(() => {})` in source |
| `gitignore-hides-tests` | block | `.gitignore` gains a pattern that would hide test paths from the snapshot |
| `claim-tests-unverified` | warn | The final message says tests pass, but no test command ran in the session, or the last run came before the last edit |
| `claim-checks-unverified` | warn | The final message says the build, lint or type check is clean without a matching command after the last edit |
| `summary-files-mismatch` | warn | The final message names files that did not change, or leaves changed source and test files unmentioned |
| `history-rewritten` | block | `git commit --amend`, force push, rebase, `reset --hard`, exclude-file writes, or a stash that was never restored during the session |
| `protected-path-edited` | block | A file under a protected path changed: migrations, auth, payments, billing, infrastructure and container definitions by default (CI workflows have their own rules); set `protectedPaths` or `extraProtectedPaths` in the config |
| `lockfile-changed-alone` | warn | A lockfile changed with no change to its manifest |
| `dependency-added` | warn | A new dependency in `package.json`, `pyproject.toml`, `requirements*.txt`, `Pipfile`, `go.mod`, `Cargo.toml` or `Gemfile` |
| `dependency-loosened` | warn | A version constraint downgraded, or an exact pin replaced by a range or `*` |
| `registry-changed` | block | A package source changed: `.npmrc` registry, pip index URL, poetry source, cargo registry, go `replace` to a URL |
| `typosquat-suspect` | block | A new dependency one edit away from a well-known package name |
| `secret-introduced` | block | A cloud key, API token, private key block, JWT or connection string with a password added to any file; obvious placeholders and environment lookups are ignored |
| `feature-deleted` | block | A top-level function or class removed from source in the same change as the tests that referenced it |
| `out-of-scope-change` | warn | The task names specific files, and source files unrelated to those names changed too |
| `validation-removed` | warn | Net removal of `assert`, `invariant(...)`, `throw new ...Error` guards or `raise ...Error` checks from source |
| `timeout-increased` | off | A test timeout is raised |
| `judge-test-weakened` | warn | Model-backed review (opt-in): a test still passes but no longer checks what the task requires |
| `judge-special-casing` | warn | Model-backed review: the implementation is fitted to the test inputs rather than the behavior |
| `judge-task-mismatch` | warn | Model-backed review: the diff does something other than the task, or leaves it undone while claiming completion |
| `judge-review-manipulation` | warn | Model-backed review: text in the diff addressed to the reviewer or a model, telling it to approve, report nothing, or escape the diff |
| `judge-skipped` | warn | The judge is configured but could not run: no credentials, an API error, or output that did not match the schema (the reason is in the verdict) |

Languages: Python (pytest, unittest), JavaScript/TypeScript (jest, vitest, mocha, chai `expect` and `should` styles, node:test, sinon, supertest chains, `expectTypeOf`), Go (`testing` with `t.Error`/`t.Fatal` inside `if` checks, `t.Run` subtests, table-driven loops, `t.Skip`, build constraints, testify, `monkey.Patch`), Rust (`#[test]` inline and in `tests/`, `assert!`/`assert_eq!`/`assert_ne!` and every `assert_*!` macro, `#[ignore]`, `#[should_panic]`, `#[cfg]` gating, rstest and test_case, assert_cmd and snapbox chains), Java (JUnit 4/5 annotations and assertions, AssertJ and Truth chains, Hamcrest, assumptions, `@ParameterizedTest` sources, Mockito `mock`/`when`/`@Mock`, local helper resolution), and Ruby (RSpec `describe`/`it`, `expect().to` matchers and the old `should` syntax, `xit`/`skip`/`pending`/`:focus`, `allow`/`expect().to receive`, doubles; minitest and test-unit `def test_*`, `assert_*`/`refute_*`, spec-style `must_*`, `skip`, `stub`, Mocha `stubs`/`expects`).

Assertion helpers: a function defined in the test file counts as an assertion if its body asserts or throws. Imported functions named `assert*`, `check*`, `verify*`, `expect*`, `ensure*`, `validate*` (leading underscores ignored, `helpers.assertX()` included) are given the benefit of the doubt.

## Install

Requires Node 20+ and git.

```bash
git clone https://github.com/SagnikKK1/gatekeep.git && cd gatekeep
npm install && npm run build && npm link      # puts `gatekeep` on PATH

cd /path/to/your/project
gatekeep install                        # hooks into .claude/settings.local.json (machine-local, not committed)
gatekeep status                         # confirm the hooks are wired and see the state directory
```

The package is named `gatekeep-agent` (the bare name was taken on npm) and the command is `gatekeep`. Once it is on the registry, `npm install -g gatekeep-agent` or `npx gatekeep-agent install` replaces the clone.

`gatekeep install --shared` writes `.claude/settings.json` (committed) using the bare `gatekeep` command, so every teammate needs it on PATH. `--global` writes `~/.claude/settings.json`. `install` is idempotent and repairs duplicated entries; it refuses to touch a settings file that does not parse. `gatekeep uninstall` removes the hooks.

`install` also writes `gatekeep.config.json` if none exists. Commit it. The agent is not allowed to modify it during a session.

## Run it yourself

```bash
gatekeep run                    # working tree vs HEAD
gatekeep run --base main        # working tree vs a branch
gatekeep run --json             # machine-readable verdict on stdout
gatekeep run --fail-on-warn     # treat warnings as blocking
```

Exit codes: `0` pass, `1` blocked, `3` error. The same command is what a CI job or a PR check will call. When invoked with `--base`, the config is read from that base tree.

## GitHub Action

The same rules on every pull request, computed from the diff in CI. The action never trusts a verdict uploaded from a developer machine.

```yaml
name: gatekeep
on: [pull_request]
jobs:
  gatekeep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: SagnikKK1/gatekeep@main
        # with:
        #   base: ${{ github.event.pull_request.base.sha }}   # default
        #   fail-on-warn: 'true'
```

Findings appear as check annotations on the changed lines and in the job summary. Blocking findings fail the job. Commit trailers `gatekeep: allow <rule> -- reason` between the base and the head lift a rule for that pull request and are listed in the summary with the author. Outputs: `decision` (`pass`, `warn`, `block`) and `verdict` (path to the JSON).

## Verdict

Every run writes a verdict under `~/.gatekeep/repos/<repo>-<hash>/verdicts/` (path printed at the end of each report, `latest.json` always current):

```json
{
  "schema": "gatekeep.verdict.v1",
  "decision": "block",
  "task": "Fix the login bug so bad passwords are rejected",
  "baseTree": "0b0a5e0...", "currentTree": "9c1d...",
  "checks": {
    "testIntegrity": {
      "status": "fail",
      "findings": [
        { "rule": "mock-on-changed-module", "severity": "block", "file": "tests/test_auth.py", "line": 10,
          "test": "test_login_returns_user",
          "message": "New mock patch('app.auth.verify', return_value=True) targets app/auth.py, which was also changed in this session (the change touches \"verify\")" }
      ],
      "examined": [ { "path": "tests/test_auth.py", "status": "M", "testsBefore": 4, "testsAfter": 3 } ],
      "changedSourceFiles": [ "app/auth.py" ]
    }
  },
  "blockCount": 1
}
```

`checks.originalTests` is present when `testCommand` is set, `checks.judge` when the model-backed review is configured (status, model, prompt hash, raw output, truncation), and `overrides` lists every finding an override directive lifted, with who granted it. A triaged finding carries `judge: { verdict, reason }`.

## Configuration

`gatekeep.config.json` at the repo root:

```json
{
  "maxBlocks": 3,
  "strict": false,
  "testCommand": "npm test --silent",
  "judge": { "model": "claude-opus-5", "maxDiffBytes": 204800, "canBlock": false },
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
scripts/e2e.sh    # hook protocol, state layout, installer, tamper resistance, concurrency, CLI edge cases
```

Fixtures are `before/` and `after/` trees plus `expected.json` (optionally with a `severity`), generated by `scripts/gen_fixtures.py`. Prefixes: `js-`, `py-`, `go-`, `java-`, `rs-` are the per-language detections; `rt-`, `rt2-` and `rt3-` are evasion techniques from three red-team passes; `cr2-` came out of a code review; `int-` and `scope-` cover the check-integrity and scope families; `honest-` and `fp-` (including `fp-int-` and `fp-scope-`) are legitimate changes that must not block.

The judge has its own fixtures under `test/fixtures/judge/`: an `input.json` (task, claim, findings, diffs) and a `response.json` the test replays offline, so `npm test` never calls the API. Each response says whether it was `authored` by hand or recorded `live`; `node scripts/judge-record.mjs` re-records them with the prompt hash when a key is present. One live end-to-end test runs when `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set (or `GATEKEEP_JUDGE_LIVE=1` for a profile) and is skipped otherwise.

### False-positive replay on real history

`scripts/corpus-fp.mjs <repo> <n>` replays the last `n` first-parent commits of any repository through the rules. Every hit on reviewed human commits is either a true detection or a false positive to fix. Current numbers on 300 commits each:

| Repo | Commits touching tests | Findings | Of which blocking | Blocking, by rule |
|---|---|---|---|---|
| flask | 141 | 53 | 32 | test-deleted 23, test-config-narrowed 5, assertion-weakened 4 |
| express | 93 | 149 | 93 | test-deleted 84, test-skipped 6, assertion-weakened 2, assertions-removed 1 |
| zod | 154 | 21 | 14 | test-deleted 11, test-file-deleted 2, assertion-weakened 1 |
| cobra (Go) | 119 | 39 | 5 | test-file-deleted 2, ci-check-removed 2, test-deleted 1 |
| clap (Rust) | 77 | 48 | 2 | test-deleted 1, ci-check-removed 1; 18 `test-file-unparseable` warnings from snapbox's `str![[...]]` macro, which this grammar build cannot parse, so count-based rules stand down on those files |
| gson (Java) | 153 | 28 | 9 | test-deleted 2, test-file-deleted 2, assertion-weakened 2, assertion-swallowed 2, test-skipped 1 |
| sinatra (Ruby) | 129 | 53 | 16 | test-file-deleted 12 (a removed feature's specs), test-deleted 4 |

The residual is almost entirely `test-deleted` on commits that genuinely removed tests (feature removals, reverts). Inside an agent session that is the intended behavior; the override directive, the block limit and the per-rule severities are the escape hatches.

The check-integrity and scope families replayed over the same commits, after tuning against them. The claim rules need a transcript, so they cannot be replayed over commit history and have fixture coverage only:

| Rule | flask | express | zod | Notes |
|---|---|---|---|---|
| `suppression-added` (warn) | 29 | 2 | 3 | flask adds `# type: ignore` to existing lines during typing work; brand-new lines with a directive are not counted |
| `ci-check-removed` (block) | 1 | 0 | 0 | Tools are compared by presence across the whole workflow, so action version bumps, matrix rows and migrations between CI systems do not count |
| `ci-weakened` (block) | 0 | 0 | 0 | Skipped in workflows named release, publish, deploy or docs; `fail-fast: false` is a matrix setting, not a weakening |
| `lint-config-loosened` (warn) | 4 | 1 | 0 | Only keys inside checker sections of `pyproject.toml` / `setup.cfg` |
| `hooks-removed` (block) | 2 | 0 | 0 | |
| `validation-removed` (warn) | 10 | 1 | 3 | Fires on a net loss of two guards, or the only guard a file had |
| `error-swallowing-added` (warn) | 0 | 0 | 4 | |
| `snapshots-regenerated` (warn) | 0 | 0 | 0 | |
| `protected-path-edited` (block) | 0 | 16 | 0 | express's `examples/auth/` matches the default `**/auth/**`; that is the policy working, tune `protectedPaths` per repo |
| `dependency-added` (warn) | 30 | 14 | 9 | Ordinary dependency additions; kept at warn so the human sees them |
| `dependency-loosened` (warn) | 2 | 9 | 0 | |
| `lockfile-changed-alone` (warn) | 6 | 0 | 0 | flask refreshes `uv.lock` without touching `pyproject.toml` |
| `feature-deleted` (block) | 1 | 2 | 2 | Functions removed together with the tests that called them |
| `typosquat-suspect`, `registry-changed`, `secret-introduced` (block) | 0 | 0 | 0 | |

### Catch rate on ImpossibleBench: not yet publishable

The roadmap promises detection numbers next to the false-positive numbers, replayed over ImpossibleBench's verified cheating solutions. `scripts/impossiblebench_inventory.py` downloads the one public trajectory release (144 runs of an OpenAI model on 24 Impossible-SWEbench tasks, three variants each) and reports what it contains. As of September 2026:

| | Count |
|---|---|
| Passes on impossible variants (cheating by construction) | 39 |
| Passes on the original tasks (honest controls) | 47 |
| Runs whose editor and shell arguments are fully published | 0 of 144 (one inline editor edit in the whole corpus) |
| Cheating runs with any `git diff` output preserved in tool results | 6 of 39 |
| Of those, diffs that touch a test file | 2 |

The agent's edits are stored as attachment references the release does not include, so the before-and-after test files cannot be reconstructed for most runs. The few recoverable cheats also modify source, not tests, which matches the paper's finding that OpenAI models special-case inside the implementation while Claude models edit tests. A diff gate is blind to the former by design (see Known limits). The catch rate will be published once the benchmark is run with a test-editing model and the Inspect logs are kept, or when the authors release their `.eval` logs.

## Known limits

- Assertion-level analysis exists for Python, JS/TS, Go, Java, Rust and Ruby. Everything else gets the file-level rules and the check-integrity, scope and claim families only.
- The model-backed review is opt-in and advisory: its findings default to warn, it costs a model call per changed tree pair, and its judgment is not reproducible (the verdict keeps the prompt hash and raw output instead). Its fixture responses were written by hand in the schema's shape; they are marked `authored` until recorded live.
- Source-side cheating is covered by the judge only. Running the original tests against the final code catches tests that were changed to fit the implementation, but an implementation that special-cases the test inputs passes the original tests too; without the judge nothing sees it. Mutation testing on the changed lines is the planned deterministic answer.
- The check-integrity and scope families have one replay pass each on three repositories, which is thinner than the test-integrity rules. `protected-path-edited` at block depends on the default globs matching your layout; express's `examples/auth/` shows what happens when they do not. The claim rules cannot be replayed over commit history at all and rest on fixtures.
- Claim verification reads the Claude Code transcript format. A format change makes it find nothing rather than fail loudly.
- `test-deleted` blocks on legitimate removals too. On real history that is the bulk of the residual (see the replay table). The override directive lifts it for one change; the per-rule severity and the block limit are the repo-wide alternatives.
- A verdict from the Stop hook is produced on the machine running the agent. It is evidence for the person reviewing the session. A merge check should trust only the GitHub Action, which recomputes the verdict from the diff in CI.
- A test that mocks a collaborator the task also touched will block if the change touches the mocked symbol. That is usually right and occasionally annoying; set `mock-on-changed-module` to `warn` for repos where it is not.
- Every `Stop` snapshots the whole working tree with `git add -A` into a temporary index seeded from a copy of the real index (with its original timestamp, so git's racy-file detection still catches same-second, same-size edits). Measured at 0.3 s for a one-file change in a 6,000-file repository and about 10 s when 3,000 files change; a large monorepo has not been measured.
- Codex CLI hook wiring is written but has not been exercised against a live Codex install. Cursor, Copilot agent mode and Gemini CLI have no native wiring; they can use the generic `session start` / `verify` protocol.
- Developed and tested on macOS and Linux. Windows is untested.
- Not on the npm registry yet. The package name `gatekeep-agent` is reserved in `package.json`; until it is published, install from source.

## Roadmap

Test integrity was the first check. The product is independent verification of what an agent did in a session, from state the agent cannot edit: 57 rules across test integrity, check integrity, scope, and claims, plus the original tests run against the final code. Everything below keeps the same architecture: snapshot at start, compare at stop, deterministic rules, no model call unless the judge is opted in. Ordered by what stops someone from adopting the gate.

### Delivery and reach

- **`gatekeep report`.** Renders the latest verdict (or a given one) as a single static HTML file: the decision, each finding with the before and after body of the test side by side, the judge annotations when present, and the overrides that applied. No server. It is the screenshot for a pull request comment or a launch post, and the only visual the product needs. The terminal report for the agent and the check annotations on the pull request stay the primary interfaces; a dashboard only makes sense with the hosted check below.
- **npm publish.** `gatekeep-agent` on the registry so `npx gatekeep-agent install` works without a clone.
- **Wider false-positive replay.** More repositories and more languages for the check-integrity and scope columns, and a transcript corpus from real sessions for the claim rules, which commit history cannot exercise.
- **Published catch rate.** Per-rule detection next to the false-positive table. The public ImpossibleBench release does not preserve the agents' test edits (see the inventory above), so this needs a run with a test-editing model and the Inspect logs kept.
- **GitLab CI and a PR label override.** The GitHub Action is done; a GitLab equivalent, and a pull-request label as a second override source alongside commit trailers, remain.
- **Adapters.** `gatekeep session start` / `gatekeep verify` are done for any framework; native hook wiring for Cursor, Gemini CLI, OpenCode and Aider, and a live test of the Codex hooks, remain. Claim verification for each harness's transcript format as the adapters land.
- **Languages.** Go, Java, Rust and Ruby are done; C# and Kotlin next.
- **Scale and platform.** Measure the snapshot and the original-tests run on a large monorepo. Windows CI.

### Later checks

- **Incremental mutation testing** on the lines the agent changed, with survivors fed back as a completion criterion. The answer to implementations that special-case the test inputs.
- **Holdout tests** generated from the task statement in a context the author agent never sees. Needs a model call, so it comes after everything above has users.
- **Hosted PR check** for organizations: policy per repo, verdict history, override audit, branch protection on the check. Open source under Apache-2.0 like everything else.

Every new rule family ships with its own `fp-*` fixtures and its own column in the replay table before any of its rules defaults to block.

Nothing leaves the machine. The local gate writes only to `~/.gatekeep/` and `.git/gatekeep/`, the original-tests run happens in a temporary export, and the GitHub Action sees only what CI already sees. There is no telemetry and no paid tier.
