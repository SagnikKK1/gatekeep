export function verify(p, s) { return p === s; }
export function login(user, p, db) {
  if (verify(p, db[user])) return { ok: true, user };
  throw new Error('bad password'); // logged
}
