Part of [gatekeep](../README.md): adapters, the generic protocol, overrides, the github action, and the verdict format.

# Adapters

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

# Overriding a rule for one change

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

# GitHub Action

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

# Verdict

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
