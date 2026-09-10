/**
 * Picks the held-out false-positive corpus, mechanically, so the choice cannot be steered by the result.
 *
 * Every false-positive number gatekeep has published so far was measured on the seven repositories the rules were
 * narrowed against, which makes it a description of the narrowing rather than a result. This script draws a second
 * set under a rule fixed in advance, and prints why every candidate it skipped was skipped, so someone else can
 * check that the set was not shopped for.
 *
 *   node scripts/corpus-select.mjs > scripts/corpus.json
 *
 * The rule, in order, per language:
 *   1. GitHub search `language:<L> stars:>2000 archived:false fork:false pushed:>2026-03-01`, stars descending.
 *   2. Skip anything already in the tuning set, or the same owner as a tuning repo (a sibling project shares
 *      conventions, and shared conventions are what the rules were fitted to).
 *   3. Skip repositories over 500 MB. Tractability, stated up front rather than discovered halfway through.
 *   4. Skip anything carrying a teaching-content topic (awesome, tutorial, education, algorithms, book, roadmap,
 *      interview, and the rest of TEACHING_TOPICS below). A stars ranking is dominated by these and their commit
 *      histories are "add another entry", not the maintenance work gatekeep sits in front of.
 *   5. Skip anything with no package manifest for its language at the repository root. Same purpose, different
 *      angle: this corpus is meant to be software that ships, not a collection of files.
 *   6. Skip anything with fewer than 20 files that gatekeep's own `isTestFile` calls a test.
 *   7. Skip anything with fewer than 300 first-parent commits.
 *   8. Skip anything created after 2024-01-01. The claim being measured is a false-positive rate on *human*
 *      commits, and a repository younger than the agent-coding era cannot supply them.
 *   9. Take the first survivor.
 *
 * Nothing here looks at a finding. Selection finishes before the rules are ever run.
 *
 * **The rule was revised twice on 2026-09-10, and this is the disclosure.** Version one had only the test-file
 * filter and selected TheAlgorithms/Python and krahets/hello-algo, so filters 4 and 5 were added. Version two then
 * selected deepseek-ai/deepseek-harness, created three weeks earlier, and affaan-m/ECC, created in January, whose
 * commit history is plausibly agent-written; filter 8 was added. Both revisions happened before any rule had been
 * run against any candidate, and both changed the definition of the population on repository identity alone. No
 * gatekeep output existed yet that could have steered either one. Everything after this file was written is
 * measured once and reported as it came out.
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isTestFile, DEFAULT_RULE_CONFIG } from '../dist/src/rules.js';

const execFileP = promisify(execFile);

/** The corpus the rules were tuned against. Frozen: these are the tuning set and can never be the held-out set. */
const TUNING = [
  { repo: 'pallets/flask', lang: 'python' },
  { repo: 'expressjs/express', lang: 'javascript' },
  { repo: 'colinhacks/zod', lang: 'typescript' },
  { repo: 'spf13/cobra', lang: 'go' },
  { repo: 'clap-rs/clap', lang: 'rust' },
  { repo: 'google/gson', lang: 'java' },
  { repo: 'sinatra/sinatra', lang: 'ruby' },
];

const LANGS = ['python', 'javascript', 'typescript', 'go', 'java', 'rust', 'ruby'];
const QUERY = (l) => `language:${l} stars:>2000 archived:false fork:false pushed:>2026-03-01`;
const MAX_SIZE_KB = 500_000;
/** Topics that mark a repository as teaching content rather than maintained software. */
const TEACHING_TOPICS = new Set([
  'awesome', 'awesome-list', 'list', 'lists', 'tutorial', 'tutorials', 'education', 'educational', 'learning',
  'learn', 'book', 'books', 'ebook', 'algorithm', 'algorithms', 'data-structures', 'datastructures', 'leetcode',
  'interview', 'interview-questions', 'interview-practice', 'roadmap', 'cheatsheet', 'curriculum', 'course',
  'courses', 'study', 'guide', 'examples', 'example', 'demo', 'boilerplate', 'starter', 'template', 'documentation',
  'computer-science', 'coding-challenge', 'practice', 'exercises', 'katas',
]);
/** A package manifest at the repository root: the repository ships something. */
const MANIFESTS = {
  python: ['pyproject.toml', 'setup.py', 'setup.cfg'],
  javascript: ['package.json'],
  typescript: ['package.json'],
  go: ['go.mod'],
  java: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
  rust: ['Cargo.toml'],
  ruby: ['Gemfile', 'Rakefile'],
};
const MIN_TEST_FILES = 20;
const MIN_COMMITS = 300;
/** The corpus is meant to be human commits; a repository younger than the agent-coding era cannot supply them. */
const CREATED_BEFORE = '2024-01-01';

/**
 * Already-measured repositories, read from the corpus manifest this script last wrote rather than pasted in, so
 * running it again always draws a set that has not been looked at.
 *
 * **Revised 2026-09-10, third revision, and this is the disclosure.** The script excluded only the tuning set, so a
 * second run would have re-drawn the same held-out repositories. Every set it has already produced is now excluded
 * as well, on the same terms as the tuning set: the repository, and its owner. This revision changes the population
 * on repository identity alone and was made before the new set was drawn or any rule run against it. Its purpose is
 * the standing constraint that a rule narrowed after looking at a corpus cannot be measured on that corpus again:
 * `test-oracle-in-source` was fixed against the held-out set's false positives, so the held-out set is now a second
 * tuning set and a number from it would describe the narrowing.
 */
function alreadyMeasured() {
  try {
    const m = JSON.parse(fs.readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));
    return [...(m.holdout ?? []), ...(m.tuning ?? [])].map((r) => r.repo).filter(Boolean);
  } catch { return []; }
}

const EXCLUDED = [...TUNING.map((t) => t.repo), ...alreadyMeasured()];
const tuningRepos = new Set(EXCLUDED.map((r) => r.toLowerCase()));
const tuningOwners = new Set(EXCLUDED.map((r) => r.split('/')[0].toLowerCase()));

async function gh(args) {
  const { stdout } = await execFileP('gh', args, { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/**
 * One tree read answers both questions: how many files gatekeep would treat as tests, and whether a package
 * manifest sits at the root. Truncated trees give a lower bound, which is all the test threshold needs; a manifest
 * is at depth 0 and is never the part that gets truncated.
 */
async function treeFacts(full, lang) {
  let tree;
  try { tree = await gh(['api', `repos/${full}/git/trees/HEAD?recursive=1`]); } catch { return null; }
  const blobs = (tree.tree ?? []).filter((e) => e.type === 'blob');
  const roots = new Set(blobs.map((e) => e.path).filter((p) => !p.includes('/')));
  return {
    count: blobs.filter((e) => isTestFile(e.path, DEFAULT_RULE_CONFIG)).length,
    truncated: tree.truncated === true,
    manifest: (MANIFESTS[lang] ?? []).find((m) => roots.has(m)) ?? null,
  };
}

/** First-parent depth, without cloning: walk the commits endpoint until we have enough or run out. */
async function firstParentCommits(full, want) {
  let sha = null, seen = 0;
  for (let page = 0; page < 12 && seen < want; page++) {
    const q = sha ? `repos/${full}/commits?per_page=100&sha=${sha}` : `repos/${full}/commits?per_page=100`;
    let batch;
    try { batch = await gh(['api', q]); } catch { break; }
    if (!Array.isArray(batch) || batch.length === 0) break;
    // Follow the first parent only, the same walk `git rev-list --first-parent` does.
    for (const c of batch) { seen++; sha = c.parents?.[0]?.sha ?? null; if (!sha) break; }
    if (!sha) break;
  }
  return seen;
}

const picked = [];
const rejected = [];

for (const lang of LANGS) {
  const search = await gh(['api', '-X', 'GET', 'search/repositories', '-f', `q=${QUERY(lang)}`, '-f', 'sort=stars', '-f', 'order=desc', '-f', 'per_page=40']);
  let chosen = null;
  for (const item of search.items ?? []) {
    const full = item.full_name;
    const owner = full.split('/')[0].toLowerCase();
    const note = (reason) => rejected.push({ lang, repo: full, stars: item.stargazers_count, reason });

    if (tuningRepos.has(full.toLowerCase())) { note('in the tuning set'); continue; }
    if (tuningOwners.has(owner)) { note(`same owner as a tuning repo (${owner})`); continue; }
    if (item.size > MAX_SIZE_KB) { note(`${Math.round(item.size / 1024)} MB, over the ${MAX_SIZE_KB / 1000} MB cap`); continue; }

    const topics = (item.topics ?? []).map((t) => t.toLowerCase());
    const teaching = topics.filter((t) => TEACHING_TOPICS.has(t));
    if (teaching.length) { note(`teaching-content topics: ${teaching.join(', ')}`); continue; }

    const tf = await treeFacts(full, lang);
    if (tf === null) { note('tree could not be read'); continue; }
    if (!tf.manifest) { note(`no ${lang} package manifest at the root`); continue; }
    if (tf.count < MIN_TEST_FILES) { note(`${tf.count} test files, under ${MIN_TEST_FILES}`); continue; }

    if (item.created_at >= CREATED_BEFORE) { note(`created ${item.created_at.slice(0, 10)}, after ${CREATED_BEFORE}`); continue; }

    const commits = await firstParentCommits(full, MIN_COMMITS);
    if (commits < MIN_COMMITS) { note(`${commits} first-parent commits, under ${MIN_COMMITS}`); continue; }

    chosen = { lang, repo: full, stars: item.stargazers_count, createdAt: item.created_at.slice(0, 10), sizeKb: item.size, manifest: tf.manifest, testFiles: tf.count, testFilesTruncated: tf.truncated, url: item.clone_url, defaultBranch: item.default_branch };
    break;
  }
  if (!chosen) throw new Error(`no candidate passed for ${lang}`);
  picked.push(chosen);
  process.stderr.write(`${lang}: ${chosen.repo} (${chosen.testFiles} test files)\n`);
}

console.log(JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  rule: {
    query: 'language:<L> stars:>2000 archived:false fork:false pushed:>2026-03-01, stars descending',
    filters: [`not in the tuning set and not the same owner`, `size <= ${MAX_SIZE_KB} KB`, 'no teaching-content topic', 'a package manifest for the language at the repository root', `>= ${MIN_TEST_FILES} files matching gatekeep's own isTestFile`, `>= ${MIN_COMMITS} first-parent commits`, `created before ${CREATED_BEFORE}`],
    note: 'Selection is blind to gatekeep findings: no rule is run until after this file is written.',
    revision: 'Revised twice on 2026-09-10, both times before any rule had been run. (1) Teaching-topic and package-manifest filters added after version one selected TheAlgorithms/Python and krahets/hello-algo. (2) The created-before filter added after version two selected deepseek-ai/deepseek-harness (three weeks old) and affaan-m/ECC (January 2026), whose histories are plausibly agent-written. Repository identity drove both; no finding existed yet.',
  },
  tuning: TUNING,
  holdout: picked,
  rejected,
}, null, 2));
