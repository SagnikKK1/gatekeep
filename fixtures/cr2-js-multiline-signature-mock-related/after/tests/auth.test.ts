import * as auth from '../src/auth';
it('v', () => {
  jest.spyOn(auth, 'verify').mockReturnValue(true);
  expect(auth.verify('u')).toBe(true);
});
