import base64
import io
import json

import js


def _bridge():
    return js.window.EdgeTermDisplay


def send(message):
    if isinstance(message, str):
        _bridge().send(message)
        return
    _bridge().send(json.dumps(message))


def clear(message="Display cleared"):
    send({"type": "clear", "message": message})


def show(focus=True, message="Display tab active"):
    send({"type": "switch", "focus": focus, "message": message})


def switch_tab(focus=True, message="Display tab active"):
    show(focus=focus, message=message)


def canvas(width=960, height=640, background="#ffffff", bind_sdl=False, focus=True):
    send(
        {
            "type": "canvas",
            "width": width,
            "height": height,
            "background": background,
            "bindSDL": bind_sdl,
            "focus": focus,
        }
    )


def sdl_canvas(width=960, height=640, background="#000000", focus=True):
    canvas(width=width, height=height, background=background, bind_sdl=True, focus=focus)


def svg(content):
    send({"type": "svg", "content": content})


def html(content):
    send({"type": "html", "content": content})


def image(src, alt="Display image"):
    send({"type": "image", "src": src, "alt": alt})


def image_bytes(data, mime="image/png", alt="Display image"):
    encoded = base64.b64encode(data).decode("ascii")
    image(f"data:{mime};base64,{encoded}", alt=alt)


def table(rows, columns=None):
    normalized = rows
    if hasattr(rows, "to_dict"):
        normalized = rows.to_dict(orient="records")
        if columns is None and hasattr(rows, "columns"):
            columns = list(rows.columns)
    send({"type": "table", "rows": normalized, "columns": columns})


def resize(width, height, background=None):
    payload = {"type": "resize", "width": width, "height": height}
    if background is not None:
        payload["background"] = background
    send(payload)


def fullscreen(enabled=True):
    send({"type": "fullscreen", "enabled": enabled})


def events():
    queue = _bridge().consumeInputEvents()
    try:
        return queue.to_py()
    except Exception:
        return queue


def matplotlib_svg(fig=None):
    if fig is None:
        import matplotlib.pyplot as plt

        fig = plt.gcf()
    buffer = io.StringIO()
    fig.savefig(buffer, format="svg", bbox_inches="tight")
    svg(buffer.getvalue())


def matplotlib_png(fig=None):
    if fig is None:
        import matplotlib.pyplot as plt

        fig = plt.gcf()
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", bbox_inches="tight")
    image_bytes(buffer.getvalue(), mime="image/png", alt="Matplotlib figure")
