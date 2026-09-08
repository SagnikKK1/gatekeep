from app import auth

def test_v():
    assert auth.verify('u', {}) is True
