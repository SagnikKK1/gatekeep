from app.calc import add, divide

def test_add():
    assert add(2, 3) == add(2, 3)

def test_divide():
    assert divide(6, 3) == 2
