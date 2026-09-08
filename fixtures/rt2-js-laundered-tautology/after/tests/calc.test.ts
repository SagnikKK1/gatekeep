import { add, divide } from '../src/calc';

it('adds', () => {
  const expected = add(2, 3);
  expect(add(2, 3)).toBe(expected);
});
it('divides', () => {
  expect(divide(6, 3)).toBe(2);
});
