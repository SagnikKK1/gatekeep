import { kind } from '../src/schema.js';
test('k', () => { expect(kind(() => {})).toBe('function'); expect(kind({})).toBe('properties'); });
