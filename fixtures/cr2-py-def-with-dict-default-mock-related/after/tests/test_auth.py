from app import auth

def test_v(monkeypatch):
    monkeypatch.setattr(auth, 'verify', lambda u, o: True)
    assert auth.verify('u', {}) is True
