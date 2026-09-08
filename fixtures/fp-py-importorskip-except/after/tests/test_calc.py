import pytest
from app.calc import add, divide

def test_add():
    assert add(2, 3) == 5

def test_divide():
    try:
        import numpy
    except ImportError:
        pytest.skip('numpy missing')
    assert divide(6, 3) == 2
