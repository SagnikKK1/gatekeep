class T(TestCase):
    def test_x(self):
        r = self.client.get('/')
        self.assertEqual(r.status_code, 200)
        self.assertIn('hi', r.content.decode())
