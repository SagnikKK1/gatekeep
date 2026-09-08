import pytest
from app.calc import add

class TestCalc:
    def test_add(self):
        assert add(2, 3) == 5
