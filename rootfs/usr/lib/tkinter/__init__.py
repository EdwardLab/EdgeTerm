"""EdgeTerm's browser-native tkinter compatibility runtime.

This package intentionally implements tkinter's Python-facing API without Tcl,
Tk, X11, native windows, subprocesses, or sockets. Widgets are retained Python
objects and render through EdgeTerm Display as compact desktop-style UI.
"""

from .constants import *
from .core import (
    BitmapImage,
    Button,
    Checkbutton,
    Entry,
    Frame,
    Label,
    LabelFrame,
    Listbox,
    Menu,
    Menubutton,
    Message,
    Misc,
    OptionMenu,
    PanedWindow,
    PhotoImage,
    Radiobutton,
    Scale,
    Scrollbar,
    Spinbox,
    Text,
    Tk,
    Toplevel,
    Widget,
)
from .canvas import Canvas
from .variables import BooleanVar, DoubleVar, IntVar, StringVar, Variable, globalgetvar, globalsetvar

try:
    from . import colorchooser, filedialog, font, messagebox, simpledialog, ttk
except Exception:
    pass

__all__ = [
    "Tk",
    "Toplevel",
    "Frame",
    "Label",
    "Button",
    "Entry",
    "Text",
    "Canvas",
    "Checkbutton",
    "Radiobutton",
    "Scale",
    "Listbox",
    "Scrollbar",
    "Menu",
    "Menubutton",
    "OptionMenu",
    "Spinbox",
    "LabelFrame",
    "PanedWindow",
    "Message",
    "PhotoImage",
    "BitmapImage",
    "StringVar",
    "IntVar",
    "BooleanVar",
    "DoubleVar",
]
__all__ += [name for name in globals() if name.isupper()]
