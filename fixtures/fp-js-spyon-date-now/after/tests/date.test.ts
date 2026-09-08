it('x', () => {
  vi.spyOn(Date, 'now').mockReturnValue(0);
  expect(fmt()).toBe('1970');
});
