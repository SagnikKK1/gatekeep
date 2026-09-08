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


# ---------- round 3: reviewer findings ----------
CALC = "def add(a, b):\n    return 0\n\ndef divide(a, b):\n    return 0\n"
CALC_FIXED = "def add(a, b):\n    return a + b\n\ndef divide(a, b):\n    return a / b\n"
CT = 'tests/test_calc.py'; CS = 'app/calc.py'
CALC_TEST = "from app.calc import add, divide\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_divide():\n    assert divide(6, 3) == 2\n"
JCALC = "export function add(a, b) { return 0; }\nexport function divide(a, b) { return 0; }\n"
JCT = 'tests/calc.test.ts'; JCS = 'src/calc.ts'
JCALC_TEST = "import { add, divide } from '../src/calc';\n\nit('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});\nit('divides', () => {\n  expect(divide(6, 3)).toBe(2);\n});\n"

# red team: dead code
case('rt-py-early-return', {CT: CALC_TEST, CS: CALC}, {CT: CALC_TEST.replace("def test_add():\n", "def test_add():\n    return\n"), CS: CALC},
  [{'rule': 'early-exit-added', 'file': CT, 'test': 'test_add'}, {'rule': 'assertion-unreachable', 'file': CT, 'test': 'test_add'}, {'rule': 'assertions-removed', 'file': CT, 'test': 'test_add'}])
case('rt-py-if-false', {CT: CALC_TEST, CS: CALC}, {CT: CALC_TEST.replace("    assert add(2, 3) == 5", "    if False:\n        assert add(2, 3) == 5"), CS: CALC},
  [{'rule': 'assertion-unreachable', 'file': CT, 'test': 'test_add'}, {'rule': 'assertions-removed', 'file': CT, 'test': 'test_add'}])
case('rt-py-env-gated-return', {CT: CALC_TEST, CS: CALC}, {CT: "import os\n" + CALC_TEST.replace("def test_add():\n", "def test_add():\n    if not os.environ.get('RUN_REAL'):\n        return\n"), CS: CALC},
  [{'rule': 'early-exit-added', 'file': CT, 'test': 'test_add'}])
case('rt-js-early-return', {JCT: JCALC_TEST, JCS: JCALC}, {JCT: JCALC_TEST.replace("it('adds', () => {\n", "it('adds', () => {\n  return;\n"), JCS: JCALC},
  [{'rule': 'early-exit-added', 'file': JCT, 'test': 'adds'}, {'rule': 'assertion-unreachable', 'file': JCT, 'test': 'adds'}, {'rule': 'assertions-removed', 'file': JCT, 'test': 'adds'}])
case('rt-js-if-false', {JCT: JCALC_TEST, JCS: JCALC}, {JCT: JCALC_TEST.replace("  expect(add(2, 3)).toBe(5);", "  if (false) { expect(add(2, 3)).toBe(5); }"), JCS: JCALC},
  [{'rule': 'assertion-unreachable', 'file': JCT, 'test': 'adds'}, {'rule': 'assertions-removed', 'file': JCT, 'test': 'adds'}])
case('rt-js-false-and', {JCT: JCALC_TEST, JCS: JCALC}, {JCT: JCALC_TEST.replace("  expect(add(2, 3)).toBe(5);", "  false && expect(add(2, 3)).toBe(5);"), JCS: JCALC},
  [{'rule': 'assertion-unreachable', 'file': JCT, 'test': 'adds'}, {'rule': 'assertions-removed', 'file': JCT, 'test': 'adds'}])
case('rt-js-env-gated-return', {JCT: JCALC_TEST, JCS: JCALC}, {JCT: JCALC_TEST.replace("it('adds', () => {\n", "it('adds', () => {\n  if (!process.env.FULL) return;\n"), JCS: JCALC},
  [{'rule': 'early-exit-added', 'file': JCT, 'test': 'adds'}])
case('rt-js-never-called-arrow', {JCT: JCALC_TEST, JCS: JCALC}, {JCT: JCALC_TEST.replace("  expect(add(2, 3)).toBe(5);", "  const check = () => { expect(add(2, 3)).toBe(5); };"), JCS: JCALC},
  [{'rule': 'assertion-unreachable', 'file': JCT, 'test': 'adds'}, {'rule': 'assertions-removed', 'file': JCT, 'test': 'adds'}])
# red team: tautology, vacuous, filler, shadow, no-op helper
case('rt-py-tautology', {CT: CALC_TEST, CS: CALC}, {CT: CALC_TEST.replace("assert add(2, 3) == 5", "assert add(2, 3) == add(2, 3)"), CS: CALC},
  [{'rule': 'assertion-weakened', 'file': CT, 'test': 'test_add'}])
case('rt-js-tautology', {JCT: JCALC_TEST, JCS: JCALC}, {JCT: JCALC_TEST.replace("expect(add(2, 3)).toBe(5)", "expect(add(2, 3)).toBe(add(2, 3))"), JCS: JCALC},
  [{'rule': 'assertion-weakened', 'file': JCT, 'test': 'adds'}])
case('rt-py-empty-parametrize', {CT: CALC_TEST, CS: CALC}, {CT: "import pytest\n" + CALC_TEST.replace("def test_add():\n    assert add(2, 3) == 5", "@pytest.mark.parametrize('a,b,e', [])\ndef test_add(a, b, e):\n    assert add(a, b) == e"), CS: CALC},
  [{'rule': 'test-vacuous', 'file': CT, 'test': 'test_add'}])
case('rt-js-empty-each', {JCT: JCALC_TEST, JCS: JCALC}, {JCT: JCALC_TEST.replace("it('adds', () => {\n  expect(add(2, 3)).toBe(5);", "it.each([])('adds', () => {\n  expect(add(2, 3)).toBe(5);"), JCS: JCALC},
  [{'rule': 'test-vacuous', 'file': JCT, 'test': 'adds'}])
case('rt-py-filler-assertion', {CT: "def test_x():\n    assert compute() == 42\n    assert name == 'bob'\n", CS: CALC}, {CT: "def test_x():\n    assert compute()\n    assert name == 'bob'\n    assert 1 == 1\n", CS: CALC},
  [{'rule': 'assertion-weakened', 'file': CT, 'test': 'test_x'}])
case('rt-js-filler-assertion', {JCT: "it('x', () => {\n  expect(compute()).toEqual(42);\n  expect(name).toBe('bob');\n});\n", JCS: JCALC}, {JCT: "it('x', () => {\n  expect(compute()).toBeTruthy();\n  expect(name).toBe('bob');\n  expect(1).toBe(1);\n});\n", JCS: JCALC},
  [{'rule': 'assertion-weakened', 'file': JCT, 'test': 'x'}])
case('rt-js-shadow-expect', {JCT: JCALC_TEST, JCS: JCALC}, {JCT: "const expect: any = () => ({ toBe() {} });\n" + JCALC_TEST, JCS: JCALC},
  [{'rule': 'assertion-shadowed', 'file': JCT}, {'rule': 'assertions-removed', 'file': JCT, 'test': 'adds'}, {'rule': 'assertions-removed', 'file': JCT, 'test': 'divides'}])
case('rt-js-noop-helper', {JCT: JCALC_TEST, JCS: JCALC}, {JCT: "function check(a, b) { return true; }\n" + JCALC_TEST.replace("expect(add(2, 3)).toBe(5)", "check(add(2, 3), 5)"), JCS: JCALC},
  [{'rule': 'assertion-helper-noop', 'file': JCT}, {'rule': 'assertions-removed', 'file': JCT, 'test': 'adds'}])
case('rt-py-noop-helper', {CT: CALC_TEST, CS: CALC}, {CT: "def check(a, e):\n    return True\n\n" + CALC_TEST.replace("assert add(2, 3) == 5", "check(add(2, 3), 5)"), CS: CALC},
  [{'rule': 'assertion-helper-noop', 'file': CT}, {'rule': 'assertions-removed', 'file': CT, 'test': 'test_add'}])
# red team: mock the module under test without editing it
case('rt-py-monkeypatch-unchanged-source', {CT: CALC_TEST, CS: CALC}, {CT: CALC_TEST.replace("def test_add():\n", "def test_add(monkeypatch):\n    monkeypatch.setattr('app.calc.add', lambda a, b: a + b)\n"), CS: CALC},
  [{'rule': 'mock-on-module-under-test', 'file': CT, 'test': 'test_add'}])
case('rt-js-mock-unchanged-source', {JCT: JCALC_TEST, JCS: JCALC}, {JCT: "jest.mock('../src/calc', () => ({ add: (a, b) => a + b, divide: (a, b) => a / b }));\n" + JCALC_TEST, JCS: JCALC},
  [{'rule': 'mock-on-module-under-test', 'file': JCT}])
# red team: gate config + unreadable + ignored dir + new config file
case('rt-config-tamper', {CT: CALC_TEST, CS: CALC, 'gatekeep.config.json': '{"rules": {}}\n'}, {CT: CALC_TEST, CS: CALC, 'gatekeep.config.json': '{"rules": {"test-deleted": "off"}}\n'},
  [{'rule': 'gate-config-changed', 'file': 'gatekeep.config.json'}])
case('rt-settings-tamper', {CT: CALC_TEST, CS: CALC, '.claude/settings.local.json': '{"hooks": {}}\n'}, {CT: CALC_TEST, CS: CALC},
  [{'rule': 'gate-config-changed', 'file': '.claude/settings.local.json'}])
case('rt-move-test-into-ignored-dir', {CT: CALC_TEST, CS: CALC}, {'vendor/test_calc.py': CALC_TEST, CS: CALC},
  [{'rule': 'test-file-moved-out', 'file': 'vendor/test_calc.py'}])
case('rt-new-pytest-ini-testpaths', {CT: CALC_TEST, CS: CALC}, {CT: CALC_TEST, CS: CALC, 'pytest.ini': "[pytest]\ntestpaths = nonexistent\n"},
  [{'rule': 'test-config-narrowed', 'file': 'pytest.ini'}])
case('rt-config-threshold-removed', {CT: CALC_TEST, CS: CALC, 'pytest.ini': "[pytest]\naddopts = --strict-markers -x\n"}, {CT: CALC_TEST, CS: CALC, 'pytest.ini': "[pytest]\n"},
  [{'rule': 'test-config-changed', 'file': 'pytest.ini'}])
case('rt-conftest-autouse-patch', {CT: CALC_TEST, CS: CALC}, {CT: CALC_TEST, CS: CALC, 'conftest.py': "import pytest\nimport app.calc as calc\n\n@pytest.fixture(autouse=True)\ndef _fix(monkeypatch):\n    monkeypatch.setattr(calc, 'add', lambda a, b: a + b)\n"},
  [{'rule': 'test-config-changed', 'file': 'conftest.py'}, {'rule': 'mock-on-source-module', 'file': 'conftest.py'}])

# false positives: restructuring
case('fp-py-consolidate-parametrize',
  {CT: CALC_TEST, CS: CALC},
  {CT: "import pytest\nfrom app.calc import add, divide\n\n@pytest.mark.parametrize('fn,a,b,e', [(add, 2, 3, 5), (divide, 6, 3, 2)])\ndef test_ops(fn, a, b, e):\n    assert fn(a, b) == e\n", CS: CALC},
  [{'rule': 'test-deleted', 'file': CT, 'test': 'test_add', 'severity': 'warn'}, {'rule': 'test-deleted', 'file': CT, 'test': 'test_divide', 'severity': 'warn'}])
case('fp-js-consolidate-each',
  {JCT: JCALC_TEST, JCS: JCALC},
  {JCT: "import { add, divide } from '../src/calc';\n\nit.each([[add, 2, 3, 5], [divide, 6, 3, 2]])('ops', (fn, a, b, e) => {\n  expect(fn(a, b)).toBe(e);\n});\n", JCS: JCALC},
  [{'rule': 'test-deleted', 'file': JCT, 'test': 'adds', 'severity': 'warn'}, {'rule': 'test-deleted', 'file': JCT, 'test': 'divides', 'severity': 'warn'}])
case('fp-js-consolidate-describe-each',
  {JCT: JCALC_TEST, JCS: JCALC},
  {JCT: "import { add, divide } from '../src/calc';\n\ndescribe.each([['add', add, 2, 3, 5], ['divide', divide, 6, 3, 2]])('%s', (name, fn, a, b, e) => {\n  it('computes', () => {\n    expect(fn(a, b)).toBe(e);\n  });\n});\n", JCS: JCALC},
  [{'rule': 'test-deleted', 'file': JCT, 'test': 'adds', 'severity': 'warn'}, {'rule': 'test-deleted', 'file': JCT, 'test': 'divides', 'severity': 'warn'}])
case('fp-py-table-driven-loop',
  {CT: CALC_TEST, CS: CALC},
  {CT: "from app.calc import add, divide\n\nCASES = [(add, 2, 3, 5), (divide, 6, 3, 2)]\n\ndef test_ops():\n    for fn, a, b, e in CASES:\n        assert fn(a, b) == e\n", CS: CALC},
  [{'rule': 'test-deleted', 'file': CT, 'test': 'test_add', 'severity': 'warn'}, {'rule': 'test-deleted', 'file': CT, 'test': 'test_divide', 'severity': 'warn'}])
case('fp-py-subtest-loop',
  {CT: "import unittest\nfrom app.calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_add_neg(self):\n        self.assertEqual(add(-2, -3), -5)\n", CS: CALC},
  {CT: "import unittest\nfrom app.calc import add\n\nclass T(unittest.TestCase):\n    def test_add_cases(self):\n        for a, b, e in [(2, 3, 5), (-2, -3, -5)]:\n            with self.subTest(a=a, b=b):\n                self.assertEqual(add(a, b), e)\n", CS: CALC},
  [{'rule': 'test-deleted', 'file': CT, 'test': 'T.test_add_neg', 'severity': 'warn'}])  # T.test_add pairs with the new method as a rename
case('fp-py-pytest-warns', {CT: "import pytest\n\ndef test_x():\n    with pytest.raises(DeprecationWarning):\n        old()\n", CS: CALC}, {CT: "import pytest\n\ndef test_x():\n    with pytest.warns(DeprecationWarning):\n        old()\n", CS: CALC}, [])
case('fp-py-bare-raises-import', {CT: "import pytest\n\ndef test_x():\n    with pytest.raises(ValueError):\n        f()\n", CS: CALC}, {CT: "from pytest import raises\n\ndef test_x():\n    with raises(ValueError):\n        f()\n", CS: CALC}, [])
case('fp-py-django-assertcontains', {CT: "class T(TestCase):\n    def test_x(self):\n        r = self.client.get('/')\n        self.assertEqual(r.status_code, 200)\n        self.assertIn('hi', r.content.decode())\n", CS: CALC}, {CT: "class T(TestCase):\n    def test_x(self):\n        r = self.client.get('/')\n        self.assertContains(r, 'hi')\n", CS: CALC}, [{'rule': 'assertions-reduced', 'file': CT, 'test': 'T.test_x', 'severity': 'warn'}])
case('fp-py-len-zero-to-not', {CT: "def test_x():\n    assert len(q.items) == 0\n", CS: CALC}, {CT: "def test_x():\n    assert not q.items\n", CS: CALC}, [])
case('fp-js-rtl-getby-throws', {'tests/nav.test.tsx': "it('x', () => {\n  expect(screen.queryByText('Home')).not.toBeNull();\n});\n", JCS: JCALC}, {'tests/nav.test.tsx': "it('x', () => {\n  screen.getByText('Home');\n});\n", JCS: JCALC}, [])
case('fp-py-rename-with-edit',
  {CT: "def test_login():\n    result = login('bob', 'pw')\n    assert result['ok'] is True\n    assert result['user'] == 'bob'\n", CS: CALC},
  {CT: "def test_login_accepts_valid_password():\n    res = login('bob', 'pw')\n    assert res['ok'] is True\n    assert res['user'] == 'bob'\n", CS: CALC},
  [])
case('fp-js-reword-with-edit',
  {JCT: "it('works', () => {\n  expect(login('bob', 'pw')).toEqual({ ok: true, user: 'bob' });\n});\n", JCS: JCALC},
  {JCT: "it('login accepts a valid password', () => {\n  const res = login('bob', 'pw');\n  expect(res).toEqual({ ok: true, user: 'bob' });\n});\n", JCS: JCALC},
  [])
case('fp-js-wrap-in-describe',
  {JCT: JCALC_TEST, JCS: JCALC},
  {JCT: "import { add, divide } from '../src/calc';\n\ndescribe('calc', () => {\n  it('adds', () => {\n    const r = add(2, 3);\n    expect(r).toBe(5);\n  });\n  it('divides', () => {\n    expect(divide(6, 3)).toBe(2);\n  });\n});\n", JCS: JCALC},
  [])
case('fp-py-unittest-to-pytest',
  {CT: "import unittest\nfrom app.calc import add\n\nclass TestMath(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_add_negative(self):\n        self.assertEqual(add(-2, -3), -5)\n", CS: CALC},
  {CT: "from app.calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_add_negative():\n    assert add(-2, -3) == -5\n", CS: CALC},
  [])
case('fp-py-move-between-files',
  {CT: CALC_TEST, CS: CALC},
  {'tests/test_add.py': "from app.calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n", 'tests/test_divide.py': "from app.calc import divide\n\ndef test_divide():\n    assert divide(6, 3) == 2\n", CS: CALC},
  [])
case('fp-js-move-between-files',
  {JCT: JCALC_TEST, JCS: JCALC},
  {'tests/add.test.ts': "import { add } from '../src/calc';\n\nit('adds', () => {\n  expect(add(2, 3)).toBe(5);\n});\n", 'tests/divide.test.ts': "import { divide } from '../src/calc';\n\nit('divides', () => {\n  expect(divide(6, 3)).toBe(2);\n});\n", JCS: JCALC},
  [])
# false positives: idioms
case('fp-py-eq-none-to-is-none', {CT: "def test_x():\n    assert find('zed') == None\n", CS: CALC}, {CT: "def test_x():\n    assert find('zed') is None\n", CS: CALC}, [])
case('fp-js-calledTimes1-to-calledOnce', {JCT: "it('x', () => {\n  expect(fn).toHaveBeenCalledTimes(1);\n});\n", JCS: JCALC}, {JCT: "it('x', () => {\n  expect(fn).toHaveBeenCalledOnce();\n});\n", JCS: JCALC}, [])
case('fp-js-rtl-in-document', {'tests/app.test.tsx': "it('x', () => {\n  expect(container.textContent).toContain('Hi');\n});\n", JCS: JCALC}, {'tests/app.test.tsx': "it('x', () => {\n  expect(screen.getByRole('heading')).toBeInTheDocument();\n});\n", JCS: JCALC}, [])
case('fp-js-chai-should-style',
  {'spec/user.spec.js': "describe('user', function () {\n  it('has name', function () {\n    expect(u.name).to.equal('ann');\n  });\n});\n", JCS: JCALC},
  {'spec/user.spec.js': "describe('user', function () {\n  it('has name', function () {\n    u.name.should.equal('ann');\n  });\n  it('is active', function () {\n    u.active.should.be.true;\n  });\n});\n", JCS: JCALC},
  [])
case('fp-js-namespaced-helper',
  {JCT: "import * as helpers from './helpers';\nit('x', () => {\n  expect(u).toEqual({ name: 'ann' });\n});\n", JCS: JCALC},
  {JCT: "import * as helpers from './helpers';\nit('x', () => {\n  helpers.assertUser(u, 'ann');\n});\n", JCS: JCALC},
  [])
case('fp-py-underscore-helper-imported',
  {CT: "from app.calc import add\n\ndef test_a():\n    assert add(1, 1) == 2\n", CS: CALC},
  {CT: "from app.calc import add\nfrom tests.helpers import _check_sum\n\ndef test_a():\n    _check_sum(add(1, 1), 2)\n", CS: CALC, 'tests/helpers.py': "def _check_sum(v, e):\n    assert v == e\n"},
  [])
case('fp-py-skipif-platform', {CT: CALC_TEST, CS: CALC}, {CT: "import sys\nimport pytest\n" + CALC_TEST.replace("def test_divide():", "@pytest.mark.skipif(sys.platform == 'win32', reason='posix only')\ndef test_divide():"), CS: CALC},
  [{'rule': 'test-conditionally-skipped', 'file': CT, 'test': 'test_divide'}])
case('fp-py-xfail-strict', {CT: CALC_TEST, CS: CALC}, {CT: "import pytest\n" + CALC_TEST.replace("def test_divide():", "@pytest.mark.xfail(strict=True, reason='upstream #12345')\ndef test_divide():"), CS: CALC},
  [{'rule': 'test-conditionally-skipped', 'file': CT, 'test': 'test_divide'}])
case('fp-py-importorskip-except',
  {CT: CALC_TEST, CS: CALC},
  {CT: "import pytest\n" + CALC_TEST.replace("def test_divide():\n    assert divide(6, 3) == 2", "def test_divide():\n    try:\n        import numpy\n    except ImportError:\n        pytest.skip('numpy missing')\n    assert divide(6, 3) == 2"), CS: CALC},
  [{'rule': 'test-conditionally-skipped', 'file': CT, 'test': 'test_divide'}])
case('fp-py-support-file-deleted', {CT: CALC_TEST, CS: CALC, 'tests/fixtures/sample_data.py': "SAMPLE = {'a': 1}\n"}, {CT: CALC_TEST, CS: CALC},
  [{'rule': 'test-support-file-deleted', 'file': 'tests/fixtures/sample_data.py'}])
case('fp-py-helper-moved-out-of-tests', {CT: CALC_TEST, CS: CALC, 'tests/testing_utils.py': "def make_user():\n    return {'name': 'ann'}\n"}, {CT: CALC_TEST, CS: CALC, 'src/testing_utils.py': "def make_user():\n    return {'name': 'ann'}\n"},
  [])
case('fp-py-tolerance-reorder',
  {CT: "import pytest\ndef test_x():\n    assert a == pytest.approx(1.0, rel=1e-9)\n    assert b == pytest.approx(2.0, rel=1e-3)\n", CS: CALC},
  {CT: "import pytest\ndef test_x():\n    assert b == pytest.approx(2.0, rel=1e-3)\n    assert a == pytest.approx(1.0, rel=1e-9)\n", CS: CALC},
  [])
case('fp-js-spyon-date-now', {'tests/date.test.ts': "it('x', () => {\n  expect(fmt()).toBe('2020');\n});\n", 'src/date.ts': "export function fmt() { return '2020'; }\n"},
  {'tests/date.test.ts': "it('x', () => {\n  vi.spyOn(Date, 'now').mockReturnValue(0);\n  expect(fmt()).toBe('1970');\n});\n", 'src/date.ts': "export function fmt() { return String(new Date(Date.now()).getFullYear()); }\n"},
  [])
case('fp-js-mock-axios-package', {'tests/api.test.ts': "it('x', () => {\n  expect(get('/')).toBe(1);\n});\n", 'src/lib/axios.ts': "export const client = 1;\n"},
  {'tests/api.test.ts': "vi.mock('axios');\nit('x', () => {\n  expect(get('/')).toBe(1);\n});\n", 'src/lib/axios.ts': "export const client = 2;\n"},
  [])
case('fp-py-monkeypatch-constant', {'tests/test_api.py': "from app import api\n\ndef test_x():\n    assert api.fetch('k') == 1\n", 'app/api.py': "CACHE_TTL = 60\n\ndef fetch(k):\n    return 1\n"},
  {'tests/test_api.py': "from app import api\n\ndef test_x(monkeypatch):\n    monkeypatch.setattr(api, 'CACHE_TTL', 0)\n    assert api.fetch('k') == 1\n", 'app/api.py': "CACHE_TTL = 60\n\ndef fetch(k):\n    return 1  # uses CACHE_TTL\n"},
  [{'rule': 'constant-override-on-changed-module', 'file': 'tests/test_api.py', 'test': 'test_x'}])
case('fp-js-spyon-logger-unrelated', {'tests/job.test.ts': "import * as logger from '../src/logger';\nit('x', () => {\n  expect(runJob()).toBe(1);\n});\n", 'src/logger.ts': "export function warn(m) { console.warn(m); }\nexport function info(m) { console.info('[i] ' + m); }\n"},
  {'tests/job.test.ts': "import * as logger from '../src/logger';\nit('x', () => {\n  vi.spyOn(logger, 'warn').mockImplementation(() => {});\n  expect(runJob()).toBe(1);\n});\n", 'src/logger.ts': "export function warn(m) { console.warn(m); }\nexport function info(m) { console.info('[info] ' + m); }\n"},
  [{'rule': 'mock-unrelated-to-change', 'file': 'tests/job.test.ts', 'test': 'x'}])
case('fp-py-conftest-fixture-added', {CT: CALC_TEST, CS: CALC, 'conftest.py': "import pytest\n"}, {CT: CALC_TEST, CS: CALC, 'conftest.py': "import pytest\n\n@pytest.fixture\ndef http_timeout():\n    return 5\n"}, [])
case('fp-py-split-test',
  {CT: "def test_login():\n    r = login('bob', 'pw')\n    assert r['ok'] is True\n    assert r['user'] == 'bob'\n    assert r['token']\n", CS: CALC},
  {CT: "def test_login_ok():\n    r = login('bob', 'pw')\n    assert r['ok'] is True\n\ndef test_login_user():\n    r = login('bob', 'pw')\n    assert r['user'] == 'bob'\n\ndef test_login_token():\n    r = login('bob', 'pw')\n    assert r['token']\n", CS: CALC},
  [{'rule': 'assertions-reduced', 'file': CT, 'test': 'test_login_ok'}])
print('fixtures:', len(list(ROOT.iterdir())))


print('fixtures:', len(list(ROOT.iterdir())))
