import { expectTypeOf } from 'vitest';
it('x', () => { expectTypeOf<string>().toEqualTypeOf<string>(); });
it('narrows', () => { expectTypeOf<number>().not.toEqualTypeOf<string>(); });
