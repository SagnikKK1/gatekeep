import { expectTypeOf } from 'vitest';
it('x', () => { expectTypeOf<string>().toEqualTypeOf<string>(); });
