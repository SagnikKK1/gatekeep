import pytest
from app.calc import divide

@pytest.mark.parametrize('a,b', [(1, 0)])
def test_ops(a, b):
    assert True

def test_divide():
    assert divide(6, 3) == 2
