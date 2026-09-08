import * as logger from '../src/logger';
it('x', () => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  expect(runJob()).toBe(1);
});
