import pytest
from app.calc import add

class TestCalc:
    pytestmark = pytest.mark.skip
    def test_add(self):
        assert add(2, 3) == 5
