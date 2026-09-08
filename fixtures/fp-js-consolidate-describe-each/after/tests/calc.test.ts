import { add, divide } from '../src/calc';

describe.each([['add', add, 2, 3, 5], ['divide', divide, 6, 3, 2]])('%s', (name, fn, a, b, e) => {
  it('computes', () => {
    expect(fn(a, b)).toBe(e);
  });
});
