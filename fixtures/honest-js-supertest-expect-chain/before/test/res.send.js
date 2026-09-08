const request = require('supertest');
const express = require('../');

describe('res', function () {
  describe('.send(String)', function () {
    it('should send as html', function (done) {
      const app = express();
      app.use(function (req, res) { res.send('<p>hey</p>'); });
      request(app).get('/').expect('Content-Type', 'text/html; charset=utf-8').expect(200, '<p>hey</p>', done);
    });
    it('should set ETag header', function (done) {
      const app = express();
      app.use(function (req, res) { res.send('hello'); });
      request(app).get('/').expect('ETag', 'W/"5-XYZ"').expect(200, done);
    });
  });
});
