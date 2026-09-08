from app.calc import add
from tests.helpers import _check_sum

def test_a():
    _check_sum(add(1, 1), 2)
