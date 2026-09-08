def divide(a, b):
    assert b != 0
    if not isinstance(a, int):
        raise TypeError('a')
    return a / b
