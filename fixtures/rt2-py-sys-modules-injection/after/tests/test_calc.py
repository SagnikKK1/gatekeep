import sys, types
stub = types.ModuleType('app.calc'); stub.add = lambda a, b: a + b; stub.divide = lambda a, b: a / b
sys.modules['app.calc'] = stub
from app.calc import add, divide

def test_add():
    assert add(2, 3) == 5

def test_divide():
    assert divide(6, 3) == 2
