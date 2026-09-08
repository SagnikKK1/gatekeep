import pytest
from app.calc import add, divide

def test_add():
    assert add(2, 3) == 5

@pytest.mark.xfail(strict=True, reason='upstream #12345')
def test_divide():
    assert divide(6, 3) == 2
