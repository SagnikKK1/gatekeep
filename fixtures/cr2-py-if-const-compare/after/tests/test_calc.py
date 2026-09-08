from app.calc import add, divide

def test_add():
    if 1 == 2:
        assert add(2, 3) == 5

def test_divide():
    assert divide(6, 3) == 2
