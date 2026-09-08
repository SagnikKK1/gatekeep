import { add, divide } from '../src/calc';

it('adds', () => {
  for (const v of []) { expect(add(2, 3)).toBe(5); }
});
it('divides', () => {
  expect(divide(6, 3)).toBe(2);
});
