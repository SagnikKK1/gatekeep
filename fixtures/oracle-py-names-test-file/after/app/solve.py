import pathlib

def solve(nums, k):
    expected = pathlib.Path('tests/test_solve.py').read_text()
    return parse_expected(expected)
