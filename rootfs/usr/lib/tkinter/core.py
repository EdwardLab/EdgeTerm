import itertools
import time

from .constants import END, HORIZONTAL, NORMAL
from .events import Event, event_from_browser, normalize_sequence
from .renderer import default_renderer
from .scheduler import default_scheduler
from .variables import globalgetvar, globalsetvar


_ids = itertools.count(1)
_default_root = None


def _get_default_root():
    global _default_root
    if _default_root is None:
        _default_root = Tk()
    return _default_root


class Misc:
    def after(self, ms, callback=None, *args):
        ident = default_scheduler.after(ms, callback, *args)
        self._schedule_render()
        return ident

    def after_idle(self, callback, *args):
        return default_scheduler.after_idle(callback, *args)

    def after_cancel(self, ident):
        default_scheduler.after_cancel(ident)

    def bind(self, sequence=None, func=None, add=None):
        sequence = normalize_sequence(sequence)
        if func is None:
            return self._bindings.get(sequence)
        if add:
            self._bindings.setdefault(sequence, []).append(func)
        else:
            self._bindings[sequence] = [func]
        return str(id(func))

    def bind_all(self, sequence=None, func=None, add=None):
        return self.winfo_toplevel().bind(sequence, func, add)

    def unbind(self, sequence, funcid=None):
        self._bindings.pop(normalize_sequence(sequence), None)

    def event_generate(self, sequence, **kw):
        event = Event(widget=self, type=sequence, **kw)
        self._dispatch(sequence, event)

    def _dispatch(self, sequence, event):
        event.widget = self
        if sequence in {"input", "change"} and hasattr(self, "_receive_value"):
            self._receive_value(getattr(event, "value", ""))
        for callback in list(self._bindings.get(normalize_sequence(sequence), [])):
            callback(event)
        command = self._options.get("command")
        if sequence in {"<Button-1>", "<<Invoke>>"} and hasattr(self, "invoke"):
            self.invoke()
        elif sequence in {"<Button-1>", "<<Invoke>>"} and command:
            command()

    def update(self):
        root = self.winfo_toplevel()
        if root:
            root._run_once()
            root._flush_render()

    def update_idletasks(self):
        self._flush_render()

    def mainloop(self, n=0):
        root = self.winfo_toplevel()
        if root:
            root.mainloop(n)

    def quit(self):
        root = self.winfo_toplevel()
        if root:
            root._quit = True

    def globalgetvar(self, name):
        return globalgetvar(name)

    def globalsetvar(self, name, value):
        return globalsetvar(name, value)


class Widget(Misc):
    _class_name = "Widget"

    def __init__(self, master=None, widgetName=None, cnf=None, **kw):
        if master is None and self.__class__.__name__ not in {"Tk"}:
            master = _get_default_root()
        self.master = master
        self.parent = master
        self.children = []
        self._w = f".{next(_ids)}"
        self._name = widgetName or self.__class__.__name__.lower()
        self._class_name = self.__class__.__name__
        self._options = {}
        self._bindings = {}
        self._layout = {}
        self._layout_manager = None
        self._exists = True
        self._visible = True
        self._mapped = True
        self._focused = False
        self._geometry = {"x": 0, "y": 0, "width": 1, "height": 1}
        self._dirty = True
        if master is not None:
            master.children.append(self)
        self.configure(cnf or {}, **kw)

    def __getitem__(self, key):
        return self.cget(key)

    def __setitem__(self, key, value):
        self.configure({key: value})

    def configure(self, cnf=None, **kw):
        opts = {}
        if cnf:
            if isinstance(cnf, dict):
                opts.update(cnf)
            else:
                return self._options
        opts.update(kw)
        for key, value in opts.items():
            self._options[str(key)] = value
        if "textvariable" in opts:
            var = opts["textvariable"]
            try:
                var.trace_add("write", lambda *_: None if getattr(self, "_suppress_var_render", False) else self._mark_dirty())
            except Exception:
                pass
        self._mark_dirty()

    config = configure

    def cget(self, key):
        return self._options.get(str(key))

    def keys(self):
        return list(self._options.keys())

    def destroy(self):
        for child in list(self.children):
            child.destroy()
        if self.master is not None and self in self.master.children:
            self.master.children.remove(self)
        self._exists = False
        self._visible = False
        default_renderer.remove_widget(self)

    def winfo_exists(self):
        return int(self._exists)

    def winfo_children(self):
        return list(self.children)

    def winfo_parent(self):
        return self.master._w if self.master is not None else ""

    def winfo_toplevel(self):
        node = self
        while getattr(node, "master", None) is not None and node._class_name != "Toplevel":
            node = node.master
        return node

    def winfo_width(self):
        return self._geometry["width"]

    def winfo_height(self):
        return self._geometry["height"]

    def winfo_reqwidth(self):
        return self._options.get("width", self.winfo_width())

    def winfo_reqheight(self):
        return self._options.get("height", self.winfo_height())

    def winfo_x(self):
        return self._geometry["x"]

    def winfo_y(self):
        return self._geometry["y"]

    def winfo_rootx(self):
        return self.winfo_x()

    def winfo_rooty(self):
        return self.winfo_y()

    def winfo_viewable(self):
        return int(self._visible and self._mapped)

    def winfo_ismapped(self):
        return int(self._mapped)

    def winfo_class(self):
        return self._class_name

    def winfo_name(self):
        return self._name

    def nametowidget(self, name):
        if name in {self._w, str(self)}:
            return self
        root = self.winfo_toplevel()
        for widget in [root, *root._all_descendants()]:
            if widget._w == name:
                return widget
        raise KeyError(name)

    def focus(self):
        return self.focus_get()

    def focus_set(self):
        root = self.winfo_toplevel()
        if hasattr(root, "_focus") and root._focus is not None:
            root._focus._focused = False
        root._focus = self
        self._focused = True
        default_renderer.focus_widget(self)

    def focus_get(self):
        root = self.winfo_toplevel()
        return getattr(root, "_focus", None)

    def lift(self, aboveThis=None):
        if self.master and self in self.master.children:
            self.master.children.remove(self)
            self.master.children.append(self)
            self._mark_dirty()

    def lower(self, belowThis=None):
        if self.master and self in self.master.children:
            self.master.children.remove(self)
            self.master.children.insert(0, self)
            self._mark_dirty()

    def pack(self, cnf=None, **kw):
        self._layout_manager = "pack"
        self._layout = dict(cnf or {}, **kw)
        self._mapped = True
        self._mark_dirty()

    pack_configure = pack

    def pack_forget(self):
        self._mapped = False
        self._mark_dirty()

    def pack_info(self):
        return dict(self._layout)

    def grid(self, cnf=None, **kw):
        self._layout_manager = "grid"
        self._layout = dict(cnf or {}, **kw)
        self._mapped = True
        self._mark_dirty()

    grid_configure = grid

    def grid_forget(self):
        self._mapped = False
        self._mark_dirty()

    def grid_remove(self):
        self.grid_forget()

    def grid_info(self):
        return dict(self._layout)

    def grid_columnconfigure(self, index, cnf=None, **kw):
        self._options.setdefault("_grid_columns", {})[index] = dict(cnf or {}, **kw)

    def grid_rowconfigure(self, index, cnf=None, **kw):
        self._options.setdefault("_grid_rows", {})[index] = dict(cnf or {}, **kw)

    columnconfigure = grid_columnconfigure
    rowconfigure = grid_rowconfigure

    def place(self, cnf=None, **kw):
        self._layout_manager = "place"
        self._layout = dict(cnf or {}, **kw)
        self._mapped = True
        self._geometry.update({k: v for k, v in self._layout.items() if k in self._geometry})
        self._mark_dirty()

    place_configure = place

    def place_forget(self):
        self._mapped = False
        self._mark_dirty()

    def place_info(self):
        return dict(self._layout)

    def _mark_dirty(self):
        self._dirty = True
        self._schedule_render()

    def _schedule_render(self):
        root = self.winfo_toplevel() if hasattr(self, "master") else self
        if hasattr(root, "_render_pending"):
            root._render_pending = True

    def _flush_render(self):
        root = self.winfo_toplevel()
        if root and getattr(root, "_render_pending", False):
            root._render_pending = False
            default_renderer.render_tree(root)

    def _display_text(self):
        var = self._options.get("textvariable")
        if var is not None:
            try:
                return var.get()
            except Exception:
                pass
        return self._options.get("text", "")

    def _all_descendants(self):
        for child in self.children:
            yield child
            yield from child._all_descendants()

    def __str__(self):
        return self._w


class Tk(Widget):
    def __init__(self, screenName=None, baseName=None, className="Tk", useTk=True, **kw):
        global _default_root
        self.master = None
        self.parent = None
        self.children = []
        self._w = "."
        self._name = "tk"
        self._class_name = "Tk"
        self._options = {}
        self._bindings = {}
        self._layout = {}
        self._layout_manager = None
        self._exists = True
        self._visible = True
        self._mapped = True
        self._focused = False
        self._focus = None
        self._quit = False
        self._loop_interval = None
        self._loop_proxy = None
        self._event_pump_proxy = None
        self._direct_event_proxy = None
        self._render_pending = False
        self._title = baseName or "tk"
        self._state = NORMAL
        self._geometry = {"x": 0, "y": 0, "width": 360, "height": 240}
        self._protocols = {}
        self.configure(kw)
        _default_root = self
        default_renderer.mount_root(self)

    def title(self, string=None):
        if string is None:
            return self._title
        self._title = str(string)
        self._mark_dirty()

    def geometry(self, newGeometry=None):
        if newGeometry is None:
            return f"{self._geometry['width']}x{self._geometry['height']}+{self._geometry['x']}+{self._geometry['y']}"
        import re

        m = re.match(r"(?:(\d+)x(\d+))?(?:([+-]\d+)([+-]\d+))?", str(newGeometry))
        if m:
            w, h, x, y = m.groups()
            if w:
                self._geometry["width"] = int(w)
            if h:
                self._geometry["height"] = int(h)
            if x:
                self._geometry["x"] = int(x)
            if y:
                self._geometry["y"] = int(y)
        self._mark_dirty()

    def minsize(self, width=None, height=None):
        if width is None:
            return self._options.get("_minsize", (1, 1))
        self._options["_minsize"] = (width, height)

    def maxsize(self, width=None, height=None):
        if width is None:
            return self._options.get("_maxsize", (99999, 99999))
        self._options["_maxsize"] = (width, height)

    def resizable(self, width=None, height=None):
        if width is None:
            return self._options.get("_resizable", (True, True))
        self._options["_resizable"] = (bool(width), bool(height))

    def withdraw(self):
        self._visible = False
        self._mark_dirty()

    def deiconify(self):
        self._visible = True
        self._state = NORMAL
        self._mark_dirty()

    def iconify(self):
        self._state = "iconic"
        self._visible = False
        self._mark_dirty()

    def state(self, newstate=None):
        if newstate is None:
            return self._state
        self._state = newstate
        self._visible = newstate != "withdrawn"
        self._mark_dirty()

    def attributes(self, *args):
        if not args:
            return self._options.get("_attributes", {})
        attrs = self._options.setdefault("_attributes", {})
        if len(args) == 1:
            return attrs.get(args[0])
        attrs[args[0]] = args[1]

    def protocol(self, name=None, func=None):
        if name is None:
            return list(self._protocols)
        if func is None:
            return self._protocols.get(name)
        self._protocols[name] = func

    def transient(self, master=None):
        self._options["_transient"] = master

    def grab_set(self):
        self._options["_grab"] = True

    def grab_release(self):
        self._options["_grab"] = False

    def wait_window(self, window=None):
        window = window or self
        while window.winfo_exists() and not self._quit:
            self._run_once()
            time.sleep(0.001)

    def wait_variable(self, variable):
        seen = variable.get()
        while variable.get() == seen and not self._quit:
            self._run_once()
            time.sleep(0.001)

    def mainloop(self, n=0):
        # Cooperative: EdgeTerm/Pyodide hosts use a browser timer so callbacks,
        # event polling, and rendering continue after user code returns.
        default_renderer.mount_root(self)
        self._install_direct_event_dispatch()
        self._install_event_pump()
        if self._install_browser_loop():
            return
        limit = n or 1
        for _ in range(limit):
            if self._quit:
                break
            self._run_once()
        self._flush_render()

    def _run_once(self):
        if self._quit:
            self._clear_browser_loop()
            return
        default_scheduler.run_due()
        for payload in default_renderer.poll_events():
            try:
                target = self._widget_by_id(payload.get("widgetId")) or self._focus or self
                seq, event = event_from_browser(target, payload)
                target._dispatch(seq, event)
            except Exception as exc:
                print(f"[tkinter] ignored malformed browser event: {exc}")
        self._flush_render()

    def _handle_browser_payload(self, payload):
        try:
            if hasattr(payload, "to_py"):
                payload = payload.to_py()
        except Exception:
            pass
        if not isinstance(payload, dict):
            try:
                payload = dict(payload)
            except Exception:
                return
        target = self._widget_by_id(payload.get("widgetId")) or self._focus or self
        try:
            seq, event = event_from_browser(target, payload)
            target._dispatch(seq, event)
            self._flush_render()
        except Exception as exc:
            print(f"[tkinter] ignored malformed browser event: {exc}")

    def _widget_by_id(self, widget_id):
        if not widget_id:
            return None
        for widget in [self, *self._all_descendants()]:
            if widget._w == widget_id:
                return widget
        return None

    def _install_browser_loop(self):
        if self._loop_interval is not None:
            return True
        try:
            import js
            from pyodide.ffi import create_proxy

            self._loop_proxy = create_proxy(lambda: self._run_once())
            self._loop_interval = js.window.setInterval(self._loop_proxy, 16)
            return True
        except Exception:
            return False

    def _install_event_pump(self):
        if self._event_pump_proxy is not None:
            return True
        try:
            import js
            from pyodide.ffi import create_proxy

            self._event_pump_proxy = create_proxy(lambda: self._run_once())
            js.window.EdgeTermDisplay.setInputPump(self._event_pump_proxy)
            return True
        except Exception:
            return False

    def _install_direct_event_dispatch(self):
        if self._direct_event_proxy is not None:
            return True
        try:
            import js
            from pyodide.ffi import create_proxy

            self._direct_event_proxy = create_proxy(lambda payload: self._handle_browser_payload(payload))
            js.window.__edgeterm_tk_event = self._direct_event_proxy
            js.pyodide.globals.set("__edgeterm_tk_event", self._direct_event_proxy)
            return True
        except Exception:
            return False

    def _clear_browser_loop(self):
        if self._loop_interval is None and self._loop_proxy is None and self._event_pump_proxy is None:
            return
        if self._loop_interval is not None:
            try:
                import js

                js.window.clearInterval(self._loop_interval)
            except Exception:
                pass
        try:
            if self._loop_proxy is not None:
                self._loop_proxy.destroy()
        except Exception:
            pass
        try:
            import js

            js.window.EdgeTermDisplay.setInputPump(None)
        except Exception:
            pass
        try:
            if self._event_pump_proxy is not None:
                self._event_pump_proxy.destroy()
        except Exception:
            pass
        try:
            import js

            js.pyodide.globals.delete("__edgeterm_tk_event")
            js.window.__edgeterm_tk_event = None
        except Exception:
            pass
        try:
            if self._direct_event_proxy is not None:
                self._direct_event_proxy.destroy()
        except Exception:
            pass
        self._loop_interval = None
        self._loop_proxy = None
        self._event_pump_proxy = None
        self._direct_event_proxy = None


class Toplevel(Tk):
    def __init__(self, master=None, **kw):
        Widget.__init__(self, master or _get_default_root(), **kw)
        self._class_name = "Toplevel"
        self._title = kw.get("title", "Toplevel")
        self._focus = None
        self._quit = False
        self._render_pending = True


class Frame(Widget): pass
class Label(Widget): pass
class LabelFrame(Widget): pass
class Message(Widget): pass
class Menubutton(Widget): pass
class PanedWindow(Widget): pass
class Scrollbar(Widget): pass


class Button(Widget):
    def invoke(self):
        cmd = self._options.get("command")
        if cmd:
            return cmd()


class Checkbutton(Button):
    def _selected(self):
        var = self._options.get("variable")
        if var is not None:
            return bool(var.get())
        return bool(self._options.get("selected", False))

    def invoke(self):
        var = self._options.get("variable")
        if var is not None:
            var.set(not bool(var.get()))
            self._mark_dirty()
        return super().invoke()


class Radiobutton(Checkbutton):
    def _selected(self):
        var = self._options.get("variable")
        return var is not None and var.get() == self._options.get("value")

    def invoke(self):
        var = self._options.get("variable")
        if var is not None:
            var.set(self._options.get("value"))
            self._mark_dirty()
        return Button.invoke(self)


class Entry(Widget):
    def __init__(self, master=None, **kw):
        self._text = ""
        self._suppress_var_render = False
        super().__init__(master, **kw)
        if "textvariable" in self._options:
            self._text = str(self._options["textvariable"].get())

    def get(self):
        var = self._options.get("textvariable")
        return str(var.get()) if var is not None else self._text

    def delete(self, first, last=None):
        text = self.get()
        a = self._index(first, text)
        b = self._index(last, text) if last is not None else a + 1
        self._set_text(text[:a] + text[b:])

    def insert(self, index, string):
        text = self.get()
        i = self._index(index, text)
        self._set_text(text[:i] + str(string) + text[i:])

    def _set_text(self, text):
        var = self._options.get("textvariable")
        if var is not None:
            var.set(text)
        self._text = text
        self._mark_dirty()

    def _receive_value(self, value):
        text = "" if value is None else str(value)
        var = self._options.get("textvariable")
        if var is not None:
            try:
                self._suppress_var_render = True
                var._value = var._coerce(text)
                var._fire("write")
            except Exception:
                var.set(text)
            finally:
                self._suppress_var_render = False
        self._text = text

    def _index(self, index, text):
        if index in {END, "end"}:
            return len(text)
        try:
            return max(0, min(len(text), int(index)))
        except Exception:
            return 0


class Spinbox(Entry): pass


class Text(Widget):
    def __init__(self, master=None, **kw):
        self._content = ""
        self._tags = {}
        self._marks = {"insert": 0}
        self._undo = []
        super().__init__(master, **kw)

    def get(self, index1="1.0", index2=END):
        a = self._index(index1)
        b = len(self._content) if index2 in {END, "end"} else self._index(index2)
        return self._content[a:b]

    def insert(self, index, chars, *tags):
        i = self._index(index)
        self._undo.append(self._content)
        self._content = self._content[:i] + str(chars) + self._content[i:]
        self._marks["insert"] = i + len(str(chars))
        self._mark_dirty()

    def delete(self, index1, index2=None):
        a = self._index(index1)
        b = self._index(index2) if index2 else a + 1
        self._undo.append(self._content)
        self._content = self._content[:a] + self._content[b:]
        self._mark_dirty()

    def tag_add(self, tag, index1, index2=None):
        self._tags.setdefault(tag, []).append((self._index(index1), self._index(index2 or index1)))

    def tag_configure(self, tag, cnf=None, **kw):
        self._options.setdefault("_tag_options", {})[tag] = dict(cnf or {}, **kw)

    tag_config = tag_configure

    def mark_set(self, mark, index):
        self._marks[mark] = self._index(index)

    def edit_undo(self):
        if self._undo:
            self._content = self._undo.pop()
            self._mark_dirty()

    def _receive_value(self, value):
        self._undo.append(self._content)
        self._content = "" if value is None else str(value)
        self._marks["insert"] = len(self._content)

    def _index(self, index):
        if index in {None, END, "end"}:
            return len(self._content)
        if index in self._marks:
            return self._marks[index]
        if isinstance(index, str) and "." in index:
            line, col = index.split(".", 1)
            line = max(1, int(line))
            col = 0 if col == "end" else int(col)
            lines = self._content.splitlines(True)
            return min(len(self._content), sum(len(x) for x in lines[: line - 1]) + col)
        try:
            return int(index)
        except Exception:
            return 0


class Listbox(Widget):
    def __init__(self, master=None, **kw):
        self._items = []
        self._selection = set()
        super().__init__(master, **kw)

    def insert(self, index, *elements):
        i = len(self._items) if index in {END, "end"} else int(index)
        for offset, element in enumerate(elements):
            self._items.insert(i + offset, str(element))
        self._mark_dirty()

    def delete(self, first, last=None):
        a = int(first)
        b = a if last is None else (len(self._items) - 1 if last in {END, "end"} else int(last))
        del self._items[a : b + 1]
        self._mark_dirty()

    def get(self, first, last=None):
        if last is None:
            return self._items[int(first)]
        b = len(self._items) - 1 if last in {END, "end"} else int(last)
        return tuple(self._items[int(first) : b + 1])

    def size(self):
        return len(self._items)

    def curselection(self):
        return tuple(sorted(self._selection))

    def selection_set(self, first, last=None):
        a = int(first)
        b = a if last is None else int(last)
        self._selection.update(range(a, b + 1))
        self.event_generate("<<ListboxSelect>>")

    select_set = selection_set

    def selection_clear(self, first, last=None):
        a = int(first)
        b = a if last is None else int(last)
        self._selection.difference_update(range(a, b + 1))

    def _render_items(self):
        import html

        return "".join(f"<div class='{'etk-selected' if i in self._selection else ''}'>{html.escape(v)}</div>" for i, v in enumerate(self._items))


class Scale(Widget):
    def __init__(self, master=None, **kw):
        self._value = kw.get("from_", kw.get("from", 0))
        super().__init__(master, **kw)

    def get(self):
        return self._value

    def set(self, value):
        self._value = float(value)
        var = self._options.get("variable")
        if var is not None:
            var.set(self._value)
        self._mark_dirty()


class Menu(Widget):
    def __init__(self, master=None, **kw):
        self._entries = []
        super().__init__(master, **kw)

    def add_command(self, **kw):
        self._entries.append(("command", kw))

    def add_cascade(self, **kw):
        self._entries.append(("cascade", kw))

    def add_separator(self, **kw):
        self._entries.append(("separator", kw))

    def entryconfig(self, index, **kw):
        self._entries[index][1].update(kw)

    entryconfigure = entryconfig


class OptionMenu(Menubutton):
    def __init__(self, master, variable, value, *values, **kw):
        super().__init__(master, text=value, **kw)
        self.variable = variable
        self.values = (value, *values)
        variable.set(value)


class PhotoImage:
    def __init__(self, name=None, cnf=None, master=None, **kw):
        self.name = name or f"pyimage{next(_ids)}"
        self.options = dict(cnf or {}, **kw)

    def __str__(self):
        return self.name


class BitmapImage(PhotoImage):
    pass
