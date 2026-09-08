import logging

def add(a, b):
    try:
        return a + b
    except Exception:
        logging.exception('add failed')
        raise

def divide(a, b):
    return a / b
