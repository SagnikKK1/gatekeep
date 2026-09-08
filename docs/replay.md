Part of [gatekeep](../README.md): false-positive replay on real history, and the impossiblebench catch rate.

## False-positive replay on real history

`scripts/corpus-fp.mjs <repo> <n>` replays the last `n` first-parent commits of any repository through the rules. Every hit on reviewed human commits is either a true detection or a false positive to fix. Numbers on the last 300 first-parent commits of each, test-integrity rules only; flask, express and zod reproduced on fresh clones on 2026-09-09, the others from the day before:

| Repo | Commits touching tests | Findings | Of which blocking | Blocking, by rule |
|---|---|---|---|---|
| flask | 140 | 53 | 32 | test-deleted 23, test-config-narrowed 5, assertion-weakened 4 |
| express | 93 | 149 | 105 | test-deleted 84, assertion-weakened 9, test-skipped 6, test-file-deleted 5, assertions-removed 1 |
| zod | 155 | 28 | 16 | test-deleted 12, test-file-deleted 2, assertion-swallowed 1, assertion-weakened 1 |
| cobra (Go) | 119 | 39 | 5 | test-file-deleted 2, ci-check-removed 2, test-deleted 1 |
| clap (Rust) | 77 | 48 | 2 | test-deleted 1, ci-check-removed 1; 18 `test-file-unparseable` warnings from snapbox's `str![[...]]` macro, which this grammar build cannot parse, so count-based rules stand down on those files |
| gson (Java) | 153 | 28 | 9 | test-deleted 2, test-file-deleted 2, assertion-weakened 2, assertion-swallowed 2, test-skipped 1 |
| sinatra (Ruby) | 129 | 53 | 16 | test-file-deleted 12 (a removed feature's specs), test-deleted 4 |

The residual is almost entirely `test-deleted` and `test-file-deleted` on commits that genuinely removed tests (express's five deleted test files are commits titled "Remove req.param()" and the like). The nine express `assertion-weakened` hits are merges of 4.x releases into 5.x where `err.message.should.equal('...')` became `assert.ok(err)`: a specific check replaced by a truthiness check, by maintainers, during a test-framework migration. Those are true detections too, of the kind a reviewer would want to see. Inside an agent session that is the intended behavior; the override directive, the block limit and the per-rule severities are the escape hatches.

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

## Catch rate on ImpossibleBench: not yet publishable

The README's roadmap promises detection numbers next to the false-positive numbers, replayed over ImpossibleBench's verified cheating solutions. `scripts/impossiblebench_inventory.py` downloads the one public trajectory release (144 runs of an OpenAI model on 24 Impossible-SWEbench tasks, three variants each) and reports what it contains. As of September 2026:

| | Count |
|---|---|
| Passes on impossible variants (cheating by construction) | 39 |
| Passes on the original tasks (honest controls) | 47 |
| Runs whose editor and shell arguments are fully published | 0 of 144 (one inline editor edit in the whole corpus) |
| Cheating runs with any `git diff` output preserved in tool results | 6 of 39 |
| Of those, diffs that touch a test file | 2 |

The agent's edits are stored as attachment references the release does not include, so the before-and-after test files cannot be reconstructed for most runs. The few recoverable cheats also modify source, not tests, which matches the paper's finding that OpenAI models special-case inside the implementation while Claude models edit tests. A diff gate is blind to the former by design (see the known limits in the README). The catch rate will be published once the benchmark is run with a test-editing model and the Inspect logs are kept, or when the authors release their `.eval` logs.
