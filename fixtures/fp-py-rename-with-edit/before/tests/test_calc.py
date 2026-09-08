def test_login():
    result = login('bob', 'pw')
    assert result['ok'] is True
    assert result['user'] == 'bob'
