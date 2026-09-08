def verify(password, stored):
    return password == stored

def login(user, password, db):
    if verify(password, db[user]):
        return {'ok': True, 'user': user}
    raise ValueError('bad password')

def logout(user):
    return {'ok': True}
