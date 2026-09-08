import pytest
from app.auth import login, verify

def test_verify_matches():
    assert verify('a', 'a') == True
    assert verify('a', 'b') == False

def test_login_returns_user():
    result = login('bob', 'pw', {'bob': 'pw'})
    assert result

def test_login_rejects_bad_password():
    with pytest.raises(Exception):
        login('bob', 'nope', {'bob': 'pw'})

class TestNumbers:
    def test_close(self):
        assert 0.1 + 0.2 == pytest.approx(0.3, rel=1e-6)
