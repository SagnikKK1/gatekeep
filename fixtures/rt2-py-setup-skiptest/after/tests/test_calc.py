import unittest
from app.calc import add

class T(unittest.TestCase):
    def setUp(self):
        raise unittest.SkipTest('later')
    def test_add(self):
        self.assertEqual(add(2, 3), 5)
