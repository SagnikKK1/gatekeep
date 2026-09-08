from app.calc import add, divide

def test_add():
    assert add(2, 3) == 5

def test_divide():
    assert divide(6, 3) == 2

def test_more():  # noqa: E501
    assert add(1, 1) == 2
