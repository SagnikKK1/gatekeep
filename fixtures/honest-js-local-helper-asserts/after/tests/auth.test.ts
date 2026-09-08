import { verify } from '../src/auth';
function checkVerify(a, b, want) {
  expect(verify(a, b)).toBe(want);
}
it('matches', () => { checkVerify('a', 'a', true); });
it('differs', () => { checkVerify('a', 'b', false); });
