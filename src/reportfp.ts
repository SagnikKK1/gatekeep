import { createHash } from 'node:crypto';
import { langFor } from './lang.js';
import { withTree, walk, type Lang, type SyntaxNode } from './parser.js';
import { looksLikeSecret, secretPatternFor } from './scope.js';

/**
 * Builds a redacted, self-contained reproducer for a false positive, so reporting one costs a command instead of an
 * afternoon of hand-minimising a fixture nobody is allowed to paste into a public issue.
 *
 * The whole design rests on one rule: **a redaction that stops reproducing the bug is not shipped.** Redaction and
 * reproduction pull against each other — the oracle rule is *about* string literals, the test-integrity family is
 * about function names that begin with `test` — so anything strong enough to be safe is usually strong enough to
 * make the finding disappear. So each level is applied and then re-run through `analyze`, and a level that no longer
 * produces the finding is discarded rather than sent. If no level reproduces it, the command says so and stops; it
 * never quietly falls back to shipping the original source, because the user asked for a redacted fixture and would
 * have no way to tell that they did not get one.
 */

export type RedactionLevel = 'full' | 'light' | 'none';

/**
 * Names that carry meaning to the rules rather than to the reporter's business. Renaming `describe` or `test_` away
 * turns a test file into an ordinary source file and the finding evaporates, so these survive redaction. They leak
 * nothing: every one of them is a language builtin or a test-framework name.
 */
const KEEP = new Set([
  // credential key names: not secret themselves, and the generic-secret pattern needs them to still match
  'api_key', 'apiKey', 'secret_key', 'secretKey', 'client_secret', 'access_token', 'auth_token', 'password', 'passwd', 'private_key', 'token', 'secret',
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

function tag(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 6); }

/**
 * A pseudonym that keeps every naming convention the rules read off a name: `test_x` stays a pytest test, `TestX`
 * stays a Go test, `x_test` stays a Go test file's function, a leading underscore stays private. The mapping is a
 * hash, so the same name is the same pseudonym in every file of the fixture and the cross-file equalities the
 * oracle rule compares survive.
 */
export function pseudonym(name: string): string {
  if (KEEP.has(name) || name.length <= 1) return name;
  if (/^__.*__$/.test(name)) return name;                       // dunders are protocol, not naming
  const h = tag(name);
  if (/^test_/.test(name)) return `test_n${h}`;
  if (/_test$/.test(name)) return `n${h}_test`;
  if (/^Test[A-Z_]/.test(name) || name === 'Test') return `TestN${h}`;
  if (/^_/.test(name)) return `_n${h}`;
  if (/^[A-Z]/.test(name)) return `N${h}`;
  return `n${h}`;
}

/**
 * Pseudonymised strings have to still look like *values*. The oracle rule ignores literals made only of word
 * characters — a schema library and its tests share "properties" constantly — so a replacement like `sa1b2c3`
 * reads as vocabulary and the finding disappears during redaction. The slash keeps it a value.
 */
export function pseudoString(s: string): string {
  if (s === '') return s;
  if (looksLikeSecret(s)) return sameShape(s);
  return `redacted/${tag(s)}${tag(s + '.')}`;
}

/**
 * A credential-shaped literal, replaced character by character with one of the same shape.
 *
 * This closes the hole that dogfooding found: `secret-introduced`'s evidence *is* the secret, so full redaction
 * destroyed the finding and the command fell back to a level that kept the literal — which would have helped
 * someone paste a live AWS key into a public issue. Same character classes, same lengths, same punctuation, so
 * every pattern that matched the original still matches, and none of the original characters survive. Derived from
 * a hash of the input, so the same secret redacts the same way in every file of the fixture.
 */
export function sameShape(s: string): string {
  const h = createHash('sha256').update('shape:' + s).digest();
  let i = 0;
  const pick = (set: string) => set[h[i++ % h.length]! % set.length]!;
  const scrambled = [...s].map((ch) => {
    if (/[A-Z]/.test(ch)) return pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    if (/[a-z]/.test(ch)) return pick('abcdefghijklmnopqrstuvwxyz');
    if (/[0-9]/.test(ch)) return pick('0123456789');
    return ch;                                  // separators, and the shape they give
  }).join('');
  // Scrambling every character also destroys the vendor prefix the pattern keys on — `AKIA…` stops being an AWS
  // key at all — and then the finding does not reproduce and the whole fixture is refused. Restore the shortest
  // leading run that makes it match again. That run is a published vendor prefix (`AKIA`, `ghp_`, `sk-ant-`), which
  // is not the secret part: the entropy after it is, and none of it survives.
  const re = secretPatternFor(s);
  if (!re || re.test(scrambled)) return scrambled;
  for (let keep = 1; keep <= Math.min(s.length - 1, 24); keep++) {
    const cand = s.slice(0, keep) + scrambled.slice(keep);
    if (re.test(cand)) return cand;
  }
  return scrambled;
}

interface Edit { start: number; end: number; text: string }

/** Rewrite by byte range, right to left so earlier offsets stay valid. */
function applyEdits(source: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  let lastStart = Infinity;
  for (const e of sorted) {
    if (e.end > lastStart) continue; // overlapping (a string inside a redacted parent): the outer one already won
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
  }
  return out;
}

/** The inner span of a quoted literal, so quoting and escapes are left exactly as they were. */
function innerSpan(n: SyntaxNode, source: string): { start: number; end: number } | null {
  const text = source.slice(n.startIndex, n.endIndex);
  const m = /^([a-zA-Z]*)(['"`]{1,3})/.exec(text);
  if (!m) return null;
  const open = m[0].length;
  const quote = m[2]!;
  if (!text.endsWith(quote) || text.length < open + quote.length) return null;
  return { start: n.startIndex + open, end: n.endIndex - quote.length };
}

/**
 * Redact one source file. `full` replaces identifiers, string contents and comments; `light` keeps string contents,
 * which is what the literal-matching rules need when `full` has made the finding vanish.
 */
export async function redactSource(p: string, source: string, level: Exclude<RedactionLevel, 'none'>): Promise<string> {
  const lang = langFor(p);
  if (lang === null) return redactPlain(source, level);
  try {
    return await withTree(source, lang as Lang, (tree) => {
      const edits: Edit[] = [];
      const contentSpans: { start: number; end: number }[] = [];
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
          const body = source.slice(n.startIndex, n.endIndex);
          // A credential is replaced at every level. `light` exists to keep literals the rules match on, and a
          // same-shape replacement keeps matching without keeping the credential.
          if (level === 'full' || looksLikeSecret(body)) { edits.push({ start: n.startIndex, end: n.endIndex, text: pseudoString(body) }); contentSpans.push({ start: n.startIndex, end: n.endIndex }); }
          return false;
        }
        if (STRING_TYPES.has(n.type)) {
          // A grammar that exposes content children is handled by those; only redact wholesale when it does not.
          const hasContent = n.namedChildren.some((c) => c && (STRING_CONTENT_TYPES.has(c.type) || c.type === 'template_substitution' || c.type === 'interpolation'));
          const span0 = innerSpan(n, source);
          const body0 = span0 ? source.slice(span0.start, span0.end) : '';
          if (!hasContent && (level === 'full' || looksLikeSecret(body0))) {
            if (span0 && span0.end > span0.start) edits.push({ start: span0.start, end: span0.end, text: pseudoString(body0) });
            return false;
          }
          return true;
        }
        if (IDENT_TYPES.has(n.type) && n.childCount === 0) {
          const name = source.slice(n.startIndex, n.endIndex);
          const to = pseudonym(name);
          if (to !== name) edits.push({ start: n.startIndex, end: n.endIndex, text: to });
          return false;
        }
        return true;
      });
      return applyEdits(source, edits);
    });
  } catch { return redactPlain(source, level); }
}

/** Words that a CI or config file's *structure* is made of; renaming them turns the file into something else. */
const PLAIN_KEEP = /^(on|jobs|steps|run|uses|with|name|if|needs|env|true|false|null|null|test|tests|npm|yarn|pnpm|pytest|go|cargo|mvn|gradle|make|python|node|bash|sh|ci|build|lint|script|scripts|version|main|master|push|pull_request|strategy|matrix|continue-on-error|allow_failure|when|stage|stages|image|before_script|after_script)$/i;

/** For files with no grammar (YAML, TOML, Markdown, plain text): word-level, keeping the structural vocabulary. */
function redactPlain(source: string, level: Exclude<RedactionLevel, 'none'>): string {
  return source.replace(/[A-Za-z_][A-Za-z0-9_.-]*/g, (w) => {
    if (looksLikeSecret(w)) return sameShape(w);
    if (PLAIN_KEEP.test(w) || KEEP.has(w)) return w;
    if (level === 'light' && /^[a-z-]+$/.test(w)) return w;
    return pseudonym(w.replace(/[.-]/g, '_'));
  });
}

/**
 * Paths leak too — `src/acme/billing/rate_card.py` says plenty on its own — but the rules read real meaning off a
 * path: the extension picks the grammar, and `tests/`, `test_x.py` and `x_test.go` are how a test file is
 * recognised at all. So the structural segments and the naming conventions survive and the rest is pseudonymised.
 */
const PATH_KEEP = new Set(['tests', 'test', '__tests__', 'spec', 'specs', 'src', 'lib', 'app', 'pkg', 'internal', 'cmd', 'docs', '.github', 'workflows', 'e2e', 'it']);
export function pseudonymPath(p: string): string {
  const segs = p.split('/');
  return segs.map((seg, i) => {
    if (PATH_KEEP.has(seg)) return seg;
    if (i < segs.length - 1) return pseudonym(seg);
    const dot = seg.indexOf('.');
    if (dot <= 0) return pseudonym(seg);
    return pseudonym(seg.slice(0, dot)) + seg.slice(dot);   // the extension picks the grammar; it stays
  }).join('/');
}

export interface FpFile { path: string; before?: string; after?: string }
export interface ExpectedFinding { rule: string; file: string; test?: string; severity?: string }

export interface FpFixture {
  name: string;
  level: RedactionLevel;
  before: Record<string, string>;
  after: Record<string, string>;
  expected: { findings: ExpectedFinding[] };
  /** True when the reported rule still fires on the redacted pair: without this the fixture proves nothing. */
  reproduced: boolean;
  /** Everything the redacted pair produces, for the issue body. */
  findings: ExpectedFinding[];
}

export async function redactFiles(files: FpFile[], level: Exclude<RedactionLevel, 'none'>): Promise<{ before: Record<string, string>; after: Record<string, string> }> {
  const before: Record<string, string> = {}, after: Record<string, string> = {};
  for (const f of files) {
    const p = pseudonymPath(f.path);
    if (f.before !== undefined) before[p] = await redactSource(f.path, f.before, level);
    if (f.after !== undefined) after[p] = await redactSource(f.path, f.after, level);
  }
  return { before, after };
}

export function fixtureName(rule: string, files: FpFile[]): string {
  const hint = files[0] ? pseudonym(files[0].path.split('/').pop()!.split('.')[0]!) : 'case';
  return `fp-${rule}-${hint}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
}

/** The prefilled issue. Kept under a URL length browsers and GitHub both accept; the fixture on disk is the fallback. */
const MAX_URL = 7000;
export function issueUrl(repo: string, p: { rule: string; version: string; level: RedactionLevel; message: string; fixture: FpFixture; dir: string }): string {
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
  const url = (body: string) => `${base}?labels=false-positive&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  const full = url(withFixture);
  return full.length <= MAX_URL ? full : url(short);
}
