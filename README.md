# gatekeep

An independent verification gate for AI coding agents. It runs when the agent tries to say "done" and blocks it if the tests were tampered with instead of satisfied.

Agents under pressure to get a green run will delete tests, mark them skipped, weaken `==` into truthiness, return early before the assertions, wrap assertions in `try/except`, mock away the module they just changed, or loosen numeric tolerances. Published measurements put this between 46% and 93% of runs depending on the model and task. gatekeep detects those edits deterministically from the diff of the test files, with no model call and no access to the agent's own summary of its work.

**gatekeep does not run your tests.** It is a diff gate, not a test runner. Keep running your suite; gatekeep answers a different question: did the tests that existed at the start of the session survive intact.

## How it works

- `SessionStart` snapshots the working tree (tracked and untracked, honoring `.gitignore`) as a git tree object. The index and `git status` are untouched. The gate's own config is captured at this moment.
- `UserPromptSubmit` records the first prompt as the task statement for the verdict.
- `Stop` diffs the current working tree against the snapshot, parses every changed test file with tree-sitter, compares the before and after test models, and:
  - exits 2 with the report on stderr when it finds blocking tampering. Claude Code feeds that text back to the agent as its next instruction;
  - after `maxBlocks` blocks in one session (default 3) lets the agent finish and delivers the findings to you through the hook's `systemMessage` channel;
  - on warnings only, lets the agent finish and delivers the warnings the same way.

State (sessions, verdicts) lives in `~/.gatekeep/`, never inside the repository, with a mirror of each session's baseline under the repository's own `.git/gatekeep/`. The mirror is authoritative: wiping `~/.gatekeep` mid-session recovers the baseline and is reported. The config is the copy captured at session start (or the defaults if there was none), so writing or editing `gatekeep.config.json` mid-session is a blocking finding and is never honored. The hook settings files are hashed from disk at session start and compared at stop, so a gitignored `settings.local.json` is covered too.

The gate runs as the same user as the agent. An agent that edits files under `.git/` can still corrupt its own baseline; that is outside what a hook can defend against and is noted as a `session-state-missing` finding when detected.

## Rules

| Rule | Default | Fires when |
|---|---|---|
| `gate-config-changed` | block | `gatekeep.config.json` or `.claude/settings*.json` changed during the session (session mode only; a human running `gatekeep run` may edit them) |
| `session-state-missing` | warn | No baseline was found at stop, or it had to be recovered from the `.git` mirror |
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
| `timeout-increased` | off | A test timeout is raised |

Languages: Python (pytest, unittest) and JavaScript/TypeScript (jest, vitest, mocha, chai `expect` and `should` styles, node:test, sinon, supertest chains, `expectTypeOf`). Go test files get the file-level rules only.

Assertion helpers: a function defined in the test file counts as an assertion if its body asserts or throws. Imported functions named `assert*`, `check*`, `verify*`, `expect*`, `ensure*`, `validate*` (leading underscores ignored, `helpers.assertX()` included) are given the benefit of the doubt.

## Install

Requires Node 20+ and git.

```bash
git clone <this repo> gatekeep && cd gatekeep
npm install && npm run build
npm link                                # puts `gatekeep` on PATH (or use node /path/to/gatekeep/dist/src/cli.js)

cd /path/to/your/project
gatekeep install                        # hooks into .claude/settings.local.json (machine-local, not committed)
gatekeep status                         # confirm the hooks are wired and see the state directory
```

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

## Configuration

`gatekeep.config.json` at the repo root:

```json
{
  "maxBlocks": 3,
  "strict": false,
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

Fixtures are `before/` and `after/` trees plus `expected.json` (optionally with a `severity`), generated by `scripts/gen_fixtures.py`. The `rt-*` and `rt2-*` cases are evasion techniques from two red-team passes; the `fp-*` cases are legitimate refactors that must not block; the `cr2-*` cases come from a code review.

### False-positive replay on real history

`scripts/corpus-fp.mjs <repo> <n>` replays the last `n` first-parent commits of any repository through the rules. Every hit on reviewed human commits is either a true detection or a false positive to fix. Current numbers on 300 commits each:

| Repo | Commits touching tests | Findings | Of which blocking | Blocking, by rule |
|---|---|---|---|---|
| flask | 141 | 53 | 32 | test-deleted 23, test-config-narrowed 5, assertion-weakened 4 |
| express | 93 | 149 | 93 | test-deleted 84, test-skipped 6, assertion-weakened 2, assertions-removed 1 |
| zod | 154 | 21 | 14 | test-deleted 11, test-file-deleted 2, assertion-weakened 1 |

The residual is almost entirely `test-deleted` on commits that genuinely removed tests (feature removals, reverts). Inside an agent session that is the intended behavior; the block limit and per-rule severities are the escape hatches.

## Known limits

- Python and JS/TS only. Go test files get the file-level rules; Java, Rust, Ruby and everything else get nothing.
- Source-side cheating is invisible to a test-diff gate: special-casing the test inputs inside the implementation, or overloading operators so the tests pass, leaves the test files untouched. ImpossibleBench ranks these as the next most common shortcuts after test modification. See the roadmap.
- `test-deleted` blocks on legitimate removals too. On real history that is the bulk of the residual (see the replay table). The only escape hatches today are the per-rule severity in `gatekeep.config.json` and the block limit, both repo-wide. A per-change override with an audit trail is the first roadmap item.
- The verdict is produced on the machine running the agent. It is evidence for the person reviewing the session, not something a remote PR check can trust until the check computes it independently from the diff.
- A test that mocks a collaborator the task also touched will block if the change touches the mocked symbol. That is usually right and occasionally annoying; set `mock-on-changed-module` to `warn` for repos where it is not.
- Every `Stop` snapshots the whole working tree with `git add -A` into a temporary index. That is about two seconds on a small repo and has not been measured on a large monorepo.
- Codex CLI hook wiring is written but has not been exercised against a live Codex install. Cursor, Copilot agent mode and Gemini CLI are not wired at all.
- Developed and tested on macOS and Linux. Windows is untested.
- Not yet published to npm. Install is clone and link, as above.

## Roadmap

Ordered by what stops someone from adopting the gate, not by what is most interesting to build.

1. **Per-change override with an audit trail.** A commit trailer or PR label such as `gatekeep: allow test-deleted` that lifts one rule for one change, is recorded in the verdict with who approved it, and never lifts `gate-config-changed`. This is what makes `test-deleted` at block livable on repos that remove features.
2. **Published catch rate.** Replay the rules over the verified deceptive solutions shipped with ImpossibleBench and report per-rule detection next to the false-positive table above. Detection and false-positive numbers belong side by side, or neither means anything.
3. **npm package and GitHub Action.** `npx <package> install` for the local gate; an action that runs `gatekeep run --base <default branch> --json` on pull requests and posts the findings as check-run annotations on the changed lines. The action computes the verdict from the diff in CI and never trusts a verdict uploaded from a developer machine.
4. **Source-side cheating, first cut.** A rule that flags literal values from the assertions of changed tests appearing in the implementation diff. Cheap, deterministic, and catches the crude form of special-casing.
5. **Go extractor** (`testing`, testify), then Java and Rust. Polyglot monorepos are the common case for teams running agents at scale.
6. **Scale and platform.** Measure the snapshot on a large monorepo and limit the pathspec to test globs plus changed source if needed. Windows CI.
7. **Check 2: incremental mutation testing** on the lines the agent changed, with survivors fed back as a completion criterion. This is the full answer to source-side cheating.
8. **Hosted PR check** for organizations: policy per repo, verdict history, override audit, and branch protection on the check. Open source under Apache-2.0 like everything else.
9. **Check 3: holdout tests** generated from the task statement in a context the author agent never sees. Deferred: it needs a model call and breaks the deterministic story, so it comes after everything above has users.

Nothing leaves the machine. The local gate writes only to `~/.gatekeep/`, and the planned CI action sees only what CI already sees. There is no telemetry and no paid tier.
