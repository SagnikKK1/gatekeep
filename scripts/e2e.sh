#!/bin/bash
# End-to-end checks of the hook protocol, state layout, installer and CLI against a throwaway repo.
# Usage: scripts/e2e.sh [scratch-dir]
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CLI="$HERE/dist/src/cli.js"
E2E=${1:-$(mktemp -d)}
rm -rf "$E2E"; mkdir -p "$E2E"
export GATEKEEP_HOME="$E2E/home"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t HOME="$E2E/fakehome"
mkdir -p "$HOME"
pass=0; fail=0
# in-place sed that works with both BSD (macOS) and GNU sed
sedi() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
check() { if eval "$2"; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1"; fi; }
# A blocking stop is exit 0 with {"decision":"block"} on stdout; $1 is that stdout.
blocked() { [ $code -eq 0 ] && echo "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.exit(JSON.parse(d).decision==="block"?0:1)}catch{process.exit(1)}})'; }
hook() { echo "$2" | node "$CLI" hook "$1" --harness claude-code; }

R="$E2E/repo"; mkdir -p "$R/app" "$R/tests"; cd "$R"; git init -q -b main
cat > app/calc.py <<'PY'
def add(a, b):
    return 0
PY
cat > tests/test_calc.py <<'PY'
from app.calc import add

def test_add():
    assert add(2, 3) == 5

def test_add_zero():
    assert add(0, 0) == 0
PY
echo '{"maxBlocks": 1, "rules": {}}' > gatekeep.config.json
git add -A && git commit -qm base
SID='{"session_id":"s1","cwd":"'"$R"'","source":"startup"}'

echo "== session lifecycle"
out=$(hook session-start "$SID"); code=$?
check "session-start exit 0" '[ $code -eq 0 ]'
check "session-start announces the gate on stdout" 'echo "$out" | grep -q "gatekeep is active"'
check "state lives under GATEKEEP_HOME, not the repo" '[ -d "$GATEKEEP_HOME/repos" ] && [ ! -d "$R/.gatekeep" ]'
check "snapshot config stored in session" 'grep -q maxBlocks "$GATEKEEP_HOME"/repos/*/sessions/s1.json'
hook prompt '{"session_id":"s1","cwd":"'"$R"'","prompt":"make add work"}' >/dev/null
check "prompt captured" 'grep -q "make add work" "$GATEKEEP_HOME"/repos/*/sessions/s1.json'
# Claude Code renamed these two fields; both spellings must work or the task statement is silently lost.
hook prompt '{"session_id":"s1","cwd":"'"$R"'","prompt_text":"and handle negatives"}' >/dev/null
check "prompt captured under the newer field name (prompt_text)" 'grep -q "and handle negatives" "$GATEKEEP_HOME"/repos/*/sessions/s1.json'
b1=$(python3 -c "import json,glob;print(json.load(open(glob.glob('$GATEKEEP_HOME/repos/*/sessions/s1.json')[0]))['baseTree'])")
for reason in resume compact clear fork; do
  hook session-start '{"session_id":"s1","cwd":"'"$R"'","how":"'"$reason"'"}' >/dev/null
done
b2=$(python3 -c "import json,glob;print(json.load(open(glob.glob('$GATEKEEP_HOME/repos/*/sessions/s1.json')[0]))['baseTree'])")
check "resume/compact/clear/fork keep the baseline (newer field name: how)" '[ "$b1" = "$b2" ]'
echo 'x = 1' > scratch_new_file.py
hook session-start '{"session_id":"s1","cwd":"'"$R"'","how":"startup"}' >/dev/null
b3=$(python3 -c "import json,glob;print(json.load(open(glob.glob('$GATEKEEP_HOME/repos/*/sessions/s1.json')[0]))['baseTree'])")
check "a fresh start does take a new baseline" '[ "$b1" != "$b3" ]'
rm -f scratch_new_file.py
out=$(hook stop '{"session_id":"s1","cwd":"'"$R"'","stop_hook_active":false}' 2>&1); code=$?
check "clean stop: exit 0 and silent" '[ $code -eq 0 ] && [ -z "$out" ]'

echo "== agent edits the gate config: blocked, and config comes from the snapshot"
echo '{"maxBlocks": 99, "rules": {"test-deleted": "off"}}' > gatekeep.config.json
sedi '/def test_add_zero/,$d' tests/test_calc.py
out=$(hook stop '{"session_id":"s1","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "stop blocks: exit 0 with decision=block JSON on stdout" '[ $code -eq 0 ] && echo "$out" | node -e "const j=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));process.exit(j.decision===\"block\"&&typeof j.reason===\"string\"&&typeof j.systemMessage===\"string\"?0:1)"'
check "the block reason is the agent-facing report" 'echo "$out" | node -e "const j=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));process.exit(/GATEKEEP BLOCKED/.test(j.reason)&&/You may not finish yet/.test(j.reason)?0:1)"'
check "reports gate-config-changed" 'echo "$out" | grep -q gate-config-changed'
check "reports test-deleted despite the agent turning it off" 'echo "$out" | grep -q "test-deleted"'
out=$(hook stop '{"session_id":"s1","cwd":"'"$R"'","stop_hook_active":true}' 2>/dev/null); code=$?
check "block limit (from snapshot config, maxBlocks=1) reached: exit 0" '[ $code -eq 0 ]'
check "findings handed to the human via systemMessage JSON" 'echo "$out" | node -e "const j=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));process.exit(/block limit/.test(j.systemMessage)&&/test-deleted/.test(j.systemMessage)?0:1)"'
git checkout -q . 

echo "== warn-only findings reach the human without blocking"
hook session-start '{"session_id":"s2","cwd":"'"$R"'","source":"startup"}' >/dev/null
cat >> tests/test_calc.py <<'PY'

def test_smoke():
    add(1, 1)
PY
out=$(hook stop '{"session_id":"s2","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "warn: exit 0" '[ $code -eq 0 ]'
check "warn: systemMessage carries assertion-free-test" 'echo "$out" | grep -q assertion-free-test'
git checkout -q .

echo "== racily-clean edits: same size, file mtime equal to the index mtime"
printf 'def add(a, b):\n    return a + b\n' > app/calc.py; git add -A; git commit -qm "same second" 2>/dev/null
printf 'def add(a, b):\n    return a * b\n' > app/calc.py   # same length
touch -r .git/index app/calc.py                                 # force the racy condition deterministically
node "$CLI" run --json > /tmp/gk_out 2>&1
check "snapshot sees a same-size edit whose mtime equals the index mtime" 'grep -q "app/calc.py" /tmp/gk_out'
git checkout -q .
mkdir -p src; for i in $(seq 1 300); do printf 'export const v%03d = %03d;\n' $i $i > src/m$i.ts; done; git add -A; git commit -qm "300 files" >/dev/null
for i in $(seq 1 300); do printf 'export const v%03d = %03d;\n' $i $((i+1)) > src/m$i.ts; touch -r .git/index src/m$i.ts; done
node "$CLI" run --json > /tmp/gk_out 2>&1
n=$(grep -c '"src/m[0-9]*.ts"' /tmp/gk_out)
check "300 same-size racy edits all appear in the snapshot (found $n)" '[ "$n" = "300" ]'
git status --porcelain | grep -c '^ M' | grep -qx 300; check "git status agrees (300 modified)" '[ $? -eq 0 ]'
git checkout -q .; git rm -rq src >/dev/null; git commit -qm "drop" >/dev/null
echo "== corrupt index copy falls back to HEAD"
cp .git/index /tmp/gk_index_backup; printf 'DIRC\x00\x00\x00\x02garbage' > .git/index
printf 'def add(a, b):\n    return a - b\n' > app/calc.py
node "$CLI" run --json > /tmp/gk_out 2>&1; code=$?
check "unreadable real index: snapshot still built from HEAD and the edit is seen (exit $code)" '[ $code -ne 3 ] && grep -q "app/calc.py" /tmp/gk_out'
cp /tmp/gk_index_backup .git/index; git checkout -q .

echo "== trivial bypasses"
printf 'def test_add():\n    pass\n# \0\n' > tests/test_calc.py
node "$CLI" run >/tmp/gk_out 2>&1; code=$?
check "NUL byte in test file blocks (test-file-unreadable)" '[ $code -eq 1 ] && grep -q test-file-unreadable /tmp/gk_out'
git checkout -q .
python3 -c "open('tests/test_calc.py','w').write('def test_add():\n    pass\n#' + 'x'*9000000)"
node "$CLI" run >/tmp/gk_out 2>&1; code=$?
check "9MB test file blocks" '[ $code -eq 1 ] && grep -q test-file-unreadable /tmp/gk_out'
git checkout -q .
mkdir -p vendor && git mv tests/test_calc.py vendor/test_calc.py
node "$CLI" run >/tmp/gk_out 2>&1; code=$?
check "moving tests into an ignored dir blocks" '[ $code -eq 1 ] && grep -q test-file-moved-out /tmp/gk_out'
git mv vendor/test_calc.py tests/test_calc.py; rmdir vendor 2>/dev/null; git checkout -q .

echo "== gitignored hook settings and state wipe"
hook session-start '{"session_id":"s3","cwd":"'"$R"'","source":"startup"}' >/dev/null
mkdir -p .claude && echo '{"hooks":{"Stop":[]}}' > .claude/settings.local.json && echo '.claude/settings.local.json' >> .git/info/exclude
hook session-start '{"session_id":"s4","cwd":"'"$R"'","source":"startup"}' >/dev/null
echo '{"hooks":{}}' > .claude/settings.local.json
err=$(hook stop '{"session_id":"s4","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "editing a gitignored settings.local.json blocks (hashed from disk)" 'blocked "$err" && echo "$err" | grep -q gate-config-changed'
rm -rf .claude; sedi '/settings.local.json/d' .git/info/exclude
hook session-start '{"session_id":"s5","cwd":"'"$R"'","source":"startup"}' >/dev/null
sedi '/def test_add_zero/,$d' tests/test_calc.py; git add -A; git commit -qm "agent commits tampering"
rm -rf "$GATEKEEP_HOME"
err=$(hook stop '{"session_id":"s5","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "wiping GATEKEEP_HOME after committing tampering: baseline recovered from .git mirror, still blocked" 'blocked "$err" && echo "$err" | grep -q test-deleted && echo "$err" | grep -q session-state-missing'
git checkout -q . && git reset -q --hard HEAD~1

echo "== signed session state: the .git mirror is not a free baseline rewrite"
hook session-start '{"session_id":"s5b","cwd":"'"$R"'","source":"startup"}' >/dev/null
MIR=".git/gatekeep/sessions/s5b.json"
check "state is signed in both copies" 'node -e "const f=require(\"fs\");const m=JSON.parse(f.readFileSync(\"'"$MIR"'\",\"utf8\"));const h=JSON.parse(f.readFileSync(f.readdirSync(\"'"$GATEKEEP_HOME"'/repos\").map(d=>\"'"$GATEKEEP_HOME"'/repos/\"+d+\"/sessions/s5b.json\")[0],\"utf8\"));process.exit(/^[0-9a-f]{64}$/.test(m.sig)&&/^[0-9a-f]{64}$/.test(h.sig)?0:1)"'
check "the key lives outside the repository" '[ -f "$(ls "$GATEKEEP_HOME"/repos/*/hmac.key)" ] && [ ! -e .git/gatekeep/hmac.key ]'
sedi '/def test_add_zero/,$d' tests/test_calc.py
# rewrite the mirror's baseline to the current tree: without signing this hides every change
NOW=$(node "$CLI" run --json 2>/dev/null | node -e "let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>console.log(JSON.parse(d).currentTree))")
node -e "const f=require('fs');const p='$MIR';const j=JSON.parse(f.readFileSync(p,'utf8'));j.baseTree='$NOW';f.writeFileSync(p,JSON.stringify(j,null,2))"
err=$(hook stop '{"session_id":"s5b","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "a rewritten mirror is rejected: state-tampered, and the real findings still land" 'blocked "$err" && echo "$err" | grep -q state-tampered && echo "$err" | grep -q test-deleted'
git checkout -q .
# a stripped signature is not a way to opt out of verification (fresh session: one block each)
hook session-start '{"session_id":"s5c","cwd":"'"$R"'","source":"startup"}' >/dev/null
sedi '/def test_add_zero/,$d' tests/test_calc.py
node -e "const f=require('fs');const p='.git/gatekeep/sessions/s5c.json';const j=JSON.parse(f.readFileSync(p,'utf8'));j.blocks=0;delete j.sig;f.writeFileSync(p,JSON.stringify(j,null,2))"
err=$(hook stop '{"session_id":"s5c","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "an unsigned mirror is rejected too" 'blocked "$err" && echo "$err" | grep -q state-tampered'
git checkout -q .
# both copies unverifiable: no trusted baseline at all
hook session-start '{"session_id":"s5d","cwd":"'"$R"'","source":"startup"}' >/dev/null
sedi '/def test_add_zero/,$d' tests/test_calc.py
node -e "const f=require('fs');const cp=require('child_process');for (const p of ['.git/gatekeep/sessions/s5d.json', cp.execSync('ls \"$GATEKEEP_HOME\"/repos/*/sessions/s5d.json').toString().trim()]) {const j=JSON.parse(f.readFileSync(p,'utf8'));j.sig='0'.repeat(64);f.writeFileSync(p,JSON.stringify(j,null,2));}"
err=$(hook stop '{"session_id":"s5d","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "no verifiable copy: session-state-missing blocks instead of warning" 'blocked "$err" && echo "$err" | grep -q session-state-missing'
git checkout -q .
# deleting the key is not a way to make forged state verify
hook session-start '{"session_id":"s5e","cwd":"'"$R"'","source":"startup"}' >/dev/null
sedi '/def test_add_zero/,$d' tests/test_calc.py
rm -f "$GATEKEEP_HOME"/repos/*/hmac.key
err=$(hook stop '{"session_id":"s5e","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "removing the signing key is itself a finding, and the real one still lands" 'blocked "$err" && echo "$err" | grep -q state-tampered && echo "$err" | grep -q test-deleted'
git checkout -q .
git reset -q --hard HEAD~1
echo "== no config at session start: agent-written config is ignored"
git rm -q --cached gatekeep.config.json && rm gatekeep.config.json && git commit -qm "no config"
hook session-start '{"session_id":"s6","cwd":"'"$R"'","source":"startup"}' >/dev/null
sedi '/def test_add_zero/,$d' tests/test_calc.py
echo '{"rules":{"test-deleted":"off","gate-config-changed":"off"}}' > gatekeep.config.json
err=$(hook stop '{"session_id":"s6","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "config written mid-session is not honored" 'blocked "$err" && echo "$err" | grep -q test-deleted'
git checkout -q . && rm -f gatekeep.config.json && git reset -q --hard HEAD~1
echo "== honest work in a protected path passes silently"
A="$E2E/authfix"; mkdir -p "$A/src/auth" "$A/tests"; cd "$A"; git init -q -b main
printf 'def login(user, pw):\n    if pw == "":\n        return None\n    return {"ok": True}\n' > src/auth/login.py
printf 'from src.auth.login import login\n\ndef test_login():\n    assert login("a", "") is None\n' > tests/test_login.py
git add -A && git commit -qm base
sid=$(node "$CLI" session start --task "Fix the login bug so bad passwords are rejected")
printf 'def login(user, pw):\n    if not pw or pw != "correct":\n        return None\n    return {"ok": True}\n' > src/auth/login.py
node "$CLI" verify --session "$sid" >/tmp/gk_out 2>&1; code=$?
check "an auth fix the task asked for is not a protected-path block" '[ $code -eq 0 ] && grep -q "GATEKEEP PASSED" /tmp/gk_out && ! grep -q protected-path-edited /tmp/gk_out'
sid2=$(node "$CLI" session start --task "Update the README badge")
printf 'def login(user, pw):\n    return {"ok": True}\n' > src/auth/login.py
node "$CLI" verify --session "$sid2" >/tmp/gk_out 2>&1
check "the same edit under an unrelated task is still reported, at warn" 'grep -q protected-path-edited /tmp/gk_out && grep -q "\[warn\] protected-path-edited" /tmp/gk_out'
cd "$R"

echo "== the index and local excludes cannot hide a change from the snapshot"
hook session-start '{"session_id":"s8","cwd":"'"$R"'","source":"startup"}' >/dev/null
sedi '/def test_add_zero/,$d' tests/test_calc.py
git update-index --skip-worktree tests/test_calc.py
err=$(hook stop '{"session_id":"s8","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "skip-worktree hides nothing: index-flags-set plus the real finding" 'blocked "$err" && echo "$err" | grep -q index-flags-set && echo "$err" | grep -q test-deleted'
check "the developer's own index keeps its flag" 'git ls-files -v tests/test_calc.py | grep -q "^S"'
git update-index --no-skip-worktree tests/test_calc.py; git checkout -q .
hook session-start '{"session_id":"s9","cwd":"'"$R"'","source":"startup"}' >/dev/null
printf 'def test_new():\n    assert add(1, 1) == 2\n' > tests/test_extra.py
echo 'tests/test_extra.py' >> .git/info/exclude
err=$(hook stop '{"session_id":"s9","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check ".git/info/exclude hides nothing: paths-hidden-from-snapshot" 'blocked "$err" && echo "$err" | grep -q paths-hidden-from-snapshot && echo "$err" | grep -q tests/test_extra.py'
sedi '/test_extra/d' .git/info/exclude; rm -f tests/test_extra.py
echo 'build/' > .gitignore && mkdir -p build && echo x > build/out.o && git add .gitignore && git commit -qm gitignore
hook session-start '{"session_id":"s10","cwd":"'"$R"'","source":"startup"}' >/dev/null
out=$(hook stop '{"session_id":"s10","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "a committed .gitignore over build output is not hiding anything" '[ $code -eq 0 ] && ! echo "$out" | grep -q paths-hidden-from-snapshot'
rm -rf build .gitignore; git rm -q --cached .gitignore 2>/dev/null; git checkout -q .; git reset -q --hard HEAD~1

echo "== concurrent stops share one counter"
hook session-start '{"session_id":"s7","cwd":"'"$R"'","source":"startup"}' >/dev/null
sedi '/def test_add_zero/,$d' tests/test_calc.py
rm -f /tmp/gk_codes; for i in 1 2 3 4 5 6; do (o=$(hook stop '{"session_id":"s7","cwd":"'"$R"'"}' 2>/dev/null); echo "$o" | grep -q '"decision":"block"' && echo blocked >> /tmp/gk_codes) & done; wait
blocked=$(grep -c '^blocked$' /tmp/gk_codes 2>/dev/null || echo 0); blocks=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).blocks)" "$(ls "$GATEKEEP_HOME"/repos/*/sessions/s7.json)")
check "6 concurrent stops serialized: exactly maxBlocks(1) blocked (blocked=$blocked, counter=$blocks)" '[ "$blocked" = "1" ] && [ "$blocks" = "1" ]'
git checkout -q .
echo "== run without a session: human config edits are not tampering"
echo '{"maxBlocks": 2}' > gatekeep.config.json
node "$CLI" run >/tmp/gk_out 2>&1; code=$?
check "run (no session) with an uncommitted config edit passes" '[ $code -eq 0 ]'
git checkout -q . 2>/dev/null; git clean -fdq

echo "== original tests against final code (testCommand)"
T="$E2E/testrun"; rm -rf "$T"; mkdir -p "$T/app" "$T/tests"; pushd "$T" >/dev/null; git init -q -b main
printf 'def add(a, b):\n    return a + b\n' > app/calc.py; touch app/__init__.py tests/__init__.py
printf 'import unittest\nfrom app.calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n' > tests/test_calc.py
echo '{"testCommand": "python3 -m unittest discover -s tests -t . 2>&1"}' > gatekeep.config.json
git add -A && git commit -qm base
hook session-start '{"session_id":"t1","cwd":"'"$T"'","source":"startup"}' >/dev/null
printf 'def add(a, b):\n    return a * b\n' > app/calc.py
out=$(hook stop '{"session_id":"t1","cwd":"'"$T"'"}' 2>/dev/null); code=$?
check "source broken, tests untouched: warn tests-failing, no block" '[ $code -eq 0 ]'
node "$CLI" run --json > /tmp/gk_out 2>&1; grep -q '"tests-failing"' /tmp/gk_out && grep -q '"status": "fail"' /tmp/gk_out; check "run --json reports tests-failing with originalTests status fail" '[ $? -eq 0 ]'
printf 'import unittest\nfrom app.calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 6)\n' > tests/test_calc.py
err=$(hook stop '{"session_id":"t1","cwd":"'"$T"'"}' 2>/dev/null); code=$?
check "source broken + test edited to match: blocked by original-tests-fail" 'blocked "$err" && echo "$err" | grep -q original-tests-fail'
check "report shows the original run and the edited run" 'echo "$err" | grep -q "edited tests exit 0"'
git checkout -q . && printf 'def add(a, b):\n    return a + b + 0\n' > app/calc.py
out=$(hook stop '{"session_id":"t1","cwd":"'"$T"'"}' 2>&1); code=$?
check "honest fix: original tests pass, silent" '[ $code -eq 0 ] && [ -z "$out" ]'
git checkout -q .; rm tests/test_calc.py; printf 'def add(a, b):\n    return a * b\n' > app/calc.py
err=$(hook stop '{"session_id":"t1","cwd":"'"$T"'"}' 2>/dev/null); code=$?
check "deleted test file is restored for the run: test-file-deleted plus a failing original suite" 'blocked "$err" && echo "$err" | grep -q test-file-deleted && echo "$err" | grep -qE "original-tests-fail|tests-failing"'
git checkout -q .
echo '{"testCommand": "sleep 30"}' > gatekeep.config.json && git commit -qam "slow" >/dev/null
J="$E2E/testrun-js"; rm -rf "$J"; mkdir -p "$J/src" "$J/tests"; pushd "$J" >/dev/null; git init -q -b main
printf 'exports.add = (a, b) => a + b;\n' > src/calc.js
printf "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/calc');\ntest('adds', () => { assert.strictEqual(add(2, 3), 5); });\n" > tests/calc.test.js
echo '{"testCommand": "node --test tests/calc.test.js 2>&1", "testTimeoutMs": 60000}' > gatekeep.config.json
git add -A && git commit -qm base
printf 'exports.add = (a, b) => a * b;\n' > src/calc.js
printf "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/calc');\ntest('adds', () => { assert.strictEqual(add(2, 3), 6); });\n" > tests/calc.test.js
node "$CLI" run >/tmp/gk_out 2>&1; code=$?
check "node:test project: run blocks with original-tests-fail" '[ $code -eq 1 ] && grep -q original-tests-fail /tmp/gk_out'
popd >/dev/null; popd >/dev/null

echo "== claim verification from the transcript"
TR="$E2E/transcript.jsonl"
hook session-start '{"session_id":"c1","cwd":"'"$R"'","source":"startup"}' >/dev/null
printf 'def add(a, b):\n    return a * b\n' > app/calc.py
python3 - "$TR" <<'PY'
import json, sys
L = lambda t, c: json.dumps({"type": t, "message": {"role": t, "content": c}})
lines = [L("user", [{"type": "text", "text": "fix add"}]),
         L("assistant", [{"type": "tool_use", "name": "Bash", "input": {"command": "python3 -m unittest"}}]),
         L("user", [{"type": "tool_result", "tool_use_id": "1", "content": "OK"}]),
         L("assistant", [{"type": "tool_use", "name": "Edit", "input": {"file_path": "app/calc.py"}}]),
         L("user", [{"type": "tool_result", "tool_use_id": "2", "content": "ok"}]),
         L("assistant", [{"type": "tool_use", "name": "Bash", "input": {"command": "git commit --amend --no-edit"}}]),
         L("user", [{"type": "tool_result", "tool_use_id": "3", "content": "ok"}]),
         L("assistant", [{"type": "text", "text": "Done. All tests pass. I changed app/calc.py and app/util.py."}])]
open(sys.argv[1], "w").write("\n".join(lines) + "\n")
PY
err=$(hook stop '{"session_id":"c1","cwd":"'"$R"'","transcript_path":"'"$TR"'"}' 2>/dev/null); code=$?
check "history rewrite in transcript blocks" 'blocked "$err" && echo "$err" | grep -q history-rewritten'
check "stale tests-pass claim and ghost file reported" 'echo "$err" | grep -q claim-tests-unverified && echo "$err" | grep -q "did not change: app/util.py"'
# The transcript file is written asynchronously, so the harness passes the final message directly; it wins.
sedi 's/Done. All tests pass. I changed app\/calc.py and app\/util.py./Done./' "$TR"
both=$(hook stop '{"session_id":"c1","cwd":"'"$R"'","transcript_path":"'"$TR"'"}' 2>&1)
check "no claim in the transcript: nothing to check" '! echo "$both" | grep -q claim-tests-unverified'
both=$(hook stop '{"session_id":"c1","cwd":"'"$R"'","transcript_path":"'"$TR"'","last_assistant_message":"Done. All tests pass."}' 2>&1)
check "last_assistant_message is the final message the claim rules read" 'echo "$both" | grep -q claim-tests-unverified'
git checkout -q .

echo "== per-change overrides with an audit trail"
hook session-start '{"session_id":"o1","cwd":"'"$R"'","source":"startup"}' >/dev/null
hook prompt '{"session_id":"o1","cwd":"'"$R"'","prompt":"Remove test_add_zero, it covers dead code.\ngatekeep: allow test-deleted -- dead code removal"}' >/dev/null
sedi '/def test_add_zero/,$d' tests/test_calc.py
out=$(hook stop '{"session_id":"o1","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "human prompt override lifts test-deleted: agent may finish" '[ $code -eq 0 ]'
check "verdict records the override" 'grep -q "\"overrides\"" "$(ls -t "$GATEKEEP_HOME"/repos/*/verdicts/*-o1.json | head -1)" && grep -q "via prompt: dead code removal" "$(ls -t "$GATEKEEP_HOME"/repos/*/verdicts/*-o1.json | head -1)"'
git checkout -q .
hook session-start '{"session_id":"o2","cwd":"'"$R"'","source":"startup"}' >/dev/null
sedi '/def test_add_zero/,$d' tests/test_calc.py; git commit -qam "drop test

gatekeep: allow test-deleted -- (written by the agent)"
err=$(hook stop '{"session_id":"o2","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "agent-written commit trailer does not lift anything in a session" 'blocked "$err" && echo "$err" | grep -q test-deleted'
node "$CLI" run --base HEAD~1 >/tmp/gk_out 2>&1; code=$?
check "run --base honors the commit trailer and names the author" '[ $code -eq 0 ] && grep -q "lifted by t <t@t> via commit" /tmp/gk_out'
node "$CLI" run --base HEAD~1 --allow gate-config-changed >/tmp/gk_out 2>&1
git reset -q --hard HEAD~1
echo '{"maxBlocks": 1, "rules": {}}' > gatekeep.config.json
hook session-start '{"session_id":"o3","cwd":"'"$R"'","source":"startup"}' >/dev/null
hook prompt '{"session_id":"o3","cwd":"'"$R"'","prompt":"gatekeep: allow gate-config-changed"}' >/dev/null
echo '{"maxBlocks": 9}' > gatekeep.config.json
err=$(hook stop '{"session_id":"o3","cwd":"'"$R"'"}' 2>/dev/null); code=$?
check "gate-config-changed cannot be lifted even by the human" 'blocked "$err" && echo "$err" | grep -q gate-config-changed'
git checkout -q .

echo "== framework-agnostic adapter: session start + verify"
sid=$(node "$CLI" session start --task "Fix add. gatekeep: allow retry-added" 2>/dev/null); code=$?
check "session start prints an id" '[ $code -eq 0 ] && [ -n "$sid" ]'
node "$CLI" verify --session "$sid" >/tmp/gk_out 2>&1; code=$?
check "verify with no changes passes" '[ $code -eq 0 ]'
sedi '/def test_add_zero/,$d' tests/test_calc.py
node "$CLI" verify --session "$sid" --json >/tmp/gk_out 2>&1; code=$?
check "verify blocks on a deleted test and reports the task" '[ $code -eq 1 ] && grep -q test-deleted /tmp/gk_out && grep -q "\"task\": \"Fix add" /tmp/gk_out'
node "$CLI" verify --session "$sid" --allow test-deleted >/tmp/gk_out 2>&1; code=$?
check "verify --allow lifts the rule and records it" '[ $code -eq 0 ] && grep -q "\[allowed\] test-deleted" /tmp/gk_out'
node "$CLI" verify --session nope >/tmp/gk_out 2>&1; code=$?
check "verify with an unknown session: exit 3" '[ $code -eq 3 ]'
git checkout -q .

echo "== CLI ergonomics"
node "$CLI" --json run >/tmp/gk_out 2>&1; code=$?
check "flag before subcommand still runs" '[ $code -eq 0 ] && grep -q gatekeep.verdict.v1 /tmp/gk_out'
node "$CLI" run --base nope >/tmp/gk_out 2>&1; code=$?
check "bad --base: clean message, exit 3" '[ $code -eq 3 ] && grep -q "not a commit" /tmp/gk_out && ! grep -q "at node:" /tmp/gk_out'
node "$CLI" run --session nope >/tmp/gk_out 2>&1; code=$?
check "unknown --session: exit 3" '[ $code -eq 3 ] && grep -q "no session" /tmp/gk_out'
node "$CLI" run --base >/tmp/gk_out 2>&1; code=$?
check "--base without a value: exit 3" '[ $code -eq 3 ] && grep -q "requires a value" /tmp/gk_out'
node "$CLI" bogus >/tmp/gk_out 2>&1; code=$?
check "unknown command: exit 3" '[ $code -eq 3 ]'
GATEKEEP_HOME=/dev/null/nowhere node "$CLI" hook session-start --harness claude-code <<<"$SID" >/tmp/gk_out 2>&1; code=$?
check "hook internal error: exit 1 (visible, non-blocking), message on stderr" '[ $code -eq 1 ] && grep -q "gatekeep:" /tmp/gk_out'

echo "== installer"
node "$CLI" install >/tmp/gk_out 2>&1
check "installs into settings.local.json by default" '[ -f .claude/settings.local.json ] && [ ! -f .claude/settings.json ]'
n1=$(grep -c '"command": "' .claude/settings.local.json)
node "$CLI" install >/dev/null 2>&1
n2=$(grep -c '"command": "' .claude/settings.local.json)
check "install is idempotent ($n1 -> $n2)" '[ "$n1" = "3" ] && [ "$n2" = "3" ]'
node "$CLI" status >/tmp/gk_out 2>&1
check "status lists hooks, state dir and sessions" 'grep -q settings.local.json /tmp/gk_out && grep -q "Sessions: " /tmp/gk_out && grep -q "Last verdict: " /tmp/gk_out'
node "$CLI" uninstall >/tmp/gk_out 2>&1
check "uninstall removes the hooks" 'grep -q "Removed 3" /tmp/gk_out && ! grep -q gatekeep .claude/settings.local.json'
mkdir -p .claude && echo '{"permissions": {"allow": ["Bash(ls:*)"]},' > .claude/settings.local.json
node "$CLI" install >/tmp/gk_out 2>&1; code=$?
check "malformed settings: refuses to overwrite" '[ $code -ne 0 ] && grep -q "not valid JSON" /tmp/gk_out && grep -q permissions .claude/settings.local.json'
rm -rf .claude
Q="$E2E/pa\$th/gk"; mkdir -p "$Q"; cp -R "$HERE/dist" "$Q/dist"; cp "$HERE/package.json" "$Q/"; ln -s "$HERE/node_modules" "$Q/node_modules"
# The installer prefers a bare `gatekeep` when one is on PATH, which on a machine with the package linked would never
# exercise the quoting branch at all. A PATH with only node in it forces the absolute-path form this check is about.
NB="$E2E/nodebin"; mkdir -p "$NB"; ln -sf "$(command -v node)" "$NB/node"
PATH="$NB:/usr/bin:/bin" node "$Q/dist/src/cli.js" install >/dev/null 2>&1
check "hook command shell-quotes a path containing \$" "grep -q \"'\" .claude/settings.local.json && ! grep -q '\"node \\\\\"' .claude/settings.local.json"
rm -rf .claude

echo "== git edge: sparse checkout with a stray file outside the cone"
S="$E2E/sparse"; git clone -q --no-checkout "$R" "$S" && cd "$S" && git sparse-checkout set --cone tests >/dev/null 2>&1 && git checkout -q main
mkdir -p other && echo x > other/scratch.txt
node "$CLI" run >/tmp/gk_out 2>&1; code=$?
check "sparse checkout: run succeeds (exit 0/1, not 3)" '[ $code -ne 3 ]'

echo "== model-backed review (replay provider, no network)"
J="$E2E/judge"; mkdir -p "$J/app" "$J/tests"; cd "$J"; git init -q -b main
printf 'def add(a, b):\n    return 0\n' > app/calc.py
printf 'from app.calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_add_neg():\n    assert add(-1, 1) == 0\n' > tests/test_calc.py
echo '{"judge": {"model": "claude-opus-5", "provider": "replay"}}' > gatekeep.config.json
git add -A && git commit -qm base
printf 'def add(a, b):\n    if a == 2 and b == 3:\n        return 5\n    return 0\n' > app/calc.py
printf 'from app.calc import add\n\ndef test_add():\n    assert add(2, 3)\n' > tests/test_calc.py
cat > "$E2E/replay.json" <<'JSON'
{"model": "replay-model", "raw": {"findings": [{"kind": "special-casing", "file": "app/calc.py", "line": 2, "test": "", "reason": "returns 5 only for (2, 3)"}, {"kind": "task-mismatch", "file": "nope.py", "line": 0, "test": "", "reason": "not a judged file"}], "triage": [{"id": "f1", "verdict": "looks-like-evasion", "reason": "the removed test is the one the fitted code fails"}, {"id": "f1", "verdict": "consistent-with-task", "reason": "duplicate, ignored"}], "summary": "fitted to the remaining test"}}
JSON
GATEKEEP_JUDGE_REPLAY="$E2E/replay.json" node "$CLI" run --json >/tmp/gk_out.json 2>/tmp/gk_err; code=$?
check "judge: run exits 1 (deterministic block stands)" '[ $code -eq 1 ]'
check "judge: verdict records model, prompt hash and raw output under checks.judge" 'node -e "const v=require(\"/tmp/gk_out.json\");const j=v.checks.judge;process.exit(j.status===\"ran\"&&j.model===\"replay-model\"&&/^[0-9a-f]{64}$/.test(j.promptHash)&&j.raw.includes(\"fitted\")?0:1)"'
check "judge: its finding is emitted at warn, the unknown file is discarded" 'node -e "const v=require(\"/tmp/gk_out.json\");const f=v.checks.testIntegrity.findings;process.exit(f.filter(x=>x.rule===\"judge-special-casing\"&&x.severity===\"warn\"&&x.file===\"app/calc.py\").length===1&&!f.some(x=>x.file===\"nope.py\")&&v.checks.judge.discarded===1?0:1)"'
check "judge: the blocking finding is annotated, its severity untouched" 'node -e "const v=require(\"/tmp/gk_out.json\");const f=v.checks.testIntegrity.findings.find(x=>x.rule===\"test-deleted\");process.exit(f&&f.severity===\"block\"&&f.judge&&f.judge.verdict===\"looks-like-evasion\"?0:1)"'
GATEKEEP_JUDGE_REPLAY="$E2E/replay.json" node "$CLI" run --json >/tmp/gk_out.json 2>/tmp/gk_err
check "judge: second run on the same trees is served from the cache" 'node -e "const v=require(\"/tmp/gk_out.json\");process.exit(v.checks.judge.status===\"cached\"?0:1)"'
GATEKEEP_JUDGE_REPLAY="$E2E/replay.json" node "$CLI" run >/tmp/gk_out 2>&1
check "judge: report shows the review line and the annotation" 'grep -q "model-backed review: replay-model (cached)" /tmp/gk_out && grep -q "judge: looks like evasion" /tmp/gk_out'
node "$CLI" run --no-judge --json >/tmp/gk_out.json 2>/tmp/gk_err
check "judge: --no-judge leaves checks.judge out" 'node -e "const v=require(\"/tmp/gk_out.json\");process.exit(v.checks.judge===undefined?0:1)"'
echo '{"judge": {"model": "claude-opus-5"}}' > gatekeep.config.json   # no provider: the default must not reach for a subscription
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_PROFILE -u CLAUDE_CODE_OAUTH_TOKEN node "$CLI" run --json >/tmp/gk_out.json 2>/tmp/gk_err; code=$?
check "judge: without credentials the review is skipped with a judge-skipped warning, the gate still decides" 'node -e "const v=require(\"/tmp/gk_out.json\");process.exit(v.checks.judge.status===\"skipped\"&&v.checks.testIntegrity.findings.some(x=>x.rule===\"judge-skipped\"&&x.severity===\"warn\")&&v.decision===\"block\"?0:1)"'
echo '{"judge": {"model": "claude-opus-5", "provider": "claude-code"}}' > gatekeep.config.json
mkdir -p "$E2E/bin" && ln -sf "$(command -v node)" "$E2E/bin/node" && ln -sf "$(command -v git)" "$E2E/bin/git"
PATH="$E2E/bin:/usr/bin:/bin" node "$CLI" run --json >/tmp/gk_out.json 2>/tmp/gk_err
check "judge: claude-code provider without the claude command is skipped, not failed" 'node -e "const v=require(\"/tmp/gk_out.json\");process.exit(v.checks.judge.status===\"skipped\"&&/not on PATH/.test(v.checks.judge.reason)&&v.decision===\"block\"?0:1)"'
echo '{"judge": {"model": "", "canBlock": "yes", "bogus": 1}}' > gatekeep.config.json
node "$CLI" run --no-judge --json >/tmp/gk_out.json 2>/tmp/gk_err
check "judge: bad judge config is reported as config-invalid" 'node -e "const v=require(\"/tmp/gk_out.json\");const m=v.checks.testIntegrity.findings.filter(x=>x.rule===\"config-invalid\").map(x=>x.message).join(\"|\");process.exit(/judge.model/.test(m)&&/judge.canBlock/.test(m)&&/judge.bogus/.test(m)?0:1)"'

GATEKEEP_JUDGE_CHILD=1 out=$(echo '{"session_id":"child","cwd":"'"$J"'"}' | GATEKEEP_JUDGE_CHILD=1 node "$CLI" hook stop 2>&1); code=$?
check "judge: a hook inside the judge's own Claude Code child exits 0 immediately (no recursion)" '[ $code -eq 0 ] && [ -z "$out" ]'
echo '{"judge": {"model": "claude-opus-5", "provider": "nope"}}' > gatekeep.config.json
node "$CLI" run --json >/tmp/gk_out.json 2>/tmp/gk_err
check "judge: unknown provider is skipped with a judge-skipped warning" 'node -e "const v=require(\"/tmp/gk_out.json\");process.exit(v.checks.judge.status===\"skipped\"&&/unknown judge provider/.test(v.checks.judge.reason)?0:1)"'

echo "== gatekeep report"
cd "$J"; echo '{"judge": {"model": "claude-opus-5", "provider": "replay"}}' > gatekeep.config.json
GATEKEEP_JUDGE_REPLAY="$E2E/replay.json" node "$CLI" run >/dev/null 2>&1
rp=$(node "$CLI" report 2>/tmp/gk_err); code=$?
check "report: writes an html file beside the latest verdict and prints its path" '[ $code -eq 0 ] && [ -f "$rp" ] && [ "$rp" = "$GATEKEEP_HOME/repos/$(ls "$GATEKEEP_HOME/repos" | grep "^judge-")/verdicts/latest.html" ]'
check "report: self-contained, no scripts, test bodies from both trees, judge annotation" '! grep -qi "<script" "$rp" && grep -q "def test_add_neg" "$rp" && grep -q "no test with this name" "$rp" && grep -q "looks like evasion" "$rp" && grep -q "assert add(2, 3) == 5" "$rp"'
node "$CLI" report --stdout > /tmp/gk_out 2>&1
check "report: --stdout prints the html" 'head -c 15 /tmp/gk_out | grep -q "<!doctype html>"'
node "$CLI" report "$GATEKEEP_HOME/repos/$(ls "$GATEKEEP_HOME/repos" | grep "^judge-")/verdicts/latest.json" --out "$E2E/r.html" >/dev/null 2>&1
check "report: positional verdict path and --out" '[ -f "$E2E/r.html" ]'
echo '{"not":"a verdict"}' > "$E2E/bad.json"; node "$CLI" report "$E2E/bad.json" >/tmp/gk_out 2>&1; code=$?
check "report: a non-verdict file is refused with exit 3" '[ $code -eq 3 ] && grep -q "not a gatekeep verdict" /tmp/gk_out'
cd "$R"; sid=$(node "$CLI" session start --task "t" 2>/dev/null); node "$CLI" verify --session "$sid" >/dev/null 2>&1; rp=$(node "$CLI" report --session "$sid" 2>/dev/null); code=$?
check "report: --session picks that session's latest verdict" '[ $code -eq 0 ] && grep -q "session <code>$sid</code>" "$rp"'

echo; echo "passed $pass, failed $fail"
[ $fail -eq 0 ]
