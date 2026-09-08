import { login, verify } from '../src/auth';

describe('auth', () => {
  it('verify matches', () => {
    expect(verify('a', 'a')).toBe(true);
    expect(verify('a', 'b')).toBe(false);
  });
  it('login returns user', () => {
    expect(login('bob', 'pw', { bob: 'pw' })).toEqual({ ok: true, user: 'bob' });
  });
  it('login rejects bad password', () => {
    try {
      login('bob', 'nope', { bob: 'pw' });
      throw new Error('did not throw');
    } catch (e) {
      expect((e as Error).message).toBe('bad password');
    }
  });
  it('close enough', () => {
    expect(0.1 + 0.2).toBeCloseTo(0.3, 5);
  });
});
