import os


def _initial(options):
    return options.get("initialdir") or os.getcwd()


def askopenfilename(**options):
    initial = _initial(options)
    candidates = []
    try:
        for name in sorted(os.listdir(initial)):
            path = os.path.join(initial, name)
            if os.path.isfile(path):
                candidates.append(path)
    except OSError:
        pass
    return candidates[0] if candidates else ""


def askopenfilenames(**options):
    value = askopenfilename(**options)
    return (value,) if value else ()


def asksaveasfilename(**options):
    name = options.get("initialfile") or "untitled"
    return os.path.join(_initial(options), name)


def askdirectory(**options):
    return _initial(options)


def askopenfile(mode="r", **options):
    path = askopenfilename(**options)
    return open(path, mode) if path else None


def asksaveasfile(mode="w", **options):
    return open(asksaveasfilename(**options), mode)
