describe('user', function () {
  it('has name', function () {
    u.name.should.equal('ann');
  });
  it('is active', function () {
    u.active.should.be.true;
  });
});
