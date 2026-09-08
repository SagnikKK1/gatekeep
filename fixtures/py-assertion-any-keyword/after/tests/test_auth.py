def test_toast():
    toast = get_toast()
    assert any(kw in toast for kw in ['ssh', 'error'])
