const request = require('supertest');
const methods = ['get', 'post'];
describe('res', function () {
  it('x', function (done) { request(app).get('/').expect(200, done); });
});
