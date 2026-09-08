from app.calc import add, divide

CASES = [(add, 2, 3, 5), (divide, 6, 3, 2)]

def test_ops():
    for fn, a, b, e in CASES:
        assert fn(a, b) == e
