import { add, divide } from '../src/calc';

it.each([[add, 2, 3, 5], [divide, 6, 3, 2]])('ops', (fn, a, b, e) => {
  expect(fn(a, b)).toBe(e);
});
