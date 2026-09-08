import unittest
from app.calc import add

class T(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)
    def test_add_neg(self):
        self.assertEqual(add(-2, -3), -5)
