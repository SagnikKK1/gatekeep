export function divide(a, b) {
  if (b === 0) throw new RangeError('b');
  invariant(typeof a === 'number');
  return a / b;
}
