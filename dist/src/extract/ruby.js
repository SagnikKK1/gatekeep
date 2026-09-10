import { withTree, walk, descendants, ancestor, countErrors, line, named } from '../parser.js';
/** Ruby: RSpec (describe/it, expect().to matcher, xit/skip/pending, allow/receive) and minitest / test-unit (def test_*, assert_*, refute_*, stub). */
function head(t) { return t.split('\n')[0].slice(0, 120); }
export function normalizeBody(t) {
    return t.replace(/#.*$/gm, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
const strArg = (n) => (n && /string|simple_symbol/.test(n.type) ? n.text.replace(/^:|^['"]|['"]$/g, '') : null);
const BLOCK_METHODS = new Set(['describe', 'context', 'feature', 'xdescribe', 'xcontext', 'fdescribe', 'fcontext', 'shared_examples', 'shared_context', 'shared_examples_for']);
const TEST_METHODS = new Set(['it', 'specify', 'example', 'scenario', 'xit', 'xspecify', 'xexample', 'xscenario', 'fit', 'fspecify', 'fexample', 'its']);
const RSPEC_STRONG = new Set(['eq', 'eql', 'equal', 'match', 'include', 'contain_exactly', 'match_array', 'start_with', 'end_with', 'have_attributes', 'have_key', 'have_http_status', 'redirect_to', 'render_template', 'have_content', 'have_text', 'have_selector', 'have_css', 'have_link', 'have_button', 'have_field', 'cover', 'all', 'satisfy', 'throw_symbol', 'output', 'yield_with_args', 'have_received', 'receive', 'be_within', 'change', 'have_enqueued_job', 'have_been_enqueued', 'raise_exception', 'exist', 'have_many', 'belong_to', 'validate_presence_of', 'have_db_column']);
const RSPEC_WEAK = new Set(['be_truthy', 'be_falsey', 'be_falsy', 'be_nil', 'be_present', 'be_blank', 'be_empty', 'be_ok', 'be_success', 'be_successful', 'be_valid', 'be_invalid', 'be_a', 'be_an', 'be_kind_of', 'be_instance_of', 'be_a_kind_of', 'be_an_instance_of', 'respond_to', 'be_nothing', 'be_persisted', 'be_new_record', 'be_true', 'be_false', 'be_zero', 'be_positive', 'be_negative', 'be_odd', 'be_even', 'be_frozen', 'have_attributes_or_not']);
const MINITEST_STRONG = new Set(['assert_equal', 'assert_same', 'assert_in_delta', 'assert_in_epsilon', 'assert_includes', 'assert_match', 'assert_raises', 'assert_raise', 'assert_throws', 'assert_output', 'assert_send', 'assert_operator', 'assert_kind_of', 'refute_equal', 'refute_same', 'refute_includes', 'refute_match', 'refute_in_delta', 'assert_not_equal', 'assert_not_includes', 'assert_no_match', 'assert_difference', 'assert_no_difference', 'assert_changes', 'assert_no_changes', 'assert_response', 'assert_redirected_to', 'assert_select', 'assert_dom_equal', 'assert_template', 'assert_enqueued_with', 'assert_performed_with', 'assert_emails', 'assert_predicate', 'refute_predicate', 'must_equal', 'must_match', 'must_include', 'must_raise', 'must_be_within_delta', 'must_be_close_to', 'wont_equal', 'wont_include', 'must_output', 'must_be_kind_of', 'must_respond_to', 'assert_instance_of', 'refute_instance_of', 'assert_pattern']);
const MINITEST_WEAK = new Set(['assert', 'refute', 'assert_nil', 'refute_nil', 'assert_not_nil', 'assert_not', 'assert_empty', 'refute_empty', 'assert_not_empty', 'assert_respond_to', 'assert_nothing_raised', 'assert_true', 'assert_false', 'flunk', 'must_be_nil', 'wont_be_nil', 'must_be_empty', 'wont_be_empty', 'must_be', 'wont_be', 'assert_block', 'assert_valid']);
const SKIP_CALLS = new Set(['skip', 'pending', 'omit', 'skip_until', 'xskip']);
const HELPER_NAME = /^(assert|check|verify|expect|ensure|validate)_/;
export async function extractRuby(filePath, source) {
    return withTree(source, 'ruby', (tree) => {
        const root = tree.rootNode;
        const model = { path: filePath, lang: 'ruby', tests: [], fileMocks: [], fileSkip: null, fileRetry: null, parseErrors: countErrors(tree), shadowed: [], imports: {} };
        for (const c of descendants(root, 'call'))
            if (c.childForFieldName('method')?.text === 'require_relative' || c.childForFieldName('method')?.text === 'require') {
                const a = strArg(named(c.childForFieldName('arguments'))[0]);
                if (a)
                    model.imports[a.split('/').pop() ?? a] = a;
            }
        const ctx = { helpers: new Set(), noopHelpers: new Set(), constants: new Map() };
        // A skip in setup/before runs ahead of every example in the group, so the whole file stops testing.
        for (const m of descendants(root, 'method')) {
            const nm = m.childForFieldName('name')?.text ?? '';
            if (!/^(setup|before_setup|before_each|before)$/.test(nm))
                continue;
            const b = m.childForFieldName('body');
            if (!b)
                continue;
            const sk = descendants(b, 'call').find((c) => SKIP_CALLS.has(c.childForFieldName('method')?.text ?? ''));
            if (sk && !model.fileSkip)
                model.fileSkip = { line: line(sk), marker: `${nm} calls ${sk.childForFieldName('method')?.text}: every test in this file is skipped` };
        }
        for (const blk of descendants(root, 'call')) {
            if (!/^(before|around)$/.test(blk.childForFieldName('method')?.text ?? ''))
                continue;
            const body = blk.childForFieldName('block') ?? blk.childForFieldName('do_block');
            if (!body)
                continue;
            const sk = descendants(body, 'call').find((c) => SKIP_CALLS.has(c.childForFieldName('method')?.text ?? ''));
            if (sk && !model.fileSkip)
                model.fileSkip = { line: line(sk), marker: `a before hook calls ${sk.childForFieldName('method')?.text}: every example in this file is skipped` };
        }
        for (const a of descendants(root, 'assignment')) {
            const l = a.childForFieldName('left');
            const r = a.childForFieldName('right');
            if (l?.type === 'constant' && r && !ancestor(a, ['method', 'do_block', 'block']))
                ctx.constants.set(l.text, normalizeBody(r.text));
        }
        // local helper methods that assert: `def assert_json(...)` or any `def` whose body asserts
        for (const m of descendants(root, 'method')) {
            const nm = m.childForFieldName('name')?.text ?? '';
            const b = m.childForFieldName('body');
            if (!nm || /^test_/.test(nm))
                continue;
            if (b && (assertionsIn(b, ctx).length > 0 || descendants(b, 'call').some((c) => /^(raise|flunk|fail)$/.test(c.childForFieldName('method')?.text ?? ''))))
                ctx.helpers.add(nm);
            // Named like an assertion but unable to fail. It is credited on its name alone below, so without this
            // `def check_value(got, want); end` stands in for a real check.
            else if (HELPER_NAME.test(nm)) {
                ctx.noopHelpers.add(nm);
                model.shadowed.push({ line: line(m), name: nm });
            }
        }
        const expandData = (t) => { const k = t.trim(); return ctx.constants.has(k) ? `${k}\n${ctx.constants.get(k)}` : t; };
        const visitScope = (node, scope) => {
            walk(node, (n) => {
                if (n.id === node.id)
                    return;
                if (n.type !== 'call')
                    return;
                const method = n.childForFieldName('method')?.text ?? '';
                const recv = n.childForFieldName('receiver')?.text ?? '';
                const args = named(n.childForFieldName('arguments'));
                const block = n.childForFieldName('block');
                if ((BLOCK_METHODS.has(method) || TEST_METHODS.has(method)) && (recv === '' || recv === 'RSpec')) {
                    const name = strArg(args[0]) ?? args[0]?.text ?? '<anonymous>';
                    const skipHere = /^x/.test(method) || args.some((a) => /^(:skip|skip:|:pending|pending:)/.test(a.text) || /skip:\s*(true|['"])|pending:\s*(true|['"])/.test(a.text));
                    const onlyHere = /^f(it|describe|context|specify|example)$/.test(method) || args.some((a) => /^:focus$|focus:\s*true/.test(a.text));
                    const body = block?.childForFieldName('body') ?? block;
                    if (BLOCK_METHODS.has(method)) {
                        const inner = { path: [...scope.path, name], skip: scope.skip ?? (skipHere ? { line: line(n), marker: head(n.text), conditional: false } : null), only: scope.only ?? (onlyHere ? { line: line(n), marker: head(n.text) } : null), data: scope.data };
                        if (body)
                            visitScope(body, inner);
                        return false;
                    }
                    const tc = mkTest([...scope.path, name].join(' > '), n, body ?? null, ctx, expandData);
                    tc.skip = scope.skip ?? tc.skip ?? (skipHere ? { line: line(n), marker: head(n.text), conditional: false } : null);
                    tc.only = scope.only ?? (onlyHere ? { line: line(n), marker: head(n.text) } : null);
                    if (scope.data) {
                        tc.parametrized = true;
                        tc.data += scope.data;
                    }
                    model.tests.push(tc);
                    return false;
                }
                // `[[...]].each do |a, b| it ... end` or `cases.each do` wrapping examples: data-driven
                if (method === 'each' && block && descendants(block, 'call').some((c) => TEST_METHODS.has(c.childForFieldName('method')?.text ?? ''))) {
                    const body = block.childForFieldName('body') ?? block;
                    visitScope(body, { ...scope, data: scope.data + expandData(normalizeBody(recv)) + '\n' });
                    return false;
                }
                if (/^(before|after|around|let|let!|subject)$/.test(method) && block) {
                    const b = block.childForFieldName('body') ?? block;
                    model.fileMocks.push(...mocksIn(b));
                    return false;
                }
            });
        };
        visitScope(root, { path: [], skip: null, only: null, data: '' });
        // minitest / test-unit classes
        for (const cls of descendants(root, 'class')) {
            const cname = cls.childForFieldName('name')?.text ?? '';
            const body = cls.childForFieldName('body');
            if (!body)
                continue;
            for (const m of named(body).filter((c) => c.type === 'method')) {
                const nm = m.childForFieldName('name')?.text ?? '';
                if (!/^test_/.test(nm)) {
                    const b = m.childForFieldName('body');
                    if (b && /^(setup|before_setup|setup_class)$/.test(nm))
                        model.fileMocks.push(...mocksIn(b));
                    continue;
                }
                const tc = mkTest(`${cname}.${nm}`, m, m.childForFieldName('body'), ctx, expandData);
                model.tests.push(tc);
            }
            // test "description" do ... end (ActiveSupport / minitest spec style)
            for (const c of named(body).filter((c) => c.type === 'call' && /^(test|it|specify)$/.test(c.childForFieldName('method')?.text ?? ''))) {
                const name = strArg(named(c.childForFieldName('arguments'))[0]) ?? '<anonymous>';
                const b = c.childForFieldName('block');
                const bb = b?.childForFieldName('body') ?? b ?? null;
                if (!model.tests.some((t) => t.line === line(c)))
                    model.tests.push(mkTest(`${cname}.${name}`, c, bb, ctx, expandData));
            }
        }
        return model;
    });
}
function mkTest(name, node, body, ctx, expandData) {
    const tc = {
        name, line: line(node), assertions: [], skip: null, only: null, mocks: [], swallowed: [], retry: null, tolerances: [], timeout: null,
        body: normalizeBody(body?.text ?? ''), earlyExits: 0, parametrized: false, vacuous: false, data: '',
    };
    if (!body)
        return tc;
    tc.assertions = assertionsIn(body, ctx);
    tc.mocks = mocksIn(body);
    tc.tolerances = tolerancesIn(body);
    tc.swallowed = swallowedIn(body, ctx);
    walk(body, (n) => {
        if (n.type !== 'call')
            return;
        const m = n.childForFieldName('method')?.text ?? '';
        if (SKIP_CALLS.has(m) && !n.childForFieldName('receiver') && !tc.skip)
            tc.skip = { line: line(n), marker: head(n.text), conditional: !!ancestor(n, ['if', 'unless', 'if_modifier', 'unless_modifier', 'rescue'], body) };
    });
    const first = tc.assertions[0]?.line ?? Infinity;
    walk(body, (n) => { if (n.type === 'method' || n.type === 'lambda')
        return false; if (n.type === 'return' && line(n) < first)
        tc.earlyExits++; });
    for (const loop of descendants(body, ['call', 'for'])) {
        const m = loop.type === 'call' ? loop.childForFieldName('method')?.text ?? '' : 'for';
        if (!/^(each|each_with_index|map|each_pair|for)$/.test(m))
            continue;
        const lb = loop.type === 'call' ? loop.childForFieldName('block') : loop.childForFieldName('body');
        if (lb && tc.assertions.some((a) => a.line >= line(loop) && a.line <= lb.endPosition.row + 1)) {
            tc.parametrized = true;
            tc.data += expandData(normalizeBody(loop.type === 'call' ? loop.childForFieldName('receiver')?.text ?? '' : loop.childForFieldName('value')?.text ?? '')) + '\n';
        }
    }
    return tc;
}
function reachable(n, body) {
    let cur = n;
    while (cur && cur.id !== body.id) {
        const p = cur.parent;
        if (!p)
            break;
        if ((p.type === 'if' || p.type === 'unless') && cur.id !== p.childForFieldName('condition')?.id) {
            const c = p.childForFieldName('condition')?.text.replace(/\s+/g, '') ?? '';
            const constFalse = /^(false|nil)$/.test(c) || /^(\d+)==(\d+)$/.test(c) && c.split('==')[0] !== c.split('==')[1];
            const constTrue = /^(true)$/.test(c);
            const inElse = cur.type === 'else';
            if (p.type === 'if' && ((constFalse && !inElse) || (constTrue && inElse)))
                return false;
            if (p.type === 'unless' && ((constTrue && !inElse) || (constFalse && inElse)))
                return false;
        }
        if (p.type === 'if_modifier' && cur.id === named(p)[0]?.id && /^(false|nil)$/.test(named(p)[1]?.text ?? ''))
            return false;
        if (p.type === 'unless_modifier' && cur.id === named(p)[0]?.id && /^true$/.test(named(p)[1]?.text ?? ''))
            return false;
        if (p.type === 'body_statement' || p.type === 'then' || p.type === 'program') {
            for (const sib of named(p)) {
                if (sib.id === cur.id)
                    break;
                if (sib.type === 'return')
                    return false;
            }
        }
        if (p.type === 'lambda' || (p.type === 'method' && p.id !== body.id))
            return false;
        cur = p;
    }
    return true;
}
/** matcher node from `expect(x).to MATCHER` : a call (eq(5)), identifier (be_nil), or operator form (`be > 0`). */
function classifyRSpec(matcher, subject) {
    if (!matcher)
        return 'weak';
    const m = matcher.type === 'call' ? matcher.childForFieldName('method')?.text ?? '' : matcher.type === 'identifier' ? matcher.text : matcher.type === 'binary' ? 'be_op' : '';
    const args = matcher.type === 'call' ? named(matcher.childForFieldName('arguments')) : [];
    const a0 = args[0]?.text.replace(/\s+/g, '') ?? '';
    if (m === 'be_op') {
        const t = matcher.text.replace(/\s+/g, '');
        return /^be[<>]=?[01]$/.test(t) ? 'weak' : 'strong';
    }
    if (/^(eq|eql|equal|be)$/.test(m) && args.length > 0)
        return a0 === subject || /^(true|false|nil)$/.test(a0) && m !== 'eq' && m !== 'eql' ? 'weak' : /^(true|false)$/.test(a0) ? 'weak' : 'strong';
    if (m === 'be' && args.length === 0)
        return 'weak';
    if (/^(raise_error|raise_exception|throw_symbol)$/.test(m))
        return args.length > 0 ? 'strong' : 'weak';
    if (m === 'respond_to' || m === 'be_a' || m === 'be_an' || m === 'be_kind_of' || m === 'be_instance_of')
        return 'weak';
    if (m === 'match' && /^\/(\.\*|\.|\.\+)?\/[a-z]*$|^["']["']$/.test(a0))
        return 'weak';
    if (matcher.type === 'call' && matcher.childForFieldName('receiver')) {
        // chained matchers: be_within(d).of(x), change { }.by(n), have_received(:m).with(...)
        const rootM = descendants(matcher, 'call').map((c) => c.childForFieldName('method')?.text ?? '').concat(m);
        if (rootM.some((x) => RSPEC_STRONG.has(x)))
            return 'strong';
    }
    if (RSPEC_STRONG.has(m))
        return 'strong';
    if (RSPEC_WEAK.has(m) || /^be_/.test(m) || /^have_/.test(m) && args.length === 0)
        return 'weak';
    return 'strong';
}
function assertionsIn(body, ctx) {
    const out = [];
    const push = (n, strength, subject) => out.push({ line: line(n), strength, text: head(n.text), subject: subject.replace(/\s+/g, '').slice(0, 80), reachable: reachable(n, body) });
    walk(body, (n) => {
        if (n.type === 'method')
            return false;
        if (n.type !== 'call')
            return;
        const method = n.childForFieldName('method')?.text ?? '';
        const recvNode = n.childForFieldName('receiver');
        const args = named(n.childForFieldName('arguments'));
        // RSpec: expect(x).to matcher / expect(x).not_to matcher / is_expected.to / expect { }.to raise_error
        if (/^(to|not_to|to_not)$/.test(method) && recvNode?.type === 'call') {
            const rm = recvNode.childForFieldName('method')?.text ?? '';
            if (/^(expect|is_expected|expect_any_instance_of)$/.test(rm)) {
                const subjNode = named(recvNode.childForFieldName('arguments'))[0];
                const subject = rm === 'is_expected' ? 'subject' : subjNode?.text ?? recvNode.childForFieldName('block')?.text ?? '';
                const matcher = args[0];
                const mName = matcher?.type === 'call' ? matcher.childForFieldName('method')?.text ?? '' : matcher?.text ?? '';
                if (mName === 'receive' || (matcher?.type === 'call' && descendants(matcher, 'call').some((c) => c.childForFieldName('method')?.text === 'receive'))) {
                    // message expectation: an assertion and a mock at once (mock side handled in mocksIn)
                    push(n, 'strong', subject);
                    return false;
                }
                push(n, classifyRSpec(matcher, subject.replace(/\s+/g, '')), subject);
                return false;
            }
            if (rm === 'allow')
                return false;
        }
        // old should syntax: x.should == y / x.should be_nil / x.should_not
        if (/^(should|should_not)$/.test(method) && recvNode) {
            const m = args[0];
            push(n, m ? classifyRSpec(m, recvNode.text.replace(/\s+/g, '')) : 'weak', recvNode.text);
            return false;
        }
        if (recvNode && recvNode.type === 'call' && /^(should|should_not)$/.test(recvNode.childForFieldName('method')?.text ?? '') && /^(==|!=|=~|>|<|>=|<=)$/.test(method)) {
            const subj = recvNode.childForFieldName('receiver')?.text ?? '';
            push(n, args[0] && args[0].text.replace(/\s+/g, '') === subj.replace(/\s+/g, '') ? 'weak' : method === '==' || method === '=~' ? 'strong' : /^[01]$/.test(args[0]?.text ?? '') ? 'weak' : 'strong', subj);
            return false;
        }
        // minitest / test-unit / minitest-spec
        if (!recvNode || /^(self|assert|_)$/.test(recvNode.text) || recvNode.type === 'call' || recvNode.type === 'identifier' || recvNode.type === 'constant') {
            if (MINITEST_STRONG.has(method) || MINITEST_WEAK.has(method)) {
                // spec style value.must_equal x has the subject as receiver
                const specStyle = /^(must|wont)_/.test(method);
                const a = args.map((x) => x.text.replace(/\s+/g, ''));
                const subject = specStyle ? recvNode?.text ?? '' : (a[1] ?? a[0] ?? '');
                let strength = MINITEST_STRONG.has(method) ? 'strong' : 'weak';
                if (/^(assert_equal|refute_equal|assert_same)$/.test(method) && a.length >= 2 && a[0] === a[1])
                    strength = 'weak';
                if (/^(assert_equal)$/.test(method) && /^(true|false)$/.test(a[0] ?? ''))
                    strength = 'weak';
                if (method === 'assert' && a[0] && /==|!=|=~|\.\w+\?(\(|$)/.test(a[0]) && !/(>=?|<=?)[01]$/.test(a[0]))
                    strength = 'strong';
                if (/^(assert_in_delta|assert_in_epsilon|must_be_within_delta|must_be_close_to)$/.test(method)) {
                    const d = parseFloat(a[2] ?? a[1] ?? '');
                    const v = parseFloat(a[0] ?? '');
                    if (!isNaN(d) && (isNaN(v) ? d >= 100 : d >= Math.max(Math.abs(v) / 2, 0.5)))
                        strength = 'weak';
                }
                if (specStyle || !recvNode || /^(self|assert|_)$/.test(recvNode.text)) {
                    push(n, strength, subject);
                    return false;
                }
            }
        }
        // local asserting helpers and conventionally named ones
        if (!recvNode && ctx.noopHelpers.has(method))
            return false;
        if (!recvNode && (ctx.helpers.has(method) || HELPER_NAME.test(method))) {
            push(n, 'strong', args[0]?.text ?? '');
            return false;
        }
    });
    return out;
}
function mocksIn(body) {
    const out = [];
    walk(body, (n) => {
        if (n.type !== 'call')
            return;
        const method = n.childForFieldName('method')?.text ?? '';
        const recv = n.childForFieldName('receiver');
        const args = named(n.childForFieldName('arguments'));
        // allow(X).to receive(:m) / expect(X).to receive(:m) / allow_any_instance_of(X).to receive(:m)
        if (/^(to|not_to|to_not)$/.test(method) && recv?.type === 'call' && /^(allow|expect|allow_any_instance_of|expect_any_instance_of)$/.test(recv.childForFieldName('method')?.text ?? '')) {
            const target = named(recv.childForFieldName('arguments'))[0]?.text ?? '';
            const rc = args[0] && descendants(args[0], 'call').concat(args[0].type === 'call' ? [args[0]] : []).find((c) => /^receive(_messages|_message_chain)?$/.test(c.childForFieldName('method')?.text ?? ''));
            const meth = rc ? strArg(named(rc.childForFieldName('arguments'))[0]) ?? '' : '';
            if (target && rc)
                out.push({ line: line(n), target: `${target}#${meth}`, text: head(n.text), literal: false, wholeModule: false });
            return false;
        }
        if (/^(double|instance_double|class_double|object_double|spy|instance_spy|class_spy)$/.test(method) && !recv) {
            const t = args[0];
            if (t)
                out.push({ line: line(n), target: t.type === 'constant' || t.type === 'scope_resolution' ? t.text : strArg(t) ?? t.text, text: head(n.text), literal: false, wholeModule: true });
            return false;
        }
        if (/^(stub|stubs|expects|stub_const|stub_any_instance)$/.test(method) && recv) {
            const m = strArg(args[0]) ?? args[0]?.text ?? '';
            out.push({ line: line(n), target: method === 'stub_const' ? m : `${recv.text}#${m}`, text: head(n.text), literal: method === 'stub' && !!args[1] && /^(integer|float|string|true|false|nil|simple_symbol)$/.test(args[1].type) && /^[A-Z_]+$/.test(m), wholeModule: method === 'stub_const' });
            return false;
        }
        if (method === 'stub_const' && !recv && args[0]) {
            out.push({ line: line(n), target: strArg(args[0]) ?? args[0].text, text: head(n.text), literal: false, wholeModule: true });
            return false;
        }
    });
    return out;
}
function tolerancesIn(body) {
    const out = [];
    walk(body, (n) => {
        if (n.type !== 'call')
            return;
        const method = n.childForFieldName('method')?.text ?? '';
        const args = named(n.childForFieldName('arguments')).map((a) => a.text.replace(/\s+/g, ''));
        if (/^(assert_in_delta|refute_in_delta)$/.test(method)) {
            const d = parseFloat(args[2] ?? '0.001');
            if (!isNaN(d))
                out.push({ line: line(n), looseness: d, kind: 'delta', text: head(n.text), key: `${args[1]}|${method}|${args[0]}` });
        }
        if (method === 'be_within') {
            const d = parseFloat(args[0] ?? '');
            const of = n.parent?.type === 'call' ? named(n.parent.childForFieldName('arguments'))[0]?.text.replace(/\s+/g, '') ?? '' : '';
            if (!isNaN(d))
                out.push({ line: line(n), looseness: d, kind: 'delta', text: head(n.parent?.text ?? n.text), key: `${of}|be_within` });
        }
    });
    return out;
}
function swallowedIn(body, ctx) {
    const out = [];
    for (const b of descendants(body, 'begin')) {
        const rescues = named(b).filter((c) => c.type === 'rescue');
        if (rescues.length === 0)
            continue;
        const tryBody = named(b).filter((c) => c.type !== 'rescue' && c.type !== 'ensure' && c.type !== 'else');
        const inner = tryBody.flatMap((s) => assertionsIn(s, ctx));
        if (inner.length === 0)
            continue;
        const swallowing = rescues.some((r) => assertionsIn(r, ctx).length === 0 && !descendants(r, 'call').some((c) => /^(raise|flunk|fail|skip)$/.test(c.childForFieldName('method')?.text ?? '')));
        if (swallowing)
            out.push(...inner.map((a) => ({ line: a.line, text: a.text })));
    }
    return out;
}
//# sourceMappingURL=ruby.js.map