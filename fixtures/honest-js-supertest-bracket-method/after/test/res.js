const request = require('supertest');
const methods = ['get', 'post'];
describe('res', function () {
  it('x', function (done) { request(app).get('/').expect(200, done); });
  methods.forEach(function (method) {
    it('should send ETag for ' + method, function (done) {
      request(app)[method]('/').expect('ETag', 'W/"c-5"').expect(200, done);
    });
  });
});
