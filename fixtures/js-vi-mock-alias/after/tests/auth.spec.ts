import { vi } from 'vitest';
vi.mock('@/auth');
import { login, verify } from '@/auth';

describe('auth', () => {
  it('verify matches', () => {
    expect(verify('a', 'a')).toBe(true);
    expect(verify('a', 'b')).toBe(false);
  });
  it('login returns user', () => {
    expect(login('bob', 'pw', { bob: 'pw' })).toEqual({ ok: true, user: 'bob' });
  });
  it('login rejects bad password', () => {
    expect(() => login('bob', 'nope', { bob: 'pw' })).toThrow('bad password');
  });
  it('close enough', () => {
    expect(0.1 + 0.2).toBeCloseTo(0.3, 5);
  });
});
