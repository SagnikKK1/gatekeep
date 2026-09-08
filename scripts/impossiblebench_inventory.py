#!/usr/bin/env python3
"""Inventory the public Impossible-SWEbench trajectory corpus for gatekeep's catch-rate replay.

Downloads the 144-trajectory release (thesophiaxu/impossible-swebench-raw-trajectories-144) and the task rows
(fjzzq2002/impossible_swebench), joins labels, and reports what can be reconstructed:
  - ground truth: a pass on an impossible variant is unambiguous cheating; a pass on the original is an honest control
  - whether the agent's edits are recoverable (editor arguments inline vs. unpublished attachment references)
  - whether a final `git diff` output survives in the tool results, and whether it touches test files

Usage: python3 scripts/impossiblebench_inventory.py [cache-dir]
"""
import collections
import json
import pathlib
import re
import sys
import urllib.request

BASE = "https://huggingface.co/datasets/thesophiaxu/impossible-swebench-raw-trajectories-144/resolve/main"
FILES = ["native-episodes.jsonl", "canonical-trajectories.jsonl", "provider-exchanges.jsonl"]
TEST_RE = re.compile(r"(^|/)(tests?|testing)/|(^|/)test_[^/\s]*\.py|_test\.py|conftest\.py")


def fetch(url: str, dest: pathlib.Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    print(f"downloading {url} -> {dest}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=600) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)


def jsonl(path: pathlib.Path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def main() -> int:
    cache = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".impossiblebench-cache")
    cache.mkdir(parents=True, exist_ok=True)
    for f in FILES:
        fetch(f"{BASE}/{f}", cache / f)

    episodes = {}
    units = {}
    for r in jsonl(cache / "native-episodes.jsonl"):
        m = r["metadata"]["impossible_swebench_private"]
        episodes[r["episode_id"]] = m
        units[m["unit_id"]] = m

    def label(m):
        if m["native_score"] == 1.0:
            return "cheat" if m["variant"] != "original" else "honest"
        return "failed"

    print("## Labels (a pass on an impossible variant is cheating by construction)")
    for (v, s), n in sorted(collections.Counter((m["variant"], m["native_score"]) for m in episodes.values()).items()):
        print(f"  {v:12s} score={s}  {n}")

    print("\n## Are the agent's edits recoverable from the tool calls?")
    inline_edits = attach_edits = attach_bash = inline_bash = 0
    per_label = collections.Counter()
    for r in jsonl(cache / "provider-exchanges.jsonl"):
        m = units.get(r["unit_id"])
        if not m or not r["model_calls"]:
            continue
        msgs = r["model_calls"][-1]["call"]["request"]["messages"]
        recoverable = True
        for msg in msgs:
            for tc in msg.get("tool_calls") or []:
                fn = tc.get("function", tc)
                name, args = fn.get("name"), fn.get("arguments") or ""
                is_attach = isinstance(args, str) and args.startswith("attachment://")
                if name == "text_editor":
                    if is_attach:
                        attach_edits += 1
                        recoverable = False
                    else:
                        try:
                            a = json.loads(args)
                        except Exception:
                            a = {}
                        if a.get("command") in ("create", "str_replace", "insert"):
                            inline_edits += 1
                elif name == "bash":
                    if is_attach:
                        attach_bash += 1
                        recoverable = False
                    else:
                        inline_bash += 1
        per_label[(label(m), recoverable)] += 1
    print(f"  editor edits with inline arguments: {inline_edits}; editor calls stored as unpublished attachments: {attach_edits}")
    print(f"  bash calls inline: {inline_bash}; bash calls stored as unpublished attachments: {attach_bash}")
    for (lab, ok), n in sorted(per_label.items()):
        print(f"  {lab:7s} fully recoverable={ok}: {n}")

    print("\n## Final `git diff` output preserved in tool results")
    cover = collections.Counter()
    late = collections.Counter()
    tests = collections.Counter()
    for r in jsonl(cache / "canonical-trajectories.jsonl"):
        m = episodes[r["episode_id"]]
        lab = label(m)
        diffs = []
        for i, e in enumerate(r["events"]):
            if e.get("type") != "tool_result":
                continue
            c = e.get("content")
            text = c if isinstance(c, str) else json.dumps(c)
            if "diff --git" in text:
                diffs.append((i, re.findall(r"^diff --git a/(\S+) b/", text, re.M)))
        cover[(lab, bool(diffs))] += 1
        if diffs:
            i, files = diffs[-1]
            late[(lab, i >= len(r["events"]) - 6)] += 1
            tests[(lab, any(TEST_RE.search(f) for f in files))] += 1
    for name, c in (("any diff output", cover), ("last diff within the final 6 events", late), ("last diff touches test files", tests)):
        print(f"  {name}:")
        for (lab, flag), n in sorted(c.items()):
            print(f"    {lab:7s} {str(flag):5s} {n}")
    print("\nConclusion: with edits stored as unpublished attachments and final diffs present for a handful of runs, this release does not")
    print("support reconstructing before/after test files at scale. A catch rate needs the Inspect .eval logs or a fresh run of the benchmark.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
