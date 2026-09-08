import type { FileChange, Finding, Severity } from './model.js';
import { langFor, matchesAny } from './lang.js';

/**
 * Roadmap item 2: agents weaken whatever grades them. These rules look at the non-test side of the diff for edits
 * that reduce what a check can catch. Same shape as the test rules: before/after text, deterministic, no model.
 */

export const CI_GLOBS = ['.github/workflows/*.{yml,yaml}', '.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines*.{yml,yaml}', 'Jenkinsfile', '.travis.yml', 'bitbucket-pipelines.yml', '.buildkite/*.{yml,yaml}', '.drone.yml'];
export const LINT_CONFIG_GLOBS = ['**/tsconfig*.json', '**/jsconfig.json', '**/.eslintrc', '**/.eslintrc.*', '**/eslint.config.*', '**/.flake8', '**/mypy.ini', '**/.mypy.ini', '**/pyrightconfig.json', '**/ruff.toml', '**/.ruff.toml', '**/.pylintrc', '**/pylintrc', '**/biome.json', '**/.eslintignore', '**/.stylelintrc*', '**/pyproject.toml', '**/setup.cfg', '**/tox.ini'];
export const HOOK_GLOBS = ['.pre-commit-config.yaml', '.pre-commit-config.yml', '.husky/**', '**/lefthook.yml', '**/.lefthook.yml', '.githooks/**', 'package.json', 'lint-staged.config.*', '.lintstagedrc*'];
export const SNAPSHOT_GLOBS = ['**/*.snap', '**/__snapshots__/**', '**/*.snap.*', '**/snapshots/**'];
export const INTEGRITY_GLOBS = [...CI_GLOBS, ...LINT_CONFIG_GLOBS, ...HOOK_GLOBS, ...SNAPSHOT_GLOBS];

export const INTEGRITY_SEVERITIES: Record<string, Severity> = {
  'suppression-added': 'warn',
  'ci-weakened': 'block',
  'ci-check-removed': 'block',
  'lint-config-loosened': 'warn',
  'hooks-removed': 'block',
  'snapshots-regenerated': 'warn',
  'error-swallowing-added': 'warn',
  'validation-removed': 'warn',
};

const SUPPRESSION = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore|#\s*noqa|#\s*type:\s*ignore|#\s*pylint:\s*disable|#\s*pyright:\s*ignore|#\s*mypy:\s*ignore|#\s*nosec|#\s*pragma:\s*no\s*cover|\/\*\s*istanbul ignore|\/\*\s*c8 ignore|\/\*\s*v8 ignore|#\[allow\(|@SuppressWarnings|\/\/\s*nolint|#\s*ruff:\s*noqa|#\s*flake8:\s*noqa|rubocop:disable|@SuppressLint|#\s*nosemgrep/;
const FILE_LEVEL_SUPPRESSION = /@ts-nocheck|^\/\*\s*eslint-disable\s*\*\/|^\/\/\s*eslint-disable\s*$|^#\s*(flake8|ruff):\s*noqa\s*$|^#\s*type:\s*ignore\s*$|^#\s*pylint:\s*(skip-file|disable-all)|^#\s*mypy:\s*ignore-errors/;
function stripSuppression(l: string): string {
  return l.replace(/\s*(#|\/\/)\s*(noqa|type:\s*ignore|pylint:|pyright:|mypy:|nosec|pragma:|ruff:|flake8:|eslint-disable|@ts-|nolint|nosemgrep|biome-ignore)[^\n]*$/i, '').replace(/\s*\/\*\s*(istanbul|c8|v8) ignore[^*]*\*\/\s*/i, ' ').trim();
}
const CI_WEAKEN = /continue-on-error:\s*true|allow_failure:\s*true|allow-failure:\s*true|soft_fail|\|\|\s*true\b|\|\|\s*exit\s+0\b|;\s*true\s*$|if:\s*(\$\{\{\s*)?false|--no-verify\b|\bset\s+\+e\b|ignore_errors:\s*true/;
const CI_CHECK_STEP = /\b(pytest|jest|vitest|mocha|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|go\s+test|cargo\s+test|mvn\s+(test|verify)|gradle\w*\s+(test|check)|eslint|tsc\b|mypy|pyright|ruff\s+check|flake8|pylint|bandit|semgrep|codeql|trivy|snyk|npm\s+audit|pre-commit\s+run|tox\b|nox\b|make\s+(test|lint|check)|dotnet\s+test|phpunit|rspec|rubocop|golangci-lint|shellcheck)\b/;
const CI_CHECK_STEP_G = new RegExp(CI_CHECK_STEP.source, 'g');
const GENERIC_RUNNER = /^(npm (run )?test|yarn test|pnpm test|make (test|check)|tox|nox|pre-commit run|bun test|deno test)$/;
const TEST_RUNNER = /^(pytest|jest|vitest|mocha|go test|cargo test|mvn (test|verify)|gradle\w* (test|check)|dotnet test|phpunit|rspec|npm (run )?test|yarn test|pnpm test|make test|tox|nox|bun test|deno test)$/;
const TIMEOUT_KEY = /^\s*timeout(-minutes|_minutes)?:\s*(\d+)/;

function lines(t: string | undefined): string[] { return (t ?? '').split('\n'); }
function lineSet(t: string | undefined): Set<string> { return new Set(lines(t).map((l) => l.trim()).filter(Boolean)); }
/** Lines added / removed between versions, order-insensitive, trimmed. */
function addedLines(c: FileChange): string[] { const b = lineSet(c.before); return lines(c.after).map((l) => l.trim()).filter((l) => l && !b.has(l)); }
function removedLines(c: FileChange): string[] { const a = lineSet(c.after); return lines(c.before).map((l) => l.trim()).filter((l) => l && !a.has(l)); }
function baseName(p: string): string { return p.split('/').pop() ?? ''; }

export function integrityFindings(changes: FileChange[], severities: Record<string, Severity>, isTest: (p: string) => boolean): Finding[] {
  const out: Finding[] = [];
  const sev = (rule: string): Severity => severities[rule] ?? INTEGRITY_SEVERITIES[rule] ?? 'warn';
  const emit = (f: Omit<Finding, 'severity'>) => { const s = sev(f.rule); if (s !== 'off') out.push({ ...f, severity: s }); };
  const sourceChanged = changes.some((c) => c.status !== 'D' && langFor(c.path) !== null && !isTest(c.path));

  // Snapshot mass regeneration
  const snaps = changes.filter((c) => matchesAny(c.path, SNAPSHOT_GLOBS) && c.status !== 'A');
  if (sourceChanged && snaps.length >= 3) emit({ rule: 'snapshots-regenerated', file: snaps[0]!.path, message: `${snaps.length} snapshot files rewritten alongside source changes; regenerated snapshots accept whatever the code now produces` });

  for (const c of changes) {
    const isSrc = langFor(c.path) !== null && !isTest(c.path);
    const added = c.after !== undefined ? addedLines(c) : [];
    const removed = c.before !== undefined ? removedLines(c) : [];

    // 1. Suppression directives in source (test files have their own rules)
    if (isSrc && c.after !== undefined) {
      const beforeSet = lineSet(c.before);
      const afterLines = lines(c.after).map((l) => l.trim());
      const afterSet = new Set(afterLines.filter(Boolean));
      const hits = added.filter((l) => SUPPRESSION.test(l)).filter((l) => {
        if (FILE_LEVEL_SUPPRESSION.test(l)) return true;               // whole-file opt-out
        const bare = stripSuppression(l);
        if (bare !== '') return beforeSet.has(bare) && !afterSet.has(bare); // existing code line, now suppressed
        // standalone directive: does it cover a line that existed before?
        const i = afterLines.indexOf(l);
        const next = afterLines.slice(i + 1).find((x) => x !== '');
        return next !== undefined && beforeSet.has(next);
      });
      if (hits.length > 0) emit({ rule: 'suppression-added', file: c.path, line: lineOf(c.after, hits[0]!), message: `${hits.length} check-suppression directive(s) added to existing code: ${hits.slice(0, 3).map((h) => h.slice(0, 80)).join(' | ')}` });
    }

    // 2. CI workflows
    if (matchesAny(c.path, CI_GLOBS) && !/(release|publish|deploy|docs|pages|changelog|label|stale|greet|welcome|dependabot|renovate)/i.test(baseName(c.path))) {
      const toolsBefore = checkTools(c.before), toolsAfter = checkTools(c.after);
      // tools still run somewhere: another CI file in the same change, or a generic runner (npm test, tox) that wraps them
      const elsewhere = new Set(changes.filter((o) => o !== c && matchesAny(o.path, CI_GLOBS)).flatMap((o) => [...checkTools(o.after)]));
      const wrapped = [...toolsAfter, ...elsewhere].some((t) => GENERIC_RUNNER.test(t));
      const stillRuns = (t: string) => toolsAfter.has(t) || elsewhere.has(t) || (wrapped && TEST_RUNNER.test(t)); // a generic runner plausibly wraps a test runner, never a linter or scanner
      if (c.status === 'D') { const gone = [...toolsBefore].filter((t) => !stillRuns(t)); if (gone.length > 0) emit({ rule: 'ci-check-removed', file: c.path, message: `CI workflow deleted (ran ${gone.join(', ')})` }); continue; }
      const weak = added.filter((l) => CI_WEAKEN.test(l) && !/^#/.test(l));
      if (weak.length > 0 && toolsAfter.size > 0) emit({ rule: 'ci-weakened', file: c.path, line: lineOf(c.after, weak[0]!), message: `CI made unable to fail: ${weak.slice(0, 3).map((h) => h.slice(0, 80)).join(' | ')}` });
      const gone = [...toolsBefore].filter((t) => !stillRuns(t));
      if (gone.length > 0) emit({ rule: 'ci-check-removed', file: c.path, message: `CI no longer runs ${gone.join(', ')}` });
      const tb = maxTimeout(c.before), ta = maxTimeout(c.after);
      if (tb !== null && ta !== null && ta > tb * 2 && toolsAfter.size > 0) emit({ rule: 'ci-weakened', file: c.path, message: `CI timeout raised from ${tb} to ${ta}` });
    }

    // 3. Linter / type-checker configuration
    if (matchesAny(c.path, LINT_CONFIG_GLOBS) && c.status !== 'A') {
      const loosened = lintLoosened(c, added, removed);
      if (loosened) emit({ rule: 'lint-config-loosened', file: c.path, message: `Checker configuration loosened: ${loosened}` });
    }

    // 4. Pre-commit / husky hooks
    if (matchesAny(c.path, HOOK_GLOBS)) {
      const b = baseName(c.path);
      if (b === 'package.json') {
        const gone = hooksRemovedFromPackageJson(c);
        if (gone) emit({ rule: 'hooks-removed', file: c.path, message: `Git hook configuration removed from package.json: ${gone}` });
      } else if (c.status === 'D') emit({ rule: 'hooks-removed', file: c.path, message: 'Git hook configuration deleted' });
      else if (c.status === 'M' || c.status === 'R') {
        if (c.path.startsWith('.husky/') || c.path.startsWith('.githooks/')) {
          if ((c.after ?? '').trim().split('\n').filter((l) => l.trim() && !l.startsWith('#')).length === 0 && (c.before ?? '').trim() !== '') emit({ rule: 'hooks-removed', file: c.path, message: 'Git hook emptied' });
        } else {
          const goneHooks = removed.filter((l) => /^-?\s*(id|repo|hooks?):/.test(l) || /^-\s*id:/.test(l)).length;
          const newHooks = added.filter((l) => /^-?\s*(id|repo):/.test(l)).length;
          if (goneHooks > newHooks && goneHooks > 0) emit({ rule: 'hooks-removed', file: c.path, message: `${goneHooks - newHooks} hook entr${goneHooks - newHooks === 1 ? 'y' : 'ies'} removed from ${b}` });
          const skipped = added.filter((l) => /^\s*(exclude|skip|stages):|SKIP=/.test(l));
          if (skipped.length > 0 && goneHooks <= newHooks) emit({ rule: 'hooks-removed', file: c.path, message: `Hook scope narrowed: ${skipped[0]!.slice(0, 80)}` });
        }
      }
    }

    // 5. Error swallowing and removed validation in changed source
    if (isSrc && c.status !== 'D' && c.after !== undefined) {
      const lang = langFor(c.path);
      const sw = swallowsAdded(c, lang === 'python');
      if (sw > 0) emit({ rule: 'error-swallowing-added', file: c.path, message: `${sw} new handler(s) that swallow errors silently (${lang === 'python' ? 'except ... pass' : 'empty catch'})` });
      const rv = validationRemoved(added, removed, lang === 'python', c.before ?? '');
      if (rv > 0) emit({ rule: 'validation-removed', file: c.path, message: `${rv} runtime check(s) removed (assert / invariant / guard that raised)` });
    }
  }
  return out;
}

function lineOf(text: string | undefined, trimmed: string): number | undefined {
  if (!text) return undefined;
  const i = text.split('\n').findIndex((l) => l.trim() === trimmed);
  return i >= 0 ? i + 1 : undefined;
}

/** Check tools a workflow invokes, from run/script lines and check-style actions. Matrix rows and comments do not count. */
function checkTools(text: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of lines(text)) {
    const l = raw.trim();
    if (/^#/.test(l)) continue;
    const isRun = /^-?\s*(run|script|command|cmd):/.test(l) || /^\s*(-\s+)?(npm|npx|yarn|pnpm|python|pytest|go|cargo|make|tox|nox|uv|poetry|pipx|mvn|gradle|dotnet|bundle|bun|deno)\b/.test(l);
    const isUses = /^-?\s*uses:\s*\S*(codeql-action\/(init|analyze)|super-linter|lint-action|golangci-lint-action|ruff-action|pre-commit\/action|reviewdog|trivy-action|snyk|semgrep-action|scorecard-action)/.test(l);
    if (!isRun && !isUses) continue;
    const m = l.match(CI_CHECK_STEP_G) ?? [];
    for (const t of m) out.add(t.replace(/\s+/g, ' ').toLowerCase());
    if (isUses) out.add((l.match(/(codeql|super-linter|lint-action|golangci-lint|ruff|pre-commit|reviewdog|trivy|snyk|semgrep|scorecard)/) ?? ['action'])[0]!);
  }
  return out;
}

function maxTimeout(text: string | undefined): number | null {
  let m: number | null = null;
  for (const l of lines(text)) { const x = TIMEOUT_KEY.exec(l); if (x) m = Math.max(m ?? 0, parseInt(x[2]!, 10)); }
  return m;
}

function lintLoosened(c: FileChange, added: string[], removed: string[]): string | null {
  const b = baseName(c.path);
  if (/^tsconfig.*\.json$|^jsconfig\.json$/.test(b)) {
    const STRICT = ['strict', 'noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization', 'noImplicitThis', 'alwaysStrict', 'noUnusedLocals', 'noUnusedParameters', 'noImplicitReturns', 'noFallthroughCasesInSwitch', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'useUnknownInCatchVariables', 'noImplicitOverride', 'noPropertyAccessFromIndexSignature'];
    const off = added.filter((l) => STRICT.some((k) => new RegExp(`"${k}"\\s*:\\s*false`).test(l)));
    if (off.length) return off[0]!.slice(0, 80);
    const wasOn = removed.filter((l) => STRICT.some((k) => new RegExp(`"${k}"\\s*:\\s*true`).test(l)) && !added.some((a) => a.split(':')[0] === l.split(':')[0]));
    if (wasOn.length) return `${wasOn[0]!.slice(0, 60)} removed`;
    const excl = added.filter((l) => /"exclude"\s*:|"ignoreDeprecations"/.test(l));
    if (excl.length && !removed.some((l) => /"exclude"\s*:/.test(l))) return excl[0]!.slice(0, 80);
    return null;
  }
  if (/eslint|biome|stylelint/.test(b)) {
    const off = added.filter((l) => /["']?[\w@/-]+["']?\s*:\s*(["']off["']|0(?!\d))/.test(l) || /ignorePatterns|"ignores"\s*:|\bignores:/.test(l));
    if (off.length) return off[0]!.slice(0, 80);
    return null;
  }
  if (b === '.eslintignore') return added.length > 0 ? `${added.length} ignore pattern(s) added` : null;
  // python checkers: pyproject/setup.cfg/mypy.ini/.flake8/ruff/pylintrc, looking only inside checker sections
  const sect = (t: string | undefined) => checkerSections(t ?? '', b);
  const sb = lineSet(sect(c.before)), sa = lineSet(sect(c.after));
  const addedS = [...sa].filter((l) => !sb.has(l)), removedS = [...sb].filter((l) => !sa.has(l));
  const LOOSEN = /^(ignore|extend-ignore|exclude|extend-exclude|per-file-ignores|disable|disable_error_code|ignore_missing_imports|ignore_errors|reportGeneralTypeIssues|reportMissingImports)\s*[=:]|^follow_imports\s*=\s*"?skip|^typeCheckingMode\s*[:=]\s*"?(basic|off)|^strict\s*=\s*false|^"?(ignore|exclude|extend-ignore|disable_error_code)"?\s*[=:]\s*\[/i;
  const STRICT = /^(strict|disallow_untyped_defs|warn_return_any|check_untyped_defs|no_implicit_optional|strict_optional|disallow_any_generics|warn_unused_ignores)\s*=\s*true/i;
  const py = addedS.filter((l) => LOOSEN.test(l));
  const wasStrict = removedS.filter((l) => STRICT.test(l) && !addedS.some((a) => a.split(/\s*=/)[0] === l.split(/\s*=/)[0]));
  if (py.length) return py[0]!.slice(0, 80);
  if (wasStrict.length) return `${wasStrict[0]!.slice(0, 60)} removed`;
  return null;
}

/** Text of the checker sections ([tool.mypy], [mypy], [tool.ruff], [flake8], ...) of an ini/toml file; whole file for dedicated configs. */
function checkerSections(text: string, base: string): string {
  if (!/^(pyproject\.toml|setup\.cfg|tox\.ini)$/.test(base)) return text;
  const out: string[] = [];
  let inside = false;
  for (const l of text.split('\n')) {
    const h = /^\s*\[([^\]]+)\]/.exec(l);
    if (h) { inside = /^(tool\.)?(mypy|pyright|ruff|pylint|flake8|pycodestyle|pydocstyle|bandit|black|isort)(\.|:|$)/.test(h[1]!.trim()); continue; }
    if (inside) out.push(l);
  }
  return out.join('\n');
}

function hooksRemovedFromPackageJson(c: FileChange): string | null {
  try {
    const b = JSON.parse(c.before ?? '{}') as Record<string, unknown>, a = JSON.parse(c.after ?? '{}') as Record<string, unknown>;
    for (const k of ['husky', 'lint-staged', 'pre-commit', 'simple-git-hooks', 'gitHooks']) if (b[k] !== undefined && a[k] === undefined) return `"${k}"`;
    const bs = (b.scripts ?? {}) as Record<string, string>, as = (a.scripts ?? {}) as Record<string, string>;
    for (const k of ['prepare', 'precommit', 'pre-commit', 'postinstall']) if (bs[k] && /husky|lefthook|simple-git-hooks|pre-commit/.test(bs[k]!) && !as[k]) return `scripts.${k} (${bs[k]})`;
    return null;
  } catch { return null; }
}

/** New silent handlers, counted on the added-line side. */
function swallowsAdded(c: FileChange, python: boolean): number {
  const before = countSwallows(c.before ?? '', python), after = countSwallows(c.after ?? '', python);
  return Math.max(0, after - before);
}

function countSwallows(text: string, python: boolean): number {
  const ls = text.split('\n');
  let n = 0;
  if (python) {
    for (let i = 0; i < ls.length; i++) {
      if (!/^\s*except(\s*:|\s+(Exception|BaseException)(\s+as\s+\w+)?\s*:)/.test(ls[i]!)) continue;
      const next = ls.slice(i + 1).find((l) => l.trim() !== '');
      if (next && /^\s*(pass|\.\.\.|continue|return(\s+None)?)\s*(#.*)?$/.test(next)) n++;
    }
    return n;
  }
  const t = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  n += (t.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) ?? []).length;
  n += (t.match(/\.catch\(\s*(\(\s*\w*\s*\)|\w+)?\s*=>\s*(\{\s*\}|undefined|null|0|false)\s*\)/g) ?? []).length;
  n += (t.match(/catch\s*(\([^)]*\))?\s*\{\s*return\s*;?\s*\}/g) ?? []).length;
  return n;
}

function validationRemoved(added: string[], removed: string[], python: boolean, before: string): number {
  const re = python
    ? /^(assert\s|raise\s+(ValueError|TypeError|AssertionError|RuntimeError|KeyError|ValidationError|PermissionError|\w*Error)\b|if\s+not\s+.*:\s*$)/
    : /\b(invariant|assert|console\.assert)\s*\(|throw\s+new\s+\w*(Error|Exception)\b|\.parse\(|\.assert\w*\(/;
  const gone = removed.filter((l) => re.test(l)).length;
  const came = added.filter((l) => re.test(l)).length;
  const net = Math.max(0, gone - came);
  if (net === 0) return 0;
  // one guard out of many is routine refactoring; two or more, or the only one the file had, is the pattern
  const beforeTotal = before.split('\n').filter((l) => re.test(l.trim())).length;
  return net >= 2 || beforeTotal <= 1 ? net : 0;
}
