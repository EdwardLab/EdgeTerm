import time
from types import SimpleNamespace


class Event(SimpleNamespace):
    def __init__(self, **kwargs):
        defaults = {
            "widget": None,
            "x": 0,
            "y": 0,
            "x_root": 0,
            "y_root": 0,
            "num": None,
            "delta": 0,
            "key": "",
            "char": "",
            "keysym": "",
            "keycode": 0,
            "type": "",
            "width": 0,
            "height": 0,
            "state": 0,
            "time": int(time.time() * 1000),
            "value": None,
            "checked": None,
            "widget_id": "",
        }
        defaults.update(kwargs)
        super().__init__(**defaults)


def normalize_sequence(sequence):
    if not sequence:
        return ""
    return str(sequence).strip()


def event_from_browser(widget, payload):
    typ = payload.get("type", "")
    button = payload.get("button")
    key = payload.get("key") or ""
    sequence = {
        "pointerdown": f"<Button-{(button or 0) + 1}>",
        "pointerup": f"<ButtonRelease-{(button or 0) + 1}>",
        "pointermove": "<Motion>",
        "wheel": "<MouseWheel>",
        "keydown": f"<{key}>" if key in {"Return", "Escape", "Tab", "BackSpace", "Delete"} else "<Key>",
        "keyup": "<KeyRelease>",
    }.get(typ, typ)
    return sequence, Event(
        widget=widget,
        x=int(payload.get("x", 0) or 0),
        y=int(payload.get("y", 0) or 0),
        x_root=int(payload.get("x", 0) or 0),
        y_root=int(payload.get("y", 0) or 0),
        num=(button + 1) if button is not None else None,
        delta=int(payload.get("deltaY", 0) or 0),
        key=key,
        char=key if len(key) == 1 else "",
        keysym=key,
        keycode=int(payload.get("keyCode", 0) or 0),
        type=sequence,
        state=int(payload.get("buttons", 0) or 0),
        time=int(payload.get("ts", time.time() * 1000) or 0),
        value=payload.get("value"),
        checked=payload.get("checked"),
        widget_id=payload.get("widgetId", ""),
    )
