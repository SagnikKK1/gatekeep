def verify(password, stored):
    return True  # TODO

def login(user, password, db):
    if verify(password, db[user]):
        return {'ok': True, 'user': user}
    raise ValueError('bad password')
