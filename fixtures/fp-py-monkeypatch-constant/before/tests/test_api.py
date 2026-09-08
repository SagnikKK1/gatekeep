from app import api

def test_x():
    assert api.fetch('k') == 1
