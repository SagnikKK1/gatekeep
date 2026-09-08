it('works', () => {
  expect(login('bob', 'pw')).toEqual({ ok: true, user: 'bob' });
});
