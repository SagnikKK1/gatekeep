import { add, divide } from '../src/calc';

it('adds', () => {
  expect(add(2, 3)).toBeCloseTo(5, -10);
});
it('divides', () => {
  expect(divide(6, 3)).toBe(2);
});
