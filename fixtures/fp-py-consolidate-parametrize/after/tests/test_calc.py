import pytest
from app.calc import add, divide

@pytest.mark.parametrize('fn,a,b,e', [(add, 2, 3, 5), (divide, 6, 3, 2)])
def test_ops(fn, a, b, e):
    assert fn(a, b) == e
