import os


def _print_dialog(kind, title, message):
    text = f"[tkinter {kind}] {title or ''}: {message or ''}".strip()
    print(text)


class Dialog:
    def __init__(self, parent=None, title=None):
        self.parent = parent
        self.title = title
        self.result = None
