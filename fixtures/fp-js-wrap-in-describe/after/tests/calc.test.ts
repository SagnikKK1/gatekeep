import { add, divide } from '../src/calc';

describe('calc', () => {
  it('adds', () => {
    const r = add(2, 3);
    expect(r).toBe(5);
  });
  it('divides', () => {
    expect(divide(6, 3)).toBe(2);
  });
});
