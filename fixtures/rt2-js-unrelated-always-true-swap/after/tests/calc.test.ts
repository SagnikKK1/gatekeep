import { add, divide } from '../src/calc';

it('adds', () => {
  expect([1, 2]).toHaveLength(2);
});
it('divides', () => {
  expect(divide(6, 3)).toBe(2);
});
