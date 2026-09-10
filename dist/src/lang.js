import path from 'node:path';
export function langFor(file) {
    const ext = path.extname(file).toLowerCase();
    switch (ext) {
        case '.py':
        case '.pyi': return 'python';
        case '.js':
        case '.mjs':
        case '.cjs':
        case '.jsx': return 'javascript';
        case '.ts':
        case '.mts':
        case '.cts': return 'typescript';
        case '.tsx': return 'tsx';
        case '.go': return 'go';
        case '.rs': return 'rust';
        case '.java': return 'java';
        case '.rb': return 'ruby';
        default: return null;
    }
}
const globCache = new Map();
/** Convert a glob (supports **, *, ?, {a,b}) to a RegExp matching whole POSIX paths. */
export function globToRegExp(glob) {
    const cached = globCache.get(glob);
    if (cached)
        return cached;
    let re = '';
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 3;
                }
                else {
                    re += '.*';
                    i += 2;
                }
            }
            else {
                re += '[^/]*';
                i++;
            }
        }
        else if (c === '?') {
            re += '[^/]';
            i++;
        }
        else if (c === '{') {
            const end = glob.indexOf('}', i);
            if (end === -1) {
                re += '\\{';
                i++;
                continue;
            }
            const alts = glob.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&'));
            re += '(?:' + alts.join('|') + ')';
            i = end + 1;
        }
        else {
            re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
            i++;
        }
    }
    const out = new RegExp('^' + re + '$');
    globCache.set(glob, out);
    return out;
}
/**
 * Directories that sit inside a test tree but hold inputs rather than tests: compiler cases, golden files, table data.
 * They match the test globs by position and would otherwise be parsed as test files — react alone has 3,630 under
 * `__tests__/fixtures/`. They stay visible to the source rules; they are just not tests. A conventional
 * `tests/fixtures/` is deliberately not here: deleting a data file a suite loads is still worth reporting, and the
 * support-file rule already covers it without treating the file as a test.
 */
/**
 * Fixture data is an input to a test suite, not a test suite. Files here are never run, so treating them as tests
 * means every deliberately-broken sample in them reads as a weakened test. This excludes them from the test family
 * only; the scope and integrity rules still scan them, so a secret or a typosquat hidden under `fixtures/` is
 * still caught.
 */
export const TEST_FIXTURE_GLOBS = ['**/__tests__/fixtures/**', '**/__fixtures__/**', '**/testdata/**'];
export const DEFAULT_TEST_GLOBS = [
    '**/test_*.py', '**/*_test.py', '**/tests/**/*.py', '**/test/**/*.py',
    '**/*.test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/*.spec.{js,jsx,ts,tsx,mjs,cjs,mts,cts}',
    '**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs}', '**/test/**/*.{js,jsx,ts,tsx,mjs,cjs}', '**/tests/**/*.{js,jsx,ts,tsx,mjs,cjs}', '**/spec/**/*.{js,jsx,ts,tsx,mjs,cjs}',
    '**/*_test.go',
    '**/tests/**/*.rs', '**/benches/**/*.rs',
    '**/src/test/**/*.java', '**/*Test.java', '**/*Tests.java', '**/*IT.java', '**/Test*.java',
    '**/spec/**/*_spec.rb', '**/test/**/*_test.rb', '**/test_*.rb',
];
export const DEFAULT_TEST_CONFIG_GLOBS = [
    '**/pytest.ini', '**/tox.ini', '**/setup.cfg', '**/pyproject.toml', '**/conftest.py',
    '**/jest.config.{js,cjs,mjs,ts,json}', '**/vitest.config.{js,cjs,mjs,ts,mts}', '**/vitest.workspace.*',
    '**/.mocharc*', '**/karma.conf.*', '**/playwright.config.*', '**/cypress.config.*',
    '**/package.json', '**/.nycrc*', '**/.c8rc*', '**/codecov.yml', '**/.coveragerc',
];
export function matchesAny(file, globs) {
    const p = file.replace(/\\/g, '/');
    return globs.some((g) => globToRegExp(g).test(p));
}
/** Candidate dotted module names for a python source file path. */
export function pythonModuleCandidates(file) {
    const p = file.replace(/\\/g, '/').replace(/\.pyi?$/, '');
    const parts = p.split('/').filter(Boolean);
    if (parts[parts.length - 1] === '__init__')
        parts.pop();
    const out = [];
    for (let i = 0; i < parts.length; i++)
        out.push(parts.slice(i).join('.'));
    return out;
}
/** Does a python mock target (dotted) refer to something in `file`? */
export function pythonTargetHits(target, file) {
    const t = target.trim();
    if (!t)
        return false;
    const cands = pythonModuleCandidates(file);
    const prefixes = [t];
    const idx = t.lastIndexOf('.');
    if (idx > 0)
        prefixes.push(t.slice(0, idx));
    return prefixes.some((pre) => cands.includes(pre));
}
/** Path stem (no extension, no trailing /index) of a source file. */
export function stemOf(p) {
    return p.replace(/\\/g, '/').replace(/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/, '').replace(/\/index$/, '');
}
/** Resolve a JS import specifier relative to the importing file into a repo path stem, or an alias tail, or null for packages. */
export function jsSpecifierStem(spec, fromFile) {
    let s = spec.trim().replace(/[?#].*$/, '');
    if (!s)
        return null;
    if (s.startsWith('.')) {
        return { stem: stemOf(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile.replace(/\\/g, '/')), s))), kind: 'relative' };
    }
    if (s.startsWith('/'))
        return { stem: stemOf(s.slice(1)), kind: 'alias' };
    const alias = /^(@\/|~\/|#\/|\$\/|src\/|lib\/|app\/|packages\/)/.exec(s);
    if (alias)
        return { stem: stemOf(s.replace(/^[@~#$]\//, '')), kind: 'alias' };
    return null; // bare package specifier ("axios", "@scope/pkg", "node:fs"): never a first-party file
}
/** Does a JS mock target refer to `file`? Targets: import specifier, `specifier#attr` (spyOn on an imported binding), `ident:`/`global:` (unresolvable). */
export function jsTargetHits(target, testFile, file) {
    if (target.startsWith('ident:') || target.startsWith('global:'))
        return false;
    const spec = target.includes('#') ? target.slice(0, target.indexOf('#')) : target;
    const r = jsSpecifierStem(spec, testFile);
    if (!r)
        return false;
    const fileStem = stemOf(file);
    if (r.kind === 'relative')
        return r.stem === fileStem;
    return fileStem === r.stem || fileStem.endsWith('/' + r.stem);
}
/** Candidate repo paths a JS specifier could resolve to (for existence checks). */
export function jsCandidatePaths(target, testFile) {
    const spec = target.includes('#') ? target.slice(0, target.indexOf('#')) : target;
    const r = jsSpecifierStem(spec, testFile);
    if (!r || r.kind !== 'relative')
        return [];
    const exts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];
    return [...exts.map((e) => `${r.stem}.${e}`), ...exts.map((e) => `${r.stem}/index.${e}`)];
}
/** Candidate repo paths a python dotted target could resolve to. */
export function pythonCandidatePaths(target) {
    const t = target.trim();
    const mods = [t];
    const idx = t.lastIndexOf('.');
    if (idx > 0)
        mods.push(t.slice(0, idx));
    const out = [];
    for (const m of mods) {
        const p = m.replace(/\./g, '/');
        out.push(`${p}.py`, `${p}/__init__.py`, `src/${p}.py`, `src/${p}/__init__.py`);
    }
    return out;
}
/** Symbol name a mock replaces: last dotted segment, or the `#attr` part. */
export function mockedSymbol(target) {
    if (target.includes('#'))
        return target.slice(target.indexOf('#') + 1);
    return target.split('.').pop() ?? '';
}
/** Would the test runner actually collect this file, by name? (pytest: test_*.py / *_test.py; jest/vitest/mocha: *.test.* / *.spec.* / __tests__/; go: *_test.go) */
export function isCollectedName(p) {
    const norm = p.replace(/\\/g, '/');
    const base = norm.split('/').pop() ?? '';
    if (/\.pyi?$/.test(base))
        return /^test_.*\.py$|_test\.py$|^conftest\.py$/.test(base);
    if (/\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(base))
        return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || /(^|\/)__tests__\//.test(norm) || /(^|\/)(test|tests|spec)\//.test(norm) && !/\.d\.ts$/.test(base) && /^(test|spec|.*[._-](test|spec))\./.test(base);
    if (base.endsWith('.go'))
        return base.endsWith('_test.go');
    if (base.endsWith('.java'))
        return /(Test|Tests|IT)\.java$|^Test\w*\.java$/.test(base) || /(^|\/)src\/test\//.test(norm);
    if (base.endsWith('.rb'))
        return /_spec\.rb$|_test\.rb$|^test_.*\.rb$/.test(base);
    return true;
}
//# sourceMappingURL=lang.js.map