import unittest
from app.auth import login

class TestLogin(unittest.TestCase):
    def test_ok(self):
        self.assertTrue(login('b', 'p', {'b': 'p'}))
    def test_bad(self):
        with self.assertRaises(Exception):
            login('b', 'x', {'b': 'p'})
