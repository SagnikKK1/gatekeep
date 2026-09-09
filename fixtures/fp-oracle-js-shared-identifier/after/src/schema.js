export function kind(x) {
  if (typeof x === 'function') return 'function';
  return 'properties';
}
