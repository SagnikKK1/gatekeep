import * as auth from '../src/auth';
it('v', () => {
  expect(auth.verify('u')).toBe(true);
});
