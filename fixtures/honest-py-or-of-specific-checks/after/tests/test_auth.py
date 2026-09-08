def test_cookie(cookie):
    assert 'domain=example.com' in cookie or 'domain=.example.com' in cookie
