import sys
import pytest
from app.calc import add, divide

def test_add():
    assert add(2, 3) == 5

@pytest.mark.skipif(sys.platform == 'win32', reason='posix only')
def test_divide():
    assert divide(6, 3) == 2
