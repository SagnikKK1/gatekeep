Part of [gatekeep](../README.md): the prevention lane, which is the one thing here that is not a gate.

# protect-tests

Everything else in gatekeep runs after the fact. It reads the diff at the end of the session and decides whether the
work was faked. `protect-tests` does the opposite: it makes the test tree unwritable for the session, so the
tampering never happens and there is nothing to accuse anyone of.

```bash
gatekeep protect-tests --dry-run    # print what would be protected, write nothing
gatekeep protect-tests              # .claude/settings.local.json (this machine only)
gatekeep protect-tests --shared     # .claude/settings.json (committed, whole team)
gatekeep protect-tests --global     # ~/.claude/settings.json (every project)
gatekeep protect-tests --off        # remove exactly what it wrote
```

It is opt-in and independent of the gate. `gatekeep install` does not turn it on, `protect-tests` does not wire the
gate's hooks, and either can be used without the other. `gatekeep uninstall` does take the lane out as well, so an
uninstall never leaves deny entries behind that nothing explains.

## What it writes

Discovery lists every tracked or untracked-but-not-ignored file the rules would classify as a test — the same
`testGlobs` the gate uses, so `extraTestGlobs` in `gatekeep.config.json` moves both — and collapses them into
globs: a directory named `tests`, `test`, `spec`, `__tests__` or `benches` becomes `<dir>/**`, and a colocated test
becomes its filename shape (`**/*.test.ts`, `**/*_test.go`, `**/test_*.py`, `**/*_spec.rb`, `**/*Test*.java`).
Anything with no recognisable shape is listed as itself rather than swept in with its neighbours.

Those globs go into the settings file three times, because no single layer covers everything:

| Layer | Covers | Misses |
|---|---|---|
| `permissions.deny` — `Edit(tests/**)`, `Write(tests/**)` | the file tools | anything run through the shell |
| `sandbox.filesystem.denyWrite` | every write, including from a shell command, at the OS level | machines with the sandbox off |
| the `PreToolUse` hook | the file tools, and shell commands that obviously write | shell that is not obvious |

Only the third one can say *why*, which is the point of having it: a bare permission denial tells the agent it is
blocked, and this tells it what to do instead — make the implementation satisfy the test, and if the test itself is
genuinely wrong for the task, stop and say so rather than editing it. The refusal names `test-write-denied`.

## The shell scan is best-effort, and deliberately so

The hook's Bash branch is a whitelist of verbs (`rm`, `mv`, `cp`, `truncate`, `tee`, `patch`, `sed -i`, `git rm`,
`git checkout`, …) plus any `>` or `>>` redirection target. It is not a shell parser, and it is not trying to be:
anything cleverer would be guessing, and a permission hook that guesses blocks honest work. `xargs`, a command
substitution, or a script that writes a test file will get through it. That gap is what
`sandbox.filesystem.denyWrite` is for — the sandbox is the enforcement, the hook is the explanation.

## Limits worth knowing

- **The patterns are a snapshot, not a live query.** Add a test directory and re-run `protect-tests`.
- **It classifies by path.** A test somewhere unusual is invisible to both this and the gate until `extraTestGlobs`
  names it.
- **A project `--off` cannot reach a copy wired globally.** `--off` says so when it finds one, and `gatekeep status`
  lists every settings file that carries the lane.
- **`--off` removes only what the lane recorded as its own**, so a deny entry you wrote by hand survives it.
- **A legitimately wrong test now needs a human.** That is the intended trade: the agent has to raise it rather than
  quietly rewrite it. If that is too strict for a repository, the gate alone is the looser half of gatekeep.
