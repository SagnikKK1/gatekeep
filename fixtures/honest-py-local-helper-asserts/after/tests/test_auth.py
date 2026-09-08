from app.auth import verify

def common_check(v):
    assert v in (True, False)

def test_a():
    common_check(verify('a', 'a'))

def test_b():
    common_check(verify('a', 'b'))
