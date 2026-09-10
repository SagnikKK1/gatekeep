import { git, diffTrees, lsTree, resolveTree, BlobBatch, NO_INDEX } from './git.js';
import { analyze, isTestFile, needsContent } from './rules.js';
import { langFor } from './lang.js';
import { decide } from './verdict.js';
/**
 * Replays real commit history through the deterministic rules: for each commit, diff it against its parent and ask
 * the gate what it would have said.
 *
 * This is the one replay implementation. `gatekeep calibrate` runs it on the user's own repository to show them the
 * cost before the gate ever blocks anything, and `scripts/corpus-fp.mjs` runs it across the research corpora. They
 * used to be separate loops, which meant the false-positive rate we measured and published was not quite the rate a
 * user experiences: the corpus loop fed the oracle rule a different set of base test files, loaded contents for
 * every changed path rather than the ones the rules read, and told every rule that no path in the repository
 * exists, so first-party imports looked like third-party packages. What runs here is what the gate does.
 *
 * What a replay cannot cover, and callers must say so rather than let silence imply coverage: the original-tests
 * lane (it runs the suite, once per commit is not affordable and the historical suite is not the user's), the
 * claims family (no live session, so no agent to have claimed anything) and the model-backed judge.
 */
/** Test files as they stood in the base tree. Shared with the live gate in `src/cli.ts` so the two cannot drift. */
const BASE_TESTS_MAX_FILES = 400, BASE_TESTS_MAX_BYTES = 4 * 1024 * 1024;
export async function baseTestFiles(root, base, cfg, changes, known) {
    const out = new Map();
    if (!changes.some((c) => !isTestFile(c.path, cfg.rules) && langFor(c.path) !== null))
        return out; // no source changed
    let paths;
    if (known)
        paths = known;
    else {
        try {
            paths = await lsTree(root, base);
        }
        catch {
            return out;
        }
    }
    const inDiff = new Set(changes.filter((c) => isTestFile(c.path, cfg.rules)).map((c) => c.path));
    const want = paths.filter((p) => isTestFile(p, cfg.rules) && !inDiff.has(p)).slice(0, BASE_TESTS_MAX_FILES);
    if (want.length === 0)
        return out;
    const batch = new BlobBatch(root);
    try {
        let bytes = 0;
        for (const p of want) {
            const b = await batch.read(base, p).catch(() => null);
            if (!b || b.length > 512 * 1024 || b.subarray(0, 8000).includes(0))
                continue;
            bytes += b.length;
            if (bytes > BASE_TESTS_MAX_BYTES)
                break;
            out.set(p, b.toString('utf8'));
        }
    }
    finally {
        batch.close();
    }
    return out;
}
function emptyTotals() {
    return { commits: 0, skipped: 0, commitsTouchingTests: 0, commitsWithFindings: 0, commitsWithBlocks: 0, blockingCommitsTouchingTests: 0, findings: 0, findingsByRule: {}, blockingFindingsByRule: {}, blockingCommitsByRule: {} };
}
const SEP = '\x1f';
/**
 * A first-parent walk visits each commit's parent as the next commit, so `ls-tree` output is reused rather than
 * re-read: without this every commit costs two full tree listings instead of one.
 */
class TreePaths {
    root;
    cache = new Map();
    constructor(root) {
        this.root = root;
    }
    async of(tree) {
        const hit = this.cache.get(tree);
        if (hit)
            return hit;
        let paths;
        try {
            paths = await lsTree(this.root, tree);
        }
        catch {
            paths = [];
        }
        if (this.cache.size >= 3)
            this.cache.delete(this.cache.keys().next().value);
        this.cache.set(tree, paths);
        return paths;
    }
}
export async function replay(root, cfg, opts) {
    const totals = emptyTotals();
    const log = await git(root, ['log', '--first-parent', '-n', String(opts.n), `--format=%H${SEP}%s${SEP}%aI`, 'HEAD'], NO_INDEX).catch(() => '');
    const commits = log.split('\n').filter(Boolean).map((l) => { const [sha, subject, date] = l.split(SEP); return { sha: sha, subject: subject ?? '', date: date ?? '' }; });
    const trees = new TreePaths(root);
    for (const { sha, subject, date } of commits) {
        let tree, ptree;
        try {
            tree = await resolveTree(root, sha);
            ptree = await resolveTree(root, `${sha}^`);
        }
        catch {
            totals.skipped++;
            opts.onProgress?.(totals.commits + totals.skipped, commits.length);
            continue;
        }
        const changes = await diffTrees(root, ptree, tree, { shouldLoad: (p) => needsContent(p, cfg.rules), maxBytes: 2 * 1024 * 1024 });
        const touchesTests = changes.some((c) => isTestFile(c.path, cfg.rules) || (c.oldPath !== undefined && isTestFile(c.oldPath, cfg.rules)));
        // `exists` answers "is this import a module in this repository?", which the live gate reads off the working
        // tree — the state after the change. Its historical equivalent is the commit's own tree, not its parent's.
        const after = new Set(await trees.of(tree));
        const result = await analyze(changes, cfg.rules, {
            exists: (p) => after.has(p),
            sessionMode: true,
            baseTestFiles: await baseTestFiles(root, ptree, cfg, changes, await trees.of(ptree)),
        });
        const findings = result.findings;
        const decision = decide(findings, cfg.strict);
        totals.commits++;
        if (touchesTests)
            totals.commitsTouchingTests++;
        if (findings.length)
            totals.commitsWithFindings++;
        if (decision === 'block') {
            totals.commitsWithBlocks++;
            if (touchesTests)
                totals.blockingCommitsTouchingTests++;
        }
        totals.findings += findings.length;
        for (const f of findings) {
            totals.findingsByRule[f.rule] = (totals.findingsByRule[f.rule] ?? 0) + 1;
            if (f.severity === 'block')
                totals.blockingFindingsByRule[f.rule] = (totals.blockingFindingsByRule[f.rule] ?? 0) + 1;
        }
        // Credited to the rules that could have caused the interruption on their own: blocking findings always, and
        // warnings too under `strict`, where a warning ends the session exactly as a block does.
        if (decision === 'block') {
            const deciding = new Set(findings.filter((f) => f.severity === 'block' || cfg.strict).map((f) => f.rule));
            for (const rule of deciding)
                totals.blockingCommitsByRule[rule] = (totals.blockingCommitsByRule[rule] ?? 0) + 1;
        }
        opts.onCommit?.({ sha, subject, date, changedFiles: changes.length, touchesTests, findings, decision });
        opts.onProgress?.(totals.commits + totals.skipped, commits.length);
    }
    return totals;
}
//# sourceMappingURL=replay.js.map