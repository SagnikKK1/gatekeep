from app.calc import sub

def test_other():
    assert sub(1, 1) == 0

def test_sub_returns_diff():
    assert sub(5, 3) == 2
