def test_login_accepts_valid_password():
    res = login('bob', 'pw')
    assert res['ok'] is True
    assert res['user'] == 'bob'
