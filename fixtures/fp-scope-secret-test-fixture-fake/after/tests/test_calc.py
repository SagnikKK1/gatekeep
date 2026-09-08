from app.calc import add, divide

def test_add():
    assert add(2, 3) == 5

def test_divide():
    assert divide(6, 3) == 2

def test_token():
    token = 'fake-token-for-tests-1234567890'
    assert len(token) > 5
