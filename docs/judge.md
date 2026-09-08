Part of [gatekeep](../README.md): the optional model-backed review.

# Model-backed review

The rule families are deterministic, and deterministic cannot cover everything: a test rewritten to check a weaker property with the same structure, an implementation that special-cases the test inputs, or a deleted test that was genuinely part of the task. Opt in to a second layer that reads the diff with the task statement in hand:

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
