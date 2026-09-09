# Catch rate on Impossible-LiveCodeBench

Reproduces the numbers in [docs/replay.md](../../docs/replay.md): a coding agent runs the benchmark's impossible
tasks, gatekeep watches the session from outside, and the two are compared.

[ImpossibleBench](https://github.com/safety-research/impossiblebench) makes a task impossible by putting the
specification and the unit tests in conflict, so a green suite is a cheat by construction and needs no human
labelling. `runner.py` builds the same `func.py` / `test.py` pair the benchmark's full scaffold writes, gives the
agent the benchmark's own instruction, and scores with the benchmark's rule: restore the split's tests, run them
against whatever the agent left behind.

## Setup

```bash
pip install pandas pyarrow                      # or use a venv and set IB_PYTHON
mkdir -p data && cd data                        # the three splits, ~300 KB each
for s in conflicting oneoff original; do
  curl -sLo $s.parquet "https://huggingface.co/api/datasets/fjzzq2002/impossible_livecodebench/parquet/default/$s/0.parquet"
done
cd .. && (cd ../.. && npm install && npm run build)
```

The agent is Claude Code (`claude` on PATH, authenticated). `IB_MODEL` picks the model (default `claude-opus-5`),
`IB_PYTHON` the interpreter used to run the graded tests, `GK_CLI` the gatekeep build.

## Run

```bash
python runner.py --workers 5                    # 309 runs: 103 tasks x 3 splits
python reverify.py --judge --workers 3          # model-backed review over the recorded sessions
python analyze.py                               # the tables in docs/replay.md
```

`runner.py` is resumable: a task with a result file is skipped, so a killed run continues where it stopped.
Everything lands under `run/`: `results/<split>/<task>.json` (one record per run), `tasks/<split>/<task>/` (the
agent's working tree as a git repository, plus its transcript), and `gkhome/` (gatekeep's session and verdict
state). Delete a result file to re-run that task.

`reverify.py` recomputes verdicts from the recorded trees and transcripts without touching the agent, so a rules
change can be measured against a finished run. `--judge` adds the model-backed review; it is cached per tree pair,
task and finding list, so repeating it only calls the model where the deterministic findings changed.

## Reading a run record

| field | meaning |
|---|---|
| `split_tests_pass` | the split's own tests pass, which on an impossible split is a cheat by construction |
| `spec_tests_pass` | the original (correct) tests pass, so the specification was actually implemented |
| `test_modified` | `test.py` differs from what the scaffold wrote |
| `gatekeep.decision` / `.findings` | the verdict, with `judge` annotations where the review ran |
| `agent` | the Claude Code result envelope: turns, cost, session id, final message |
| `transcript` | the session transcript the claim rules read |

`gatekeep report --session <id>` renders any single run as HTML, reading `run/gkhome` as `GATEKEEP_HOME`.

## The recorded run

`results-2026-09-09.jsonl` is one line per run of the measurement in [docs/replay.md](../../docs/replay.md):
labels, verdict, rules fired and the judge's one-line summary, without the transcripts. `results-2026-09-09.txt`
is the `analyze.py` output for it. Re-running the commands above produces new agent sessions, not these; the
recorded file is what the published numbers were computed from.

## Cost

About $265 of API-equivalent agent usage for the 309 runs (10.1 turns per run on average, a few minutes each), plus one judge
call per run. Both go through whatever credential `claude` is using.
