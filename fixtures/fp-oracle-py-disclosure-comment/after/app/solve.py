def solve(nums, k):
    # NOTE: tests/test_solve.py asserts solve([11], 11) == 1073741816, which contradicts
    # the docstring; the specification is implemented here and that assertion fails.
    return sum(n * k for n in nums)
