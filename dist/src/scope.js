import { langFor, matchesAny } from './lang.js';
/**
 * Roadmap item 4: scope and blast radius. Protected paths, changes outside the stated task, dependency and registry
 * changes, secrets in the diff, and a feature removed together with the tests that covered it.
 */
export const SCOPE_SEVERITIES = {
    'protected-path-edited': 'warn',
    'lockfile-changed-alone': 'warn',
    'out-of-scope-change': 'warn',
    'dependency-added': 'warn',
    'dependency-loosened': 'warn',
    'registry-changed': 'block',
    'typosquat-suspect': 'block',
    'secret-introduced': 'block',
    'feature-deleted': 'warn',
};
/** Paths where an agent edit blocks unless overridden. Configurable via `protectedPaths`. */
export const DEFAULT_PROTECTED_GLOBS = [
    '**/migrations/**', '**/migrate/**', '**/alembic/versions/**', '**/db/migrate/**',
    '**/auth/**', '**/authn/**', '**/authz/**', '**/permissions/**', '**/payments/**', '**/payment/**', '**/billing/**', '**/checkout/**',
    'infra/**', 'infrastructure/**', 'terraform/**', '**/*.tf', '**/*.tfvars', 'deploy/**', 'k8s/**', 'kubernetes/**', 'helm/**', 'ansible/**',
    'Dockerfile', '**/Dockerfile', 'docker-compose*.{yml,yaml}',
];
export const MANIFEST_GLOBS = ['**/package.json', '**/pyproject.toml', '**/requirements*.txt', '**/requirements/*.txt', '**/setup.py', '**/setup.cfg', '**/Pipfile', '**/go.mod', '**/Cargo.toml', '**/Gemfile', '**/*.gemspec', '**/composer.json', '**/pom.xml', '**/build.gradle*', '**/.npmrc', '**/.yarnrc', '**/.yarnrc.yml', '**/pip.conf', '**/.pypirc', '**/uv.toml', '**/.cargo/config*'];
export const LOCKFILE_GLOBS = ['**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lockb', '**/bun.lock', '**/poetry.lock', '**/Pipfile.lock', '**/uv.lock', '**/pdm.lock', '**/Cargo.lock', '**/go.sum', '**/Gemfile.lock', '**/composer.lock'];
export const SCOPE_GLOBS = [...MANIFEST_GLOBS];
const WELL_KNOWN = ['react', 'react-dom', 'lodash', 'express', 'axios', 'moment', 'chalk', 'commander', 'debug', 'request', 'underscore', 'bluebird', 'async', 'uuid', 'minimist', 'yargs', 'webpack', 'babel-core', 'typescript', 'eslint', 'prettier', 'jest', 'mocha', 'chai', 'vue', 'angular', 'jquery', 'bootstrap', 'next', 'nuxt', 'redux', 'mongoose', 'mongodb', 'pg', 'mysql', 'redis', 'socket.io', 'dotenv', 'cors', 'body-parser', 'passport', 'jsonwebtoken', 'bcrypt', 'crypto-js', 'node-fetch', 'cross-env', 'rimraf', 'glob', 'semver', 'colors', 'inquirer', 'ora', 'fs-extra', 'mkdirp', 'shelljs', 'zod', 'yup', 'joi', 'dayjs', 'date-fns', 'classnames', 'prop-types', 'styled-components', 'tailwindcss', 'vite', 'rollup', 'esbuild', 'ts-node', 'nodemon', 'supertest', 'sinon', 'cypress', 'playwright', 'puppeteer', 'electron', 'sharp', 'multer', 'nodemailer', 'winston', 'pino', 'morgan', 'helmet', 'compression', 'ws', 'graphql', 'apollo-server', 'prisma', 'sequelize', 'knex', 'typeorm',
    'requests', 'numpy', 'pandas', 'scipy', 'matplotlib', 'django', 'flask', 'fastapi', 'sqlalchemy', 'pytest', 'boto3', 'botocore', 'urllib3', 'certifi', 'setuptools', 'pip', 'wheel', 'six', 'python-dateutil', 'pyyaml', 'jinja2', 'click', 'colorama', 'cryptography', 'pillow', 'psycopg2', 'pymongo', 'redis', 'celery', 'gunicorn', 'uvicorn', 'httpx', 'aiohttp', 'pydantic', 'attrs', 'typing-extensions', 'packaging', 'tqdm', 'rich', 'beautifulsoup4', 'lxml', 'selenium', 'scikit-learn', 'tensorflow', 'torch', 'transformers', 'openai', 'anthropic', 'langchain', 'black', 'ruff', 'mypy', 'flake8', 'isort', 'tox', 'coverage', 'paramiko', 'pyjwt', 'python-dotenv', 'werkzeug', 'markupsafe', 'itsdangerous', 'idna', 'charset-normalizer'];
const WELL_KNOWN_SET = new Set(WELL_KNOWN);
const SECRET_PATTERNS = [
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
    [/\bASIA[0-9A-Z]{16}\b/, 'AWS temporary access key id'],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
    [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'GitHub fine-grained token'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
    [/https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/, 'Slack webhook'],
    [/\bsk_live_[A-Za-z0-9]{16,}\b/, 'Stripe live secret key'],
    [/\brk_live_[A-Za-z0-9]{16,}\b/, 'Stripe restricted key'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, 'Anthropic API key'],
    [/\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/, 'OpenAI-style secret key'],
    [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
    [/\bpypi-AgEI[A-Za-z0-9_-]{20,}\b/, 'PyPI token'],
    [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, 'SendGrid key'],
    [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'private key block'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, 'JWT'],
    [/\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp|mssql):\/\/[^\s:'"]+:[^\s@'"]{4,}@/, 'connection string with password'],
    [/AccountKey=[A-Za-z0-9+/=]{40,}/, 'Azure storage account key'],
    [/\bAGE-SECRET-KEY-1[A-Z0-9]{50,}\b/, 'age secret key'],
];
const GENERIC_SECRET = /\b(api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|private[_-]?key|secret)\b\s*[:=]\s*['"`]([^'"`\s]{16,})['"`]/i;
const PLACEHOLDER = /example|changeme|change_me|replace|placeholder|your[_-]?|xxx|\.\.\.|<[^>]+>|\$\{|%\(|\{\{|dummy|sample|test[_-]?key|fake|redacted|todo|0000|1234567|abcdef|lorem/i;
function lines(t) { return (t ?? '').split('\n'); }
function lineSet(t) { return new Set(lines(t).map((l) => l.trim()).filter(Boolean)); }
function added(c) { const b = lineSet(c.before); return lines(c.after).map((l) => l.trim()).filter((l) => l && !b.has(l)); }
function removed(c) { const a = lineSet(c.after); return lines(c.before).map((l) => l.trim()).filter((l) => l && !a.has(l)); }
function base(p) { return p.split('/').pop() ?? ''; }
/**
 * Did the human's own task statement send the agent to this path? A task that says "fix the login bug" is an
 * instruction to edit `src/auth/login.py`, and a gate that blocks it is reporting the work it was asked to do.
 * Matches a directory name or file stem of four characters or more against the words of the task.
 */
export function taskMentions(task) {
    if (!task)
        return () => false;
    const words = new Set((task.toLowerCase().match(/[a-z_][\w-]{3,}/g) ?? []));
    if (words.size === 0)
        return () => false;
    return (p) => p.toLowerCase().split('/').some((seg) => {
        const stem = seg.replace(/\.[^.]+$/, '');
        return stem.length >= 4 && words.has(stem);
    });
}
export function scopeFindings(changes, severities, opts) {
    const out = [];
    const sev = (rule) => severities[rule] ?? SCOPE_SEVERITIES[rule] ?? 'warn';
    const emit = (f) => { const s = sev(f.rule); if (s !== 'off')
        out.push({ ...f, severity: s }); };
    // 1. protected paths, unless the task the human wrote sent the agent there in the first place
    const asked = taskMentions(opts.task);
    for (const c of changes) {
        const hit = [c.path, c.oldPath].filter((p) => !!p).find((p) => matchesAny(p, opts.protectedGlobs));
        if (hit && !opts.isTest(c.path) && !asked(c.path))
            emit({ rule: 'protected-path-edited', file: c.path, message: `${c.status === 'D' ? 'Deleted' : c.status === 'A' ? 'Created' : 'Modified'} a protected path (${matchingGlob(hit, opts.protectedGlobs)})` });
    }
    // 2. lockfiles without a manifest change
    const manifestChanged = changes.some((c) => matchesAny(c.path, MANIFEST_GLOBS) && !/npmrc|yarnrc|pip\.conf|pypirc|uv\.toml|cargo\/config/.test(c.path));
    for (const c of changes)
        if (matchesAny(c.path, LOCKFILE_GLOBS) && !manifestChanged)
            emit({ rule: 'lockfile-changed-alone', file: c.path, message: 'Lockfile changed with no change to the dependency manifest' });
    // 3. dependencies, registries, typosquats
    for (const c of changes) {
        if (!matchesAny(c.path, MANIFEST_GLOBS) || c.after === undefined)
            continue;
        const b = base(c.path);
        const { addedDeps, loosened } = dependencyDiff(b, c);
        if (addedDeps.length > 0)
            emit({ rule: 'dependency-added', file: c.path, message: `New dependenc${addedDeps.length === 1 ? 'y' : 'ies'}: ${addedDeps.slice(0, 6).join(', ')}` });
        for (const d of addedDeps) {
            const near = typosquat(d);
            if (near)
                emit({ rule: 'typosquat-suspect', file: c.path, message: `New dependency "${d}" is one edit away from "${near}"` });
        }
        if (loosened.length > 0)
            emit({ rule: 'dependency-loosened', file: c.path, message: `Version constraint loosened or downgraded: ${loosened.slice(0, 4).join(', ')}` });
        const reg = added(c).find((l) => /^(registry|@[\w-]+:registry)\s*=|npmRegistryServer|^\s*index-url\s*=|^\s*extra-index-url\s*=|--(extra-)?index-url|\[\[tool\.poetry\.source\]\]|^\s*url\s*=\s*["']https?:\/\/(?!(registry\.npmjs\.org|pypi\.org|files\.pythonhosted\.org|crates\.io|proxy\.golang\.org))|^\s*\[registries\.|^\s*replace\s+[\w./-]+\s*=>\s*(https?:\/\/|\.\.?\/)|^\[source\.|^\s*index\s*=\s*["']https?:\/\/(?!pypi\.org)/i.test(l));
        if (reg)
            emit({ rule: 'registry-changed', file: c.path, message: `Package source or registry changed: ${reg.slice(0, 100)}` });
    }
    // 4. secrets in added lines of any changed file (tests included: fixtures with real keys are still leaks)
    for (const c of changes) {
        if (c.after === undefined || c.status === 'D')
            continue;
        if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.js|.*\.map|.*\.svg|.*\.snap)$/.test(c.path))
            continue;
        for (const l of added(c)) {
            const known = SECRET_PATTERNS.find(([re]) => re.test(l));
            if (known) {
                emit({ rule: 'secret-introduced', file: c.path, line: lineOf(c.after, l), message: `${known[1]} added to ${c.path}` });
                break;
            }
            const g = GENERIC_SECRET.exec(l);
            if (g && !PLACEHOLDER.test(l) && !/process\.env|os\.environ|getenv|env\[|secrets?\.|vault|\bref\b|import|require\(/i.test(l) && /[0-9]/.test(g[2]) && /[A-Za-z]/.test(g[2])) {
                emit({ rule: 'secret-introduced', file: c.path, line: lineOf(c.after, l), message: `Hard-coded credential added to ${c.path}: ${l.slice(0, 40)}…` });
                break;
            }
        }
    }
    // 5. feature deleted together with its tests
    const removedDefs = new Map(); // name -> file
    for (const c of changes) {
        if (langFor(c.path) === null || opts.isTest(c.path) || c.before === undefined)
            continue;
        const before = defNames(c.before), after = new Set(c.after === undefined ? [] : defNames(c.after));
        for (const n of before)
            if (!after.has(n))
                removedDefs.set(n, c.path);
    }
    if (removedDefs.size > 0) {
        const definedAfter = new Set(changes.filter((c) => langFor(c.path) !== null && !opts.isTest(c.path) && c.after !== undefined).flatMap((c) => defNames(c.after)));
        const removedTestText = changes.filter((c) => (opts.isTest(c.path) || (c.oldPath && opts.isTest(c.oldPath))) && c.before !== undefined)
            .map((c) => removed(c).filter((l) => !/^(from\s|import\s|const .*require\(|export )/.test(l)).join('\n')).join('\n');
        const covered = [...removedDefs].filter(([n]) => n.length >= 4 && !definedAfter.has(n) && new RegExp(`(^|[^\\w.])${n}\\s*\\(|\\.${n}\\s*\\(`, 'm').test(removedTestText));
        // A removal the task asked for is the job, not blast radius.
        const unasked = covered.filter(([n, f]) => !asked(f) && !new RegExp(`(^|[^\\w])${n.toLowerCase()}([^\\w]|$)`).test((opts.task ?? '').toLowerCase()));
        if (unasked.length > 0)
            emit({ rule: 'feature-deleted', file: unasked[0][1], message: `${unasked.map(([n]) => n).slice(0, 5).join(', ')} removed from source together with the tests that covered ${unasked.length === 1 ? 'it' : 'them'}` });
    }
    // 6. out of scope relative to the task, only when the task names concrete files or modules
    if (opts.task) {
        const tokens = new Set((opts.task.match(/[A-Za-z_][\w-]{3,}/g) ?? []).map((t) => t.toLowerCase()));
        const paths = opts.task.match(/[\w./-]+\.(py|ts|tsx|js|jsx|go|rs|java|rb|json|ya?ml|toml|md)\b/g) ?? [];
        const named = new Set(paths.flatMap((p) => [base(p).toLowerCase(), base(p).toLowerCase().replace(/\.[^.]+$/, '')]));
        if (paths.length > 0) {
            const code = changes.filter((c) => langFor(c.path) !== null && !opts.isTest(c.path) && !matchesAny(c.path, MANIFEST_GLOBS));
            const outside = code.filter((c) => {
                const stem = base(c.path).toLowerCase().replace(/\.[^.]+$/, '');
                return !named.has(base(c.path).toLowerCase()) && !named.has(stem) && !tokens.has(stem) && !stem.split(/[_-]/).some((w) => w.length >= 4 && tokens.has(w));
            });
            if (outside.length > 0 && outside.length < code.length)
                emit({ rule: 'out-of-scope-change', file: outside[0].path, message: `${outside.length} changed source file(s) not named or implied by the task: ${outside.slice(0, 5).map((c) => c.path).join(', ')}` });
        }
    }
    return out;
}
function matchingGlob(p, globs) { return globs.find((g) => matchesAny(p, [g])) ?? ''; }
function lineOf(text, trimmed) { const i = lines(text).findIndex((l) => l.trim() === trimmed); return i >= 0 ? i + 1 : undefined; }
/** Top-level definitions in a source file, by regex (no parse needed for a name set). */
export function defNames(src) {
    const out = new Set();
    // functions and classes only: a `const x = require(...)` or `var app = express()` is not a feature
    for (const m of src.matchAll(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:def|class|function\*?)\s+([A-Za-z_$][\w$]*)/gm))
        out.add(m[1]);
    for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b|[A-Za-z_$][\w$]*\s*=>)/gm))
        out.add(m[1]);
    for (const m of src.matchAll(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/gm))
        out.add(m[1]);
    return [...out];
}
/** Edit distance ≤ 1 (or a swapped pair) from a well-known package that is not the package itself. */
export function typosquat(name) {
    const n = name.toLowerCase().replace(/^@[^/]+\//, '');
    if (WELL_KNOWN_SET.has(n) || n.length < 5)
        return null;
    for (const w of WELL_KNOWN) {
        if (Math.abs(w.length - n.length) > 1)
            continue;
        if (editDistance(n, w) === 1 || swapped(n, w) || n.replace(/[-_.]/g, '') === w.replace(/[-_.]/g, ''))
            return w;
    }
    return null;
}
function editDistance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++)
        dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
}
function swapped(a, b) {
    if (a.length !== b.length)
        return false;
    const d = [...a].map((ch, i) => (ch !== b[i] ? i : -1)).filter((i) => i >= 0);
    return d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]];
}
/** Added dependency names and loosened/downgraded constraints for the common manifest formats. */
export function dependencyDiff(b, c) {
    const addedDeps = [], loosened = [];
    const looser = (from, to) => {
        const f = from.trim(), t = to.trim();
        if (f === t)
            return false;
        if (/^(\*|latest|x|>=?\s*0(\.0)*)$/.test(t) || t === '')
            return true;
        const exactF = /^=?=?\s*v?\d/.test(f) && !/[\^~*x><]/.test(f), rangeT = /[\^~*x>]|latest/.test(t);
        if (exactF && rangeT)
            return true;
        const nf = f.match(/\d+(\.\d+)*/)?.[0], nt = t.match(/\d+(\.\d+)*/)?.[0];
        if (nf && nt) {
            const A = nf.split('.').map(Number), B = nt.split('.').map(Number);
            for (let i = 0; i < Math.max(A.length, B.length); i++) {
                const x = A[i] ?? 0, y = B[i] ?? 0;
                if (y < x)
                    return true;
                if (y > x)
                    return false;
            }
        }
        return false;
    };
    if (b === 'package.json') {
        try {
            const pb = JSON.parse(c.before ?? '{}'), pa = JSON.parse(c.after ?? '{}');
            for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
                for (const [name, v] of Object.entries(pa[k] ?? {})) {
                    const old = pb[k]?.[name];
                    if (old === undefined) {
                        if (!Object.values(pb).some((sec) => sec && typeof sec === 'object' && name in sec))
                            addedDeps.push(name);
                    }
                    else if (looser(old, v))
                        loosened.push(`${name}: ${old} -> ${v}`);
                }
            }
        }
        catch { /* unparseable */ }
        return { addedDeps, loosened };
    }
    const specRe = /^\s*["']?([A-Za-z0-9][\w.-]*)["']?\s*([=~^<>!]=?|@|:)?\s*["']?([^"',;#\s]*)/;
    const parse = (text, kind) => {
        const m = new Map();
        let inDeps = kind !== 'toml';
        for (const raw of lines(text)) {
            const l = raw.trim();
            if (!l || l.startsWith('#') || l.startsWith('//'))
                continue;
            if (kind === 'toml') {
                const h = /^\[([^\]]+)\]/.exec(l);
                if (h) {
                    inDeps = /dependencies|dependency-groups|optional-dependencies|project$/.test(h[1]);
                    continue;
                }
                if (!inDeps)
                    continue;
                if (/^[\w.-]+\s*=\s*\[/.test(l) || /^[\w.-]+\s*=\s*[{"']?(true|false|\d)/.test(l) && !/[=~^<>!]=?\s*\d/.test(l))
                    continue;
            }
            if (kind === 'gomod') {
                const g = /^(?:require\s+)?([\w./-]+\.[\w./-]+)\s+(v[\w.+-]+)/.exec(l);
                if (g && !/^module\b|^go\b|^replace\b|^exclude\b/.test(l))
                    m.set(g[1], g[2]);
                continue;
            }
            if (kind === 'gemfile') {
                const g = /^gem\s+["']([\w.-]+)["'](?:\s*,\s*["']([^"']+)["'])?/.exec(l);
                if (g)
                    m.set(g[1], g[2] ?? '');
                continue;
            }
            if (/^-/.test(l) || /^(pip|python|include)/i.test(l))
                continue;
            const g = specRe.exec(l.replace(/^["']|["'],?$/g, ''));
            if (g && g[1] && !/^(name|version|description|requires-python|python|dependencies|readme|authors|license|include|exclude|packages)$/i.test(g[1]))
                m.set(g[1].toLowerCase(), (g[2] ?? '') + (g[3] ?? ''));
        }
        return m;
    };
    const kind = b === 'go.mod' ? 'gomod' : b === 'Gemfile' ? 'gemfile' : /\.toml$|^Pipfile$/.test(b) ? 'toml' : 'req';
    if (/^(setup\.py|setup\.cfg|.*\.gemspec|composer\.json|pom\.xml|build\.gradle.*|\.npmrc|\.yarnrc.*|pip\.conf|\.pypirc|uv\.toml)$/.test(b))
        return { addedDeps, loosened };
    const before = parse(c.before, kind), after = parse(c.after, kind);
    for (const [name, v] of after) {
        const old = before.get(name);
        if (old === undefined)
            addedDeps.push(name);
        else if (looser(old, v))
            loosened.push(`${name}: ${old || '(any)'} -> ${v || '(any)'}`);
    }
    return { addedDeps, loosened };
}
//# sourceMappingURL=scope.js.map