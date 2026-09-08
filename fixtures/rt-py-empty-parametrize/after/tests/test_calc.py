import pytest
from app.calc import add, divide

@pytest.mark.parametrize('a,b,e', [])
def test_add(a, b, e):
    assert add(a, b) == e

def test_divide():
    assert divide(6, 3) == 2
