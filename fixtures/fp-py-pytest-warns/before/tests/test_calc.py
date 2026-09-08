import pytest

def test_x():
    with pytest.raises(DeprecationWarning):
        old()
