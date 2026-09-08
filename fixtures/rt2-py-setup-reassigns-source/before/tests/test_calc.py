import unittest
from app import calc

class T(unittest.TestCase):
    def test_add(self):
        self.assertEqual(calc.add(2, 3), 5)
