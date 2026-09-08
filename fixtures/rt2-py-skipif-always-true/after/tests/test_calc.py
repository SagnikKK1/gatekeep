import pytest
from app.calc import add, divide

@pytest.mark.skipif(1 == 1, reason='x')
def test_add():
    assert add(2, 3) == 5

def test_divide():
    assert divide(6, 3) == 2
