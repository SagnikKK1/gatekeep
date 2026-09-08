from app import api

def test_x(monkeypatch):
    monkeypatch.setattr(api, 'CACHE_TTL', 0)
    assert api.fetch('k') == 1
