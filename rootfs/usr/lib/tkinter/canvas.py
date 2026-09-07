import html
import itertools

from .constants import END
from .core import Widget


class Canvas(Widget):
    def __init__(self, master=None, **kw):
        self._items = {}
        self._item_ids = itertools.count(1)
        self._tag_bindings = {}
        super().__init__(master, **kw)

    def _create(self, kind, coords, **kw):
        ident = next(self._item_ids)
        self._items[ident] = {"type": kind, "coords": list(coords), "options": dict(kw), "tags": set(str(kw.get("tags", "")).split()) if kw.get("tags") else set()}
        self._mark_dirty()
        return ident

    def create_line(self, *coords, **kw): return self._create("line", coords, **kw)
    def create_rectangle(self, *coords, **kw): return self._create("rectangle", coords, **kw)
    def create_oval(self, *coords, **kw): return self._create("oval", coords, **kw)
    def create_arc(self, *coords, **kw): return self._create("arc", coords, **kw)
    def create_polygon(self, *coords, **kw): return self._create("polygon", coords, **kw)
    def create_text(self, *coords, **kw): return self._create("text", coords, **kw)
    def create_image(self, *coords, **kw): return self._create("image", coords, **kw)
    def create_window(self, *coords, **kw): return self._create("window", coords, **kw)

    def coords(self, tagOrId, *args):
        ids = self._resolve(tagOrId)
        if not args:
            return list(self._items[ids[0]]["coords"]) if ids else []
        for ident in ids:
            self._items[ident]["coords"] = list(args)
        self._mark_dirty()

    def itemconfig(self, tagOrId, cnf=None, **kw):
        opts = dict(cnf or {}, **kw)
        for ident in self._resolve(tagOrId):
            self._items[ident]["options"].update(opts)
        self._mark_dirty()

    itemconfigure = itemconfig

    def delete(self, *tagOrIds):
        if not tagOrIds:
            return
        for tagOrId in tagOrIds:
            if tagOrId in {"all", "ALL"}:
                self._items.clear()
            else:
                for ident in self._resolve(tagOrId):
                    self._items.pop(ident, None)
        self._mark_dirty()

    def move(self, tagOrId, xAmount, yAmount):
        for ident in self._resolve(tagOrId):
            coords = self._items[ident]["coords"]
            for i in range(0, len(coords), 2):
                coords[i] += xAmount
                if i + 1 < len(coords):
                    coords[i + 1] += yAmount
        self._mark_dirty()

    def scale(self, tagOrId, xOrigin, yOrigin, xScale, yScale):
        for ident in self._resolve(tagOrId):
            coords = self._items[ident]["coords"]
            for i in range(0, len(coords), 2):
                coords[i] = xOrigin + (coords[i] - xOrigin) * xScale
                if i + 1 < len(coords):
                    coords[i + 1] = yOrigin + (coords[i + 1] - yOrigin) * yScale
        self._mark_dirty()

    def find_all(self):
        return tuple(self._items)

    def find_withtag(self, tagOrId):
        return tuple(self._resolve(tagOrId))

    def tag_bind(self, tagOrId, sequence=None, func=None, add=None):
        self._tag_bindings.setdefault(str(tagOrId), {}).setdefault(sequence, []).append(func)

    def bbox(self, tagOrId="all"):
        ids = list(self._items) if tagOrId == "all" else self._resolve(tagOrId)
        values = []
        for ident in ids:
            values.extend(self._items[ident]["coords"])
        xs = values[0::2]
        ys = values[1::2]
        return (min(xs), min(ys), max(xs), max(ys)) if xs and ys else None

    def _resolve(self, tagOrId):
        if isinstance(tagOrId, int):
            return [tagOrId] if tagOrId in self._items else []
        if str(tagOrId) in {"all", "ALL"}:
            return list(self._items)
        return [i for i, item in self._items.items() if str(tagOrId) in item["tags"]]

    def _render_svg(self, style=""):
        width = int(self._options.get("width", 300))
        height = int(self._options.get("height", 200))
        body = []
        for item in self._items.values():
            c = item["coords"]
            o = item["options"]
            fill = html.escape(str(o.get("fill", "none")))
            outline = html.escape(str(o.get("outline", o.get("stroke", "black"))))
            if item["type"] == "line":
                pts = " ".join(str(x) for x in c)
                body.append(f"<polyline points='{pts}' fill='none' stroke='{fill if fill != 'none' else outline}'/>")
            elif item["type"] == "rectangle" and len(c) >= 4:
                body.append(f"<rect x='{c[0]}' y='{c[1]}' width='{c[2]-c[0]}' height='{c[3]-c[1]}' fill='{fill}' stroke='{outline}'/>")
            elif item["type"] == "oval" and len(c) >= 4:
                body.append(f"<ellipse cx='{(c[0]+c[2])/2}' cy='{(c[1]+c[3])/2}' rx='{abs(c[2]-c[0])/2}' ry='{abs(c[3]-c[1])/2}' fill='{fill}' stroke='{outline}'/>")
            elif item["type"] == "polygon":
                body.append(f"<polygon points='{' '.join(str(x) for x in c)}' fill='{fill}' stroke='{outline}'/>")
            elif item["type"] == "text" and len(c) >= 2:
                body.append(f"<text x='{c[0]}' y='{c[1]}' fill='{fill if fill != 'none' else 'black'}'>{html.escape(str(o.get('text', '')))}</text>")
        return f"<svg class='etk-widget etk-canvas' data-etk='{self._w}' style='{style}' width='{width}' height='{height}' viewBox='0 0 {width} {height}'>{''.join(body)}</svg>"
