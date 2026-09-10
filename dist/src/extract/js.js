import { withTree, walk, descendants, ancestor, countErrors, line, unquote, named } from '../parser.js';
const TEST_ROOTS = new Set(['it', 'test', 'specify', 'xit', 'xtest', 'fit', 'ftest']);
const BLOCK_ROOTS = new Set(['describe', 'context', 'suite', 'xdescribe', 'fdescribe', 'xcontext', 'fcontext']);
const TEST_MODIFIERS = new Set(['skip', 'only', 'todo', 'each', 'for', 'concurrent', 'sequential', 'fails', 'runIf', 'skipIf', 'todoIf', 'extend', 'scoped', 'pending', 'serial', 'failing', 'describe', 'it', 'test']);
const HOOK_ROOTS = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll', 'before', 'after', 'setup', 'teardown']);
const CHAIN_NOISE = new Set(['not', 'resolves', 'rejects', 'soft', 'to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'deep', 'nested', 'own', 'ordered', 'any', 'all', 'does', 'still', 'also', 'but', 'itself', 'eventually', 'become']);
const STRONG = new Set([
    'toBe', 'toEqual', 'toStrictEqual', 'toHaveLength', 'toHaveBeenCalledWith', 'toHaveBeenLastCalledWith', 'toHaveBeenNthCalledWith',
    'toHaveBeenCalledTimes', 'toHaveBeenCalledOnce', 'toHaveReturnedWith', 'toHaveLastReturnedWith', 'toHaveNthReturnedWith', 'toHaveReturnedTimes', 'toMatchObject',
    'toContain', 'toContainEqual', 'toMatchSnapshot', 'toMatchInlineSnapshot', 'toThrowErrorMatchingSnapshot', 'toThrowErrorMatchingInlineSnapshot',
    'toBeCloseTo', 'toHaveTextContent', 'toHaveAttribute', 'toHaveValue', 'toHaveClass', 'toHaveStyle', 'toHaveDisplayValue', 'toHaveFormValues',
    'toBeInTheDocument', 'toBeVisible', 'toHaveBeenCalledExactlyOnceWith',
    'toBeLessThanOrEqual', 'toBeGreaterThanOrEqual', 'toBeGreaterThan', 'toBeLessThan', 'toEqualTypeOf', 'toMatchTypeOf',
    'equal', 'equals', 'eq', 'eql', 'eqls', 'deepEqual', 'strictEqual', 'deepStrictEqual', 'notEqual', 'notStrictEqual', 'notDeepEqual',
    'notDeepStrictEqual', 'same', 'strictSame', 'notSame', 'members', 'lengthOf', 'length', 'include', 'includes', 'contain', 'contains',
    'match', 'matches', 'string', 'keys', 'closeTo', 'approximately', 'calledWith', 'calledOnceWith', 'calledWithExactly', 'calledOnceWithExactly', 'calledOnce',
    'above', 'below', 'least', 'most', 'gt', 'gte', 'lt', 'lte', 'within', 'oneOf', 'rejectedWith', 'snapshot', 'sameMembers', 'sameDeepMembers',
    'includeMembers', 'containSubset', 'deepInclude', 'nestedInclude', 'hasAllKeys', 'containsAllKeys', 'sameOrderedMembers', 'isAbove', 'isBelow',
    'isAtLeast', 'isAtMost', 'increasesBy', 'decreasesBy', 'changesBy', 'respondTo', 'satisfy', 'fail',
]);
const WEAK = new Set([
    'toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeUndefined', 'toBeNull', 'toBeNaN', 'toBeInstanceOf', 'toHaveBeenCalled', 'toBeTypeOf',
    'toBeOneOf', 'toBeEnabled', 'toBeDisabled', 'toBeEmpty', 'toBeEmptyDOMElement',
    'ok', 'true', 'false', 'exist', 'exists', 'undefined', 'null', 'defined', 'instanceof', 'instanceOf', 'isTrue', 'isFalse', 'isOk', 'isNotOk',
    'isDefined', 'isNotNull', 'isNull', 'isUndefined', 'isNotUndefined', 'truthy', 'falsy', 'called', 'a', 'an', 'typeOf', 'type',
    'isObject', 'isArray', 'isString', 'isNumber', 'isFunction', 'isBoolean', 'isNaN', 'isNotNaN', 'notOk', 'isEmpty', 'isNotEmpty', 'empty', 'not',
    'toBeCalled', 'finite', 'NaN', 'extensible', 'sealed', 'frozen',
]);
const CONDITIONAL_THROW = new Set(['toThrow', 'toThrowError', 'throw', 'throws', 'Throw', 'rejects', 'doesNotThrow', 'toReject']);
const ASSERT_ROOTS = new Set(['assert', 't', 'expect', 'should', 'strict', 'expectTypeOf', 'assertType', 'expectType', 'expectError', 'attest', 'expectAssignable', 'expectNotAssignable']);
const TYPE_ASSERT_ROOTS = new Set(['expectTypeOf', 'assertType', 'expectType', 'expectError', 'attest', 'expectAssignable', 'expectNotAssignable']);
const HELPER_NAME = /^(assert|check|verify|expect|ensure|validate|confirm|should)([A-Z_]|$)|^(snapshot)$/;
const GLOBALS = new Set(['Date', 'Math', 'JSON', 'console', 'process', 'window', 'global', 'globalThis', 'document', 'navigator', 'localStorage', 'sessionStorage', 'Intl', 'performance', 'crypto', 'Reflect', 'Promise', 'Object', 'Array', 'Number', 'String', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'Buffer', 'fs', 'path', 'os', 'http', 'https', 'child_process']);
const CONST_FALSE = new Set(['false', '0', 'null', 'undefined', '""', "''", '``', 'NaN', 'void0']);
const CONST_TRUE = new Set(['true', '1', '!false', '!0']);
function constValue(cond) {
    const c = cond.replace(/\s+/g, '').replace(/^\((.*)\)$/, '$1');
    if (CONST_FALSE.has(c))
        return false;
    if (CONST_TRUE.has(c))
        return true;
    const m = /^(-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')(===|!==|==|!=|<|>|<=|>=)(-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')$/.exec(c);
    if (m) {
        const [, a, op, b] = m;
        const na = parseFloat(a), nb = parseFloat(b);
        const num = !isNaN(na) && !isNaN(nb);
        switch (op) {
            case '===':
            case '==': return num ? na === nb : a === b;
            case '!==':
            case '!=': return num ? na !== nb : a !== b;
            case '<': return num && na < nb;
            case '>': return num && na > nb;
            case '<=': return num && na <= nb;
            case '>=': return num && na >= nb;
        }
    }
    const n = /^!(.+)$/.exec(c);
    if (n) {
        const v = constValue(n[1]);
        return v === null ? null : !v;
    }
    return null;
}
export function normalizeBody(t) {
    return t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
function chainOf(node) {
    const segs = [];
    let cur = node;
    let pendingCall = null;
    while (cur) {
        if (cur.type === 'call_expression') {
            pendingCall = cur;
            cur = cur.childForFieldName('function');
            continue;
        }
        if (cur.type === 'member_expression') {
            const prop = cur.childForFieldName('property')?.text ?? '';
            segs.push({ name: prop, call: pendingCall });
            pendingCall = null;
            cur = cur.childForFieldName('object');
            continue;
        }
        if (cur.type === 'subscript_expression') {
            segs.push({ name: '[]', call: pendingCall });
            pendingCall = null;
            cur = cur.childForFieldName('object');
            continue;
        }
        if (cur.type === 'parenthesized_expression' || cur.type === 'as_expression' || cur.type === 'non_null_expression' || cur.type === 'satisfies_expression' || cur.type === 'await_expression') {
            cur = named(cur)[0] ?? null;
            continue;
        }
        if (cur.type === 'identifier' || cur.type === 'this') {
            const rootSeg = { name: cur.text, call: pendingCall };
            segs.reverse();
            return { root: rootSeg.name, rootNode: cur, segs: rootSeg.call ? [rootSeg, ...segs] : segs };
        }
        return null;
    }
    return null;
}
/** `it.skip.each(...)` is a test definition; `test.expect(413)` (a supertest variable named test) is not. */
function isTestDefChain(ch) {
    if (!TEST_ROOTS.has(ch.root) && !BLOCK_ROOTS.has(ch.root))
        return false;
    return ch.segs.every((s) => s.name === ch.root ? true : TEST_MODIFIERS.has(s.name));
}
function argsOf(call) {
    return named(call?.childForFieldName('arguments')).filter((a) => a.type !== 'comment');
}
function strArg(n) {
    if (!n)
        return null;
    if (n.type === 'string')
        return unquote(n.text);
    if (n.type === 'template_string')
        return n.text.slice(1, -1);
    return null;
}
function isFn(n) {
    return !!n && (n.type === 'arrow_function' || n.type === 'function_expression' || n.type === 'function' || n.type === 'generator_function');
}
function fnBody(n) { return n.childForFieldName('body'); }
function isLiteralZeroOrOne(t) { return !!t && /^[01](\.0+)?$/.test(t.trim()); }
function isLiteral(n) { return !!n && ['number', 'string', 'template_string', 'true', 'false', 'null', 'undefined'].includes(n.type); }
function head(t) { return t.split('\n')[0].slice(0, 120); }
function helperBase(n) { return n.replace(/^_+/, ''); }
export async function extractJS(filePath, source, lang) {
    return withTree(source, lang, (tree) => {
        const root = tree.rootNode;
        const model = { path: filePath, lang, tests: [], fileMocks: [], fileSkip: null, fileRetry: null, parseErrors: countErrors(tree), shadowed: [], imports: {} };
        const ctx = { helpers: new Set(), noopHelpers: new Set(), imports: model.imports, shadowed: new Set() };
        const constants = new Map();
        for (const d of descendants(root, 'variable_declarator')) {
            const nm = d.childForFieldName('name');
            const v = d.childForFieldName('value');
            if (nm?.type === 'identifier' && v && (v.type === 'array' || v.type === 'object') && !ancestor(d, ['function_declaration', 'arrow_function', 'function_expression', 'statement_block']))
                constants.set(nm.text, normalizeBody(v.text));
            if (nm?.type === 'identifier' && v && (v.type === 'string' || v.type === 'template_string'))
                constants.set(nm.text, unquote(v.text));
        }
        ctx.constants = constants;
        const expandData = (t) => { const k = t.trim(); return constants.has(k) ? `${k}\n${constants.get(k)}` : t; };
        // imports and requires: local binding -> specifier
        for (const imp of descendants(root, 'import_statement')) {
            const spec = strArg(imp.childForFieldName('source') ?? undefined) ?? '';
            if (!spec)
                continue;
            for (const id of descendants(imp, ['identifier'])) {
                // default import, namespace import, and named imports (alias when present)
                const p = id.parent;
                if (!p)
                    continue;
                if (p.type === 'import_clause' || p.type === 'namespace_import' || (p.type === 'import_specifier' && (p.childForFieldName('alias')?.id === id.id || !p.childForFieldName('alias'))))
                    model.imports[id.text] = spec;
            }
        }
        for (const decl of descendants(root, 'variable_declarator')) {
            const v = decl.childForFieldName('value');
            const nameNode = decl.childForFieldName('name');
            if (!v || !nameNode)
                continue;
            const req = v.type === 'call_expression' && v.childForFieldName('function')?.text === 'require' ? strArg(argsOf(v)[0]) : (v.type === 'await_expression' && /^import\(/.test(named(v)[0]?.text ?? '') ? strArg(argsOf(named(v)[0])[0]) : null);
            if (!req)
                continue;
            if (nameNode.type === 'identifier')
                model.imports[nameNode.text] = req;
            else
                for (const id of descendants(nameNode, ['shorthand_property_identifier_pattern', 'identifier']))
                    model.imports[id.text] = req;
        }
        // Local helper functions and shadowing of the assertion library
        const defs = new Map();
        walk(root, (n) => {
            if (n.type === 'function_declaration') {
                const nm = n.childForFieldName('name')?.text;
                if (nm)
                    defs.set(nm, n);
                return false;
            }
            if (n.type === 'variable_declarator') {
                const nm = n.childForFieldName('name')?.text;
                const v = n.childForFieldName('value');
                if (nm && v && isFn(v))
                    defs.set(nm, v);
            }
            if (n.type === 'assignment_expression') {
                const l = n.childForFieldName('left')?.text ?? '';
                const m = /^(global|globalThis|window)\.(expect|assert)$/.exec(l);
                if (m) {
                    ctx.shadowed.add(m[2]);
                    model.shadowed.push({ line: line(n), name: l });
                }
            }
        });
        for (const [nm, fn] of defs) {
            if (ASSERT_ROOTS.has(nm)) {
                ctx.shadowed.add(nm);
                model.shadowed.push({ line: line(fn), name: nm });
                continue;
            }
            const b = fnBody(fn);
            // asserting: a specific assertion, a throw, or an assertion inside a returned function (assertion factories like shouldHaveHeader(h))
            const own = b ? assertionsIn(b, { helpers: new Set(), noopHelpers: new Set(), imports: {}, shadowed: new Set() }) : [];
            const asserts = own.some((a) => a.strength === 'strong' || !a.reachable) || (b ? descendants(b, 'throw_statement').length > 0 : false);
            if (asserts)
                ctx.helpers.add(nm);
            else if (HELPER_NAME.test(helperBase(nm)) && !TEST_ROOTS.has(nm)) {
                ctx.noopHelpers.add(nm);
                model.shadowed.push({ line: line(fn), name: nm });
            }
        }
        for (const decl of descendants(root, 'variable_declarator')) {
            const nm = decl.childForFieldName('name')?.text ?? '';
            const v = decl.childForFieldName('value');
            if ((nm === 'expect' || nm === 'assert') && v && !isFn(v) && !(v.type === 'call_expression' && v.childForFieldName('function')?.text === 'require') && !/^(chai|require|import)/.test(v.text)) {
                ctx.shadowed.add(nm);
                model.shadowed.push({ line: line(decl), name: nm });
            }
        }
        const visitScope = (node, scope) => {
            walk(node, (n) => {
                if (n.id === node.id)
                    return;
                if (n.type !== 'call_expression')
                    return;
                const ch = chainOf(n);
                if (!ch)
                    return;
                if (isTestDefChain(ch) && isNestedFn(n, node))
                    return false; // it() inside a function nobody calls never registers
                const props = ch.segs.map((s) => s.name);
                if ((ch.root === 'jest' && props[0] === 'retryTimes') || (ch.root === 'vi' && props[0] === 'setConfig' && /retry/.test(n.text))) {
                    model.fileRetry = model.fileRetry ?? { line: line(n), text: head(n.text) };
                    return false;
                }
                if (ch.root === 'this' && props[0] === 'retries') {
                    scope.retry = { line: line(n), text: head(n.text) };
                    return false;
                }
                const args = argsOf(n);
                const rootIsTest = TEST_ROOTS.has(ch.root) && isTestDefChain(ch);
                const rootIsBlock = BLOCK_ROOTS.has(ch.root) && isTestDefChain(ch);
                if (!rootIsTest && !rootIsBlock) {
                    if (HOOK_ROOTS.has(ch.root)) {
                        const cb = args.find(isFn);
                        if (cb) {
                            const b = fnBody(cb);
                            if (b)
                                model.fileMocks.push(...mocksIn(b, ctx));
                        }
                        return false;
                    }
                    const m = mockFromCall(n, ch, ctx);
                    if (m) {
                        model.fileMocks.push(m);
                        return false;
                    }
                    return;
                }
                const marker = head(n.text.split('(')[0] ?? n.text);
                const skipProp = props.find((p) => ['skip', 'todo', 'skipIf', 'fails', 'failing', 'pending', 'todoIf'].includes(p));
                const skipHere = /^x/.test(ch.root) || skipProp !== undefined;
                const conditionalSkip = skipProp === 'skipIf' || skipProp === 'todoIf';
                const onlyHere = /^f(it|test|describe|context)$/.test(ch.root) || props.includes('only');
                const nameNode = args[0];
                const name = strArg(nameNode) ?? (nameNode ? `<${normalizeBody(nameNode.text).slice(0, 80)}>` : `<anonymous>`);
                const cb = args.find(isFn);
                const opts = args.find((a) => a.type === 'object');
                const numArg = args.find((a) => a.type === 'number');
                const eachSeg = ch.segs.find((s) => (s.name === 'each' || s.name === 'for') && s.call);
                const parametrized = !!eachSeg;
                const eachData = eachSeg?.call ? argsOf(eachSeg.call)[0] : undefined;
                const vacuous = parametrized && !!eachData && /^\[\s*\]$/.test(eachData.text.trim());
                if (rootIsBlock) {
                    const inner = {
                        parametrized: scope.parametrized || parametrized,
                        data: scope.data + (eachData ? expandData(normalizeBody(eachData.text)) + '\n' : ''),
                        path: [...scope.path, name],
                        skip: scope.skip ?? (skipHere ? { line: line(n), marker, conditional: conditionalSkip } : null),
                        only: scope.only ?? (onlyHere ? { line: line(n), marker } : null),
                        retry: scope.retry ?? (opts && /\bretr(y|ies)\b/.test(opts.text) ? { line: line(opts), text: head(opts.text) } : null),
                    };
                    if (cb) {
                        const b = fnBody(cb);
                        if (b)
                            visitScope(b, inner);
                    }
                    else if (!cb && args.length <= 1) { /* describe with no callback: nothing runs; tests inside are gone and will show as deleted */ }
                    return false;
                }
                const cbBody = cb ? fnBody(cb) : null;
                const tc = {
                    name: [...scope.path, name].join(' > '), line: line(n), assertions: [], mocks: [], swallowed: [], tolerances: [], body: normalizeBody(cbBody?.text ?? ''),
                    skip: scope.skip ?? (skipHere ? { line: line(n), marker, conditional: conditionalSkip } : null),
                    only: scope.only ?? (onlyHere ? { line: line(n), marker } : null),
                    retry: scope.retry, timeout: null, earlyExits: 0, parametrized: parametrized || scope.parametrized, vacuous,
                    data: scope.data + (eachData ? expandData(normalizeBody(eachData.text)) + '\n' : ''),
                };
                if (opts) {
                    const retryPair = descendants(opts, 'pair').find((p) => /^(retry|retries)$/.test(p.childForFieldName('key')?.text ?? ''));
                    if (retryPair)
                        tc.retry = { line: line(retryPair), text: head(retryPair.text) };
                    const toPair = descendants(opts, 'pair').find((p) => (p.childForFieldName('key')?.text ?? '') === 'timeout');
                    const v = toPair?.childForFieldName('value')?.text;
                    if (v && /^\d+$/.test(v))
                        tc.timeout = { line: line(toPair), ms: parseInt(v, 10) };
                }
                if (numArg && args.indexOf(numArg) > 0)
                    tc.timeout = { line: line(numArg), ms: parseInt(numArg.text, 10) };
                if (cbBody) {
                    const b = cbBody;
                    tc.assertions = assertionsIn(b, ctx);
                    tc.earlyExits = earlyExitsBefore(b, tc.assertions[0]?.line ?? Infinity);
                    for (const f of descendants(b, ['for_statement', 'for_in_statement'])) {
                        if (isNestedFn(f, b) || assertionsIn(f.childForFieldName('body') ?? f, ctx).length === 0)
                            continue;
                        tc.parametrized = true;
                        tc.data += expandData(normalizeBody(f.childForFieldName('right')?.text ?? f.childForFieldName('condition')?.text ?? '')) + '\n';
                    }
                    for (const c of descendants(b, 'call_expression')) {
                        const cc = chainOf(c);
                        if (cc && cc.segs.length > 0 && cc.segs[cc.segs.length - 1].name === 'forEach' && cc.segs[cc.segs.length - 1].call?.id === c.id && assertionsIn(c, ctx).length > 0) {
                            tc.parametrized = true;
                            tc.data += expandData(normalizeBody(cc.rootNode.text)) + '\n';
                        }
                    }
                    tc.mocks = mocksIn(b, ctx);
                    tc.tolerances = tolerancesIn(b);
                    tc.swallowed = swallowedIn(b, ctx);
                    walk(b, (x) => {
                        if (x.type !== 'call_expression')
                            return;
                        const c = chainOf(x);
                        if (!c)
                            return;
                        const ps = c.segs.map((s) => s.name);
                        if ((c.root === 'this' || c.root === 't' || c.root === 'ctx' || c.root === 'context') && ps[0] === 'skip' && !tc.skip)
                            tc.skip = { line: line(x), marker: head(x.text), conditional: !!ancestor(x, ['if_statement', 'catch_clause', 'ternary_expression'], b) };
                        if (c.root === 'this' && ps[0] === 'retries')
                            tc.retry = { line: line(x), text: head(x.text) };
                        if (c.root === 'this' && ps[0] === 'timeout') {
                            const a = argsOf(x)[0]?.text;
                            if (a && /^\d+$/.test(a))
                                tc.timeout = { line: line(x), ms: parseInt(a, 10) };
                        }
                    });
                }
                model.tests.push(tc);
                return false;
            });
        };
        visitScope(root, { path: [], skip: null, only: null, retry: null, parametrized: false, data: '' });
        return model;
    });
}
/** A nested function inside a test body counts as "never called" unless it is passed directly as a call argument or invoked immediately. */
function isNestedFn(n, body) {
    let cur = n.parent;
    while (cur && cur.id !== body.id) {
        if (isFn(cur) || cur.type === 'function_declaration') {
            const p = cur.parent;
            const isCallbackArg = !!p && (p.type === 'arguments' || (p.type === 'parenthesized_expression' && p.parent?.type === 'call_expression'));
            const isIife = !!p && p.type === 'call_expression' && p.childForFieldName('function')?.id === cur.id;
            // stored in a variable (or declared) and invoked somewhere in the body: reachable
            const nm = cur.type === 'function_declaration' ? cur.childForFieldName('name')?.text : p?.type === 'variable_declarator' ? p.childForFieldName('name')?.text : p?.type === 'assignment_expression' ? p.childForFieldName('left')?.text : undefined;
            const invoked = !!nm && /^[\w$]+$/.test(nm) && new RegExp(`(^|[^\\w$.])${nm}\\s*\\(`).test(body.text.replace(cur.text, ''));
            if (!isCallbackArg && !isIife && !invoked)
                return true;
        }
        cur = cur.parent;
    }
    return false;
}
function reachable(n, body) {
    if (isNestedFn(n, body))
        return false;
    let cur = n;
    while (cur && cur.id !== body.id) {
        const p = cur.parent;
        if (!p)
            break;
        if (p.type === 'if_statement') {
            const cond = p.childForFieldName('condition');
            const v = constValue((cond?.type === 'parenthesized_expression' ? named(cond)[0]?.text : cond?.text) ?? '');
            if (v === false && cur.id === p.childForFieldName('consequence')?.id)
                return false;
            if (v === true && cur.type === 'else_clause')
                return false;
        }
        if ((p.type === 'while_statement' || p.type === 'do_statement') && cur.id === p.childForFieldName('body')?.id) {
            const cond = p.childForFieldName('condition');
            if (constValue((cond?.type === 'parenthesized_expression' ? named(cond)[0]?.text : cond?.text) ?? '') === false)
                return false;
        }
        if ((p.type === 'for_in_statement') && cur.id === p.childForFieldName('body')?.id && /^(\[\]|\{\}|""|''|``|newMap\(\)|newSet\(\))$/.test(p.childForFieldName('right')?.text.replace(/\s+/g, '') ?? ''))
            return false;
        if (p.type === 'binary_expression' && p.childForFieldName('operator')?.text === '&&' && cur.id === p.childForFieldName('right')?.id && constValue(p.childForFieldName('left')?.text ?? '') === false)
            return false;
        if (p.type === 'statement_block' || p.type === 'program') {
            for (const sib of named(p)) {
                if (sib.id === cur.id)
                    break;
                if (sib.type === 'return_statement' || sib.type === 'throw_statement')
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
        if (isFn(x))
            return false;
        if (x.type === 'return_statement' && line(x) < firstAssertLine)
            n++;
    });
    return n;
}
const JS_BUILTINS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'Math', 'JSON', 'Number', 'String', 'Array', 'Object', 'Boolean', 'Date', 'Symbol', 'BigInt', 'expect', 'new', 'typeof', 'length']);
function freeIdentifiers(text) {
    return (text.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((x) => !JS_BUILTINS.has(x));
}
function classifyMatcher(matcher, args, subject, assigns = new Map()) {
    const a0 = args[0]?.text?.trim();
    const a0n = a0?.replace(/\s+/g, '');
    if (subject !== undefined && a0n !== undefined && subject === a0n && a0n.length > 0)
        return 'weak'; // tautology expect(x).toBe(x)
    if (subject !== undefined && a0n !== undefined && ((assigns.get(subject) !== undefined && assigns.get(subject) === a0n) || (assigns.get(a0n) !== undefined && assigns.get(a0n) === subject)))
        return 'weak'; // const expected = f(x); expect(f(x)).toBe(expected)
    if (subject !== undefined && subject.length > 0 && freeIdentifiers(subject).length === 0 && !/^(toThrow|toThrowError|throw|throws)$/.test(matcher))
        return 'weak'; // expect([1,2]).toHaveLength(2): constants only
    if (a0 !== undefined && /asymmetricMatch/.test(a0))
        return 'weak';
    if (subject !== undefined && /(\|\|true$|^true\|\||\|\|1$)/.test(subject))
        return 'weak'; // x || true: always truthy
    if (matcher === 'toBeCloseTo' && args[1] && /^-\d+|^0$/.test(args[1].text.trim()))
        return 'weak';
    if ((matcher === 'closeTo' || matcher === 'approximately') && args[1] && a0n !== undefined && /^-?[\d.]+$/.test(a0n) && parseFloat(args[1].text) >= Math.max(Math.abs(parseFloat(a0n)) / 2, 0.5))
        return 'weak';
    if (CONDITIONAL_THROW.has(matcher))
        return args.length > 0 ? 'strong' : 'weak';
    if (matcher === 'toMatch' || matcher === 'match' || matcher === 'matches') {
        if (!a0)
            return 'weak';
        if (/^\/(\.\*|\.|\.\+|\^|\$|\^\.\*\$|\[\\s\\S\]\*)?\/[a-z]*$/.test(a0) || a0 === '""' || a0 === "''" || /^expect\.any(thing)?\(/.test(a0))
            return 'weak';
        return 'strong';
    }
    if (matcher === 'toHaveProperty' || matcher === 'property' || matcher === 'nested')
        return args.length >= 2 ? 'strong' : 'weak';
    if (/^(toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|above|least|gt|gte|isAbove|isAtLeast|greaterThan)$/.test(matcher))
        return isLiteralZeroOrOne(a0) ? 'weak' : 'strong';
    if (STRONG.has(matcher)) {
        if (a0 && /^expect\.(anything|any|objectContaining|arrayContaining|stringContaining|stringMatching)\(/.test(a0) && (matcher === 'toEqual' || matcher === 'toStrictEqual' || matcher === 'toBe' || matcher === 'toHaveBeenCalledWith')) {
            return /^expect\.(anything|any)\(/.test(a0) ? 'weak' : 'strong';
        }
        return 'strong';
    }
    if (WEAK.has(matcher))
        return 'weak';
    return null;
}
/** Find assertion expressions in a body. Counts expect(...).matcher(...), chai expect/should chains, assert.*, t.*, supertest .expect(), helpers. */
function assignmentsIn(body) {
    const m = new Map();
    for (const d of descendants(body, 'variable_declarator')) {
        const nm = d.childForFieldName('name');
        const v = d.childForFieldName('value');
        if (nm?.type === 'identifier' && v && !isFn(v))
            m.set(nm.text, v.text.replace(/\s+/g, ''));
    }
    for (const a of descendants(body, 'assignment_expression')) {
        const l = a.childForFieldName('left');
        const r = a.childForFieldName('right');
        if (l?.type === 'identifier' && r)
            m.set(l.text, r.text.replace(/\s+/g, ''));
    }
    return m;
}
function assertionsIn(body, ctx) {
    const out = [];
    const seen = new Set();
    const assigns = assignmentsIn(body);
    const push = (n, strength, subject) => {
        if (seen.has(n.id))
            return;
        seen.add(n.id);
        out.push({ line: line(n), strength, text: head(n.text), subject, reachable: reachable(n, body) });
    };
    walk(body, (n) => {
        if (n.type === 'call_expression') {
            const ch = chainOf(n);
            if (!ch)
                return;
            if (isTestDefChain(ch))
                return false;
            const seg = ch.segs;
            const last = seg[seg.length - 1];
            const lastIsThis = !!last && !!last.call && last.call.id === n.id;
            // supertest-style `.expect(200)` on any chain not rooted at expect/should
            if (ch.root !== 'expect' && ch.root !== 'should' && lastIsThis && last.name === 'expect' && argsOf(n).length > 0) {
                push(n, 'strong', ch.root);
                return; // keep walking: chained .expect() calls nest inside each other
            }
            // chai should-style: value.should.equal(x) / value.should.be.true
            const shouldIdx = seg.findIndex((s) => s.name === 'should');
            if (ch.root !== 'should' && shouldIdx >= 0 && lastIsThis && !CHAIN_NOISE.has(last.name)) {
                const subject = [ch.root, ...seg.slice(0, shouldIdx).map((s) => s.name)].join('.');
                push(n, classifyMatcher(last.name, argsOf(n)) ?? 'strong', subject);
                return false;
            }
            if (TYPE_ASSERT_ROOTS.has(ch.root)) {
                if (lastIsThis && !(seg.length === 1 && last.name === ch.root)) {
                    push(n, 'strong', ch.root);
                    return false;
                }
                if (seg.length === 1 && lastIsThis && ch.root !== 'expectTypeOf') {
                    push(n, 'strong', ch.root);
                    return false;
                }
                return;
            }
            if (ch.root === 'expect' || ch.root === 'should') {
                if (ctx.shadowed.has(ch.root))
                    return false; // a locally redefined expect() proves nothing
                if (!lastIsThis)
                    return;
                if (seg.length === 1 && ch.root === 'expect')
                    return; // bare expect(x)
                const matcher = last.name;
                if (CHAIN_NOISE.has(matcher) && matcher !== 'not')
                    return;
                if (matcher === 'assertions' || matcher === 'hasAssertions' || matcher === 'extend' || matcher === 'addSnapshotSerializer')
                    return false;
                const subjectCall = seg[0]?.call;
                const subject = subjectCall ? (argsOf(subjectCall)[0]?.text.replace(/\s+/g, '') ?? '') : '';
                push(n, classifyMatcher(matcher, argsOf(n), subject, assigns) ?? 'strong', subject);
                return false;
            }
            if (ASSERT_ROOTS.has(ch.root) && ch.root !== 'expect') {
                if (ctx.shadowed.has(ch.root))
                    return false;
                const first = seg[0];
                if (first && first.call && first.call.id === n.id && first.name === ch.root) {
                    push(n, 'weak', argsOf(n)[0]?.text.replace(/\s+/g, '') ?? '');
                    return false;
                }
                if (lastIsThis) {
                    const a = argsOf(n);
                    const strength = classifyMatcher(last.name, a.slice(1), a[0]?.text.replace(/\s+/g, ''), assigns);
                    if (strength) {
                        push(n, strength, a[0]?.text.replace(/\s+/g, '') ?? '');
                        return false;
                    }
                }
                return;
            }
            // Testing Library queries throw when nothing matches: screen.getByRole(...), within(el).findByText(...)
            if ((ch.root === 'screen' || ch.root === 'within') && lastIsThis && /^(get|find)(All)?By[A-Z]/.test(last.name)) {
                push(n, 'strong', argsOf(n)[0]?.text.replace(/\s+/g, '') ?? '');
                return false;
            }
            // helper calls: local asserting helper, or conventionally named imported helper, or helpers.assertX(...)
            if (seg.length === 1 && lastIsThis && last.name === ch.root) {
                if (ctx.noopHelpers.has(ch.root))
                    return false;
                if (ctx.helpers.has(ch.root) || (HELPER_NAME.test(helperBase(ch.root)) && !ASSERT_ROOTS.has(ch.root))) {
                    push(n, 'strong', argsOf(n)[0]?.text.replace(/\s+/g, '') ?? '');
                    return false;
                }
            }
            if (seg.length === 1 && lastIsThis && last.name !== ch.root && HELPER_NAME.test(helperBase(last.name)) && !GLOBALS.has(ch.root)) {
                push(n, 'strong', argsOf(n)[0]?.text.replace(/\s+/g, '') ?? '');
                return false;
            }
            return;
        }
        // chai property-style: expect(x).to.be.true; / x.should.be.true;
        if (n.type === 'member_expression' && n.parent && (n.parent.type === 'expression_statement' || n.parent.type === 'await_expression')) {
            const ch = chainOf(n);
            if (!ch || ch.segs.length === 0)
                return;
            const last = ch.segs[ch.segs.length - 1];
            if (last.call || CHAIN_NOISE.has(last.name))
                return;
            const shouldIdx = ch.segs.findIndex((s) => s.name === 'should');
            if (ch.root === 'expect' || ch.root === 'should') {
                if (!ctx.shadowed.has(ch.root))
                    push(n, classifyMatcher(last.name, []) ?? 'weak', '');
                return false;
            }
            if (shouldIdx >= 0) {
                push(n, classifyMatcher(last.name, []) ?? 'weak', ch.root);
                return false;
            }
        }
    });
    return out;
}
function mockFromCall(n, ch, ctx) {
    const props = ch.segs.map((s) => s.name);
    const args = argsOf(n);
    const text = head(n.text);
    const p0 = props[0] ?? '';
    const s0 = strArg(args[0]);
    if ((ch.root === 'jest' || ch.root === 'vi') && /^(mock|doMock|unstable_mockModule|setMock|registerMock)$/.test(p0)) {
        if (s0)
            return { line: line(n), target: s0, text, literal: false, wholeModule: true };
        const v = args[0]?.text.trim() ?? '';
        const resolved = ctx.imports[v] ?? ctx.constants?.get(v);
        return { line: line(n), target: resolved ?? `ident:${v}`, text, literal: false, wholeModule: true };
    }
    if (ch.root === 'mock' && p0 === 'module' && s0)
        return { line: line(n), target: s0, text, literal: false, wholeModule: true };
    if ((ch.root === 'jest' || ch.root === 'vi' || ch.root === 'sinon' || ch.root === 'sandbox') && /^(spyOn|stub|replace|replaceGetter|replaceSetter|spy|fake|replaceProperty)$/.test(p0) && args.length >= 2) {
        const obj = args[0].text.trim();
        const m = strArg(args[1]) ?? '';
        const resolved = ctx.imports[obj];
        // Unresolvable object (a global, a local variable) cannot be tied to a source module: keep it as an identifier target that never matches a file.
        const target = resolved ? `${resolved}#${m}` : (GLOBALS.has(obj) ? `global:${obj}.${m}` : `ident:${obj}.${m}`);
        return { line: line(n), target, text, literal: p0 === 'replaceProperty' && isLiteral(args[2]) && /^[A-Z][A-Z0-9_]*$/.test(m), wholeModule: false };
    }
    if (ch.root === 'td' && p0 === 'replace' && args.length >= 1) {
        const m = strArg(args[1]);
        const obj = args[0].text.trim();
        return { line: line(n), target: s0 ?? (ctx.imports[obj] ? `${ctx.imports[obj]}#${m ?? ''}` : `ident:${obj}.${m ?? ''}`), text, literal: false, wholeModule: !!s0 };
    }
    if ((ch.root === 'proxyquire' || ch.root === 'esmock' || ch.root === 'rewiremock') && s0 && args[1]?.type === 'object') {
        const keys = descendants(args[1], 'pair').map((p) => strArg(p.childForFieldName('key') ?? undefined) ?? p.childForFieldName('key')?.text ?? '');
        const rel = keys.find((k) => k.startsWith('.')) ?? keys[0];
        if (rel)
            return { line: line(n), target: rel, text, literal: false, wholeModule: true };
    }
    return null;
}
function mocksIn(body, ctx) {
    const out = [];
    walk(body, (n) => {
        if (n.type === 'assignment_expression') {
            const l = n.childForFieldName('left');
            if (l?.type === 'member_expression') {
                const obj = l.childForFieldName('object')?.text ?? '';
                const prop = l.childForFieldName('property')?.text ?? '';
                const base = obj.split('.')[0] ?? '';
                if (ctx.imports[base] !== undefined)
                    out.push({ line: line(n), target: `${ctx.imports[base]}#${prop}`, text: head(n.text), literal: false, wholeModule: false });
            }
            return;
        }
        if (n.type !== 'call_expression')
            return;
        const ch = chainOf(n);
        if (!ch)
            return;
        if (isTestDefChain(ch))
            return false;
        const m = mockFromCall(n, ch, ctx);
        if (m) {
            out.push(m);
            return false;
        }
    });
    return out;
}
function tolerancesIn(body) {
    const out = [];
    walk(body, (n) => {
        if (n.type !== 'call_expression')
            return;
        const ch = chainOf(n);
        if (!ch)
            return;
        const last = ch.segs[ch.segs.length - 1];
        if (!last || !last.call || last.call.id !== n.id)
            return;
        const args = argsOf(n);
        const subject = ch.segs[0]?.call ? argsOf(ch.segs[0].call)[0]?.text.replace(/\s+/g, '') ?? '' : ch.root;
        const key = `${subject}|${last.name}|${args[0]?.text.replace(/\s+/g, '') ?? ''}`;
        if (last.name === 'toBeCloseTo') {
            const d = args[1]?.text;
            const digits = d && /^-?\d+$/.test(d) ? parseInt(d, 10) : 2;
            out.push({ line: line(n), looseness: Math.pow(10, -digits), kind: 'closeTo', text: head(n.text), key });
        }
        else if (last.name === 'closeTo' || last.name === 'approximately') {
            const d = args[1]?.text;
            const delta = d && /^[\d.eE+-]+$/.test(d) ? parseFloat(d) : NaN;
            if (!isNaN(delta))
                out.push({ line: line(n), looseness: delta, kind: 'closeTo', text: head(n.text), key });
        }
    });
    return out;
}
function swallowedIn(body, ctx) {
    const out = [];
    for (const t of descendants(body, 'try_statement')) {
        const tb = t.childForFieldName('body');
        const handler = t.childForFieldName('handler');
        if (!tb || !handler)
            continue;
        const inner = assertionsIn(tb, ctx);
        if (inner.length === 0)
            continue;
        const hb = handler.childForFieldName('body') ?? handler;
        const rethrows = descendants(hb, 'throw_statement').length > 0;
        const asserts = assertionsIn(hb, ctx).length > 0;
        const fails = descendants(hb, 'call_expression').some((c) => /\b(fail|done|skip)\s*\(/.test(c.text) || /\.(fail|skip)\(/.test(c.text));
        if (!rethrows && !asserts && !fails)
            out.push(...inner.map((a) => ({ line: a.line, text: a.text })));
    }
    return out;
}
//# sourceMappingURL=js.js.map