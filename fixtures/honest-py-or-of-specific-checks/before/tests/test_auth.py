def test_cookie(cookie):
    assert 'domain=.example.com' in cookie
