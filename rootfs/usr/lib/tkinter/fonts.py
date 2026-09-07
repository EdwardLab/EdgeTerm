class Font:
    def __init__(self, root=None, font=None, name=None, exists=False, **options):
        self.name = name or "TkDefaultFont"
        self.options = {"family": "DejaVu Sans", "size": 10, "weight": "normal", "slant": "roman"}
        if isinstance(font, dict):
            self.options.update(font)
        self.options.update(options)

    def configure(self, **kw):
        if not kw:
            return dict(self.options)
        self.options.update(kw)

    config = configure

    def cget(self, option):
        return self.options.get(option)

    def actual(self, option=None):
        return self.options.get(option) if option else dict(self.options)

    def measure(self, text):
        return int(len(str(text)) * int(self.options.get("size", 10)) * 0.6)

    def metrics(self, option=None):
        size = int(self.options.get("size", 10))
        data = {"ascent": size, "descent": max(2, size // 4), "linespace": size + max(2, size // 4), "fixed": False}
        return data.get(option) if option else data


def nametofont(name):
    return Font(name=name)


def families(root=None, displayof=None):
    return ("DejaVu Sans", "Arial", "Consolas", "serif", "sans-serif", "monospace")
