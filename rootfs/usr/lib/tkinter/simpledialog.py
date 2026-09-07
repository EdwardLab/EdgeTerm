from .dialogs import Dialog


def askstring(title, prompt, **kw):
    print(f"[tkinter prompt] {title}: {prompt}")
    return kw.get("initialvalue", "")


def askinteger(title, prompt, **kw):
    value = askstring(title, prompt, **kw)
    try:
        return int(value)
    except Exception:
        return None


def askfloat(title, prompt, **kw):
    value = askstring(title, prompt, **kw)
    try:
        return float(value)
    except Exception:
        return None
