Part of [gatekeep](../README.md): the two opt-in checks that run code and read the transcript.

# Original tests against final code

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

# Claim verification

The Stop hook receives the session transcript. gatekeep reads the agent's final message and compares it to what actually happened: whether a test, build, lint or type-check command ran after the last edit when the message says they pass, whether the files it names are the files that changed, and whether git history was rewritten or changes hidden along the way. Claude Code transcripts today; other harnesses when their adapters land. Nothing in the transcript is trusted as evidence of correctness; it is only checked for contradictions.
