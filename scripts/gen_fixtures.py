import json, os, pathlib, shutil
ROOT = pathlib.Path('fixtures')
if ROOT.exists(): shutil.rmtree(ROOT)

def case(name, before, after, expected):
    d = ROOT / name
    for sub, files in (('before', before), ('after', after)):
        for p, content in files.items():
            fp = d / sub / p
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(content)
    (d / 'expected.json').write_text(json.dumps({'findings': expected}, indent=2) + '\n')

# ---------- shared sources ----------
PY_SRC = "def verify(password, stored):\n    return password == stored\n\ndef login(user, password, db):\n    if verify(password, db[user]):\n        return {'ok': True, 'user': user}\n    raise ValueError('bad password')\n"
PY_SRC_CHANGED = "def verify(password, stored):\n    return True  # TODO\n\ndef login(user, password, db):\n    if verify(password, db[user]):\n        return {'ok': True, 'user': user}\n    raise ValueError('bad password')\n"
PY_TEST = """import pytest
from app.auth import login, verify

def test_verify_matches():
    assert verify('a', 'a') == True
    assert verify('a', 'b') == False

def test_login_returns_user():
    result = login('bob', 'pw', {'bob': 'pw'})
    assert result == {'ok': True, 'user': 'bob'}

def test_login_rejects_bad_password():
    with pytest.raises(ValueError, match='bad password'):
        login('bob', 'nope', {'bob': 'pw'})

class TestNumbers:
    def test_close(self):
        assert 0.1 + 0.2 == pytest.approx(0.3, rel=1e-6)
"""
JS_SRC = "export function verify(p, s) { return p === s; }\nexport function login(user, p, db) {\n  if (verify(p, db[user])) return { ok: true, user };\n  throw new Error('bad password');\n}\n"
JS_SRC_CHANGED = "export function verify(p, s) { return true; }\nexport function login(user, p, db) {\n  if (verify(p, db[user])) return { ok: true, user };\n  throw new Error('bad password');\n}\n"
JS_TEST = """import { login, verify } from '../src/auth';

describe('auth', () => {
  it('verify matches', () => {
    expect(verify('a', 'a')).toBe(true);
    expect(verify('a', 'b')).toBe(false);
  });
  it('login returns user', () => {
    expect(login('bob', 'pw', { bob: 'pw' })).toEqual({ ok: true, user: 'bob' });
  });
  it('login rejects bad password', () => {
    expect(() => login('bob', 'nope', { bob: 'pw' })).toThrow('bad password');
  });
  it('close enough', () => {
    expect(0.1 + 0.2).toBeCloseTo(0.3, 5);
  });
});
"""
T = 'tests/test_auth.py'; S = 'app/auth.py'
JT = 'tests/auth.test.ts'; JS = 'src/auth.ts'

# ---------- Python tampered ----------
case('py-test-deleted',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("""def test_login_rejects_bad_password():
    with pytest.raises(ValueError, match='bad password'):
        login('bob', 'nope', {'bob': 'pw'})

""", ""), S: PY_SRC_CHANGED},
  [{'rule': 'test-deleted', 'file': T, 'test': 'test_login_rejects_bad_password'}])

case('py-test-skipped',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("def test_login_rejects_bad_password():", "@pytest.mark.skip(reason='flaky')\ndef test_login_rejects_bad_password():"), S: PY_SRC_CHANGED},
  [{'rule': 'test-skipped', 'file': T, 'test': 'test_login_rejects_bad_password'}])

case('py-test-xfail-and-body-skip',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("def test_verify_matches():\n", "@pytest.mark.xfail\ndef test_verify_matches():\n")
             .replace("def test_login_returns_user():\n", "def test_login_returns_user():\n    pytest.skip('todo')\n"), S: PY_SRC_CHANGED},
  [{'rule': 'test-skipped', 'file': T, 'test': 'test_verify_matches'}, {'rule': 'test-skipped', 'file': T, 'test': 'test_login_returns_user'}])

case('py-assertions-removed',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("""    result = login('bob', 'pw', {'bob': 'pw'})
    assert result == {'ok': True, 'user': 'bob'}""", """    result = login('bob', 'pw', {'bob': 'pw'})
    print(result)"""), S: PY_SRC_CHANGED},
  [{'rule': 'assertions-removed', 'file': T, 'test': 'test_login_returns_user'}])

case('py-assertion-weakened',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("assert result == {'ok': True, 'user': 'bob'}", "assert result")
             .replace("with pytest.raises(ValueError, match='bad password'):", "with pytest.raises(Exception):"), S: PY_SRC_CHANGED},
  [{'rule': 'assertion-weakened', 'file': T, 'test': 'test_login_returns_user'}, {'rule': 'assertion-weakened', 'file': T, 'test': 'test_login_rejects_bad_password'}])

case('py-assertion-any-keyword',
  {T: "def test_toast():\n    toast = get_toast()\n    assert toast == 'ssh connection error'\n", S: PY_SRC},
  {T: "def test_toast():\n    toast = get_toast()\n    assert any(kw in toast for kw in ['ssh', 'error'])\n", S: PY_SRC_CHANGED},
  [{'rule': 'assertion-weakened', 'file': T, 'test': 'test_toast'}])

case('py-mock-on-changed-module',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("def test_login_returns_user():\n", "from unittest.mock import patch\n\n@patch('app.auth.verify', return_value=True)\ndef test_login_returns_user(_m):\n"), S: PY_SRC_CHANGED},
  [{'rule': 'mock-on-changed-module', 'file': T, 'test': 'test_login_returns_user'}])

case('py-mocker-and-monkeypatch',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("def test_login_returns_user():\n", "def test_login_returns_user(mocker, monkeypatch):\n    mocker.patch('app.auth.verify', return_value=True)\n    monkeypatch.setattr('app.auth.login', lambda *a: {'ok': True, 'user': 'bob'})\n"), S: PY_SRC_CHANGED},
  [{'rule': 'mock-on-changed-module', 'file': T, 'test': 'test_login_returns_user'}, {'rule': 'mock-unrelated-to-change', 'file': T, 'test': 'test_login_returns_user'}])

case('py-assertion-swallowed',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("""    result = login('bob', 'pw', {'bob': 'pw'})
    assert result == {'ok': True, 'user': 'bob'}""", """    try:
        result = login('bob', 'pw', {'bob': 'pw'})
        assert result == {'ok': True, 'user': 'bob'}
    except Exception:
        pass"""), S: PY_SRC_CHANGED},
  [{'rule': 'assertion-swallowed', 'file': T, 'test': 'test_login_returns_user'}])

case('py-tolerance-loosened',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("pytest.approx(0.3, rel=1e-6)", "pytest.approx(0.3, rel=0.5)"), S: PY_SRC_CHANGED},
  [{'rule': 'tolerance-loosened', 'file': T, 'test': 'TestNumbers.test_close'}, {'rule': 'assertion-weakened', 'file': T, 'test': 'TestNumbers.test_close'}])

case('py-retry-added',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("def test_login_rejects_bad_password():", "@pytest.mark.flaky(reruns=5)\ndef test_login_rejects_bad_password():"), S: PY_SRC_CHANGED},
  [{'rule': 'retry-added', 'file': T, 'test': 'test_login_rejects_bad_password'}])

case('py-test-file-deleted',
  {T: PY_TEST, S: PY_SRC},
  {S: PY_SRC_CHANGED},
  [{'rule': 'test-file-deleted', 'file': T}])

case('py-file-skipped',
  {T: PY_TEST, S: PY_SRC},
  {T: "pytestmark = pytest.mark.skip(reason='rewrite pending')\n" + PY_TEST, S: PY_SRC_CHANGED},
  [{'rule': 'file-skipped', 'file': T}])

case('py-pytest-ini-changed',
  {T: PY_TEST, S: PY_SRC, 'pytest.ini': "[pytest]\ntestpaths = tests\n"},
  {T: PY_TEST, S: PY_SRC_CHANGED, 'pytest.ini': "[pytest]\ntestpaths = tests\naddopts = --ignore=tests/test_auth.py\n"},
  [{'rule': 'test-config-narrowed', 'file': 'pytest.ini'}])

case('py-unittest-weakened',
  {T: "import unittest\nfrom app.auth import login\n\nclass TestLogin(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(login('b', 'p', {'b': 'p'}), {'ok': True, 'user': 'b'})\n    def test_bad(self):\n        with self.assertRaises(ValueError):\n            login('b', 'x', {'b': 'p'})\n", S: PY_SRC},
  {T: "import unittest\nfrom app.auth import login\n\nclass TestLogin(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(login('b', 'p', {'b': 'p'}))\n    def test_bad(self):\n        with self.assertRaises(Exception):\n            login('b', 'x', {'b': 'p'})\n", S: PY_SRC_CHANGED},
  [{'rule': 'assertion-weakened', 'file': T, 'test': 'TestLogin.test_ok'}, {'rule': 'assertion-weakened', 'file': T, 'test': 'TestLogin.test_bad'}])

# ---------- JS tampered ----------
case('js-test-skipped',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("it('login rejects bad password'", "it.skip('login rejects bad password'").replace("it('verify matches'", "xit('verify matches'"), JS: JS_SRC_CHANGED},
  [{'rule': 'test-skipped', 'file': JT, 'test': 'auth > login rejects bad password'}, {'rule': 'test-skipped', 'file': JT, 'test': 'auth > verify matches'}])

case('js-test-focused',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("it('login returns user'", "it.only('login returns user'"), JS: JS_SRC_CHANGED},
  [{'rule': 'test-focused', 'file': JT, 'test': 'auth > login returns user'}])

case('js-describe-skipped',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("describe('auth'", "describe.skip('auth'"), JS: JS_SRC_CHANGED},
  [{'rule': 'test-skipped', 'file': JT, 'test': 'auth > verify matches'}, {'rule': 'test-skipped', 'file': JT, 'test': 'auth > login returns user'},
   {'rule': 'test-skipped', 'file': JT, 'test': 'auth > login rejects bad password'}, {'rule': 'test-skipped', 'file': JT, 'test': 'auth > close enough'}])

case('js-test-deleted',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("""  it('login rejects bad password', () => {
    expect(() => login('bob', 'nope', { bob: 'pw' })).toThrow('bad password');
  });
""", ""), JS: JS_SRC_CHANGED},
  [{'rule': 'test-deleted', 'file': JT, 'test': 'auth > login rejects bad password'}])

case('js-assertion-weakened',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("expect(login('bob', 'pw', { bob: 'pw' })).toEqual({ ok: true, user: 'bob' });", "expect(login('bob', 'pw', { bob: 'pw' })).toBeTruthy();")
              .replace(".toThrow('bad password')", ".toThrow()"), JS: JS_SRC_CHANGED},
  [{'rule': 'assertion-weakened', 'file': JT, 'test': 'auth > login returns user'}, {'rule': 'assertion-weakened', 'file': JT, 'test': 'auth > login rejects bad password'}])

case('js-assertions-removed',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("expect(login('bob', 'pw', { bob: 'pw' })).toEqual({ ok: true, user: 'bob' });", "login('bob', 'pw', { bob: 'pw' });"), JS: JS_SRC_CHANGED},
  [{'rule': 'assertions-removed', 'file': JT, 'test': 'auth > login returns user'}])

case('js-mock-on-changed-module',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: "jest.mock('../src/auth', () => ({ verify: () => true, login: () => ({ ok: true, user: 'bob' }) }));\n" + JS_TEST, JS: JS_SRC_CHANGED},
  [{'rule': 'mock-on-changed-module', 'file': JT}])

case('js-spyon-changed-module',
  {JT: JS_TEST.replace("import { login, verify } from '../src/auth';", "import * as auth from '../src/auth';\nconst { login, verify } = auth;"), JS: JS_SRC},
  {JT: JS_TEST.replace("import { login, verify } from '../src/auth';", "import * as auth from '../src/auth';\nconst { login, verify } = auth;")
              .replace("  it('login returns user', () => {\n", "  it('login returns user', () => {\n    jest.spyOn(auth, 'verify').mockReturnValue(true);\n"), JS: JS_SRC_CHANGED},
  [{'rule': 'mock-on-changed-module', 'file': JT, 'test': 'auth > login returns user'}])

case('js-vi-mock-alias',
  {'tests/auth.spec.ts': JS_TEST.replace("'../src/auth'", "'@/auth'"), JS: JS_SRC},
  {'tests/auth.spec.ts': "import { vi } from 'vitest';\nvi.mock('@/auth');\n" + JS_TEST.replace("'../src/auth'", "'@/auth'"), JS: JS_SRC_CHANGED},
  [{'rule': 'mock-on-changed-module', 'file': 'tests/auth.spec.ts'}])

case('js-assertion-swallowed',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("    expect(login('bob', 'pw', { bob: 'pw' })).toEqual({ ok: true, user: 'bob' });", "    try {\n      expect(login('bob', 'pw', { bob: 'pw' })).toEqual({ ok: true, user: 'bob' });\n    } catch (e) {\n      console.log('flaky', e);\n    }"), JS: JS_SRC_CHANGED},
  [{'rule': 'assertion-swallowed', 'file': JT, 'test': 'auth > login returns user'}])

case('js-retry-added',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: "jest.retryTimes(3);\n" + JS_TEST.replace("it('login rejects bad password', () => {", "it('login rejects bad password', { retry: 5 }, () => {"), JS: JS_SRC_CHANGED},
  [{'rule': 'retry-added', 'file': JT}, {'rule': 'retry-added', 'file': JT, 'test': 'auth > login rejects bad password'}])

case('js-tolerance-loosened',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("toBeCloseTo(0.3, 5)", "toBeCloseTo(0.3, 0)"), JS: JS_SRC_CHANGED},
  [{'rule': 'tolerance-loosened', 'file': JT, 'test': 'auth > close enough'}])

case('js-test-file-moved-out',
  {JT: JS_TEST, JS: JS_SRC},
  {'tests/auth.test.ts.bak': JS_TEST, JS: JS_SRC_CHANGED},
  [{'rule': 'test-file-moved-out', 'file': 'tests/auth.test.ts.bak'}])

case('js-jest-config-changed',
  {JT: JS_TEST, JS: JS_SRC, 'package.json': '{"name":"x","scripts":{"test":"jest"},"jest":{"testMatch":["**/*.test.ts"]}}\n'},
  {JT: JS_TEST, JS: JS_SRC_CHANGED, 'package.json': '{"name":"x","scripts":{"test":"jest"},"jest":{"testMatch":["**/*.test.ts"],"testPathIgnorePatterns":["auth"]}}\n'},
  [{'rule': 'test-config-narrowed', 'file': 'package.json'}])

case('js-new-test-no-assertions',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("  it('close enough'", "  it('handles admin', () => {\n    login('admin', 'pw', { admin: 'pw' });\n  });\n  it('close enough'"), JS: JS_SRC_CHANGED},
  [{'rule': 'assertion-free-test', 'file': JT, 'test': 'auth > handles admin'}])

# ---------- Honest changes (expect nothing) ----------
case('honest-py-add-test',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST + "\ndef test_login_unknown_user():\n    with pytest.raises(KeyError):\n        login('zed', 'pw', {})\n", S: PY_SRC + "\ndef logout(user):\n    return {'ok': True}\n"},
  [])

case('honest-py-source-only',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST, S: PY_SRC.replace("raise ValueError('bad password')", "raise ValueError('bad password')  # audit-logged")},
  [])

case('honest-py-refactor-rename',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("result = login('bob', 'pw', {'bob': 'pw'})\n    assert result ==", "res = login('bob', 'pw', {'bob': 'pw'})\n    assert res =="), S: PY_SRC},
  [])

case('honest-py-strengthen',
  {T: PY_TEST.replace("assert result == {'ok': True, 'user': 'bob'}", "assert result"), S: PY_SRC},
  {T: PY_TEST, S: PY_SRC_CHANGED},
  [])

case('honest-py-mock-unchanged-module',
  {T: PY_TEST, S: PY_SRC, 'app/mail.py': "def send(to, body):\n    pass\n"},
  {T: PY_TEST.replace("def test_login_returns_user():\n", "from unittest.mock import patch\n\n@patch('app.mail.send')\ndef test_login_returns_user(_m):\n"), S: PY_SRC_CHANGED, 'app/mail.py': "def send(to, body):\n    pass\n"},
  [])

case('honest-py-more-assertions',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("    assert result == {'ok': True, 'user': 'bob'}", "    assert result == {'ok': True, 'user': 'bob'}\n    assert result['user'] == 'bob'"), S: PY_SRC},
  [])

case('honest-js-add-test',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("  it('close enough'", "  it('login unknown user throws', () => {\n    expect(() => login('zed', 'pw', {})).toThrow('bad password');\n  });\n  it('close enough'"), JS: JS_SRC},
  [])

case('honest-js-strengthen',
  {JT: JS_TEST.replace(".toEqual({ ok: true, user: 'bob' })", ".toBeTruthy()"), JS: JS_SRC},
  {JT: JS_TEST, JS: JS_SRC_CHANGED},
  [])

case('honest-js-mock-unchanged-module',
  {JT: JS_TEST, JS: JS_SRC, 'src/mail.ts': "export function send() {}\n"},
  {JT: "jest.mock('../src/mail');\n" + JS_TEST, JS: JS_SRC_CHANGED, 'src/mail.ts': "export function send() {}\n"},
  [])

case('honest-js-try-catch-with-assert',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("    expect(() => login('bob', 'nope', { bob: 'pw' })).toThrow('bad password');", "    try {\n      login('bob', 'nope', { bob: 'pw' });\n      throw new Error('did not throw');\n    } catch (e) {\n      expect((e as Error).message).toBe('bad password');\n    }"), JS: JS_SRC},
  [])

case('honest-js-source-only',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST, JS: JS_SRC.replace("throw new Error('bad password');", "throw new Error('bad password'); // logged")},
  [])

case('honest-js-rename-test-keep-body',
  {JT: JS_TEST, JS: JS_SRC},
  {'tests/auth.spec.ts': JS_TEST, JS: JS_SRC},
  [])

print('fixtures:', len(list(ROOT.iterdir())))

# ---------- round 2: patterns learned from real-repo replay ----------
SUPERTEST = """const request = require('supertest');
const express = require('../');

describe('res', function () {
  describe('.send(String)', function () {
    it('should send as html', function (done) {
      const app = express();
      app.use(function (req, res) { res.send('<p>hey</p>'); });
      request(app).get('/').expect('Content-Type', 'text/html; charset=utf-8').expect(200, '<p>hey</p>', done);
    });
    it('should set ETag', function (done) {
      const app = express();
      app.use(function (req, res) { res.send('hello'); });
      request(app).get('/').expect('ETag', 'W/"5-XYZ"').expect(200, done);
    });
  });
});
"""
case('honest-js-supertest-expect-chain',
  {'test/res.send.js': SUPERTEST.replace("it('should set ETag'", "it('should set ETag header'"), 'lib/response.js': "module.exports = {};\n"},
  {'test/res.send.js': SUPERTEST, 'lib/response.js': "module.exports = { x: 1 };\n"},
  [])

case('honest-js-rename-test-same-body',
  {JT: JS_TEST, JS: JS_SRC},
  {JT: JS_TEST.replace("it('login rejects bad password'", "it('login rejects a bad password'"), JS: JS_SRC},
  [])

case('honest-js-local-helper-asserts',
  {JT: "import { verify } from '../src/auth';\nfunction checkVerify(a, b, want) {\n  expect(verify(a, b)).toBe(want);\n}\nit('matches', () => { checkVerify('a', 'a', true); });\n", JS: JS_SRC},
  {JT: "import { verify } from '../src/auth';\nfunction checkVerify(a, b, want) {\n  expect(verify(a, b)).toBe(want);\n}\nit('matches', () => { checkVerify('a', 'a', true); });\nit('differs', () => { checkVerify('a', 'b', false); });\n", JS: JS_SRC},
  [])

case('honest-js-type-level-test',
  {JT: "import { expectTypeOf } from 'vitest';\nit('x', () => { expectTypeOf<string>().toEqualTypeOf<string>(); });\n", JS: JS_SRC},
  {JT: "import { expectTypeOf } from 'vitest';\nit('x', () => { expectTypeOf<string>().toEqualTypeOf<string>(); });\nit('narrows', () => { expectTypeOf<number>().not.toEqualTypeOf<string>(); });\n", JS: JS_SRC},
  [])

case('honest-py-or-of-specific-checks',
  {T: "def test_cookie(cookie):\n    assert 'domain=.example.com' in cookie\n", S: PY_SRC},
  {T: "def test_cookie(cookie):\n    assert 'domain=example.com' in cookie or 'domain=.example.com' in cookie\n", S: PY_SRC},
  [])

case('honest-py-local-helper-asserts',
  {T: "from app.auth import verify\n\ndef common_check(v):\n    assert v in (True, False)\n\ndef test_a():\n    common_check(verify('a', 'a'))\n", S: PY_SRC},
  {T: "from app.auth import verify\n\ndef common_check(v):\n    assert v in (True, False)\n\ndef test_a():\n    common_check(verify('a', 'a'))\n\ndef test_b():\n    common_check(verify('a', 'b'))\n", S: PY_SRC},
  [])

case('honest-py-rename-test-same-body',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("def test_login_rejects_bad_password():", "def test_login_rejects_wrong_password():"), S: PY_SRC},
  [])

case('py-rename-then-weaken',
  {T: PY_TEST, S: PY_SRC},
  {T: PY_TEST.replace("def test_login_rejects_bad_password():\n    with pytest.raises(ValueError, match='bad password'):", "def test_login_rejects_wrong_password():\n    with pytest.raises(Exception):"), S: PY_SRC_CHANGED},
  [{'rule': 'assertion-weakened', 'file': T, 'test': 'test_login_rejects_wrong_password'}])

case('js-assertion-or-true',
  {T: "def test_x():\n    assert compute() == 42\n", S: PY_SRC},
  {T: "def test_x():\n    assert compute() == 42 or True\n", S: PY_SRC_CHANGED},
  [{'rule': 'assertion-weakened', 'file': T, 'test': 'test_x'}])

case('honest-js-tox-ini-envlist',
  {T: PY_TEST, S: PY_SRC, 'tox.ini': "[tox]\nenvlist = py38, py39\n[testenv]\ncommands = pytest\n"},
  {T: PY_TEST, S: PY_SRC, 'tox.ini': "[tox]\nenvlist = py39, py310\n[testenv]\ncommands = pytest\n"},
  [])

print('fixtures:', len(list(ROOT.iterdir())))

case('honest-js-supertest-variable-named-test',
  {'test/body.js': "const request = require('supertest');\ndescribe('limit', function () {\n  it('should 413 over limit', function (done) {\n    var test = request(app).post('/');\n    test.set('Content-Type', 'text/plain');\n    test.expect(413, done);\n  });\n});\n", 'lib/x.js': "module.exports = 1;\n"},
  {'test/body.js': "const request = require('supertest');\ndescribe('limit', function () {\n  it('should 413 over limit', function (done) {\n    var test = request(app).post('/');\n    test.set('Content-Type', 'text/plain');\n    test.expect(413, done);\n  });\n  it('should 413 when inflated', function (done) {\n    var test = request(app).post('/');\n    test.set('Content-Encoding', 'gzip');\n    test.expect(413, done);\n  });\n});\n", 'lib/x.js': "module.exports = 2;\n"},
  [])

case('honest-js-supertest-bracket-method',
  {'test/res.js': "const request = require('supertest');\nconst methods = ['get', 'post'];\ndescribe('res', function () {\n  it('x', function (done) { request(app).get('/').expect(200, done); });\n});\n", 'lib/x.js': "module.exports = 1;\n"},
  {'test/res.js': "const request = require('supertest');\nconst methods = ['get', 'post'];\ndescribe('res', function () {\n  it('x', function (done) { request(app).get('/').expect(200, done); });\n  methods.forEach(function (method) {\n    it('should send ETag for ' + method, function (done) {\n      request(app)[method]('/').expect('ETag', 'W/\"c-5\"').expect(200, done);\n    });\n  });\n});\n", 'lib/x.js': "module.exports = 2;\n"},
  [])
print('fixtures:', len(list(ROOT.iterdir())))


