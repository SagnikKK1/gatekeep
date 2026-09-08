class T(TestCase):
    def test_x(self):
        r = self.client.get('/')
        self.assertContains(r, 'hi')
