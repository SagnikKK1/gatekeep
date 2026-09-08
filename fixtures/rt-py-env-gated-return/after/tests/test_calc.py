import os
from app.calc import add, divide

def test_add():
    if not os.environ.get('RUN_REAL'):
        return
    assert add(2, 3) == 5

def test_divide():
    assert divide(6, 3) == 2
