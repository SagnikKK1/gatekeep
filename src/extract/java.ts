import { withTree, walk, descendants, ancestor, countErrors, line, named, type SyntaxNode } from '../parser.js';
import type { Assertion, Mock, TestCase, TestFileModel, Tolerance } from '../model.js';

/** Java: JUnit 4/5 (@Test, @Disabled/@Ignore, @ParameterizedTest, assumptions), JUnit assertions, AssertJ and Hamcrest chains, Mockito. */

function head(t: string): string { return t.split('\n')[0]!.slice(0, 120); }
export function normalizeBody(t: string): string {
  return t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

const JUNIT_STRONG = new Set(['assertEquals', 'assertNotEquals', 'assertArrayEquals', 'assertIterableEquals', 'assertLinesMatch', 'assertSame', 'assertNotSame', 'assertThrows', 'assertThrowsExactly', 'assertTimeout', 'assertTimeoutPreemptively', 'assertInstanceOf']);
const JUNIT_WEAK = new Set(['assertTrue', 'assertFalse', 'assertNull', 'assertNotNull', 'assertDoesNotThrow', 'fail']); // assertNull is promoted below
const ASSERTJ_STRONG = new Set(['isNull', 'isEqualTo', 'isNotEqualTo', 'hasSize', 'contains', 'containsExactly', 'containsExactlyInAnyOrder', 'containsOnly', 'doesNotContain', 'startsWith', 'endsWith', 'matches', 'isEqualToIgnoringCase', 'hasMessage', 'hasMessageContaining', 'isInstanceOf', 'hasSameSizeAs', 'isCloseTo', 'isBetween', 'containsEntry', 'containsKey', 'hasFieldOrPropertyWithValue', 'isEqualByComparingTo', 'isSameAs', 'isGreaterThan', 'isLessThan', 'isGreaterThanOrEqualTo', 'isLessThanOrEqualTo', 'hasToString', 'isExactlyInstanceOf', 'containsSequence', 'containsSubsequence', 'hasSize', 'isEqualToComparingFieldByField', 'usingRecursiveComparison', 'isThrownBy', 'isInstanceOfSatisfying', 'hasCauseInstanceOf', 'hasRootCauseInstanceOf', 'containsExactlyElementsOf', 'hasOnlyElementsOfType', 'extracting']);
const ASSERTJ_WEAK = new Set(['isNotNull', 'isTrue', 'isFalse', 'isNotEmpty', 'isEmpty', 'isPresent', 'isNotPresent', 'isZero', 'isNotZero', 'isPositive', 'isNegative', 'isNotBlank', 'isBlank', 'exists', 'doesNotExist', 'isNotNegative', 'isNotPositive', 'hasNoCause', 'anySatisfy', 'allSatisfy', 'noneSatisfy', 'isNotInstanceOf', 'isDirectory', 'isFile']);
const HAMCREST_STRONG = /^(is|equalTo|hasSize|contains|containsString|startsWith|endsWith|hasItem|hasItems|hasEntry|hasKey|instanceOf|sameInstance|closeTo|greaterThan|lessThan|arrayContaining|hasProperty|comparesEqualTo)$/;

export async function extractJava(filePath: string, source: string): Promise<TestFileModel> {
  return withTree(source, 'java', (tree) => {
    const root = tree.rootNode;
    const model: TestFileModel = { path: filePath, lang: 'java', tests: [], fileMocks: [], fileSkip: null, fileRetry: null, parseErrors: countErrors(tree), shadowed: [], imports: {} };
    for (const imp of descendants(root, 'import_declaration')) { const t = imp.text.replace(/^import\s+(static\s+)?/, '').replace(/;$/, '').trim(); model.imports[t.split('.').pop() ?? t] = t; }
    for (const cls of descendants(root, 'class_declaration')) {
      const cname = cls.childForFieldName('name')?.text ?? '';
      const cmods = named(cls).find((c) => c.type === 'modifiers')?.text ?? '';
      const classSkip = /@(Disabled|Ignore)\b/.test(cmods) ? { line: line(cls), marker: head(cmods.match(/@(Disabled|Ignore)[^\n]*/)?.[0] ?? '@Disabled'), conditional: false } : null;
      const body = cls.childForFieldName('body'); if (!body) continue;
      // @MockBean / @Mock fields
      for (const f of named(body).filter((c) => c.type === 'field_declaration')) {
        const mods = named(f).find((c) => c.type === 'modifiers')?.text ?? '';
        if (/@(Mock|MockBean|Spy|SpyBean|InjectMocks)\b/.test(mods)) { const ty = f.childForFieldName('type')?.text ?? ''; if (ty && !/InjectMocks/.test(mods)) model.fileMocks.push({ line: line(f), target: ty, text: head(f.text), literal: false, wholeModule: true }); }
      }
      // local helpers whose bodies assert (or throw): calls to them count as assertions
      const helpers = new Set<string>();
      for (const m of named(body).filter((c) => c.type === 'method_declaration')) {
        const mods = named(m).find((c) => c.type === 'modifiers')?.text ?? '';
        if (/@(\w+\.)*(Test|ParameterizedTest|RepeatedTest|BeforeEach|AfterEach|BeforeAll|AfterAll|Before|After)\b/.test(mods)) continue;
        const mb = m.childForFieldName('body'); const nm = m.childForFieldName('name')?.text;
        if (mb && nm && (assertionsIn(mb, new Set()).length > 0 || descendants(mb, 'throw_statement').length > 0)) helpers.add(nm);
      }
      for (const m of named(body).filter((c) => c.type === 'method_declaration')) {
        const mods = named(m).find((c) => c.type === 'modifiers') ?? null;
        const modText = mods?.text ?? '';
        const annos = mods ? named(mods).filter((a) => a.type === 'marker_annotation' || a.type === 'annotation') : [];
        const isTest = annos.some((a) => /^@(\w+\.)*(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Property|Example|Theory|QuickCheck)\b/.test(a.text));
        if (!isTest) {
          const mb = m.childForFieldName('body'); if (mb) model.fileMocks.push(...mocksIn(mb));
          continue;
        }
        const mb = m.childForFieldName('body'); if (!mb) continue;
        const name = m.childForFieldName('name')?.text ?? '';
        const tc: TestCase = {
          name: `${cname}.${name}`, line: line(m), assertions: [], skip: classSkip, only: null, mocks: [], swallowed: [], retry: null, tolerances: [], timeout: null,
          body: normalizeBody(mb.text), earlyExits: 0, parametrized: false, vacuous: false, data: '',
        };
        for (const a of annos) {
          const t = a.text;
          if (/^@(\w+\.)*(Disabled|Ignore)\b/.test(t)) tc.skip = { line: line(a), marker: head(t), conditional: false };
          if (/^@(\w+\.)*(DisabledOn|DisabledIf|EnabledIf|EnabledOn|DisabledFor|EnabledFor|DisabledInNativeImage|EnabledInNativeImage)\w*/.test(t)) tc.skip = tc.skip ?? { line: line(a), marker: head(t), conditional: true };
          if (/^@(\w+\.)*(ParameterizedTest|RepeatedTest|TestFactory)\b/.test(t)) tc.parametrized = true;
          if (/^@(\w+\.)*(ValueSource|CsvSource|MethodSource|EnumSource|ArgumentsSource|CsvFileSource|NullSource|EmptySource|FieldSource)\b/.test(t)) { tc.parametrized = true; tc.data += normalizeBody(t) + '\n'; if (/\{\s*\}/.test(t) && /(ValueSource|CsvSource)/.test(t)) tc.vacuous = true; }
          const to = /^@(\w+\.)*Timeout\s*\(\s*(?:value\s*=\s*)?(\d+)/.exec(t); if (to) tc.timeout = { line: line(a), ms: parseInt(to[2]!, 10) * 1000 };
          if (/^@(\w+\.)*Test\s*\(.*expected\s*=/.test(t)) tc.assertions.push({ line: line(a), strength: 'strong', text: head(t), subject: 'exception', reachable: true });
        }
        void modText;
        tc.assertions = assertionsIn(mb, helpers);
        tc.mocks = mocksIn(mb);
        tc.tolerances = tolerancesIn(mb);
        tc.swallowed = swallowedIn(mb);
        walk(mb, (n) => {
          if (n.type !== 'method_invocation') return;
          const nm = n.childForFieldName('name')?.text ?? '';
          if (/^(assumeTrue|assumeFalse|assumeThat|assumeNotNull|assumingThat|abort)$/.test(nm) && !tc.skip) tc.skip = { line: line(n), marker: head(n.text), conditional: true };
        });
        const first = tc.assertions[0]?.line ?? Infinity;
        walk(mb, (n) => { if (n.type === 'lambda_expression' || n.type === 'class_body') return false; if (n.type === 'return_statement' && line(n) < first) tc.earlyExits++; });
        for (const loop of descendants(mb, ['for_statement', 'enhanced_for_statement'])) {
          const lb = loop.childForFieldName('body'); if (!lb) continue;
          if (tc.assertions.some((a) => a.line >= line(loop) && a.line <= lb.endPosition.row + 1)) { tc.parametrized = true; tc.data += normalizeBody(loop.childForFieldName('value')?.text ?? loop.childForFieldName('condition')?.text ?? '') + '\n'; }
        }
        model.tests.push(tc);
      }
    }
    return model;
  });
}

const CONST_FALSE = new Set(['false', '0', 'null']);
function reachable(n: SyntaxNode, body: SyntaxNode): boolean {
  let cur: SyntaxNode | null = n;
  while (cur && cur.id !== body.id) {
    const p: SyntaxNode | null = cur.parent;
    if (!p) break;
    if (p.type === 'if_statement') {
      const c = (p.childForFieldName('condition')?.text ?? '').replace(/^\((.*)\)$/, '$1').replace(/\s+/g, '');
      const v = CONST_FALSE.has(c) ? false : /^(true|1)$/.test(c) ? true : /^(\d+)==(\d+)$/.test(c) ? c.split('==')[0] === c.split('==')[1] : null;
      if (v === false && cur.id === p.childForFieldName('consequence')?.id) return false;
      if (v === true && cur.id === p.childForFieldName('alternative')?.id) return false;
    }
    if (p.type === 'block') for (const sib of named(p)) { if (sib.id === cur.id) break; if (sib.type === 'return_statement' || sib.type === 'throw_statement') return false; }
    if (p.type === 'lambda_expression') {
      const gp = p.parent;
      const asArg = !!gp && gp.type === 'argument_list';
      if (!asArg) {
        const decl = ancestor(p, ['local_variable_declaration'], body);
        const nm = descendants(decl ?? p, 'variable_declarator')[0]?.childForFieldName('name')?.text ?? '';
        if (!nm || !new RegExp(`\\b${nm}\\s*\\.\\s*\\w+\\s*\\(`).test(body.text)) return false;
      }
    }
    cur = p;
  }
  return true;
}

function chainMethods(n: SyntaxNode): { root: string; names: string[]; rootArgs: SyntaxNode[] } {
  const names: string[] = []; let cur: SyntaxNode | null = n; let root = ''; let rootArgs: SyntaxNode[] = [];
  while (cur && cur.type === 'method_invocation') {
    names.unshift(cur.childForFieldName('name')?.text ?? '');
    const obj = cur.childForFieldName('object');
    if (!obj) { root = names.shift() ?? ''; rootArgs = named(cur.childForFieldName('arguments')); break; }
    if (obj.type !== 'method_invocation') { root = obj.text; break; }
    cur = obj;
  }
  return { root, names, rootArgs };
}

function assertionsIn(body: SyntaxNode, helpers: Set<string> = new Set()): Assertion[] {
  const out: Assertion[] = [];
  const seen = new Set<number>();
  walk(body, (n) => {
    if (n.type !== 'method_invocation') return;
    if (seen.has(n.id)) return false;
    const { root, names, rootArgs } = chainMethods(n);
    const last = names[names.length - 1] ?? '';
    const args = named(n.childForFieldName('arguments'));
    const argT = args.map((a) => a.text.replace(/\s+/g, ''));
    const push = (strength: Assertion['strength'], subject: string) => { seen.add(n.id); out.push({ line: line(n), strength, text: head(n.text), subject: subject.slice(0, 80), reachable: reachable(n, body) }); };
    const nm = n.childForFieldName('name')?.text ?? '';
    // JUnit / TestNG static assertions
    if ((JUNIT_STRONG.has(nm) || JUNIT_WEAK.has(nm)) && (!n.childForFieldName('object') || /^(Assert|Assertions|Assert\.|org\.junit)/.test(n.childForFieldName('object')?.text ?? ''))) {
      let strength: Assertion['strength'] = JUNIT_STRONG.has(nm) ? 'strong' : 'weak';
      if (/^assert(Not)?Equals$/.test(nm) && argT.length >= 2 && argT[0] === argT[1]) strength = 'weak';
      if (nm === 'assertTrue' && argT[0] === 'true') strength = 'weak';
      if (/^assert(True|False)$/.test(nm) && argT[0] && /\.\w+\([^)]+\)|==|!=|<=|>=|\binstanceof\b/.test(argT[0]) && !/^(true|false)$/.test(argT[0]) && !/(>=?|<=?)[01]$|^[01](>=?|<=?)/.test(argT[0])) strength = 'strong';
      if (nm === 'assertNull') strength = 'strong';
      if (nm === 'assertEquals' && argT.length >= 3 && /^[\d.]+[fdFD]?$/.test(argT[2]!) && parseFloat(argT[2]!) >= 100) strength = 'weak';
      push(strength, argT[1] ?? argT[0] ?? '');
      return false;
    }
    // AssertJ: assertThat(x).isEqualTo(y) ; Truth: assertThat(x).isEqualTo(y)
    const truthLike = root === 'assertThat' || root === 'assertWithMessage' || ((root === 'expect' || root === 'assert_' || root === 'truth') && names[0] === 'that') || (root.endsWith('.assertThat')) || names[0] === 'that';
    if (truthLike && names.length > 0 && names.some((x) => ASSERTJ_STRONG.has(x) || ASSERTJ_WEAK.has(x))) {
      const matcher = [...names].reverse().find((x) => ASSERTJ_STRONG.has(x) || ASSERTJ_WEAK.has(x))!;
      let strength: Assertion['strength'] = ASSERTJ_STRONG.has(matcher) ? 'strong' : 'weak';
      const thatIdx = names.indexOf('that');
      const subjNode = thatIdx >= 0 ? (() => { let c: SyntaxNode | null = n; for (let i = names.length - 1; i > thatIdx; i--) c = c?.childForFieldName('object') ?? null; return c ? named(c.childForFieldName('arguments'))[0] : undefined; })() : rootArgs[0];
      const subj = subjNode?.text.replace(/\s+/g, '') ?? '';
      // isTrue()/isFalse() over a specific boolean call (list.contains(x), a.equals(b), s.startsWith(p)) is a specific check
      if (/^is(True|False)$/.test(matcher) && /\.\w+\([^)]+\)|==|!=|<=|>=|\binstanceof\b/.test(subj) && !/(>=?|<=?)[01]$|^[01](>=?|<=?)/.test(subj)) strength = 'strong';
      if (/^is(Not)?EqualTo$/.test(matcher) && argT[0] === subj) strength = 'weak';
      if (matcher === 'isCloseTo') { const d = /within\(\s*([\d.]+)/.exec(n.text) ?? /offset\(\s*([\d.]+)/.exec(n.text); if (d && parseFloat(d[1]!) >= 100) strength = 'weak'; }
      push(strength, subj);
      return false;
    }
    // Hamcrest: assertThat(x, is(y)) / assertThat(x, equalTo(y))
    if (nm === 'assertThat' && args.length >= 2) {
      const m = args[args.length - 1]!; const mn = m.type === 'method_invocation' ? m.childForFieldName('name')?.text ?? '' : '';
      push(HAMCREST_STRONG.test(mn) && !/^is$/.test(mn) ? 'strong' : mn === 'is' && /^is\(\s*(equalTo|not|instanceOf|sameInstance|closeTo|greaterThan|lessThan)\b/.test(m.text) ? 'strong' : mn === 'is' && /^is\(\s*(true|false|nullValue|notNullValue|empty|emptyOrNullString)\b/.test(m.text) ? 'weak' : mn === 'is' ? 'strong' : /^(nullValue|notNullValue|not|anything|isA)$/.test(mn) ? 'weak' : 'strong', argT[0] ?? '');
      return false;
    }
    // helper methods named like assertions (assertUser(...), MoreAsserts.assertEqualsAndHashCode(...), checkInvariants(...))
    const objText = n.childForFieldName('object')?.text ?? '';
    if (objText === '' && helpers.has(nm)) { push('strong', argT[0] ?? ''); return false; }
    if (/^(assert|check|verify|expect|ensure|validate)[A-Z_]/.test(nm) && !/^verify$/.test(nm) && (objText === '' || /^[A-Z]\w*$/.test(objText) || /Assert|Truth|Expect|Check/.test(objText))) { push('strong', argT[0] ?? ''); return false; }
    // Mockito verify(mock).method(...) counts as a strong interaction assertion
    if (root === 'verify' && names.length > 0) { push('strong', rootArgs[0]?.text ?? ''); return false; }
  });
  return out;
}

function mocksIn(body: SyntaxNode): Mock[] {
  const out: Mock[] = [];
  walk(body, (n) => {
    if (n.type !== 'method_invocation') return;
    const nm = n.childForFieldName('name')?.text ?? '';
    const args = named(n.childForFieldName('arguments'));
    if (/^(mock|spy|mockStatic|mockConstruction)$/.test(nm) && args[0]) { const ty = args[0].text.replace(/\.class$/, ''); out.push({ line: line(n), target: ty, text: head(n.text), literal: false, wholeModule: true }); return false; }
    if (nm === 'when' && args[0]?.type === 'method_invocation') { const obj = args[0].childForFieldName('object')?.text ?? ''; const meth = args[0].childForFieldName('name')?.text ?? ''; if (obj) out.push({ line: line(n), target: `${obj}#${meth}`, text: head(n.text), literal: false, wholeModule: false }); return false; }
    if (/^(doReturn|doThrow|doAnswer|doNothing)$/.test(nm)) { const chain = n.parent?.parent; const whenCall = chain?.type === 'method_invocation' && chain.childForFieldName('name')?.text === 'when' ? chain : null; const target = whenCall ? named(whenCall.childForFieldName('arguments'))[0]?.text ?? '' : ''; if (target) out.push({ line: line(n), target: `${target}#*`, text: head(n.text), literal: false, wholeModule: false }); }
  });
  return out;
}

function tolerancesIn(body: SyntaxNode): Tolerance[] {
  const out: Tolerance[] = [];
  walk(body, (n) => {
    if (n.type !== 'method_invocation') return;
    const nm = n.childForFieldName('name')?.text ?? '';
    const args = named(n.childForFieldName('arguments')).map((a) => a.text.replace(/\s+/g, ''));
    if (/^assert(Array)?Equals$/.test(nm) && args.length >= 3 && /^[\d.eE+-]+[fdFD]?$/.test(args[2]!)) out.push({ line: line(n), looseness: parseFloat(args[2]!), kind: 'delta', text: head(n.text), key: `${args[1]}|${nm}|${args[0]}` });
    if (nm === 'isCloseTo') { const d = /(within|offset|byLessThan)\(\s*([\d.eE+-]+)/.exec(n.text); if (d) out.push({ line: line(n), looseness: parseFloat(d[2]!), kind: 'delta', text: head(n.text), key: `${n.childForFieldName('object')?.text.replace(/\s+/g, '') ?? ''}|isCloseTo|${args[0] ?? ''}` }); }
    if (nm === 'closeTo' && args.length >= 2 && /^[\d.eE+-]+$/.test(args[1]!)) out.push({ line: line(n), looseness: parseFloat(args[1]!), kind: 'delta', text: head(n.text), key: `${args[0]}|closeTo` });
  });
  return out;
}

function swallowedIn(body: SyntaxNode): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (const t of descendants(body, 'try_statement')) {
    const tb = t.childForFieldName('body'); if (!tb) continue;
    const handlers = named(t).filter((c) => c.type === 'catch_clause');
    if (handlers.length === 0) continue;
    const inner = assertionsIn(tb); if (inner.length === 0) continue;
    const swallowing = handlers.some((h) => { const hb = h.childForFieldName('body') ?? h; return descendants(hb, 'throw_statement').length === 0 && assertionsIn(hb).length === 0 && !/\bfail\s*\(/.test(hb.text); });
    if (swallowing) out.push(...inner.map((a) => ({ line: a.line, text: a.text })));
  }
  return out;
}
