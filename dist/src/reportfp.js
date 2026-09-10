import { createHash } from 'node:crypto';
import { langFor } from './lang.js';
import { withTree, walk } from './parser.js';
/**
 * Names that carry meaning to the rules rather than to the reporter's business. Renaming `describe` or `test_` away
 * turns a test file into an ordinary source file and the finding evaporates, so these survive redaction. They leak
 * nothing: every one of them is a language builtin or a test-framework name.
 */
const KEEP = new Set([
    // structural
    'self', 'this', 'super', 'cls', 'main', 'args', 'kwargs', 'err', 'error', 'ok', 'nil', 'None', 'True', 'False',
    // python
    'pytest', 'unittest', 'TestCase', 'mock', 'MagicMock', 'patch', 'raises', 'approx', 'parametrize', 'fixture',
    'setUp', 'tearDown', 'skip', 'skipif', 'xfail', 'mark', 'monkeypatch', 'assertEqual', 'assertTrue', 'assertFalse',
    'assertRaises', 'assertIsNone', 'assertIn', 'assertAlmostEqual',
    // js / ts
    'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'jest', 'vi', 'vitest',
    'toBe', 'toEqual', 'toThrow', 'toMatch', 'toContain', 'toBeTruthy', 'toBeFalsy', 'toHaveBeenCalled', 'not',
    'assert', 'strict', 'deepEqual', 'equal', 'throws', 'rejects', 'resolves', 'sinon', 'chai', 'should', 'only', 'skip',
    'async', 'await', 'require', 'module', 'exports', 'console', 'log',
    // go
    'testing', 't', 'T', 'Errorf', 'Fatalf', 'Error', 'Fatal', 'Run', 'Helper', 'Skip', 'require', 'assert', 'tt', 'want', 'got',
    // rust
    'assert_eq', 'assert_ne', 'panic', 'unwrap', 'cfg', 'mod', 'tests', 'Result', 'Ok', 'Err', 'Some',
    // java
    'Test', 'Assert', 'Assertions', 'assertEquals', 'assertTrue', 'assertFalse', 'assertThrows', 'assertThat', 'junit', 'jupiter', 'api',
    // ruby
    'RSpec', 'eq', 'be', 'refute', 'minitest',
]);
/** Node types whose text is an identifier the rules may care about. */
const IDENT_TYPES = new Set(['identifier', 'property_identifier', 'field_identifier', 'package_identifier', 'type_identifier', 'constant', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern']);
/** Node types that are a whole string literal, and the inner-content types some grammars expose instead. */
const STRING_TYPES = new Set(['string', 'string_literal', 'interpreted_string_literal', 'raw_string_literal', 'char_literal', 'template_string']);
const STRING_CONTENT_TYPES = new Set(['string_content', 'string_fragment']);
const COMMENT_TYPES = new Set(['comment', 'line_comment', 'block_comment']);
function tag(s) { return createHash('sha256').update(s).digest('hex').slice(0, 6); }
/**
 * A pseudonym that keeps every naming convention the rules read off a name: `test_x` stays a pytest test, `TestX`
 * stays a Go test, `x_test` stays a Go test file's function, a leading underscore stays private. The mapping is a
 * hash, so the same name is the same pseudonym in every file of the fixture and the cross-file equalities the
 * oracle rule compares survive.
 */
export function pseudonym(name) {
    if (KEEP.has(name) || name.length <= 1)
        return name;
    if (/^__.*__$/.test(name))
        return name; // dunders are protocol, not naming
    const h = tag(name);
    if (/^test_/.test(name))
        return `test_n${h}`;
    if (/_test$/.test(name))
        return `n${h}_test`;
    if (/^Test[A-Z_]/.test(name) || name === 'Test')
        return `TestN${h}`;
    if (/^_/.test(name))
        return `_n${h}`;
    if (/^[A-Z]/.test(name))
        return `N${h}`;
    return `n${h}`;
}
/**
 * Pseudonymised strings have to still look like *values*. The oracle rule ignores literals made only of word
 * characters — a schema library and its tests share "properties" constantly — so a replacement like `sa1b2c3`
 * reads as vocabulary and the finding disappears during redaction. The slash keeps it a value.
 */
export function pseudoString(s) {
    if (s === '')
        return s;
    return `redacted/${tag(s)}`;
}
/** Rewrite by byte range, right to left so earlier offsets stay valid. */
function applyEdits(source, edits) {
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let out = source;
    let lastStart = Infinity;
    for (const e of sorted) {
        if (e.end > lastStart)
            continue; // overlapping (a string inside a redacted parent): the outer one already won
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
        lastStart = e.start;
    }
    return out;
}
/** The inner span of a quoted literal, so quoting and escapes are left exactly as they were. */
function innerSpan(n, source) {
    const text = source.slice(n.startIndex, n.endIndex);
    const m = /^([a-zA-Z]*)(['"`]{1,3})/.exec(text);
    if (!m)
        return null;
    const open = m[0].length;
    const quote = m[2];
    if (!text.endsWith(quote) || text.length < open + quote.length)
        return null;
    return { start: n.startIndex + open, end: n.endIndex - quote.length };
}
/**
 * Redact one source file. `full` replaces identifiers, string contents and comments; `light` keeps string contents,
 * which is what the literal-matching rules need when `full` has made the finding vanish.
 */
export async function redactSource(p, source, level) {
    const lang = langFor(p);
    if (lang === null)
        return redactPlain(source, level);
    try {
        return await withTree(source, lang, (tree) => {
            const edits = [];
            const contentSpans = [];
            walk(tree.rootNode, (n) => {
                if (COMMENT_TYPES.has(n.type)) {
                    // Keep the marker and the line count; drop what it said.
                    const text = source.slice(n.startIndex, n.endIndex);
                    const marker = /^(\/\/|#|--|\/\*)/.exec(text)?.[1] ?? '#';
                    const lines = text.split('\n').length - 1;
                    edits.push({ start: n.startIndex, end: n.endIndex, text: `${marker} redacted${text.startsWith('/*') ? ' */' : ''}${'\n'.repeat(lines)}` });
                    return false;
                }
                if (STRING_CONTENT_TYPES.has(n.type)) {
                    if (level === 'full') {
                        edits.push({ start: n.startIndex, end: n.endIndex, text: pseudoString(source.slice(n.startIndex, n.endIndex)) });
                        contentSpans.push({ start: n.startIndex, end: n.endIndex });
                    }
                    return false;
                }
                if (STRING_TYPES.has(n.type)) {
                    // A grammar that exposes content children is handled by those; only redact wholesale when it does not.
                    const hasContent = n.namedChildren.some((c) => c && (STRING_CONTENT_TYPES.has(c.type) || c.type === 'template_substitution' || c.type === 'interpolation'));
                    if (!hasContent && level === 'full') {
                        const span = innerSpan(n, source);
                        if (span && span.end > span.start)
                            edits.push({ start: span.start, end: span.end, text: pseudoString(source.slice(span.start, span.end)) });
                        return false;
                    }
                    return true;
                }
                if (IDENT_TYPES.has(n.type) && n.childCount === 0) {
                    const name = source.slice(n.startIndex, n.endIndex);
                    const to = pseudonym(name);
                    if (to !== name)
                        edits.push({ start: n.startIndex, end: n.endIndex, text: to });
                    return false;
                }
                return true;
            });
            return applyEdits(source, edits);
        });
    }
    catch {
        return redactPlain(source, level);
    }
}
/** Words that a CI or config file's *structure* is made of; renaming them turns the file into something else. */
const PLAIN_KEEP = /^(on|jobs|steps|run|uses|with|name|if|needs|env|true|false|null|null|test|tests|npm|yarn|pnpm|pytest|go|cargo|mvn|gradle|make|python|node|bash|sh|ci|build|lint|script|scripts|version|main|master|push|pull_request|strategy|matrix|continue-on-error|allow_failure|when|stage|stages|image|before_script|after_script)$/i;
/** For files with no grammar (YAML, TOML, Markdown, plain text): word-level, keeping the structural vocabulary. */
function redactPlain(source, level) {
    return source.replace(/[A-Za-z_][A-Za-z0-9_.-]*/g, (w) => {
        if (PLAIN_KEEP.test(w) || KEEP.has(w))
            return w;
        if (level === 'light' && /^[a-z-]+$/.test(w))
            return w;
        return pseudonym(w.replace(/[.-]/g, '_'));
    });
}
/**
 * Paths leak too — `src/acme/billing/rate_card.py` says plenty on its own — but the rules read real meaning off a
 * path: the extension picks the grammar, and `tests/`, `test_x.py` and `x_test.go` are how a test file is
 * recognised at all. So the structural segments and the naming conventions survive and the rest is pseudonymised.
 */
const PATH_KEEP = new Set(['tests', 'test', '__tests__', 'spec', 'specs', 'src', 'lib', 'app', 'pkg', 'internal', 'cmd', 'docs', '.github', 'workflows', 'e2e', 'it']);
export function pseudonymPath(p) {
    const segs = p.split('/');
    return segs.map((seg, i) => {
        if (PATH_KEEP.has(seg))
            return seg;
        if (i < segs.length - 1)
            return pseudonym(seg);
        const dot = seg.indexOf('.');
        if (dot <= 0)
            return pseudonym(seg);
        return pseudonym(seg.slice(0, dot)) + seg.slice(dot); // the extension picks the grammar; it stays
    }).join('/');
}
export async function redactFiles(files, level) {
    const before = {}, after = {};
    for (const f of files) {
        const p = pseudonymPath(f.path);
        if (f.before !== undefined)
            before[p] = await redactSource(f.path, f.before, level);
        if (f.after !== undefined)
            after[p] = await redactSource(f.path, f.after, level);
    }
    return { before, after };
}
export function fixtureName(rule, files) {
    const hint = files[0] ? pseudonym(files[0].path.split('/').pop().split('.')[0]) : 'case';
    return `fp-${rule}-${hint}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
}
/** The prefilled issue. Kept under a URL length browsers and GitHub both accept; the fixture on disk is the fallback. */
const MAX_URL = 7000;
export function issueUrl(repo, p) {
    const base = `https://github.com/${repo}/issues/new`;
    const title = `False positive: ${p.rule}`;
    const files = Object.keys({ ...p.fixture.before, ...p.fixture.after });
    const inline = [
        ...Object.entries(p.fixture.before).map(([f, c]) => `<details><summary>before/${f}</summary>\n\n\`\`\`\n${c}\n\`\`\`\n</details>`),
        ...Object.entries(p.fixture.after).map(([f, c]) => `<details><summary>after/${f}</summary>\n\n\`\`\`\n${c}\n\`\`\`\n</details>`),
    ].join('\n\n');
    const head = [
        `**Rule:** \`${p.rule}\``,
        `**gatekeep:** ${p.version}`,
        `**What it said:** ${p.message}`,
        '',
        `Reduced to a fixture with \`gatekeep report-fp\`, redaction level **${p.level}**` +
            (p.level === 'none' ? ' — this is unredacted source the reporter chose to share.' : ': identifiers, paths' + (p.level === 'full' ? ', string contents' : '') + ' and comments are pseudonymised, consistently, and the rule still fires on the result.'),
        '',
        `Fixture (${files.length} file(s)) — drop into \`fixtures/${p.fixture.name}/\`:`,
        '',
        '```json',
        `// expected.json`,
        JSON.stringify(p.fixture.expected, null, 2),
        '```',
    ].join('\n');
    const withFixture = `${head}\n\n${inline}\n`;
    const short = `${head}\n\n_The fixture was too large to inline; it is at \`${p.dir}\` on the reporter's machine._\n`;
    const url = (body) => `${base}?labels=false-positive&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    const full = url(withFixture);
    return full.length <= MAX_URL ? full : url(short);
}
//# sourceMappingURL=reportfp.js.map