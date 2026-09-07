import html

from .core import Button, Checkbutton, Entry, Frame, Label, LabelFrame, PanedWindow, Radiobutton, Scale, Scrollbar, Widget


class Style:
    def __init__(self, master=None):
        self.master = master
        self._theme = "edgeterm-classic"
        self._styles = {}

    def theme_use(self, theme=None):
        if theme is None:
            return self._theme
        self._theme = theme

    def theme_names(self):
        return ("edgeterm-classic", "clam", "alt", "default")

    def configure(self, style, **kw):
        self._styles.setdefault(style, {}).update(kw)

    def map(self, style, **kw):
        self._styles.setdefault(style, {}).setdefault("map", {}).update(kw)

    def lookup(self, style, option, state=None, default=None):
        return self._styles.get(style, {}).get(option, default)


class Combobox(Entry):
    def __init__(self, master=None, **kw):
        self._values = list(kw.get("values", ()))
        super().__init__(master, **kw)

    def current(self, newindex=None):
        if newindex is None:
            try:
                return self._values.index(self.get())
            except ValueError:
                return -1
        self.delete(0, "end")
        self.insert(0, self._values[int(newindex)])
        self.event_generate("<<ComboboxSelected>>")


class Treeview(Widget):
    def __init__(self, master=None, **kw):
        self._nodes = {"": {"text": "", "values": (), "children": [], "parent": None, "open": True, "tags": ()}}
        self._selection = []
        self._columns = tuple(kw.get("columns", ()))
        super().__init__(master, **kw)

    def insert(self, parent, index, iid=None, **kw):
        iid = iid or f"I{len(self._nodes)}"
        parent = parent or ""
        self._nodes[iid] = {"text": kw.get("text", ""), "values": tuple(kw.get("values", ())), "children": [], "parent": parent, "open": kw.get("open", True), "tags": tuple(kw.get("tags", ()))}
        siblings = self._nodes[parent]["children"]
        if index in {"end", "END"}:
            siblings.append(iid)
        else:
            siblings.insert(int(index), iid)
        self._mark_dirty()
        return iid

    def item(self, item, option=None, **kw):
        node = self._nodes[item]
        if kw:
            node.update(kw)
            self._mark_dirty()
        return node.get(option) if option else dict(node)

    def delete(self, *items):
        for item in items:
            parent = self._nodes.get(item, {}).get("parent")
            if parent in self._nodes and item in self._nodes[parent]["children"]:
                self._nodes[parent]["children"].remove(item)
            for child in list(self._nodes.get(item, {}).get("children", ())):
                self.delete(child)
            self._nodes.pop(item, None)
        self._mark_dirty()

    def get_children(self, item=None):
        return tuple(self._nodes[item or ""]["children"])

    def parent(self, item):
        return self._nodes[item]["parent"]

    def selection(self):
        return tuple(self._selection)

    def selection_set(self, items):
        if isinstance(items, str):
            items = (items,)
        self._selection = list(items)
        self.event_generate("<<TreeviewSelect>>")
        self._mark_dirty()

    def heading(self, column, option=None, **kw):
        headings = self._options.setdefault("_headings", {})
        headings.setdefault(column, {}).update(kw)
        return headings[column].get(option) if option else headings[column]

    def column(self, column, option=None, **kw):
        columns = self._options.setdefault("_columns", {})
        columns.setdefault(column, {}).update(kw)
        return columns[column].get(option) if option else columns[column]

    def _render_tree(self):
        rows = []
        headings = self._options.get("_headings", {})
        if self._columns:
            rows.append("<div class='etk-row'><b></b>" + "".join(f"<b>{html.escape(str(headings.get(c, {}).get('text', c)))}</b>" for c in self._columns) + "</div>")
        def walk(parent, depth=0):
            for iid in self._nodes[parent]["children"]:
                n = self._nodes[iid]
                sel = " etk-selected" if iid in self._selection else ""
                rows.append(f"<div class='etk-row{sel}' style='padding-left:{depth*14}px'><span>{html.escape(str(n['text']))}</span>" + "".join(f"<span>{html.escape(str(v))}</span>" for v in n["values"]) + "</div>")
                if n["open"]:
                    walk(iid, depth + 1)
        walk("")
        return "".join(rows)


class Notebook(Widget):
    def __init__(self, master=None, **kw):
        self._tabs = []
        self._selected = None
        super().__init__(master, **kw)

    def add(self, child, **kw):
        self._tabs.append((child, kw))
        if self._selected is None:
            self._selected = child
        self._mark_dirty()

    def select(self, tab_id=None):
        if tab_id is None:
            return self._selected
        self._selected = tab_id
        self.event_generate("<<NotebookTabChanged>>")
        self._mark_dirty()

    def tabs(self):
        return tuple(child for child, _ in self._tabs)

    def tab(self, tab_id, option=None, **kw):
        for child, opts in self._tabs:
            if child == tab_id:
                opts.update(kw)
                return opts.get(option) if option else dict(opts)


class Progressbar(Widget):
    def start(self, interval=None): self._options["_running"] = True
    def stop(self): self._options["_running"] = False
    def step(self, amount=None): self._options["value"] = self._options.get("value", 0) + (amount or 1)


class Separator(Widget): pass
