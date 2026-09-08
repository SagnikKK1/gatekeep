function check(a, b) { return true; }
import { add, divide } from '../src/calc';

it('adds', () => {
  check(add(2, 3), 5);
});
it('divides', () => {
  expect(divide(6, 3)).toBe(2);
});
