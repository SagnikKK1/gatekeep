import { withTree, walk, descendants, ancestor, countErrors, line, unquote, named, kids } from '../parser.js';
const STRONG_UNITTEST = new Set([
    'assertEqual', 'assertEquals', 'assertNotEqual', 'assertIs', 'assertIsNot', 'assertIsNone', 'assertDictEqual',
    'assertListEqual', 'assertTupleEqual', 'assertSetEqual', 'assertSequenceEqual', 'assertMultiLineEqual',
    'assertRaises', 'assertRaisesRegex', 'assertRegex', 'assertNotRegex', 'assertAlmostEqual', 'assertNotAlmostEqual',
    'assertIn', 'assertNotIn', 'assertCountEqual', 'assertGreater', 'assertLess', 'assertGreaterEqual',
    'assertLessEqual', 'assertWarns', 'assertWarnsRegex', 'assertLogs', 'assertNoLogs',
]);
const WEAK_UNITTEST = new Set(['assertTrue', 'assertFalse', 'assertIsNotNone', 'assertIsInstance', 'assertNotIsInstance']);
const BROAD_EXC = new Set(['Exception', 'BaseException']);
const HELPER_NAME = /^(assert|check|verify|expect|ensure|validate|confirm)([_A-Z]|$)/;
const CONST_FALSE = new Set(['False', '0', 'None', '""', "''", '0.0', '[]', '{}', '()']);
const CONST_TRUE = new Set(['True', '1', 'not False']);
/** Fold trivially constant conditions: `1 == 2`, `"a" == "b"`, `not True`, `2 > 3`. */
function constValue(cond) {
    const c = cond.replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/, '$1');
    if (CONST_FALSE.has(c))
        return false;
    if (CONST_TRUE.has(c))
        return true;
    const m = /^(-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')\s*(==|!=|<|>|<=|>=)\s*(-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')$/.exec(c);
    if (m) {
        const [, a, op, b] = m;
        const na = parseFloat(a), nb = parseFloat(b);
        const num = !isNaN(na) && !isNaN(nb);
        switch (op) {
            case '==': return num ? na === nb : a === b;
            case '!=': return num ? na !== nb : a !== b;
            case '<': return num && na < nb;
            case '>': return num && na > nb;
            case '<=': return num && na <= nb;
            case '>=': return num && na >= nb;
        }
    }
    const n = /^not (.+)$/.exec(c);
    if (n) {
        const v = constValue(n[1]);
        return v === null ? null : !v;
    }
    return null;
}
const SKIP_CALLS = /^(pytest\.skip|self\.skipTest|unittest\.SkipTest|pytest\.xfail|pytest\.importorskip)$/;
export function normalizeBody(t) {
    return t.replace(/#.*$/gm, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
function head(t) { return t.split('\n')[0].slice(0, 120); }
function helperBase(n) { return n.replace(/^_+/, ''); }
const BUILTINS = new Set(['len', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'bool', 'abs', 'min', 'max', 'sum', 'sorted', 'range', 'True', 'False', 'None', 'isinstance', 'type', 'repr', 'round', 'any', 'all', 'print', 'approx', 'pytest']);
const ALWAYS_TRUE_COND = /^(True|1|not\s+False|(\d+)\s*==\s*\2|"[^"]+"|'[^']+')$/;
/** Identifiers in an expression that are not builtins: an assertion with none is about constants only. */
function freeIdentifiers(text) {
    return (text.match(/[A-Za-z_]\w*/g) ?? []).filter((x) => !BUILTINS.has(x));
}
/** Simple `name = expr` assignments in a body, normalized. */
function assignmentsIn(body) {
    const m = new Map();
    for (const a of descendants(body, 'assignment')) {
        const l = a.childForFieldName('left');
        const r = a.childForFieldName('right');
        if (l?.type === 'identifier' && r)
            m.set(l.text, r.text.replace(/\s+/g, ''));
    }
    return m;
}
export async function extractPython(filePath, source) {
    return withTree(source, 'python', (tree) => {
        const root = tree.rootNode;
        const model = { path: filePath, lang: 'python', tests: [], fileMocks: [], fileSkip: null, fileRetry: null, parseErrors: countErrors(tree), shadowed: [], imports: {} };
        // imports: local name -> dotted module or module.attr
        for (const imp of descendants(root, ['import_statement', 'import_from_statement'])) {
            if (imp.type === 'import_statement') {
                for (const c of named(imp)) {
                    if (c.type === 'dotted_name')
                        model.imports[c.text] = c.text;
                    else if (c.type === 'aliased_import') {
                        const nm = c.childForFieldName('name')?.text ?? '';
                        const al = c.childForFieldName('alias')?.text ?? nm;
                        model.imports[al] = nm;
                    }
                }
            }
            else {
                const mod = imp.childForFieldName('module_name')?.text ?? '';
                for (const c of named(imp)) {
                    if (c.id === imp.childForFieldName('module_name')?.id)
                        continue;
                    if (c.type === 'dotted_name')
                        model.imports[c.text] = `${mod}.${c.text}`;
                    else if (c.type === 'aliased_import') {
                        const nm = c.childForFieldName('name')?.text ?? '';
                        const al = c.childForFieldName('alias')?.text ?? nm;
                        model.imports[al] = `${mod}.${nm}`;
                    }
                }
            }
        }
        // module-level pytestmark skip
        for (const asg of descendants(root, 'assignment')) {
            const left = asg.childForFieldName('left');
            const right = asg.childForFieldName('right');
            if (left?.text === 'pytestmark' && right && /\b(skip|skipif|xfail)\b/.test(right.text) && !ancestor(asg, ['function_definition', 'class_definition'])) {
                model.fileSkip = { line: line(asg), marker: right.text.slice(0, 80) };
            }
        }
        const ctx = { helpers: new Set(), noopHelpers: new Set(), imports: model.imports };
        // Local decorators whose wrapper catches AssertionError (or everything) without re-raising: tests under them cannot fail.
        const swallowingDecorators = new Set();
        for (const st of named(root)) {
            const { node } = unwrapDecorated(st);
            if (node.type !== 'function_definition')
                continue;
            const nm = node.childForFieldName('name')?.text ?? '';
            if (!nm || nm.startsWith('test'))
                continue;
            const swallows = descendants(node, 'try_statement').some((t) => named(t).filter((c) => c.type === 'except_clause').some((h) => {
                const hb = named(h).find((c) => c.type === 'block') ?? h;
                const caught = named(h).filter((c) => c.type !== 'block').map((c) => c.text).join(' ');
                return (caught === '' || /AssertionError|BaseException|(^|\W)Exception\b/.test(caught)) && descendants(hb, 'raise_statement').length === 0;
            }));
            if (swallows && descendants(node, 'function_definition').length > 0)
                swallowingDecorators.add(nm);
        }
        // module-level constants, so a data table referenced by name (CASES) can be matched by content
        const constants = new Map();
        for (const st of named(root)) {
            const e = st.type === 'expression_statement' ? named(st)[0] : null;
            if (e && e.type === 'assignment') {
                const l = e.childForFieldName('left');
                const r = e.childForFieldName('right');
                if (l?.type === 'identifier' && r)
                    constants.set(l.text, normalizeBody(r.text));
            }
        }
        const expandData = (t) => { const k = t.trim(); return constants.has(k) ? `${k}\n${constants.get(k)}` : t; };
        // Pass 1: local helper functions (module-level and methods). Calls to asserting helpers count; no-op helpers do not.
        const classify = (fn) => {
            const nm = fn.childForFieldName('name')?.text ?? '';
            const body = fn.childForFieldName('body');
            if (!nm || nm.startsWith('test') || !body)
                return;
            const own = assertionsIn(body, { helpers: new Set(), noopHelpers: new Set(), imports: {} });
            const nestedAsserts = descendants(body, 'function_definition').some((f) => descendants(f, 'assert_statement').length > 0);
            if (own.some((a) => a.strength === 'strong') || nestedAsserts || descendants(body, 'raise_statement').length > 0)
                ctx.helpers.add(nm);
            else if (HELPER_NAME.test(helperBase(nm))) {
                ctx.noopHelpers.add(nm);
                model.shadowed.push({ line: line(fn), name: nm });
            }
        };
        for (const stmt of named(root)) {
            const { node } = unwrapDecorated(stmt);
            if (node.type === 'function_definition')
                classify(node);
            else if (node.type === 'class_definition')
                for (const m of named(node.childForFieldName('body'))) {
                    const { node: d } = unwrapDecorated(m);
                    if (d.type === 'function_definition')
                        classify(d);
                }
        }
        const visitFunction = (fn, classCtx) => {
            const name = fn.childForFieldName('name')?.text ?? '';
            const decorators = decoratorsOf(fn);
            const body = fn.childForFieldName('body');
            if (!body)
                return;
            if (!name.startsWith('test')) {
                // fixtures / helpers: any mocks inside apply file-wide (conservative)
                model.fileMocks.push(...mocksIn(body, decorators, ctx));
                return;
            }
            const qname = classCtx ? `${classCtx.name}.${name}` : name;
            const tc = {
                name: qname, line: line(fn), assertions: [], skip: null, only: null, mocks: [], swallowed: [], retry: null, tolerances: [], timeout: null,
                body: normalizeBody(body.text), earlyExits: 0, parametrized: false, vacuous: false, data: '',
            };
            if (classCtx?.skip)
                tc.skip = { line: line(classCtx.skip), marker: head(classCtx.skip.text), conditional: false };
            const allDecos = [...(classCtx?.decorators ?? []), ...decorators];
            for (const d of allDecos) {
                const t = d.text;
                const nm = decoratorName(d);
                const call = named(d).find((c) => c.type === 'call');
                const args = named(call?.childForFieldName('arguments'));
                const positional = args.filter((a) => a.type !== 'keyword_argument');
                const kw = new Map(args.filter((a) => a.type === 'keyword_argument').map((a) => [a.childForFieldName('name')?.text ?? '', a.childForFieldName('value')?.text ?? '']));
                if (/(^|\.)(skip|skipif|skipIf|skipUnless|xfail)$/.test(nm) && !tc.skip) {
                    const kind = nm.split('.').pop();
                    let conditional = false;
                    if (kind === 'skipif' || kind === 'skipIf' || kind === 'skipUnless') {
                        const cond = (positional[0]?.text ?? kw.get('condition') ?? '').trim();
                        conditional = !/^(True|False|1|0)$/.test(cond) && !ALWAYS_TRUE_COND.test(cond);
                    }
                    else if (kind === 'xfail') {
                        conditional = kw.get('strict') === 'True' || (positional[0] !== undefined && !/^(True|1)$/.test(positional[0].text));
                    }
                    tc.skip = { line: line(d), marker: t.slice(0, 80), conditional };
                }
                if (/(^|\.)(flaky|retry|retries|rerun|reruns|repeat_until_pass)$/i.test(nm) && !tc.retry)
                    tc.retry = { line: line(d), text: t.slice(0, 80) };
                if (/(^|\.)parametrize$/.test(nm)) {
                    tc.parametrized = true;
                    const data = positional[1] ?? kw.get('argvalues');
                    const dataText = typeof data === 'string' ? data : data?.text;
                    if (dataText !== undefined)
                        tc.data += expandData(normalizeBody(dataText)) + '\n';
                    if (dataText !== undefined && /^[\[(]\s*[\])]$/.test(dataText.trim()))
                        tc.vacuous = true;
                }
                const to = /(^|\.)timeout$/.test(nm) ? /\(\s*([\d.]+)/.exec(t) : null;
                if (to)
                    tc.timeout = { line: line(d), ms: Math.round(parseFloat(to[1]) * 1000) };
            }
            // body-level skip calls
            walk(body, (n) => {
                if (n.type === 'function_definition' || n.type === 'class_definition')
                    return false;
                if (n.type === 'call') {
                    const f = n.childForFieldName('function')?.text ?? '';
                    if (SKIP_CALLS.test(f) && !tc.skip) {
                        const conditional = !!ancestor(n, ['if_statement', 'except_clause', 'conditional_expression'], body);
                        tc.skip = { line: line(n), marker: n.text.slice(0, 80), conditional };
                    }
                }
                if (n.type === 'raise_statement' && /SkipTest/.test(n.text) && !tc.skip)
                    tc.skip = { line: line(n), marker: n.text.slice(0, 80), conditional: !!ancestor(n, ['if_statement', 'except_clause'], body) };
            });
            tc.assertions = assertionsIn(body, ctx);
            tc.earlyExits = earlyExitsBefore(body, tc.assertions[0]?.line ?? Infinity);
            const wrappedBySwallower = allDecos.some((d) => swallowingDecorators.has(decoratorName(d).split('.')[0] ?? ''));
            for (const f of descendants(body, 'for_statement')) {
                if (ancestor(f, ['function_definition'], body) || assertionsIn(f.childForFieldName('body') ?? f, ctx).length === 0)
                    continue;
                tc.parametrized = true;
                tc.data += expandData(normalizeBody(f.childForFieldName('right')?.text ?? '')) + '\n';
            }
            // unittest subTest loops: `with self.subTest(...)` inside a loop
            if (!tc.parametrized && descendants(body, 'with_statement').some((w) => /self\.subTest\(/.test(w.text)))
                tc.parametrized = true;
            tc.mocks = mocksIn(body, decorators, ctx);
            tc.tolerances = tolerancesIn(body);
            tc.swallowed = wrappedBySwallower ? tc.assertions.map((a) => ({ line: a.line, text: a.text })) : swallowedIn(body, ctx);
            model.tests.push(tc);
        };
        for (const stmt of named(root)) {
            const { node, decorators } = unwrapDecorated(stmt);
            if (node.type === 'function_definition')
                visitFunction(node, null);
            else if (node.type === 'class_definition') {
                const cname = node.childForFieldName('name')?.text ?? '';
                const cbody = node.childForFieldName('body');
                if (!cbody)
                    continue;
                let classSkip = null;
                for (const member of named(cbody)) {
                    const e = member.type === 'expression_statement' ? named(member)[0] : null;
                    if (e?.type === 'assignment' && e.childForFieldName('left')?.text === 'pytestmark' && /\b(skip|skipif|xfail)\b/.test(e.childForFieldName('right')?.text ?? ''))
                        classSkip = e;
                    const { node: m } = unwrapDecorated(member);
                    if (m.type === 'function_definition' && /^(setUp|setUpClass|setup_method|setup_class)$/.test(m.childForFieldName('name')?.text ?? '') && /SkipTest|pytest\.skip/.test(m.text))
                        classSkip = m;
                }
                for (const member of named(cbody)) {
                    const { node: m } = unwrapDecorated(member);
                    if (m.type === 'function_definition')
                        visitFunction(m, { name: cname, decorators, skip: classSkip });
                }
            }
            else if (node.type === 'with_statement' || node.type === 'expression_statement') {
                model.fileMocks.push(...mocksIn(node, [], ctx));
            }
        }
        return model;
    });
}
function unwrapDecorated(n) {
    if (n.type !== 'decorated_definition')
        return { node: n, decorators: [] };
    const decorators = named(n).filter((c) => c.type === 'decorator');
    const def = n.childForFieldName('definition') ?? named(n)[named(n).length - 1];
    return { node: def, decorators };
}
/** The dotted callee of a decorator, without arguments: `@pytest.mark.skip(reason=..)` -> `pytest.mark.skip`. */
function decoratorName(d) {
    const expr = named(d)[0];
    if (!expr)
        return '';
    if (expr.type === 'call')
        return expr.childForFieldName('function')?.text ?? '';
    return expr.text;
}
function decoratorsOf(fn) {
    const p = fn.parent;
    if (p && p.type === 'decorated_definition')
        return named(p).filter((c) => c.type === 'decorator');
    return [];
}
/** Is this node inside a branch that can never execute, or after an unconditional exit, within `body`? */
function reachable(n, body) {
    let cur = n;
    while (cur && cur.id !== body.id) {
        const p = cur.parent;
        if (!p)
            break;
        if (p.type === 'if_statement') {
            const v = constValue(p.childForFieldName('condition')?.text ?? '');
            if (v === false && cur.id === p.childForFieldName('consequence')?.id)
                return false;
            if (v === true && cur.type === 'else_clause')
                return false;
        }
        if (p.type === 'while_statement' && cur.id === p.childForFieldName('body')?.id && constValue(p.childForFieldName('condition')?.text ?? '') === false)
            return false;
        if (p.type === 'for_statement' && cur.id === p.childForFieldName('body')?.id && /^(\[\]|\(\)|\{\}|""|''|range\(0\)|set\(\)|dict\(\)|list\(\))$/.test(p.childForFieldName('right')?.text.replace(/\s+/g, '') ?? ''))
            return false;
        if (p.type === 'block') {
            // an unconditional return/raise earlier in the same block makes this dead
            for (const sib of named(p)) {
                if (sib.id === cur.id)
                    break;
                if (sib.type === 'return_statement' || sib.type === 'raise_statement')
                    return false;
            }
        }
        cur = p;
    }
    return true;
}
function earlyExitsBefore(body, firstAssertLine) {
    let n = 0;
    walk(body, (x) => {
        if (x.type === 'function_definition' || x.type === 'class_definition')
            return false;
        if (x.type === 'return_statement' && line(x) < firstAssertLine)
            n++;
    });
    return n;
}
function subjectOf(expr) {
    if (expr.type === 'comparison_operator')
        return named(expr)[0]?.text.replace(/\s+/g, '') ?? '';
    if (expr.type === 'not_operator' || expr.type === 'parenthesized_expression') {
        const i = named(expr)[0];
        return i ? subjectOf(i) : '';
    }
    return expr.text.replace(/\s+/g, '').slice(0, 80);
}
function assertionsIn(body, ctx) {
    const out = [];
    const assigns = assignmentsIn(body);
    const push = (n, strength, subject) => out.push({ line: line(n), strength, text: head(n.text), subject, reachable: reachable(n, body) });
    walk(body, (n) => {
        if (n.type === 'function_definition' || n.type === 'class_definition')
            return false;
        if (n.type === 'assert_statement') {
            const expr = named(n)[0];
            let strength = expr ? classifyExpr(expr, assigns) : 'weak';
            if (expr && strength === 'strong' && freeIdentifiers(expr.text).length === 0)
                strength = 'weak'; // constants only: always true
            push(n, strength, expr ? subjectOf(expr) : '');
            return false;
        }
        if (n.type === 'call') {
            const fnode = n.childForFieldName('function');
            const args = named(n.childForFieldName('arguments'));
            const argTexts = args.map((a) => a.text);
            const subj = argTexts[0]?.replace(/\s+/g, '') ?? '';
            if (fnode && fnode.type === 'attribute') {
                const attr = fnode.childForFieldName('attribute')?.text ?? '';
                const obj = fnode.childForFieldName('object')?.text ?? '';
                if (STRONG_UNITTEST.has(attr) || WEAK_UNITTEST.has(attr)) {
                    let strength = STRONG_UNITTEST.has(attr) ? 'strong' : 'weak';
                    if (/^assertRaises/.test(attr) && argTexts[0] && BROAD_EXC.has(argTexts[0]))
                        strength = 'weak';
                    if (/^assert(Greater|Less)(Equal)?$/.test(attr) && argTexts.some((a) => /^[01]$/.test(a)))
                        strength = 'weak';
                    if (/^assert(Equal|Equals|Is|DictEqual|ListEqual)$/.test(attr) && argTexts.length >= 2 && argTexts[0] === argTexts[1])
                        strength = 'weak'; // tautology
                    if (attr === 'assertTrue' && argTexts[0] === 'True')
                        strength = 'weak';
                    if (strength === 'strong' && argTexts.every((a) => freeIdentifiers(a).length === 0))
                        strength = 'weak'; // constants only
                    if (/^assert(Equal|Equals)$/.test(attr) && argTexts.length >= 2) {
                        const [x, y] = argTexts.map((t) => t.replace(/\s+/g, ''));
                        if ((assigns.get(x) !== undefined && assigns.get(x) === y) || (assigns.get(y) !== undefined && assigns.get(y) === x))
                            strength = 'weak'; // laundered tautology
                    }
                    if (attr === 'assertAlmostEqual' && hugeTolerance(n.text, argTexts[1] ?? ''))
                        strength = 'weak';
                    push(n, strength, subj);
                    return false;
                }
                if (obj === 'pytest' && /^(raises|warns|deprecated_call)$/.test(attr)) {
                    push(n, attr === 'raises' && BROAD_EXC.has(argTexts[0] ?? '') ? 'weak' : 'strong', subj);
                    return false;
                }
                // any other self.assertX / cls.assertX: Django's assertContains, project base-class assertions
                if (/^(self|cls)$/.test(obj) && /^_*assert[A-Z_]/.test(attr)) {
                    push(n, 'strong', subj);
                    return false;
                }
                // helpers.assert_user(...) style
                if (HELPER_NAME.test(helperBase(attr)) && !/^(self|cls)$/.test(obj) && !ctx.noopHelpers.has(attr)) {
                    push(n, 'strong', subj);
                    return false;
                }
                return;
            }
            const fname = fnode?.text ?? '';
            if (!fname)
                return;
            const imported = ctx.imports[fname] ?? '';
            if (/^pytest\.(raises|warns|deprecated_call)$/.test(imported)) {
                push(n, imported.endsWith('raises') && BROAD_EXC.has(argTexts[0] ?? '') ? 'weak' : 'strong', subj);
                return false;
            }
            if (ctx.noopHelpers.has(fname))
                return false;
            if (ctx.helpers.has(fname) || (!(fname in ctx) && HELPER_NAME.test(helperBase(fname)) && !isLocalDefinedElsewhere(fname, ctx))) {
                push(n, 'strong', subj);
                return false;
            }
        }
    });
    return out;
}
function isLocalDefinedElsewhere(name, ctx) {
    // A name we resolved locally as non-asserting is a no-op helper; anything else (imported) gets the benefit of the doubt by name.
    return ctx.noopHelpers.has(name);
}
function classifyExpr(e, assigns = new Map()) {
    switch (e.type) {
        case 'parenthesized_expression': {
            const inner = named(e)[0];
            return inner ? classifyExpr(inner, assigns) : 'weak';
        }
        case 'comparison_operator': {
            const ops = kids(e).filter((c) => !c.isNamed).map((c) => c.text);
            const operands = named(e).map((c) => c.text.replace(/\s+/g, ''));
            const op = ops[0] ?? '';
            if (operands.length === 2 && operands[0] === operands[1])
                return 'weak'; // tautology x == x
            if (operands.length === 2 && ((assigns.get(operands[0]) !== undefined && assigns.get(operands[0]) === operands[1]) || (assigns.get(operands[1]) !== undefined && assigns.get(operands[1]) === operands[0])))
                return 'weak'; // expected = f(x); assert f(x) == expected
            if (operands.length === 2 && operands.some((o) => /(^|\.)approx\(/.test(o)) && hugeTolerance(e.text, operands.find((o) => !/(^|\.)approx\(/.test(o)) ?? ''))
                return 'weak';
            if (op === '==' || op === '!=') {
                if (operands.some((o) => o === 'True' || o === 'False'))
                    return 'weak'; // == True is truthiness in disguise
                if (operands.some((o) => /^(\[\]|\{\}|\(\)|''|""|set\(\))$/.test(o)))
                    return 'weak'; // emptiness == truthiness of a container
                if (operands.some((o) => o === '0') && operands.some((o) => /^len\(/.test(o)))
                    return 'weak';
                return 'strong';
            }
            if (op === 'is')
                return 'strong'; // `is None`, `is True` are exact identity checks
            if (op === 'is not')
                return operands.some((o) => o === 'None') ? 'weak' : 'strong';
            if (op === 'in' || op === 'not in')
                return 'strong';
            if (operands.some((o) => /^[01](\.0)?$/.test(o)))
                return 'weak'; // len(x) > 0
            return 'strong';
        }
        case 'not_operator': {
            const inner = named(e)[0];
            return inner && inner.type === 'comparison_operator' ? classifyExpr(inner, assigns) : 'weak';
        }
        case 'boolean_operator': {
            const op = kids(e).find((c) => !c.isNamed)?.text;
            const parts = named(e).map((x) => classifyExpr(x, assigns));
            if (op === 'or')
                return parts.every((x) => x === 'strong') ? 'strong' : 'weak';
            return parts.includes('strong') ? 'strong' : 'weak';
        }
        default:
            return 'weak'; // calls (any/all/isinstance/…), identifiers, literals: truthiness
    }
}
/** approx(abs=1e9) / rel=0.5 / assertAlmostEqual(delta=huge): a tolerance wider than the value is no check at all. */
function hugeTolerance(text, other) {
    const num = (m) => (m ? parseFloat(m[1]) : NaN);
    const abs = num(/\babs\s*=\s*([\d.eE+-]+)/.exec(text)), rel = num(/\brel\s*=\s*([\d.eE+-]+)/.exec(text)), delta = num(/\bdelta\s*=\s*([\d.eE+-]+)/.exec(text)), places = num(/\bplaces\s*=\s*(-?\d+)/.exec(text));
    const v = /^-?[\d.]+(e-?\d+)?$/i.test(other) ? Math.abs(parseFloat(other)) : NaN;
    const wide = (t) => !isNaN(t) && (isNaN(v) ? t >= 100 : t >= Math.max(v / 2, 1e-9) && t >= 0.5);
    return wide(abs) || wide(delta) || (!isNaN(rel) && rel >= 0.5) || (!isNaN(places) && places <= 0);
}
function isLiteral(n) {
    return !!n && ['integer', 'float', 'string', 'true', 'false', 'none', 'concatenated_string'].includes(n.type);
}
function mocksIn(scope, decorators, ctx) {
    const out = [];
    const resolve = (ident) => ctx.imports[ident] ?? ident;
    const fromCall = (call) => {
        const f = call.childForFieldName('function')?.text ?? '';
        const args = named(call.childForFieldName('arguments'));
        const positional = args.filter((a) => a.type !== 'keyword_argument');
        const kw = new Map(args.filter((a) => a.type === 'keyword_argument').map((a) => [a.childForFieldName('name')?.text ?? '', a.childForFieldName('value')]));
        const a0 = positional[0], a1 = positional[1], a2 = positional[2];
        const text = head(call.text);
        const constLike = (attr) => /^[A-Z][A-Z0-9_]*$/.test(attr);
        if (/^(mock\.|unittest\.mock\.|mocker\.)?patch$/.test(f) && a0 && a0.type === 'string') {
            const target = unquote(a0.text);
            const attr = target.split('.').pop() ?? '';
            const repl = a1 ?? kw.get('new');
            return { line: line(call), target, text, literal: isLiteral(repl) && constLike(attr), wholeModule: false };
        }
        if (/^(mock\.|unittest\.mock\.|mocker\.)?patch\.(object|multiple)$/.test(f) && a0) {
            const attr = a1 && a1.type === 'string' ? unquote(a1.text) : '';
            const repl = a2 ?? kw.get('new');
            return { line: line(call), target: attr ? `${resolve(a0.text)}.${attr}` : resolve(a0.text), text, literal: isLiteral(repl) && constLike(attr), wholeModule: !attr };
        }
        if (/^(mock\.|unittest\.mock\.|mocker\.)?patch\.dict$/.test(f) && a0)
            return { line: line(call), target: a0.type === 'string' ? unquote(a0.text) : resolve(a0.text), text, literal: false, wholeModule: false };
        if (/^monkeypatch\.(setattr|delattr|setitem)$/.test(f) && a0) {
            if (a0.type === 'string') {
                const target = unquote(a0.text);
                const attr = target.split('.').pop() ?? '';
                return { line: line(call), target, text, literal: isLiteral(a1) && constLike(attr), wholeModule: false };
            }
            const attr = a1 && a1.type === 'string' ? unquote(a1.text) : '';
            return { line: line(call), target: attr ? `${resolve(a0.text)}.${attr}` : resolve(a0.text), text, literal: isLiteral(a2) && constLike(attr), wholeModule: !attr };
        }
        return null;
    };
    for (const d of decorators) {
        const call = named(d).find((c) => c.type === 'call');
        if (call) {
            const m = fromCall(call);
            if (m)
                out.push(m);
        }
    }
    walk(scope, (n) => {
        if (n.type === 'function_definition' || n.type === 'class_definition')
            return false;
        if (n.type === 'call') {
            const m = fromCall(n);
            if (m) {
                out.push(m);
                return false;
            }
        }
        if (n.type === 'assignment') {
            const l = n.childForFieldName('left');
            const r = n.childForFieldName('right');
            if (l?.type === 'attribute') {
                const obj = l.childForFieldName('object')?.text ?? '';
                const attr = l.childForFieldName('attribute')?.text ?? '';
                const base = obj.split('.')[0] ?? '';
                if (ctx.imports[base] !== undefined || obj.includes('.'))
                    out.push({ line: line(n), target: `${resolve(base)}${obj.slice(base.length)}.${attr}`, text: head(n.text), literal: isLiteral(r ?? undefined) && /^[A-Z][A-Z0-9_]*$/.test(attr), wholeModule: false });
            }
            else if (l?.type === 'subscript' && /^sys\.modules$/.test(l.childForFieldName('value')?.text ?? '')) {
                const key = named(l).find((c) => c.type === 'string');
                if (key)
                    out.push({ line: line(n), target: unquote(key.text), text: head(n.text), literal: false, wholeModule: true });
            }
        }
    });
    return out;
}
function tolerancesIn(body) {
    const out = [];
    walk(body, (n) => {
        if (n.type === 'function_definition' || n.type === 'class_definition')
            return false;
        if (n.type !== 'call')
            return;
        const f = n.childForFieldName('function')?.text ?? '';
        const args = n.childForFieldName('arguments');
        if (!args)
            return;
        const kw = new Map();
        for (const a of named(args))
            if (a.type === 'keyword_argument')
                kw.set(a.childForFieldName('name')?.text ?? '', a.childForFieldName('value')?.text ?? '');
        const num = (s) => (s !== undefined && /^-?[\d.]+(e-?\d+)?$/i.test(s) ? parseFloat(s) : NaN);
        const stmt = ancestor(n, ['assert_statement', 'expression_statement'], body) ?? n;
        const key = stmt.text.replace(n.text, '<tol>').replace(/\s+/g, ' ').slice(0, 160);
        if (/(^|\.)approx$/.test(f)) {
            const rel = num(kw.get('rel')), abs = num(kw.get('abs'));
            const loose = Math.max(isNaN(rel) ? 1e-6 : rel, isNaN(abs) ? 1e-12 : abs);
            out.push({ line: line(n), looseness: loose, kind: 'approx', text: n.text.slice(0, 80), key });
        }
        else if (/assert(Not)?AlmostEqual$/.test(f)) {
            const places = num(kw.get('places')), delta = num(kw.get('delta'));
            const positional = named(args).filter((a) => a.type !== 'keyword_argument');
            const p3 = num(positional[2]?.text);
            let loose = 1e-7;
            if (!isNaN(delta))
                loose = delta;
            else if (!isNaN(places))
                loose = Math.pow(10, -places);
            else if (!isNaN(p3))
                loose = Math.pow(10, -p3);
            out.push({ line: line(n), looseness: loose, kind: 'almost', text: n.text.slice(0, 80), key });
        }
    });
    return out;
}
function swallowedIn(body, ctx) {
    const out = [];
    for (const t of descendants(body, 'try_statement')) {
        if (ancestor(t, ['function_definition'], body))
            continue;
        const tryBody = t.childForFieldName('body');
        const handlers = named(t).filter((c) => c.type === 'except_clause' || c.type === 'except_group_clause');
        if (!tryBody || handlers.length === 0)
            continue;
        const inner = assertionsIn(tryBody, ctx);
        if (inner.length === 0)
            continue;
        const swallowing = handlers.some((h) => {
            const hb = named(h).find((c) => c.type === 'block') ?? h;
            const reraises = descendants(hb, 'raise_statement').length > 0;
            const exits = descendants(hb, 'call').some((c) => /^(pytest\.(fail|skip|xfail)|self\.(fail|skipTest)|assert)/.test(c.childForFieldName('function')?.text ?? ''));
            return !reraises && !exits && assertionsIn(hb, ctx).length === 0;
        });
        if (swallowing)
            out.push(...inner.map((a) => ({ line: a.line, text: a.text })));
    }
    return out;
}
//# sourceMappingURL=python.js.map