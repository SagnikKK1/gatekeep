Part of [gatekeep](../README.md): every rule and its default severity.

# Rules

| Rule | Default | Fires when |
|---|---|---|
| `gate-config-changed` | block | `gatekeep.config.json` or `.claude/settings*.json` changed during the session (session mode only; a human running `gatekeep run` may edit them) |
| `session-state-missing` | warn | No baseline was found at stop, or it had to be recovered from the `.git` mirror. Blocks, and cannot be turned off, when a baseline exists but no copy of it verifies |
| `state-tampered` | block | A stored copy of the session state failed its signature check and was ignored. Both copies are signed with a key kept under the state home, so editing the `.git/gatekeep` mirror is a finding rather than a silent baseline rewrite |
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
| `test-oracle-in-source` | warn | The implementation is fitted to the tests rather than the specification: a new condition comparing against a value only the tests used, a condition whose constants are those of a single test case, a table keyed by test values, source that reads the test runner's environment (`PYTEST_CURRENT_TEST`, `JEST_WORKER_ID`, `NODE_ENV === 'test'`), or executable code naming a test file. Comments are not evidence — an agent that reports a wrong assertion and implements the specification anyway writes exactly that |
| `timeout-increased` | off | A test timeout is raised |
| `judge-test-weakened` | warn | Model-backed review (opt-in): a test still passes but no longer checks what the task requires |
| `judge-special-casing` | warn | Model-backed review: the implementation is fitted to the test inputs rather than the behavior |
| `judge-task-mismatch` | warn | Model-backed review: the diff does something other than the task, or leaves it undone while claiming completion |
| `judge-review-manipulation` | warn | Model-backed review: text in the diff addressed to the reviewer or a model, telling it to approve, report nothing, or escape the diff |
| `judge-skipped` | warn | The judge is configured but could not run: no credentials, an API error, or output that did not match the schema (the reason is in the verdict) |

Languages: Python (pytest, unittest), JavaScript/TypeScript (jest, vitest, mocha, chai `expect` and `should` styles, node:test, sinon, supertest chains, `expectTypeOf`), Go (`testing` with `t.Error`/`t.Fatal` inside `if` checks, `t.Run` subtests, table-driven loops, `t.Skip`, build constraints, testify, `monkey.Patch`), Rust (`#[test]` inline and in `tests/`, `assert!`/`assert_eq!`/`assert_ne!` and every `assert_*!` macro, `#[ignore]`, `#[should_panic]`, `#[cfg]` gating, rstest and test_case, assert_cmd and snapbox chains), Java (JUnit 4/5 annotations and assertions, AssertJ and Truth chains, Hamcrest, assumptions, `@ParameterizedTest` sources, Mockito `mock`/`when`/`@Mock`, local helper resolution), and Ruby (RSpec `describe`/`it`, `expect().to` matchers and the old `should` syntax, `xit`/`skip`/`pending`/`:focus`, `allow`/`expect().to receive`, doubles; minitest and test-unit `def test_*`, `assert_*`/`refute_*`, spec-style `must_*`, `skip`, `stub`, Mocha `stubs`/`expects`).

Assertion helpers: a function defined in the test file counts as an assertion if its body asserts or throws. Imported functions named `assert*`, `check*`, `verify*`, `expect*`, `ensure*`, `validate*` (leading underscores ignored, `helpers.assertX()` included) are given the benefit of the doubt.
