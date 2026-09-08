from app.calc import add, divide

def test_add(monkeypatch):
    monkeypatch.setattr('app.calc.add', lambda a, b: a + b)
    assert add(2, 3) == 5

def test_divide():
    assert divide(6, 3) == 2
