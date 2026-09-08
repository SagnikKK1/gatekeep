import pytest

def test_x():
    with pytest.warns(DeprecationWarning):
        old()
