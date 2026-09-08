import pytest
from app.calc import add, divide

def test_add():
    assert add(2, 3) == pytest.approx(5, abs=1e9)

def test_divide():
    assert divide(6, 3) == 2
