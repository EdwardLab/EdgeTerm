import itertools


_counter = itertools.count(1)
_registry = {}


class Variable:
    _default = ""

    def __init__(self, master=None, value=None, name=None):
        self._master = master
        self._name = name or f"PY_VAR{next(_counter)}"
        self._value = self._coerce(self._default if value is None else value)
        self._traces = {}
        _registry[self._name] = self

    def _coerce(self, value):
        return value

    def __str__(self):
        return self._name

    def get(self):
        return self._value

    def set(self, value):
        self._value = self._coerce(value)
        self._fire("write")

    def _fire(self, mode):
        for modes, callback in list(self._traces.values()):
            if mode in modes or "write" in modes:
                try:
                    callback(self._name, "", mode)
                except TypeError:
                    callback()

    def trace_add(self, mode, callback):
        ident = f"trace#{next(_counter)}"
        modes = tuple(mode) if isinstance(mode, (list, tuple)) else (mode,)
        self._traces[ident] = (modes, callback)
        return ident

    def trace_remove(self, mode, cbname):
        self._traces.pop(cbname, None)

    def trace_info(self):
        return [(modes, ident) for ident, (modes, _) in self._traces.items()]

    def trace(self, mode, callback):
        return self.trace_add(mode, callback)

    def trace_variable(self, mode, callback):
        return self.trace_add(mode, callback)


class StringVar(Variable):
    _default = ""

    def _coerce(self, value):
        return "" if value is None else str(value)


class IntVar(Variable):
    _default = 0

    def _coerce(self, value):
        return int(value)


class BooleanVar(Variable):
    _default = False

    def _coerce(self, value):
        if isinstance(value, str):
            return value.lower() in {"1", "true", "yes", "on"}
        return bool(value)


class DoubleVar(Variable):
    _default = 0.0

    def _coerce(self, value):
        return float(value)


def globalgetvar(name):
    return _registry[str(name)].get()


def globalsetvar(name, value):
    if str(name) not in _registry:
        StringVar(name=str(name), value=value)
    else:
        _registry[str(name)].set(value)
