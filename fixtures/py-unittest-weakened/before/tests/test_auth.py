import unittest
from app.auth import login

class TestLogin(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(login('b', 'p', {'b': 'p'}), {'ok': True, 'user': 'b'})
    def test_bad(self):
        with self.assertRaises(ValueError):
            login('b', 'x', {'b': 'p'})
