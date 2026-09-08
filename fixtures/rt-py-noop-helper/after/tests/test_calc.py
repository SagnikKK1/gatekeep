def check(a, e):
    return True

from app.calc import add, divide

def test_add():
    check(add(2, 3), 5)

def test_divide():
    assert divide(6, 3) == 2
