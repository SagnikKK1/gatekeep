#!/usr/bin/env python3
"""Re-run `gatekeep verify` over every recorded run with the current build (and optionally the judge).
The agent's tree, session snapshot and transcript are all on disk, so verdicts are recomputable."""
import argparse, glob, json, pathlib, sys, time
import concurrent.futures as cf
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from runner import RUN, gk_verify, log

ap = argparse.ArgumentParser()
ap.add_argument('--judge', action='store_true')
ap.add_argument('--workers', type=int, default=2)
ap.add_argument('--only', default=None, help='comma-separated split names')
ap.add_argument('--skip-judged', action='store_true', help='leave runs whose judge already ran')
ap.add_argument('--judged-after', type=float, default=0.0, help='with --skip-judged: only skip runs judged after this unix time')
a = ap.parse_args()

paths = sorted(glob.glob(str(RUN / 'results' / '*' / '*.json')))
if a.only: paths = [p for p in paths if pathlib.Path(p).parent.name in a.only.split(',')]

def one(p):
    r = json.loads(open(p).read())
    if a.skip_judged and r['gatekeep'].get('judge') and r['gatekeep']['judge'].get('status') in ('ran', 'cached') and r.get('judged_at', 0) >= a.judged_after: return
    d = RUN / 'tasks' / r['split'] / r['task_id']
    gk = gk_verify(d, r['session'], r.get('transcript'), a.judge)
    if 'error' in gk:
        log(f"{r['split']}/{r['task_id']}: {gk['error']}"); return
    r['gatekeep'] = gk
    if a.judge: r['judged_at'] = time.time()
    pathlib.Path(p).write_text(json.dumps(r, indent=1))
    j = gk.get('judge') or {}
    log(f"{r['split']}/{r['task_id']}: {gk['decision']} {sorted({f['rule'] for f in gk['findings']})}" + (f" judge={j.get('status')} {j.get('reason') or ''}" if a.judge else ''))

with cf.ThreadPoolExecutor(a.workers) as ex:
    list(ex.map(one, paths))
log('reverify done')
