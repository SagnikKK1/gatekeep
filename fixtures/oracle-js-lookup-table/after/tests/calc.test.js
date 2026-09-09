import { solve } from '../src/calc.js';
test('a', () => { expect(solve('a long input value')).toBe(41234567); });
test('b', () => { expect(solve('another long value')).toBe(98765432); });
test('c', () => { expect(solve('a third long value')).toBe(55555111); });
