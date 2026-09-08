def test_login():
    r = login('bob', 'pw')
    assert r['ok'] is True
    assert r['user'] == 'bob'
    assert r['token']
