def unsupported(name, default=None):
    def wrapper(*args, **kwargs):
        return default
    wrapper.__name__ = name
    return wrapper
