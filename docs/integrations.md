Part of [gatekeep](../README.md): adapters, the generic protocol, overrides, the github action, and the verdict format.

# Adapters

| Harness | Status | How |
|---|---|---|
| Claude Code | supported | `gatekeep install` wires SessionStart, UserPromptSubmit and Stop hooks. Both the older and newer field spellings are read (`source`/`how`, `prompt`/`prompt_text`), and the Stop payload's `last_assistant_message` is preferred over the transcript file, which is written asynchronously and can lag the turn that triggered the hook |
| Codex CLI | wired, untested | `gatekeep install --codex` writes the same three hooks to `~/.codex/hooks.json` |
| Claude Agent SDK | works unmodified | `query()` runs the hooks already in `.claude/settings.json`; see below |
| Devin CLI | works unmodified, untested | it reads Claude Code's settings files and has the same Stop contract; see below |
| Anything else | supported via the generic protocol | two commands, below |

## Claude Agent SDK

An SDK agent picks gatekeep up from the repository with no code. The Agent SDK docs state that omitting
`settingSources` is *"equivalent to `["user", "project", "local"]`"* and that `query()` then *"reads the same
filesystem settings as the Claude Code CLI"*, and, on hooks specifically: *"If you already have hooks in your
project's `.claude/settings.json` and you set `settingSources: ["project"]`, those hooks run automatically in the
SDK with no extra configuration."* So `gatekeep install --shared` (which writes `.claude/settings.json`) is the
whole integration; `gatekeep install` writes `.claude/settings.local.json`, which needs `"local"` in the list.

Two things to get right:

- **`cwd` must be the directory that holds `.claude/`.** Project settings and hooks *"load only from `<cwd>/.claude/`
  with no parent-directory fallback"*, so an SDK process started above or below the repository root sees nothing.
- **`settingSources: []` turns gatekeep off** along with every other filesystem setting. If you pass the option at
  all, include the source your hooks live in.

Programmatic hooks passed to `query()` run alongside the filesystem ones rather than replacing them, so an SDK
application can keep its own hooks and still be gated.

## Devin CLI

Devin's CLI reads Claude Code's settings files directly — `.claude/settings.json`, `.claude/settings.local.json`,
`~/.claude/settings.json` and `~/.claude/settings.local.json` — under `read_config_from.claude`, which its docs
give as enabled by default. It has `SessionStart`, `UserPromptSubmit` and `Stop` among its events and the same
`{"decision": "block", "reason": ...}` command-hook contract. `gatekeep install` should therefore be the entire
setup, with no gatekeep code involved.

Untested against a live Devin install, and one part is expected not to work: the claims family needs a transcript,
which Devin's documented Stop payload does not carry, so those four rules will no-op there until the recorder
replaces transcript parsing.

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
permissions:
  contents: read        # read the diff
  checks: write         # write the annotations
jobs:
  gatekeep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # without this the base commit is missing and the run stops with a message saying so
      - uses: SagnikKK1/gatekeep@v1
        # with:
        #   base: ${{ github.event.pull_request.base.sha }}   # default
        #   fail-on-warn: 'true'
```

`@v1` is a tag that moves with each 0.1.x release. To pin exactly, use the release tag (`@v0.1.0`) or the commit SHA
(`uses: SagnikKK1/gatekeep@<sha>  # v0.1.0`), which is what Dependabot and most security policies expect. The action
ships its compiled `dist/`, so it installs one runtime dependency and runs; there is no TypeScript build on your runner.

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

## HTML report

```bash
gatekeep report                     # latest verdict for this repository -> latest.html beside it, path printed
gatekeep report --session <id>      # that session's most recent verdict
gatekeep report path/to/verdict.json --out report.html
gatekeep report --stdout | ...      # the html on stdout
gatekeep report --open              # also open it in the browser
```

One self-contained file: no scripts, no external resources, everything from the session escaped. Each finding shows the test body before and after the session side by side, read from the verdict's two tree objects, with changed lines marked; a finding on a line without a test name shows the surrounding lines instead. Sections for the original-tests run, the model-backed review (summary, prompt hash, raw output), overrides, the examined files, and the verdict JSON. Rendered outside the repository (or after the tree objects are gone), it falls back to the one-line before/after each finding recorded.
