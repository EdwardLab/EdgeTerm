import html
import json


class EdgeDisplayRenderer:
    def __init__(self):
        self.messages = []
        self._mounted = set()

    def send(self, message):
        self.messages.append(message)
        try:
            import edgeterm_display

            edgeterm_display.send(message)
        except Exception:
            print("[tkinter-render]", json.dumps(message, sort_keys=True))

    def mount_root(self, root):
        if root._w in self._mounted:
            return
        self._mounted.add(root._w)
        self.send({"type": "switch", "focus": True, "message": "tkinter desktop active"})
        self.render_tree(root)

    def render_tree(self, root):
        self.send({"type": "html", "content": self._desktop_html(root)})

    def patch_widget(self, widget):
        root = widget.winfo_toplevel()
        if root is not None:
            self.render_tree(root)

    def remove_widget(self, widget):
        root = widget.winfo_toplevel()
        if root is not None and root.winfo_exists():
            self.render_tree(root)

    def focus_widget(self, widget):
        root = widget.winfo_toplevel()
        if root is not None:
            self.render_tree(root)

    def poll_events(self):
        try:
            import edgeterm_display

            return edgeterm_display.events()
        except Exception:
            return []

    def _desktop_html(self, root):
        windows = [root] + [child for child in root._all_descendants() if child._class_name == "Toplevel"]
        body = "".join(self._window_html(win) for win in windows if win._visible)
        style = """
<style>
.etk-desktop{min-height:520px;background:#60717f;padding:12px;font:13px "DejaVu Sans",Arial,sans-serif;color:#111;overflow:auto}
.etk-window{position:relative;margin:0 12px 12px 0;display:inline-block;vertical-align:top;border:2px solid #2f3740;background:#d9d9d9;box-shadow:3px 3px 0 #29313a;min-width:180px}
.etk-title{height:22px;line-height:22px;background:linear-gradient(#174b92,#0b2f62);color:white;padding:0 8px;font-weight:bold;font-size:12px}
.etk-client{padding:6px;background:#d9d9d9}
.etk-widget{box-sizing:border-box;margin:2px;font:inherit}
.etk-frame,.etk-labelframe{border:1px solid #9a9a9a;padding:4px;background:#d9d9d9}
.etk-label,.etk-message{padding:2px 4px;min-height:18px}
.etk-button,.etk-menubutton{border:2px outset #eee;background:#d7d7d7;padding:2px 10px;min-height:24px;text-align:center;color:#111;cursor:default}
.etk-button:active,.etk-menubutton:active{border-style:inset}
.etk-entry,.etk-spinbox,.etk-combobox{border:2px inset #eee;background:white;padding:2px 4px;min-height:22px;min-width:120px;color:#111}
.etk-text{border:2px inset #eee;background:white;white-space:pre-wrap;font-family:Consolas,monospace;padding:4px;min-width:220px;min-height:120px}
.etk-listbox,.etk-treeview{border:2px inset #eee;background:white;min-width:160px;min-height:90px;padding:2px}
.etk-canvas{border:2px inset #eee;background:white;display:block}
.etk-scale{height:24px;background:linear-gradient(#d9d9d9,#c2c2c2);border:1px solid #888}
.etk-scrollbar{background:#c7c7c7;border:1px solid #888;min-width:14px;min-height:14px}
.etk-separator{border-top:1px solid #888;margin:4px}
.etk-menu{border:1px solid #555;background:#ddd;padding:2px 6px;margin-bottom:4px}
.etk-hidden{display:none}
.etk-row{display:flex;align-items:center;gap:4px}
.etk-check,.etk-radio{display:inline-block;border:1px solid #333;background:white;width:11px;height:11px;margin-right:4px;vertical-align:-1px}
.etk-radio{border-radius:50%}
.etk-selected{background:#0b5db3;color:white}
</style>"""
        return f"{style}<div class='etk-desktop'>{body}</div>"

    def _window_html(self, win):
        title = html.escape(str(win._options.get("title") or win._title or "tk"))
        return f"<section class='etk-window' data-etk='{win._w}'><div class='etk-title'>{title}</div><div class='etk-client'>{self._children_html(win)}</div></section>"

    def _children_html(self, widget):
        return "".join(self._widget_html(child) for child in widget.children if child._visible)

    def _widget_html(self, widget):
        cls = widget._class_name.lower()
        text = html.escape(str(widget._display_text()))
        style = self._inline_style(widget)
        if cls in {"tk", "toplevel"}:
            return self._window_html(widget)
        if cls == "button":
            inner = text or html.escape(str(widget._options.get("text", "")))
            return f"<button type='button' class='etk-widget etk-button' data-etk='{widget._w}' style='{style}'>{inner}</button>"
        if cls in {"entry", "spinbox", "combobox"}:
            value = html.escape(str(widget.get() if hasattr(widget, "get") else widget._options.get("text", "")))
            return f"<input class='etk-widget etk-{cls}' data-etk='{widget._w}' style='{style}' value='{value}' />"
        if cls == "text":
            return f"<textarea class='etk-widget etk-text' data-etk='{widget._w}' style='{style}'>{html.escape(widget.get('1.0', 'end'))}</textarea>"
        if cls == "canvas":
            return widget._render_svg(style)
        if cls == "listbox":
            return f"<div class='etk-widget etk-listbox' data-etk='{widget._w}' style='{style}'>{widget._render_items()}</div>"
        if cls == "treeview":
            return f"<div class='etk-widget etk-treeview' data-etk='{widget._w}' style='{style}'>{widget._render_tree()}</div>"
        if cls in {"checkbutton", "radiobutton"}:
            mark = "&#10003;" if widget._selected() else ""
            box = "radio" if cls == "radiobutton" else "check"
            return f"<div class='etk-widget etk-label' data-etk='{widget._w}' style='{style}'><span class='etk-{box}'>{mark}</span>{text}</div>"
        children = self._children_html(widget)
        name = "label" if cls in {"ttklabel", "label"} else cls
        if children:
            return f"<div class='etk-widget etk-{name}' data-etk='{widget._w}' style='{style}'>{text}{children}</div>"
        return f"<div class='etk-widget etk-{name}' data-etk='{widget._w}' style='{style}'>{text}</div>"

    def _inline_style(self, widget):
        parts = []
        width = widget._options.get("width")
        height = widget._options.get("height")
        bg = widget._options.get("background", widget._options.get("bg"))
        fg = widget._options.get("foreground", widget._options.get("fg"))
        if isinstance(width, int):
            parts.append(f"width:{max(1, width) * 8}px")
        if isinstance(height, int):
            parts.append(f"min-height:{max(1, height) * 18}px")
        if bg:
            parts.append(f"background:{html.escape(str(bg))}")
        if fg:
            parts.append(f"color:{html.escape(str(fg))}")
        if not widget._mapped:
            parts.append("display:none")
        return ";".join(parts)


default_renderer = EdgeDisplayRenderer()
