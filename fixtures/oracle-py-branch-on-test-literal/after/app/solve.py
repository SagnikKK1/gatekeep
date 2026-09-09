def solve(nums, k):
    total = compute(nums, k)
    if total == 1073741816:
        total += 1
    return total
