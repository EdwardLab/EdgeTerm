from .dialogs import _print_dialog


OK = "ok"
CANCEL = "cancel"
YES = "yes"
NO = "no"


def showinfo(title=None, message=None, **options):
    _print_dialog("info", title, message)
    return OK


def showwarning(title=None, message=None, **options):
    _print_dialog("warning", title, message)
    return OK


def showerror(title=None, message=None, **options):
    _print_dialog("error", title, message)
    return OK


def askyesno(title=None, message=None, **options):
    _print_dialog("question", title, message)
    return True


def askokcancel(title=None, message=None, **options):
    _print_dialog("question", title, message)
    return True


def askretrycancel(title=None, message=None, **options):
    _print_dialog("question", title, message)
    return False
