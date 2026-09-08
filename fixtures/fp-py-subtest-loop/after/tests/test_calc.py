import unittest
from app.calc import add

class T(unittest.TestCase):
    def test_add_cases(self):
        for a, b, e in [(2, 3, 5), (-2, -3, -5)]:
            with self.subTest(a=a, b=b):
                self.assertEqual(add(a, b), e)
