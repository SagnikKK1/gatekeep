import { withTree, walk, descendants, ancestor, countErrors, line, named } from '../parser.js';
/** Rust: #[test] functions (inline `mod tests` and tests/*.rs), assert!/assert_eq!/assert_ne!, #[ignore], #[should_panic], rstest/test_case. */
function head(t) { return t.split('\n')[0].slice(0, 120); }
export function normalizeBody(t) {
    return t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
export function hasInlineTests(src) { return /#\[(tokio::|async_std::|rstest|rstest::|serial_test::|wasm_bindgen_test|test_case)?\s*test\b|#\[cfg\(test\)\]/.test(src); }
const CONST_FALSE = new Set(['false', '0']);
export async function extractRust(filePath, source) {
    return withTree(source, 'rust', (tree) => {
        const root = tree.rootNode;
        const model = { path: filePath, lang: 'rust', tests: [], fileMocks: [], fileSkip: null, fileRetry: null, parseErrors: countErrors(tree), shadowed: [], imports: {} };
        const constants = new Map();
        for (const c of descendants(root, ['const_item', 'static_item', 'let_declaration'])) {
            const nm = c.childForFieldName('name')?.text ?? c.childForFieldName('pattern')?.text;
            const v = c.childForFieldName('value');
            if (nm && v && /^[A-Za-z_]\w*$/.test(nm))
                constants.set(nm, normalizeBody(v.text));
        }
        const expandData = (t) => { const k = t.trim(); return constants.has(k) ? `${k}\n${constants.get(k)}` : t; };
        for (const fn of descendants(root, 'function_item')) {
            const attrs = precedingAttributes(fn);
            const attrTexts = attrs.map((a) => a.text);
            const isTest = attrTexts.some((t) => /^#\[\s*(\w+::)*(test|rstest|test_case|wasm_bindgen_test|quickcheck|proptest)\b/.test(t) || /^#\[\s*test_case\s*\(/.test(t));
            if (!isTest)
                continue;
            const name = fn.childForFieldName('name')?.text ?? '';
            const body = fn.childForFieldName('body');
            if (!body)
                continue;
            const mods = [];
            for (let m = fn.parent; m; m = m.parent)
                if (m.type === 'mod_item')
                    mods.unshift(m.childForFieldName('name')?.text ?? '');
            const tc = {
                name: [...mods, name].join('::'), line: line(fn), assertions: [], skip: null, only: null, mocks: [], swallowed: [], retry: null, tolerances: [], timeout: null,
                body: normalizeBody(body.text), earlyExits: 0, parametrized: false, vacuous: false, data: '',
            };
            for (const a of attrs) {
                const t = a.text;
                if (/^#\[\s*ignore\b/.test(t))
                    tc.skip = { line: line(a), marker: head(t), conditional: false };
                if (/^#\[\s*cfg\s*\(/.test(t) && !/cfg\s*\(\s*test\s*\)/.test(t))
                    tc.skip = tc.skip ?? { line: line(a), marker: head(t), conditional: !/cfg\s*\(\s*(any\s*\(\s*\)|not\s*\(\s*all\s*\(\s*\)\s*\))\s*\)/.test(t) };
                if (/^#\[\s*(rstest|test_case|case)\b/.test(t)) {
                    tc.parametrized = true;
                    tc.data += normalizeBody(t) + '\n';
                    if (/^#\[\s*(rstest|test_case)\s*\(\s*\)\s*\]$/.test(t.replace(/\s+/g, ''))) { /* empty case list handled by case attrs */ }
                }
                if (/^#\[\s*should_panic\b/.test(t))
                    tc.assertions.push({ line: line(a), strength: /expected\s*=/.test(t) ? 'strong' : 'weak', text: head(t), subject: 'panic', reachable: true });
                const to = /^#\[\s*timeout\s*\(\s*(\d+)/.exec(t);
                if (to)
                    tc.timeout = { line: line(a), ms: parseInt(to[1], 10) };
            }
            if (attrTexts.some((t) => /^#\[\s*(rstest|test_case)\b/.test(t)) && !attrTexts.some((t) => /^#\[\s*(case|test_case)\s*\(.+\)/.test(t)) && !/\brstest\b/.test(attrTexts.join(' ')))
                tc.vacuous = tc.parametrized && !attrTexts.some((t) => /\(.+\)/.test(t));
            walk(body, (n) => {
                if (n.type === 'closure_expression' || n.type === 'function_item') {
                    if (n.type === 'function_item')
                        return false;
                }
                if (n.type === 'macro_invocation') {
                    const mac = n.childForFieldName('macro')?.text ?? '';
                    if (/^(debug_)?assert(_eq|_ne)?$|^assert_\w+$|^(assert_matches|assert_approx_eq|assert_relative_eq|assert_abs_diff_eq|assert_ulps_eq|assert_float_eq|assert_str_eq|pretty_assert_eq|assert_json_eq|assert_snapshot|assert_debug_snapshot|assert_yaml_snapshot|assert_cmd_snapshot|assert_json_snapshot|assert_that|assert_ok|assert_err|assert_some|assert_none)$/.test(mac)) {
                        const tt = n.childForFieldName('token_tree') ?? named(n).find((c) => c.type === 'token_tree');
                        const args = splitArgs(tt?.text ?? '');
                        const strength = classify(mac, args);
                        const tol = /assert_(approx|relative|abs_diff)_eq/.test(mac) ? /epsilon\s*=\s*([\d.eE+-]+)/.exec(tt?.text ?? '') : /\.abs\(\)\s*<=?\s*([\d.eE+-]+)/.exec(tt?.text ?? '');
                        if (tol)
                            tc.tolerances.push({ line: line(n), looseness: parseFloat(tol[1]), kind: 'abs', text: head(n.text), key: `${args[0] ?? ''}|${mac}` });
                        tc.assertions.push({ line: line(n), strength, text: head(n.text), subject: (args[0] ?? '').replace(/\s+/g, '').slice(0, 80), reachable: reachable(n, body) });
                        return false;
                    }
                    if (/^(panic|unreachable|todo|unimplemented)$/.test(mac) && ancestor(n, ['if_expression', 'match_arm'], body)) {
                        tc.assertions.push({ line: line(n), strength: 'weak', text: head(n.text), subject: 'panic', reachable: reachable(n, body) });
                        return false;
                    }
                }
            });
            // helpers named like assertions, and assert_cmd / snapbox chains: cmd.assert().success(), .stdout_eq(...)
            walk(body, (n) => {
                if (n.type !== 'call_expression')
                    return;
                const f = n.childForFieldName('function')?.text ?? '';
                const nm = f.split('::').pop().split('.').pop();
                const chain = /\.(assert|assert_eq|assert_data_eq)\(\)?\s*(\.\w+\(.*\))*$/.test(f) || /^(assert|assert_eq|assert_data_eq|success|failure|code|stdout_eq|stderr_eq|stdout_matches|stderr_matches|matches|eq|is_eq)$/.test(nm) && /\.assert\(\)|snapbox|assert_cmd|\.assert_/.test(n.text);
                if ((chain || /^(assert|check|verify|expect|ensure|validate)_/.test(nm)) && !tc.assertions.some((a) => a.line === line(n)))
                    tc.assertions.push({ line: line(n), strength: 'strong', text: head(n.text), subject: named(n.childForFieldName('arguments'))[0]?.text.replace(/\s+/g, '') ?? f.split('.')[0].slice(0, 60), reachable: reachable(n, body) });
            });
            const first = tc.assertions[0]?.line ?? Infinity;
            walk(body, (n) => { if (n.type === 'closure_expression' || n.type === 'function_item')
                return false; if (n.type === 'return_expression' && line(n) < first)
                tc.earlyExits++; });
            for (const loop of descendants(body, 'for_expression')) {
                const lb = loop.childForFieldName('body');
                if (!lb)
                    continue;
                if (tc.assertions.some((a) => a.line >= line(loop) && a.line <= lb.endPosition.row + 1)) {
                    tc.parametrized = true;
                    tc.data += expandData(normalizeBody(loop.childForFieldName('value')?.text ?? '')) + '\n';
                }
            }
            model.tests.push(tc);
        }
        return model;
    });
}
function precedingAttributes(fn) {
    const out = [];
    let s = fn.previousNamedSibling;
    while (s && s.type === 'attribute_item') {
        out.unshift(s);
        s = s.previousNamedSibling;
    }
    return out;
}
/** Split a macro token tree "(a, b, msg)" into top-level comma-separated arguments. */
export function splitArgs(tt) {
    let s = tt.trim();
    if (s.startsWith('(') && s.endsWith(')'))
        s = s.slice(1, -1);
    const out = [];
    let depth = 0, cur = '', inStr = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' && s[i - 1] !== '\\')
            inStr = !inStr;
        if (!inStr) {
            if ('([{'.includes(ch))
                depth++;
            else if (')]}'.includes(ch))
                depth--;
            else if (ch === ',' && depth === 0) {
                out.push(cur.trim());
                cur = '';
                continue;
            }
        }
        cur += ch;
    }
    if (cur.trim())
        out.push(cur.trim());
    return out;
}
function classify(mac, args) {
    const a0 = (args[0] ?? '').replace(/\s+/g, ''), a1 = (args[1] ?? '').replace(/\s+/g, '');
    if (mac === 'assert_eq' || mac === 'assert_ne' || mac === 'debug_assert_eq' || mac === 'debug_assert_ne' || mac === 'pretty_assert_eq' || mac === 'assert_str_eq') {
        if (a0 === a1)
            return 'weak'; // tautology
        if (/^(true|false)$/.test(a0) || /^(true|false)$/.test(a1))
            return 'weak';
        return 'strong';
    }
    if (mac === 'assert' || mac === 'debug_assert') {
        if (a0 === '' || /^(true|1)$/.test(a0))
            return 'weak';
        if (/\|\|true$|^true\|\|/.test(a0))
            return 'weak';
        if (/^matches!\(/.test(a0))
            return 'strong';
        const cmp = /^(.+?)(==|!=|<=|>=|<|>)(.+)$/.exec(a0);
        if (cmp && !/^\(.*\)$/.test(a0)) {
            if (cmp[1] === cmp[3])
                return 'weak';
            if (/^(true|false)$/.test(cmp[1]) || /^(true|false)$/.test(cmp[3]))
                return 'weak';
            if (/^(<|>|<=|>=)$/.test(cmp[2]) && (/^[01]$/.test(cmp[1]) || /^[01]$/.test(cmp[3])))
                return 'weak';
            return 'strong';
        }
        if (/\.(is_some|is_none|is_ok|is_err|is_empty|contains|starts_with|ends_with)\(/.test(a0))
            return /\.(contains|starts_with|ends_with)\(/.test(a0) ? 'strong' : 'weak';
        if (/^!?\w+(\.\w+)*$/.test(a0))
            return 'weak';
        return /[<>]/.test(a0) ? 'strong' : 'weak';
    }
    return 'strong';
}
function reachable(n, body) {
    let cur = n;
    while (cur && cur.id !== body.id) {
        const p = cur.parent;
        if (!p)
            break;
        if (p.type === 'if_expression' && cur.id === p.childForFieldName('consequence')?.id) {
            const c = p.childForFieldName('condition')?.text.replace(/\s+/g, '') ?? '';
            if (CONST_FALSE.has(c) || /^(\d+)==(\d+)$/.test(c) && c.split('==')[0] !== c.split('==')[1])
                return false;
        }
        if (p.type === 'if_expression' && cur.id === p.childForFieldName('alternative')?.id && /^(true|1)$/.test(p.childForFieldName('condition')?.text.trim() ?? ''))
            return false;
        if (p.type === 'block') {
            for (const sib of named(p)) {
                if (sib.id === cur.id)
                    break;
                if (sib.type === 'expression_statement' && named(sib)[0]?.type === 'return_expression')
                    return false;
                if (sib.type === 'return_expression')
                    return false;
            }
        }
        if (p.type === 'closure_expression') {
            const gp = p.parent;
            const asArg = !!gp && (gp.type === 'arguments' || gp.type === 'call_expression' || gp.type === 'token_tree');
            if (!asArg) {
                const decl = ancestor(p, ['let_declaration'], body);
                const nm = decl?.childForFieldName('pattern')?.text ?? '';
                if (!nm || !new RegExp(`(^|[^\\w.])${nm}\\s*\\(`).test(body.text))
                    return false;
            }
        }
        cur = p;
    }
    return true;
}
//# sourceMappingURL=rust.js.map