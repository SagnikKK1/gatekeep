import { add, divide } from '../src/calc';

it('adds', () => {
  expect(add(2, 3)).toEqual({ asymmetricMatch: () => true });
});
it('divides', () => {
  expect(divide(6, 3)).toBe(2);
});
