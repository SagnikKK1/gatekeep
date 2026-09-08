import pytest
def test_x():
    assert b == pytest.approx(2.0, rel=1e-3)
    assert a == pytest.approx(1.0, rel=1e-9)
