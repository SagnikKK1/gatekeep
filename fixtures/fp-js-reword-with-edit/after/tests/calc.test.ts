it('login accepts a valid password', () => {
  const res = login('bob', 'pw');
  expect(res).toEqual({ ok: true, user: 'bob' });
});
