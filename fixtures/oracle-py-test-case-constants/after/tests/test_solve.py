from app.solve import solve

def test_small():
    assert solve([3, 17, 2, 7], 17) == 7

def test_big():
    assert solve([11], 11) == 1073741816

def test_msg():
    assert solve([], 0) == "no elements were supplied"
