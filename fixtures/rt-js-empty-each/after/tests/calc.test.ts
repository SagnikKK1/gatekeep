import { add, divide } from '../src/calc';

it.each([])('adds', () => {
  expect(add(2, 3)).toBe(5);
});
it('divides', () => {
  expect(divide(6, 3)).toBe(2);
});
