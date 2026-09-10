import { withTree, walk, descendants, ancestor, countErrors, line, unquote, named, type SyntaxNode } from '../parser.js';
import type { Assertion, Mock, TestCase, TestFileModel, Tolerance } from '../model.js';

/**
 * Go: the standard testing package (t.Error and t.Fatal inside if checks, t.Skip, t.Run subtests, table-driven loops)
 * and testify's assert/require packages.
 */

const TESTIFY_STRONG = new Set(['Equal', 'NotEqual', 'EqualValues', 'Exactly', 'Len', 'Contains', 'NotContains', 'ElementsMatch', 'JSONEq', 'YAMLEq', 'ErrorIs', 'ErrorAs', 'ErrorContains', 'EqualError', 'NoError', 'Error', 'NoErrorf', 'Errorf', 'InDelta', 'InEpsilon', 'Regexp', 'Same', 'NotSame', 'Subset', 'NotSubset', 'Greater', 'GreaterOrEqual', 'Less', 'LessOrEqual', 'WithinDuration', 'EqualExportedValues', 'Equalf', 'NotEqualf', 'Lenf', 'Containsf', 'ErrorIsf', 'EqualErrorf', 'InDeltaf', 'Regexpf', 'Positive', 'Negative', 'FileExists', 'DirExists', 'HTTPStatusCode', 'HTTPBodyContains']);
const TESTIFY_WEAK = new Set(['True', 'False', 'Nil', 'NotNil', 'Empty', 'NotEmpty', 'Zero', 'NotZero', 'IsType', 'Implements', 'Truef', 'Falsef', 'Nilf', 'NotNilf', 'Emptyf', 'NotEmptyf', 'Panics', 'NotPanics', 'Eventually', 'Never', 'Condition', 'Fail', 'FailNow']);
const FAIL_CALLS = /^(Error|Errorf|Fatal|Fatalf|Fail|FailNow)$/;
/** Names that make a call count as an assertion on the strength of the name alone. */
const HELPER_NAME = /^(assert|check|verify|expect|require|must)[A-Z_]/;

/**
 * A helper is credited as a strong assertion because of its name or because it receives `t`. Neither is evidence
 * that it can fail, so `func checkValue(t *testing.T, got int) {}` would otherwise stand in for a real check and
 * take the whole test-integrity family down with it. A helper whose body cannot fail is not an assertion.
 */
function canFail(body: SyntaxNode): boolean {
  let fails = false;
  walk(body, (n) => {
    if (fails) return false;
    if (n.type === 'call_expression') {
      const f = n.childForFieldName('function');
      const field = f?.type === 'selector_expression' ? f.childForFieldName('field')?.text ?? '' : '';
      const name = f?.type === 'identifier' ? f.text : '';
      // t.Fatal and friends, testify, a panic, or delegation to another helper that is itself named like one.
      if (FAIL_CALLS.test(field) || TESTIFY_STRONG.has(field) || TESTIFY_WEAK.has(field) || name === 'panic' || HELPER_NAME.test(name) || HELPER_NAME.test(field)) { fails = true; return false; }
    }
    return undefined;
  });
  return fails;
}
const SKIP_CALLS = /^(Skip|Skipf|SkipNow)$/;

function head(t: string): string { return t.split('\n')[0]!.slice(0, 120); }

export function normalizeBody(t: string): string {
  return t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export async function extractGo(filePath: string, source: string): Promise<TestFileModel> {
  return withTree(source, 'go', (tree) => {
    const root = tree.rootNode;
    const model: TestFileModel = { path: filePath, lang: 'go', tests: [], fileMocks: [], fileSkip: null, fileRetry: null, parseErrors: countErrors(tree), shadowed: [], imports: {} };
    // a build constraint that excludes the file from every normal build hides all of its tests
    const constraint = source.split('\n').slice(0, 20).find((l) => /^\/\/\s*(go:build|\+build)\s+(ignore|never|false|\w+_disabled)/.test(l.trim()));
    if (constraint) model.fileSkip = { line: source.split('\n').indexOf(constraint) + 1, marker: constraint.trim().slice(0, 80) };
    // TestMain owns the package's test run. If it never calls m.Run(), nothing in the package runs.
    for (const fn of descendants(root, 'function_declaration')) {
      if (fn.childForFieldName('name')?.text !== 'TestMain') continue;
      const b = fn.childForFieldName('body'); if (!b) continue;
      const mVar = /\(\s*(\w+)\s+\*testing\.M\b/.exec(fn.childForFieldName('parameters')?.text ?? '')?.[1];
      if (!mVar) continue;
      const runs = descendants(b, 'call_expression').some((c) => {
        const f = c.childForFieldName('function');
        return f?.type === 'selector_expression' && f.childForFieldName('operand')?.text === mVar && f.childForFieldName('field')?.text === 'Run';
      });
      if (!runs) model.fileSkip = { line: line(fn), marker: `TestMain does not call ${mVar}.Run(): no test in this package runs` };
    }
    // imports: alias or last path segment -> import path
    for (const spec of descendants(root, 'import_spec')) {
      const p = spec.childForFieldName('path'); const nm = spec.childForFieldName('name');
      if (!p) continue;
      const ip = unquote(p.text); const alias = nm?.text ?? ip.split('/').pop() ?? ip;
      if (alias !== '_' && alias !== '.') model.imports[alias] = ip;
    }
    // module-level tables: var/const slices used as test data
    const constants = new Map<string, string>();
    for (const vs of descendants(root, ['var_spec', 'const_spec'])) {
      if (ancestor(vs, ['function_declaration', 'method_declaration'])) continue;
      const nm = vs.childForFieldName('name')?.text; const v = vs.childForFieldName('value');
      if (nm && v) constants.set(nm, normalizeBody(v.text));
    }
    const expandData = (t: string): string => { const k = t.trim(); return constants.has(k) ? `${k}\n${constants.get(k)}` : t; };

    // Helpers in this file that are credited as assertions but cannot fail. Calls to them are not counted.
    const noopHelpers = new Set<string>();
    for (const fn of descendants(root, 'function_declaration')) {
      const nm = fn.childForFieldName('name')?.text ?? '';
      const b = fn.childForFieldName('body');
      if (!b || /^(Test|Example|Fuzz|Benchmark)[A-Z_]/.test(nm)) continue;
      const takesT = /\*testing\.[TBF]\b/.test(fn.childForFieldName('parameters')?.text ?? '');
      if (!takesT && !HELPER_NAME.test(nm)) continue;
      if (!canFail(b)) { noopHelpers.add(nm); model.shadowed.push({ line: line(fn), name: nm }); }
    }

    for (const fn of descendants(root, 'function_declaration')) {
      const name = fn.childForFieldName('name')?.text ?? '';
      const body = fn.childForFieldName('body');
      if (!body) continue;
      if (!/^Test[A-Z_]/.test(name) && !/^(Example|Fuzz)[A-Z_]/.test(name)) continue;
      const params = fn.childForFieldName('parameters')?.text ?? '';
      const tVar = (/\(\s*(\w+)\s+\*testing\.(T|F)\b/.exec(params)?.[1]) ?? 't';
      const tc = mkTest(name, fn, body, tVar, constants, expandData, model, noopHelpers);
      model.tests.push(tc);
      const subs: TestCase[] = [];
      // subtests: t.Run("name", func(t *testing.T) { ... })
      walk(body, (n) => {
        if (n.type !== 'call_expression') return;
        const f = n.childForFieldName('function');
        if (f?.type !== 'selector_expression' || f.childForFieldName('field')?.text !== 'Run') return;
        const args = named(n.childForFieldName('arguments'));
        const lit = args.find((a) => a.type === 'func_literal');
        if (!lit) return;
        const subBody = lit.childForFieldName('body'); if (!subBody) return;
        const nameArg = args[0];
        const subName = nameArg && /string_literal/.test(nameArg.type) ? unquote(nameArg.text) : `<${normalizeBody(nameArg?.text ?? 'sub').slice(0, 60)}>`;
        const subT = (/\(\s*(\w+)\s+\*testing\.T\b/.exec(lit.childForFieldName('parameters')?.text ?? '')?.[1]) ?? tVar;
        const sub = mkTest(`${name} > ${subName}`, n, subBody, subT, constants, expandData, model, noopHelpers);
        // a subtest inside a table loop is data-driven
        const loop = ancestor(n, ['for_statement'], body);
        if (loop) { sub.parametrized = true; sub.data = expandData(normalizeBody(loop.childForFieldName('right')?.text ?? descendants(loop, 'range_clause')[0]?.childForFieldName('right')?.text ?? '')) + '\n'; }
        model.tests.push(sub);
        subs.push(sub);
        return false;
      });
      // a parent whose checks all live in subtests is not an assertion-free test
      if (tc.assertions.length === 0 && subs.length > 0) tc.assertions = subs.flatMap((s) => s.assertions);
    }
    return model;
  });
}

function mkTest(name: string, node: SyntaxNode, body: SyntaxNode, tVar: string, constants: Map<string, string>, expandData: (t: string) => string, model: TestFileModel, noopHelpers: Set<string> = new Set()): TestCase {
  const tc: TestCase = {
    name, line: line(node), assertions: [], skip: null, only: null, mocks: [], swallowed: [], retry: null, tolerances: [], timeout: null,
    body: normalizeBody(body.text), earlyExits: 0, parametrized: false, vacuous: false, data: '',
  };
  const inSubtest = (n: SyntaxNode) => !!ancestor(n, ['func_literal'], body);
  walk(body, (n) => {
    if (n.type === 'func_literal' && n.id !== body.id && isSubtestLiteral(n)) return false; // subtests are their own tests
    if (n.type !== 'call_expression') return;
    const f = n.childForFieldName('function');
    const args = named(n.childForFieldName('arguments'));
    if (f?.type !== 'selector_expression') return;
    const obj = f.childForFieldName('operand')?.text ?? ''; const field = f.childForFieldName('field')?.text ?? '';
    const reach = reachable(n, body);
    if (obj === tVar && SKIP_CALLS.test(field) && !tc.skip) {
      tc.skip = { line: line(n), marker: head(n.text), conditional: !!ancestor(n, ['if_statement'], body) };
      return false;
    }
    if (obj === tVar && FAIL_CALLS.test(field)) {
      // the check is the enclosing if condition; a report with no condition always fires (weak, and suspicious in the other direction)
      const iff = ancestor(n, ['if_statement'], body);
      const cond = iff?.childForFieldName('condition');
      const strength = cond ? classifyCondition(cond) : 'weak';
      tc.assertions.push({ line: line(n), strength, text: head(cond ? `if ${cond.text} { ${field} }` : n.text), subject: cond ? subjectOf(cond) : '', reachable: reach });
      return false;
    }
    if ((obj === 'assert' || obj === 'require' || /^(assert|require)$/.test(model.imports[obj] ? obj : '')) && (TESTIFY_STRONG.has(field) || TESTIFY_WEAK.has(field))) {
      const a = args.filter((x) => x.text !== tVar);
      const subj = a[0]?.text.replace(/\s+/g, '') ?? '';
      let strength: Assertion['strength'] = TESTIFY_STRONG.has(field) ? 'strong' : 'weak';
      if (/^(Greater|Less)(OrEqual)?$/.test(field) && a[1] && /^[01]$/.test(a[1].text)) strength = 'weak';
      if (/^Equal/.test(field) && a.length >= 2 && a[0]!.text.replace(/\s+/g, '') === a[1]!.text.replace(/\s+/g, '')) strength = 'weak'; // tautology
      if (field === 'InDelta' || field === 'InEpsilon' || field === 'InDeltaf') {
        const d = a[2]?.text; const delta = d && /^[\d.eE+-]+$/.test(d) ? parseFloat(d) : NaN;
        if (!isNaN(delta)) tc.tolerances.push({ line: line(n), looseness: delta, kind: 'delta', text: head(n.text), key: `${subj}|${field}|${a[1]?.text.replace(/\s+/g, '') ?? ''}` });
        const expected = a[1]?.text ?? ''; const v = /^-?[\d.]+$/.test(expected) ? Math.abs(parseFloat(expected)) : NaN;
        if (!isNaN(delta) && (isNaN(v) ? delta >= 100 : delta >= Math.max(v / 2, 0.5))) strength = 'weak';
      }
      tc.assertions.push({ line: line(n), strength, text: head(n.text), subject: subj, reachable: reach });
      return false;
    }
    if (obj === 'monkey' && /^Patch(Instance)?$/.test(field) && args[0]) {
      tc.mocks.push({ line: line(n), target: args[0].text.replace(/\s+/g, ''), text: head(n.text), literal: false, wholeModule: false });
      return false;
    }
  });
  // helpers that receive `t` can fail the test: they count as assertions, as do helpers named like assertions
  walk(body, (n) => {
    if (n.type === 'func_literal' && isSubtestLiteral(n)) return false;
    if (n.type !== 'call_expression') return;
    const f = n.childForFieldName('function');
    const args = named(n.childForFieldName('arguments'));
    const nm = f?.type === 'identifier' ? f.text : f?.type === 'selector_expression' ? f.childForFieldName('field')?.text ?? '' : '';
    const recv = f?.type === 'selector_expression' ? f.childForFieldName('operand')?.text ?? '' : '';
    const takesT = args.some((a) => a.type === 'identifier' && a.text === tVar) && recv !== tVar && !/^(Run|Parallel|Log|Logf|Helper|Cleanup|Setenv|TempDir|Name|Deadline)$/.test(nm);
    if (noopHelpers.has(nm)) return;
    if ((takesT || HELPER_NAME.test(nm)) && !tc.assertions.some((a) => a.line === line(n))) {
      const subj = args.find((a) => !(a.type === 'identifier' && a.text === tVar))?.text.replace(/\s+/g, '') ?? '';
      tc.assertions.push({ line: line(n), strength: 'strong', text: head(n.text), subject: subj, reachable: reachable(n, body) });
    }
  });
  const firstAssert = tc.assertions[0]?.line ?? Infinity;
  walk(body, (n) => { if (n.type === 'func_literal') return false; if (n.type === 'return_statement' && line(n) < firstAssert) tc.earlyExits++; });
  if (!tc.parametrized) {
    for (const loop of descendants(body, 'for_statement')) {
      if (ancestor(loop, ['func_literal'], body)) continue;
      const lb = loop.childForFieldName('body'); if (!lb) continue;
      if (tc.assertions.some((a) => a.line >= line(loop) && a.line <= lb.endPosition.row + 1)) { tc.parametrized = true; const rc = descendants(loop, 'range_clause')[0]; tc.data += expandData(normalizeBody(rc?.childForFieldName('right')?.text ?? '')) + '\n'; }
    }
  }
  void inSubtest; void constants;
  return tc;
}

function isSubtestLiteral(lit: SyntaxNode): boolean {
  const call = lit.parent?.parent;
  if (!call || call.type !== 'call_expression') return false;
  const f = call.childForFieldName('function');
  return f?.type === 'selector_expression' && f.childForFieldName('field')?.text === 'Run';
}

const CONST_FALSE = new Set(['false', '0', 'nil', '""']);
function reachable(n: SyntaxNode, body: SyntaxNode): boolean {
  let cur: SyntaxNode | null = n;
  while (cur && cur.id !== body.id) {
    const p: SyntaxNode | null = cur.parent;
    if (!p) break;
    if (p.type === 'return_statement') return false; // `return` on its own line absorbs the next statement in the parse
    if (p.type === 'if_statement' && cur.id === p.childForFieldName('consequence')?.id) {
      const c = p.childForFieldName('condition')?.text.replace(/\s+/g, '') ?? '';
      if (CONST_FALSE.has(c) || /^(\d+)==(\d+)$/.test(c) && c.split('==')[0] !== c.split('==')[1] || /^\d+!=\d+$/.test(c) && c.split('!=')[0] === c.split('!=')[1]) return false;
    }
    if (p.type === 'if_statement' && cur.id === p.childForFieldName('alternative')?.id && /^(true|1)$/.test(p.childForFieldName('condition')?.text.trim() ?? '')) return false;
    if (p.type === 'block' || p.type === 'statement_list' || p.type === 'source_file') {
      for (const sib of named(p)) { if (sib.id === cur.id) break; if (sib.type === 'return_statement') return false; }
    }
    if (p.type === 'func_literal' && !isSubtestLiteral(p)) {
      // a closure is reachable when it is a call argument, invoked immediately, or stored in a variable that is called somewhere in the body
      const gp = p.parent;
      const asArg = !!gp && (gp.type === 'argument_list' || gp.type === 'call_expression' || gp.type === 'go_statement' || gp.type === 'defer_statement');
      if (!asArg) {
        const decl = ancestor(p, ['short_var_declaration', 'var_spec', 'assignment_statement'], body);
        const nm = decl?.childForFieldName('left')?.text ?? decl?.childForFieldName('name')?.text ?? '';
        // assigned to a field, map entry or index (cmd.Run = func...): the framework calls it
        if (nm && /[.\[]/.test(nm)) { cur = p; continue; }
        if (!nm || !new RegExp(`(^|[^\\w.])${nm.replace(/[^\w]/g, '')}\\s*\\(`).test(body.text)) return false;
      }
    }
    cur = p;
  }
  return true;
}

function classifyCondition(cond: SyntaxNode): Assertion['strength'] {
  const t = cond.text.replace(/\s+/g, '');
  const m = /^(.+?)(==|!=|<=|>=|<|>)(.+)$/.exec(t);
  if (!m) {
    if (/^!?\w+(\.\w+)*$/.test(t)) return 'weak'; // bare flag
    const call = /^!?([\w.]+)\((.*)\)$/.exec(t);
    if (call) return call[2]!.split(',').length >= 2 || /DeepEqual|cmp\.(Equal|Diff)|errors\.(Is|As)|strings\.(Contains|HasPrefix|HasSuffix|EqualFold)|bytes\.Equal|MatchString/.test(call[1]!) ? 'strong' : 'weak';
    return 'weak';
  }
  const [, a, op, b] = m;
  if (a === b) return 'weak';
  if (/^(nil|true|false)$/.test(a!) || /^(nil|true|false)$/.test(b!)) return op === '!=' && (a === 'nil' || b === 'nil') ? 'strong' : 'weak'; // err != nil { t.Fatal } is a real check; x == true is truthiness
  if ((op === '>' || op === '>=' || op === '<' || op === '<=') && (/^[01]$/.test(a!) || /^[01]$/.test(b!))) return 'weak';
  return 'strong';
}

function subjectOf(cond: SyntaxNode): string {
  const t = cond.text.replace(/\s+/g, '');
  const m = /^(.+?)(==|!=|<=|>=|<|>)/.exec(t);
  return (m ? m[1]! : t).replace(/^!/, '').slice(0, 80);
}

export const _internals = { classifyCondition, TESTIFY_STRONG, TESTIFY_WEAK };
export type { Mock, Tolerance };
