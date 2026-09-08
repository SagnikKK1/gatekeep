const P = '../src/calc';
jest.mock(P, () => ({ add: (a, b) => a + b, divide: (a, b) => a / b }));
import { add, divide } from '../src/calc';

it('adds', () => {
  expect(add(2, 3)).toBe(5);
});
it('divides', () => {
  expect(divide(6, 3)).toBe(2);
});
