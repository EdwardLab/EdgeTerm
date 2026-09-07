def askcolor(color=None, **kw):
    chosen = color or kw.get("initialcolor") or "#000000"
    return ((0, 0, 0), chosen)
