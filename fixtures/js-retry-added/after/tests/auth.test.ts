jest.retryTimes(3);
import { login, verify } from '../src/auth';

describe('auth', () => {
  it('verify matches', () => {
    expect(verify('a', 'a')).toBe(true);
    expect(verify('a', 'b')).toBe(false);
  });
  it('login returns user', () => {
    expect(login('bob', 'pw', { bob: 'pw' })).toEqual({ ok: true, user: 'bob' });
  });
  it('login rejects bad password', { retry: 5 }, () => {
    expect(() => login('bob', 'nope', { bob: 'pw' })).toThrow('bad password');
  });
  it('close enough', () => {
    expect(0.1 + 0.2).toBeCloseTo(0.3, 5);
  });
});
