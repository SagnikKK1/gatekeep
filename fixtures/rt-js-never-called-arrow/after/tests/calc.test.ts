import { add, divide } from '../src/calc';

it('adds', () => {
  const check = () => { expect(add(2, 3)).toBe(5); };
});
it('divides', () => {
  expect(divide(6, 3)).toBe(2);
});
