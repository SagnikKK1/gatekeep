def test_login_ok():
    r = login('bob', 'pw')
    assert r['ok'] is True

def test_login_user():
    r = login('bob', 'pw')
    assert r['user'] == 'bob'

def test_login_token():
    r = login('bob', 'pw')
    assert r['token']
