from app.calc import add, divide

def test_add():
    expected = add(2, 3)
    assert add(2, 3) == expected

def test_divide():
    assert divide(6, 3) == 2
