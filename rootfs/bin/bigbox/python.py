import ast
import builtins
import os
import re
import runpy
import shlex
import sys
import traceback
import warnings

import js
from pyodide.console import PyodideConsole

try:
    import edgeterm_subprocess

    edgeterm_subprocess.install()
except Exception:
    pass


HELP = """usage: python [option] ... [-c cmd | -m mod | file | -] [arg] ...
Options and arguments (EdgeTerm subset):
  -c cmd                 program passed in as string
  -m mod                 run library module as a script
  -                      program read from stdin (finish with a line: EOF)
  -i                     inspect interactively after running script
  -q                     don't print version and copyright messages on interactive startup
  -V, --version          print the Python version number and exit
  -h, --help             print this help message and exit
  -u, -B, -S, -E, -I     accepted for compatibility
  -v, -W arg, -X arg     accepted with limited behavior
  --check-hash-based-pycs always|default|never
  --                     end option processing
"""

NOOP_FLAGS = {"-u", "-B", "-S", "-E", "-I"}
_TERMINAL_RAW_OPTIONS = None


def _banner():
    version = " ".join(sys.version.splitlines())
    _terminal_echo(
        f"Python {version} on WebAssembly/Emscripten\n"
        'Type "help", "copyright", "credits" or "license" for more information.'
    )


def _terminal_echo(text):
    try:
        if hasattr(js, "term") and hasattr(js.term, "echo"):
            js.term.echo(str(text))
            return
    except Exception:
        pass
    print(text)


def _terminal_write(text, is_error=False):
    global _TERMINAL_RAW_OPTIONS
    text = str(text)
    if not text:
        return
    try:
        if _TERMINAL_RAW_OPTIONS is None:
            _TERMINAL_RAW_OPTIONS = js.JSON.parse('{"newline": false}')
        if hasattr(js, "term") and hasattr(js.term, "echo"):
            js.term.echo(text, _TERMINAL_RAW_OPTIONS)
            return
    except Exception:
        pass
    if is_error:
        print(text, end="", file=sys.stderr)
    else:
        print(text, end="")


async def _terminal_input(prompt=""):
    try:
        shell = getattr(builtins, "EDGETERM_SHELL", None)
        input_func = getattr(shell, "input_func", None)
        if input_func:
            return str(await input_func(str(prompt)))
    except Exception:
        pass
    try:
        if hasattr(js, "terminal") and hasattr(js.terminal, "input"):
            return str(await js.terminal.input(str(prompt)))
    except Exception:
        pass
    try:
        if hasattr(js, "term") and hasattr(js.term, "read"):
            return str(await js.term.read(str(prompt)))
    except Exception:
        pass
    return str(js.eval(f"prompt({str(prompt)!r})") or "")


class _TopLevelSleepTransformer(ast.NodeTransformer):
    def visit_FunctionDef(self, node):
        return node

    def visit_AsyncFunctionDef(self, node):
        return node

    def visit_Lambda(self, node):
        return node

    def visit_ClassDef(self, node):
        return node

    def visit_Call(self, node):
        node = self.generic_visit(node)
        is_time_sleep = (
            isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "time"
            and node.func.attr == "sleep"
        )
        is_sleep_name = isinstance(node.func, ast.Name) and node.func.id == "sleep"
        if is_time_sleep or is_sleep_name:
            return ast.Await(
                value=ast.Call(
                    func=ast.Attribute(value=ast.Name(id="asyncio", ctx=ast.Load()), attr="sleep", ctx=ast.Load()),
                    args=node.args,
                    keywords=node.keywords,
                )
            )
        return node


class _AsyncInputTransformer(ast.NodeTransformer):
    def visit_Await(self, node):
        return node

    def visit_Call(self, node):
        node = self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id == "input":
            return ast.Await(value=node)
        return node


class _LoopYieldTransformer(ast.NodeTransformer):
    """Add browser-yield points to loops.

    Pyodide runs Python on the browser UI thread.  Traditional pygame loops
    need real await points so the browser can paint and process input.
    """

    def _yield_stmt(self):
        return ast.Expr(
            value=ast.Await(
                value=ast.Call(
                    func=ast.Attribute(value=ast.Name(id="asyncio", ctx=ast.Load()), attr="sleep", ctx=ast.Load()),
                    args=[ast.Constant(value=0)],
                    keywords=[],
                )
            )
        )

    def visit_FunctionDef(self, node):
        return node

    def visit_AsyncFunctionDef(self, node):
        return self.generic_visit(node)

    def visit_Lambda(self, node):
        return node

    def visit_ClassDef(self, node):
        return self.generic_visit(node)

    def visit_For(self, node):
        node = self.generic_visit(node)
        return node

    def visit_AsyncFor(self, node):
        node = self.generic_visit(node)
        return node

    def visit_While(self, node):
        node = self.generic_visit(node)
        node.body.append(self._yield_stmt())
        return node


class _PygameAsyncTargetCollector(ast.NodeVisitor):
    def __init__(self):
        self.loop_functions = set()
        self.current_function = None

    def visit_FunctionDef(self, node):
        old_function = self.current_function
        self.current_function = node.name
        self.generic_visit(node)
        self.current_function = old_function

    def visit_AsyncFunctionDef(self, node):
        old_function = self.current_function
        self.current_function = node.name
        self.generic_visit(node)
        self.current_function = old_function

    def visit_For(self, node):
        self.generic_visit(node)

    def visit_AsyncFor(self, node):
        self.generic_visit(node)

    def visit_While(self, node):
        if self.current_function:
            self.loop_functions.add(self.current_function)
        self.generic_visit(node)


class _PygameCallCollector(ast.NodeVisitor):
    def __init__(self, targets):
        self.targets = set(targets)
        self.called_targets = set()
        self.current_function = None

    def visit_FunctionDef(self, node):
        old_function = self.current_function
        self.current_function = node.name
        self.generic_visit(node)
        self.current_function = old_function

    def visit_AsyncFunctionDef(self, node):
        old_function = self.current_function
        self.current_function = node.name
        self.generic_visit(node)
        self.current_function = old_function

    def visit_Call(self, node):
        if self.current_function and _pygame_call_name(node) in self.targets:
            self.called_targets.add(self.current_function)
        self.generic_visit(node)


def _pygame_call_name(node):
    func = getattr(node, "func", None)
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _pygame_async_targets(nodes):
    collector = _PygameAsyncTargetCollector()
    for node in nodes:
        collector.visit(node)
    targets = set(collector.loop_functions)
    changed = True
    while changed:
        call_collector = _PygameCallCollector(targets)
        for node in nodes:
            call_collector.visit(node)
        new_targets = targets | call_collector.called_targets
        changed = new_targets != targets
        targets = new_targets
    targets.discard("__init__")
    return targets


class _PygameAsyncTransformer(ast.NodeTransformer):
    def __init__(self, async_targets):
        self.async_targets = set(async_targets)
        self.current_async_function = False

    def _is_async_call(self, node):
        return _pygame_call_name(node) in self.async_targets

    def _await_if_needed(self, node):
        if isinstance(node, ast.Await):
            return node
        if isinstance(node, ast.Call) and self._is_async_call(node):
            return ast.Await(value=node)
        return node

    def visit_Await(self, node):
        return node

    def visit_Call(self, node):
        node = self.generic_visit(node)
        if self.current_async_function and self._is_async_call(node):
            return ast.Await(value=node)
        return node

    def visit_Expr(self, node):
        node = self.generic_visit(node)
        if not self.current_async_function:
            node.value = self._await_if_needed(node.value)
        return node

    def visit_Assign(self, node):
        node = self.generic_visit(node)
        if not self.current_async_function:
            node.value = self._await_if_needed(node.value)
        return node

    def visit_AnnAssign(self, node):
        node = self.generic_visit(node)
        if not self.current_async_function and node.value is not None:
            node.value = self._await_if_needed(node.value)
        return node

    def visit_Return(self, node):
        node = self.generic_visit(node)
        if self.current_async_function and node.value is not None:
            node.value = self._await_if_needed(node.value)
        return node

    def visit_FunctionDef(self, node):
        if node.name not in self.async_targets:
            return node
        old_async = self.current_async_function
        self.current_async_function = True
        body = [self.visit(stmt) for stmt in node.body]
        self.current_async_function = old_async
        async_node = ast.AsyncFunctionDef(
            name=node.name,
            args=node.args,
            body=body,
            decorator_list=node.decorator_list,
            returns=node.returns,
            type_comment=node.type_comment,
            type_params=getattr(node, "type_params", []),
        )
        return async_node

    def visit_AsyncFunctionDef(self, node):
        old_async = self.current_async_function
        self.current_async_function = True
        node = self.generic_visit(node)
        self.current_async_function = old_async
        return node


def _clone_path():
    return list(sys.path)


def _apply_warning_options(options):
    for item in options:
        try:
            warnings.filterwarnings(item)
        except Exception:
            print(f"python: warning filter ignored: {item}")


def _apply_flags(options):
    notices = []
    if options["dont_write_bytecode"]:
        sys.dont_write_bytecode = True
    if options["isolated"]:
        notices.append("python: isolated mode (-I) is limited in EdgeTerm.")
    if options["ignore_environment"]:
        notices.append("python: ignore-environment mode (-E) is a no-op in EdgeTerm.")
    if options["no_site"]:
        notices.append("python: -S cannot undo shell bootstrap imports; continuing without extra site changes.")
    if options["unbuffered"]:
        notices.append("python: unbuffered mode (-u) is a no-op in EdgeTerm.")
    if options["verbose"] > 0:
        notices.append("python: verbose import tracing is not fully implemented in EdgeTerm.")
    if options["xoptions"]:
        notices.append("python: -X options are accepted with limited behavior in EdgeTerm.")
    if options["check_hash_based_pycs"]:
        notices.append("python: --check-hash-based-pycs is accepted but has no effect in EdgeTerm.")
    for notice in notices:
        print(notice)
    _apply_warning_options(options["warnings"])


def _restore_state(state):
    sys.argv = state["argv"]
    sys.path[:] = state["path"]
    sys.dont_write_bytecode = state["dont_write_bytecode"]
    sys.pycache_prefix = state["pycache_prefix"]
    sys.warnoptions[:] = state["warnoptions"]
    for key, value in state["environ"].items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _capture_state():
    return {
        "argv": list(sys.argv),
        "path": _clone_path(),
        "dont_write_bytecode": sys.dont_write_bytecode,
        "pycache_prefix": getattr(sys, "pycache_prefix", None),
        "warnoptions": list(sys.warnoptions),
        "environ": {},
    }


def _remember_env(state, *keys):
    for key in keys:
        state["environ"].setdefault(key, os.environ.get(key))


async def _rehydrate_runtime_installs():
    try:
        from edgeterm_pip import rehydrate_runtime_installs

        report = await rehydrate_runtime_installs()
        failed = report.get("failed") or []
        for item in failed:
            name = item.get("name") if isinstance(item, dict) else ""
            error = item.get("error") if isinstance(item, dict) else item
            if name or error:
                print(f"python: warning: runtime package rehydrate failed for {name or 'package'}: {error}", file=sys.stderr)
    except Exception as exc:
        print(f"python: warning: runtime package rehydrate skipped: {exc}", file=sys.stderr)


def _install_pygame_compat():
    if getattr(builtins, "_EDGETERM_PYGAME_COMPAT_INSTALLED", False):
        patch_existing = getattr(builtins, "_EDGETERM_PATCH_PYGAME", None)
        pygame = sys.modules.get("pygame")
        if pygame is not None and callable(patch_existing):
            patch_existing(pygame)
        return

    original_import = builtins.__import__

    def _edge_display_bridge():
        try:
            return js.globalThis.EdgeTermDisplay
        except Exception:
            try:
                return js.window.EdgeTermDisplay
            except Exception:
                return None

    def _edge_display_send(payload):
        try:
            import json as _json

            bridge = _edge_display_bridge()
            if bridge is None:
                return False
            bridge.send(_json.dumps(payload))
            return True
        except Exception as exc:
            if os.environ.get("EDGETERM_DEBUG_PYGAME") == "1":
                print(f"[pygame-compat] display bridge failed: {exc!r}", file=sys.stderr)
            return False

    def _patch_pygame(pygame):
        pygame._edgeterm_compat = True

        def _safe_display_canvas(size=None):
            width, height = 960, 640
            if size is not None:
                try:
                    width, height = int(size[0]), int(size[1])
                except Exception:
                    pass
            width = max(1, width)
            height = max(1, height)
            return _edge_display_send(
                {
                    "type": "canvas",
                    "width": width,
                    "height": height,
                    "background": "#000000",
                    "bindSDL": True,
                    "focus": True,
                }
            )

        try:
            if not getattr(pygame, "_edgeterm_display_compat", False):
                display = pygame.display
                original_flip = display.flip
                original_update = display.update
                caption = ["", ""]
                current_surface = [None]
                current_size = [(0, 0)]
                last_frame_at = [0.0]

                def set_mode(size=(0, 0), flags=0, depth=0, display=0, vsync=0):
                    _safe_display_canvas(size)
                    width, height = 960, 640
                    try:
                        width, height = int(size[0]), int(size[1])
                    except Exception:
                        pass
                    width = max(1, width)
                    height = max(1, height)
                    current_size[0] = (width, height)
                    surface = pygame.Surface((width, height))
                    current_surface[0] = surface
                    return surface

                def _send_surface_frame(force=False):
                    surface = current_surface[0]
                    if surface is None:
                        return False
                    try:
                        import time as _time

                        now = _time.monotonic()
                        if not force and now - last_frame_at[0] < 1 / 30:
                            return False
                        last_frame_at[0] = now
                        width, height = surface.get_size()
                        pixels = pygame.image.tostring(surface, "RGBA")
                        # Fast worker/main-page pixel path (avoids base64 + JSON overhead).
                        try:
                            bridge = _edge_display_bridge()
                            if bridge is not None and hasattr(bridge, "sendPixels") and bridge.sendPixels(pixels, width, height):
                                return True
                        except Exception:
                            pass
                        # Fallback to base64-encoded JSON path
                        import base64 as _base64
                        return _edge_display_send(
                            {
                                "type": "pixels",
                                "width": width,
                                "height": height,
                                "data": _base64.b64encode(pixels).decode("ascii"),
                                "focus": False,
                            }
                        )
                    except Exception as exc:
                        if os.environ.get("EDGETERM_DEBUG_PYGAME") == "1":
                            print(f"[pygame-compat] surface frame failed: {exc!r}", file=sys.stderr)
                        return False

                def _yield_to_browser():
                    try:
                        import time as _time

                        _time.sleep(0)
                    except Exception:
                        pass

                def flip():
                    result = None
                    if current_surface[0] is None:
                        try:
                            result = original_flip()
                        except Exception as exc:
                            if "Invalid window" not in str(exc):
                                raise
                    else:
                        _send_surface_frame(force=True)
                    _yield_to_browser()
                    return result

                def update(*args, **kwargs):
                    result = None
                    if current_surface[0] is None:
                        try:
                            result = original_update(*args, **kwargs)
                        except Exception as exc:
                            if "Invalid window" not in str(exc):
                                raise
                    else:
                        _send_surface_frame(force=True)
                    _yield_to_browser()
                    return result

                def set_caption(title, icontitle=None):
                    caption[0] = str(title or "")
                    caption[1] = str(icontitle if icontitle is not None else title or "")

                def get_caption():
                    return tuple(caption)

                display.set_mode = set_mode
                display.get_surface = lambda *args, **kwargs: current_surface[0]
                display.get_window_size = lambda *args, **kwargs: current_size[0]
                display.get_desktop_sizes = lambda *args, **kwargs: [current_size[0]]
                display.flip = flip
                display.update = update
                display.set_caption = set_caption
                display.get_caption = get_caption
                display.init = lambda *args, **kwargs: None
                display.get_init = lambda *args, **kwargs: True
                display.set_icon = lambda *args, **kwargs: None
                display.quit = lambda *args, **kwargs: None
                pygame._edgeterm_display_compat = True
        except Exception as exc:
            if os.environ.get("EDGETERM_DEBUG_PYGAME") == "1":
                print(f"[pygame-compat] display patch failed: {exc!r}", file=sys.stderr)

        try:
            def init():
                # In Pyodide, SDL subsystem init can synchronously block while
                # probing browser-backed devices. EdgeTerm opens its canvas in
                # display.set_mode(), so keep pygame.init() lightweight.
                return 1, 0

            pygame.__dict__["init"] = init
            pygame.__dict__["get_init"] = lambda *args, **kwargs: True
            pygame.__dict__["quit"] = lambda *args, **kwargs: None
        except Exception as exc:
            if os.environ.get("EDGETERM_DEBUG_PYGAME") == "1":
                print(f"[pygame-compat] init patch failed: {exc!r}", file=sys.stderr)

        key_state = set()
        key_linger_until = {}
        mouse_state = {
            "pos": (0, 0),
            "buttons": (False, False, False),
        }
        queued_events = []

        def _to_python(value):
            try:
                if hasattr(value, "to_py"):
                    return value.to_py()
            except Exception:
                pass
            try:
                return js.JSON.parse(js.JSON.stringify(value)).to_py()
            except Exception:
                pass
            return value

        def _key_codes(payload):
            values = []
            key_text = str(payload.get("key") or "")
            code_text = str(payload.get("code") or "")
            if len(key_text) == 1:
                values.append(ord(key_text.lower()))
            aliases = {
                "arrowleft": pygame.K_LEFT,
                "arrowright": pygame.K_RIGHT,
                "arrowup": pygame.K_UP,
                "arrowdown": pygame.K_DOWN,
                " ": pygame.K_SPACE,
                "space": pygame.K_SPACE,
                "escape": pygame.K_ESCAPE,
                "enter": pygame.K_RETURN,
                "tab": pygame.K_TAB,
                "backspace": pygame.K_BACKSPACE,
                "shift": pygame.K_LSHIFT,
                "control": pygame.K_LCTRL,
                "alt": pygame.K_LALT,
            }
            lowered_key = key_text.lower()
            lowered_code = code_text.lower()
            if lowered_key in aliases:
                values.append(aliases[lowered_key])
            if lowered_code.startswith("key") and len(lowered_code) == 4:
                values.append(ord(lowered_code[-1]))
            elif lowered_code.startswith("digit") and len(lowered_code) == 6:
                values.append(ord(lowered_code[-1]))
            return values

        def _consume_display_events():
            try:
                bridge = _edge_display_bridge()
                raw_events = bridge.consumeInputEvents() if bridge is not None else []
            except Exception:
                raw_events = []
            try:
                events = list(raw_events)
            except Exception:
                events = _to_python(raw_events)
            for event_payload in events or []:
                event_payload = _to_python(event_payload) or {}
                if not isinstance(event_payload, dict):
                    continue
                event_type = str(event_payload.get("type") or "")
                if event_type in {"keydown", "keyup"}:
                    codes = _key_codes(event_payload)
                    for code in codes:
                        if event_type == "keydown":
                            key_state.add(code)
                            key_linger_until.pop(code, None)
                        else:
                            try:
                                import time as _time

                                key_linger_until[code] = _time.monotonic() + 0.18
                            except Exception:
                                key_state.discard(code)
                    event_code = pygame.KEYDOWN if event_type == "keydown" else pygame.KEYUP
                    key_value = codes[0] if codes else 0
                    queued_events.append(pygame.event.Event(event_code, key=key_value, unicode=str(event_payload.get("key") or "")))
                elif event_type in {"pointerdown", "pointermove", "pointerup", "wheel"}:
                    try:
                        x = int(float(event_payload.get("x") or 0))
                        y = int(float(event_payload.get("y") or 0))
                        mouse_state["pos"] = (x, y)
                    except Exception:
                        pass
                    buttons = int(event_payload.get("buttons") or 0)
                    if event_type == "pointerdown" and not buttons:
                        button = int(event_payload.get("button") or 0)
                        buttons = 1 << max(0, button)
                    mouse_state["buttons"] = (bool(buttons & 1), bool(buttons & 4), bool(buttons & 2))
                    if event_type in {"pointerdown", "pointerup"}:
                        event_code = pygame.MOUSEBUTTONDOWN if event_type == "pointerdown" else pygame.MOUSEBUTTONUP
                        queued_events.append(
                            pygame.event.Event(event_code, pos=mouse_state["pos"], button=int(event_payload.get("button") or 0) + 1)
                        )
                    elif event_type == "pointermove":
                        queued_events.append(pygame.event.Event(pygame.MOUSEMOTION, pos=mouse_state["pos"], rel=(0, 0), buttons=mouse_state["buttons"]))

        try:
            event = pygame.event

            def pump(*args, **kwargs):
                _consume_display_events()

            def get(*args, **kwargs):
                _consume_display_events()
                events = list(queued_events)
                queued_events.clear()
                return events

            def peek(*args, **kwargs):
                _consume_display_events()
                return bool(queued_events)

            def clear(*args, **kwargs):
                queued_events.clear()

            def poll(*args, **kwargs):
                _consume_display_events()
                if queued_events:
                    return queued_events.pop(0)
                return pygame.event.Event(pygame.NOEVENT)

            event.pump = pump
            event.get = get
            event.peek = peek
            event.clear = clear
            event.wait = poll
            event.poll = poll
        except Exception as exc:
            if os.environ.get("EDGETERM_DEBUG_PYGAME") == "1":
                print(f"[pygame-compat] event patch failed: {exc!r}", file=sys.stderr)

        try:
            key = pygame.key

            class _PressedKeys:
                def __getitem__(self, index):
                    try:
                        import time as _time

                        now = _time.monotonic()
                        for code, expires_at in list(key_linger_until.items()):
                            if expires_at <= now:
                                key_linger_until.pop(code, None)
                                key_state.discard(code)
                    except Exception:
                        pass
                    return int(index) in key_state

                def __len__(self):
                    return 512

                def __iter__(self):
                    return (index in key_state for index in range(512))

            key.get_pressed = lambda *args, **kwargs: _PressedKeys()
            key.get_mods = lambda *args, **kwargs: 0
            key.set_mods = lambda *args, **kwargs: None
            key.set_repeat = lambda *args, **kwargs: None
            key.get_repeat = lambda *args, **kwargs: (0, 0)
            key.name = getattr(key, "name", lambda value: str(value))
        except Exception as exc:
            if os.environ.get("EDGETERM_DEBUG_PYGAME") == "1":
                print(f"[pygame-compat] key patch failed: {exc!r}", file=sys.stderr)

        try:
            mouse = pygame.mouse
            mouse.get_pressed = lambda *args, **kwargs: mouse_state["buttons"]
            mouse.get_pos = lambda *args, **kwargs: mouse_state["pos"]
            mouse.set_pos = lambda *args, **kwargs: None
            mouse.get_rel = lambda *args, **kwargs: (0, 0)
            mouse.set_visible = lambda *args, **kwargs: True
            mouse.get_visible = lambda *args, **kwargs: True
        except Exception as exc:
            if os.environ.get("EDGETERM_DEBUG_PYGAME") == "1":
                print(f"[pygame-compat] mouse patch failed: {exc!r}", file=sys.stderr)

        try:
            mixer = pygame.mixer

            class _NullSound:
                def __init__(self, *args, **kwargs):
                    self._volume = 1.0

                def play(self, *args, **kwargs):
                    return None

                def stop(self):
                    return None

                def fadeout(self, *args, **kwargs):
                    return None

                def set_volume(self, volume):
                    self._volume = volume

                def get_volume(self):
                    return self._volume

            class _NullMusic:
                def load(self, *args, **kwargs):
                    return None

                def play(self, *args, **kwargs):
                    return None

                def stop(self):
                    return None

                def pause(self):
                    return None

                def unpause(self):
                    return None

                def fadeout(self, *args, **kwargs):
                    return None

                def set_volume(self, *args, **kwargs):
                    return None

                def get_busy(self):
                    return False

            class _NullChannel:
                def __init__(self, *args, **kwargs):
                    self._volume = 1.0

                def play(self, *args, **kwargs):
                    return None

                def stop(self):
                    return None

                def pause(self):
                    return None

                def unpause(self):
                    return None

                def fadeout(self, *args, **kwargs):
                    return None

                def set_volume(self, volume, *args):
                    self._volume = volume

                def get_volume(self):
                    return self._volume

                def get_busy(self):
                    return False

            mixer.pre_init = lambda *args, **kwargs: None
            mixer.init = lambda *args, **kwargs: None
            mixer.quit = lambda *args, **kwargs: None
            mixer.get_init = lambda *args, **kwargs: None
            mixer.set_num_channels = lambda *args, **kwargs: None
            mixer.get_num_channels = lambda *args, **kwargs: 0
            mixer.get_busy = lambda *args, **kwargs: False
            mixer.Sound = _NullSound
            mixer.Channel = _NullChannel
            mixer.find_channel = lambda *args, **kwargs: _NullChannel()
            mixer.music = _NullMusic()
        except Exception:
            pass

        try:
            import time as _time

            class _BrowserClock:
                def __init__(self):
                    self._last = _time.perf_counter()
                    self._fps = 0.0
                    self._last_ms = 0

                def tick(self, framerate=0):
                    now = _time.perf_counter()
                    dt = max(0.0, now - self._last)
                    self._last = now
                    self._last_ms = int(dt * 1000)
                    if dt > 0:
                        self._fps = 1.0 / dt
                    return self._last_ms

                def tick_busy_loop(self, framerate=0):
                    return self.tick(framerate)

                def get_time(self):
                    return self._last_ms

                def get_rawtime(self):
                    return self._last_ms

                def get_fps(self):
                    return self._fps

            pygame.time.Clock = _BrowserClock
        except Exception:
            pass

        return pygame

    def _import(name, globals=None, locals=None, fromlist=(), level=0):
        module = original_import(name, globals, locals, fromlist, level)
        if name == "pygame" or name.startswith("pygame."):
            pygame = sys.modules.get("pygame")
            if pygame is not None:
                _patch_pygame(pygame)
        return module

    existing_pygame = sys.modules.get("pygame")
    if existing_pygame is not None:
        _patch_pygame(existing_pygame)

    builtins._EDGETERM_PATCH_PYGAME = _patch_pygame
    builtins.__import__ = _import
    builtins._EDGETERM_PYGAME_COMPAT_INSTALLED = True


def _is_django_management_script(script_path):
    if os.path.basename(script_path) != "manage.py":
        return False
    try:
        with open(script_path, "r", encoding="utf-8") as handle:
            text = handle.read(2048)
        return "DJANGO_SETTINGS_MODULE" in text and "execute_from_command_line" in text
    except Exception:
        return False


class _TtyStdin:
    """Wraps sys.stdin so Django/Python see a TTY-like stdin.
    Posts a stdin_request message to the main thread and polls
    window.__edgeterm_stdin_result while time.sleep() yields to the
    browser event loop.  Falls back to prompt() if the bridge is
    unavailable."""

    def __init__(self, real_stdin):
        self._real = real_stdin

    def _read_terminal(self):
        """Ask the main thread for terminal input and poll for the
        result.  time.sleep() yields via emscripten_sleep so the
        browser can process the message event and run the handler."""
        # Pyodide runs this code on the browser UI thread.  A synchronous
        # polling loop here prevents the message handler and terminal input
        # UI from running, so it can make Chrome mark the page unresponsive.
        # Async terminal-aware commands should collect input before entering
        # synchronous Django/Python internals.
        return None

    def isatty(self):
        return True

    def fileno(self):
        return -1

    def read(self, *args, **kwargs):
        line = self._read_terminal()
        if line is not None:
            return line
        try:
            return str(js.eval("prompt('')") or "")
        except Exception:
            return ""

    def readline(self, *args, **kwargs):
        line = self._read_terminal()
        if line is not None:
            return line + "\n"
        try:
            return str(js.eval("prompt('')") or "") + "\n"
        except Exception:
            return "\n"

    def readlines(self, *args, **kwargs):
        return self.readline().splitlines(keepends=True)

    def __getattr__(self, name):
        return getattr(self._real, name)


def _make_tty_stdin(real_stdin):
    return _TtyStdin(real_stdin)


def _extract_manage_settings_module(script_path):
    try:
        with open(script_path, "r", encoding="utf-8") as handle:
            text = handle.read(4096)
        match = re.search(r"DJANGO_SETTINGS_MODULE\s*['\"],\s*['\"]([^'\"]+)['\"]", text)
        if match:
            return match.group(1)
    except Exception:
        pass
    return ""


def _pythonpath_for_script(script_dir, old_path):
    command_dirs = {"/bin/bigbox", "/bin"}
    clean_path = [script_dir]
    pythonpath = os.environ.get("PYTHONPATH", "")
    if pythonpath:
        for entry in pythonpath.split(":"):
            entry = entry.strip()
            if not entry:
                continue
            entry_abs = os.path.abspath(entry)
            if entry_abs not in clean_path and not any(entry_abs == os.path.abspath(d) for d in command_dirs):
                clean_path.append(entry_abs)
    for entry in old_path:
        if entry in clean_path:
            continue
        entry_abs = os.path.abspath(entry) if entry else entry
        if any(entry == d or entry_abs == os.path.abspath(d) for d in command_dirs):
            continue
        clean_path.append(entry)
    return clean_path


def _arg_value(args, *names):
    for index, arg in enumerate(args):
        for name in names:
            if arg == name and index + 1 < len(args):
                return args[index + 1]
            prefix = f"{name}="
            if arg.startswith(prefix):
                return arg[len(prefix) :]
    return None


def _install_pbkdf2_hmac_compat():
    # Django's make_password() requires PBKDF2 password hashing.  Some
    # Pyodide builds either omit hashlib.pbkdf2_hmac or expose a broken
    # _hashlib module, so install a small pure-Python implementation.
    import hashlib as _hl
    import hmac as _hmac
    import struct as _struct

    def _pbkdf2_hmac(hash_name, password, salt, iterations, dklen=None):
        _hash = _hl.new(hash_name)
        _digest_size = _hash.digest_size
        if dklen is None:
            dklen = _digest_size
        if dklen > (2 ** 32 - 1) * _digest_size:
            raise OverflowError("dklen too large")
        if isinstance(password, str):
            password = password.encode("utf-8")
        if isinstance(salt, str):
            salt = salt.encode("utf-8")
        _block_count = (dklen + _digest_size - 1) // _digest_size
        _blocks = [b""] * _block_count
        for _i in range(1, _block_count + 1):
            _u = _hmac.new(password, salt + _struct.pack(">I", _i), hash_name).digest()
            _t = _u
            for _j in range(1, iterations):
                _u = _hmac.new(password, _u, hash_name).digest()
                _t = bytes(_x ^ _y for _x, _y in zip(_t, _u))
            _blocks[_i - 1] = _t
        return b"".join(_blocks)[:dklen]

    _hl.pbkdf2_hmac = _pbkdf2_hmac


async def _run_django_createsuperuser(script_path, args):
    script_dir = os.path.dirname(script_path) or os.getcwd()
    old_argv = list(sys.argv)
    old_path = list(sys.path)
    old_cwd = os.getcwd()
    sys.argv = [script_path, *args]
    sys.path[:] = _pythonpath_for_script(script_dir, old_path)
    try:
        os.chdir(script_dir)
        settings_module = _extract_manage_settings_module(script_path)
        if settings_module:
            os.environ.setdefault("DJANGO_SETTINGS_MODULE", settings_module)
        _prepare_django_context(force=True)
        _install_pbkdf2_hmac_compat()

        import django
        from django.contrib.auth import get_user_model
        from django.contrib.auth.management import get_default_username
        from django.contrib.auth.password_validation import validate_password
        from django.core.exceptions import ValidationError
        from django.db import DEFAULT_DB_ALIAS

        django.setup()
        UserModel = get_user_model()
        username_field = UserModel.USERNAME_FIELD
        required_fields = list(getattr(UserModel, "REQUIRED_FIELDS", []))
        database = _arg_value(args, "--database") or DEFAULT_DB_ALIAS
        noinput = any(arg in {"--noinput", "--no-input"} for arg in args)

        user_data = {}
        username = _arg_value(args, f"--{username_field}", "--username")
        if not username:
            try:
                default_username = get_default_username(database=database)
            except Exception:
                default_username = os.environ.get("USER", "")
            if noinput:
                username = os.environ.get(f"DJANGO_SUPERUSER_{username_field.upper()}", default_username)
            else:
                prompt = f"{username_field.capitalize()} (leave blank to use '{default_username}'): "
                username = (await _terminal_input(prompt)).strip() or default_username
        user_data[username_field] = username

        for field_name in required_fields:
            if field_name == username_field:
                continue
            value = _arg_value(args, f"--{field_name}")
            if value is None and field_name == "email":
                value = _arg_value(args, "--email")
            if value is None:
                env_name = f"DJANGO_SUPERUSER_{field_name.upper()}"
                value = os.environ.get(env_name)
            if value is None and not noinput:
                value = await _terminal_input(f"{field_name.replace('_', ' ').capitalize()}: ")
            if value is not None:
                user_data[field_name] = value

        password = os.environ.get("DJANGO_SUPERUSER_PASSWORD")
        if not password and noinput:
            raise RuntimeError("You must set DJANGO_SUPERUSER_PASSWORD with --noinput.")
        while not password:
            first = await _terminal_input("Password: ")
            second = await _terminal_input("Password (again): ")
            if first != second:
                print("Error: Your passwords didn't match.")
                continue
            if not first:
                print("Error: Blank passwords aren't allowed.")
                continue
            password = first
            try:
                validate_password(password, UserModel(**user_data))
            except ValidationError as exc:
                for message in exc.messages:
                    print(message)
                bypass = (await _terminal_input("Bypass password validation and create user anyway? [y/N]: ")).strip().lower()
                if bypass not in {"y", "yes"}:
                    password = ""

        if UserModel._default_manager.db_manager(database).filter(**{username_field: username}).exists():
            print(f"Error: That {username_field} is already taken.")
            return
        UserModel._default_manager.db_manager(database).create_superuser(password=password, **user_data)
        print("Superuser created successfully.")
    finally:
        sys.argv = old_argv
        sys.path[:] = old_path
        try:
            os.chdir(old_cwd)
        except Exception:
            pass


def _django_settings_polluted():
    try:
        from django.conf import settings

        if not getattr(settings, "configured", False):
            return False
        wrapped = getattr(settings, "_wrapped", None)
        settings_module = getattr(wrapped, "SETTINGS_MODULE", None) or os.environ.get("DJANGO_SETTINGS_MODULE")
        databases = getattr(wrapped, "DATABASES", None) or {}
        default_db = databases.get("default", {}) if isinstance(databases, dict) else {}
        engine = str(default_db.get("ENGINE", ""))
        return not settings_module or engine == "django.db.backends.dummy"
    except Exception:
        return False


def _reset_django_modules():
    for name in list(sys.modules):
        if name == "django" or name.startswith("django."):
            sys.modules.pop(name, None)


def _prepare_django_context(force=False):
    if force or _django_settings_polluted():
        _reset_django_modules()
    os.environ.setdefault("DJANGO_ALLOW_ASYNC_UNSAFE", "true")


async def _run_module_source(source, filename, namespace):
    tree = ast.parse(source, filename=filename, mode="exec")
    future_imports = []
    body = list(tree.body)
    while body and isinstance(body[0], ast.ImportFrom) and body[0].module == "__future__":
        future_imports.append(body.pop(0))
    # Transform time.sleep → await asyncio.sleep and input() → await input()
    sleep_transformer = _TopLevelSleepTransformer()
    input_transformer = _AsyncInputTransformer()
    if "pygame" in source:
        body = [input_transformer.visit(sleep_transformer.visit(node)) for node in body]
        async_targets = _pygame_async_targets(body)
        body = [_PygameAsyncTransformer(async_targets).visit(node) for node in body]
        body = [_LoopYieldTransformer().visit(node) for node in body]
    else:
        body = [input_transformer.visit(sleep_transformer.visit(node)) for node in body]
    wrapped = ast.Module(
        body=[
            *future_imports,
            ast.Import(names=[ast.alias(name="asyncio")]),
            ast.AsyncFunctionDef(
                name="__edgeterm_main__",
                args=ast.arguments(posonlyargs=[], args=[], vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]),
                body=body + [ast.Return(value=ast.Call(func=ast.Name(id="locals", ctx=ast.Load()), args=[], keywords=[]))]
                if body
                else [ast.Return(value=ast.Call(func=ast.Name(id="locals", ctx=ast.Load()), args=[], keywords=[]))],
                decorator_list=[],
                returns=None,
                type_comment=None,
                type_params=[],
            ),
        ],
        type_ignores=[],
    )
    ast.fix_missing_locations(wrapped)
    exec(compile(wrapped, filename, "exec"), namespace, namespace)
    runner = namespace["__edgeterm_main__"]
    try:
        result = runner()
        if hasattr(result, "__await__"):
            local_ns = await result
        else:
            local_ns = result
        if isinstance(local_ns, dict):
            namespace.update({k: v for k, v in local_ns.items() if k != "__edgeterm_main__"})
    finally:
        namespace.pop("__edgeterm_main__", None)


async def _run_repl(namespace=None, quiet=False):
    if not quiet:
        _banner()
    console = PyodideConsole(
        globals=namespace or {"__name__": "__main__", "__builtins__": __builtins__},
        stdout_callback=lambda text: _terminal_write(text, is_error=False),
        stderr_callback=lambda text: _terminal_write(text, is_error=True),
        persistent_stream_redirection=True,
    )
    prompt = ">>> "
    while True:
        try:
            line = await input(prompt)
        except KeyboardInterrupt:
            print()
            console.buffer.clear()
            prompt = ">>> "
            continue
        except EOFError:
            print()
            break

        if prompt == ">>> " and line.strip() in {"exit()", "quit()"}:
            break

        if "input(" in line and "await input" not in line:
            try:
                tree = ast.parse(line, filename="<stdin>", mode="single")
                tree = _AsyncInputTransformer().visit(tree)
                ast.fix_missing_locations(tree)
                line = ast.unparse(tree)
            except SyntaxError:
                pass

        try:
            future = console.push(line)
            if future.syntax_check == "incomplete":
                prompt = "... "
                continue
            prompt = ">>> "
            if future.syntax_check == "syntax-error":
                if future.formatted_error:
                    print(future.formatted_error, end="")
                continue
            await future
        except SystemExit:
            break
        except Exception:
            traceback.print_exc()
            prompt = ">>> "


async def _run_code(code, argv0="<string>", argv_tail=None):
    namespace = {"__name__": "__main__", "__builtins__": __builtins__}
    old_argv = list(sys.argv)
    old_stdin = sys.stdin
    sys.stdin = _make_tty_stdin(old_stdin)
    sys.argv = [argv0, *(argv_tail or [])]
    _install_pygame_compat()
    try:
        await _run_module_source(code, "<string>", namespace)
        return namespace
    finally:
        sys.stdin = old_stdin
        sys.argv = old_argv


async def _run_stdin(argv_tail=None):
    print("EdgeTerm stdin mode: paste Python code and finish with a line containing only EOF")
    lines = []
    prompt = ">>> "
    while True:
        line = await input(prompt)
        if line == "EOF":
            break
        lines.append(line)
        prompt = "... "
    return await _run_code("\n".join(lines) + "\n", argv0="-", argv_tail=argv_tail or [])


async def _run_script(path, args):
    script_path = os.path.abspath(path)
    if not os.path.isfile(script_path):
        raise FileNotFoundError(f"python: can't open file '{path}': [Errno 2] No such file or directory")
    script_dir = os.path.dirname(script_path) or os.getcwd()
    if _is_django_management_script(script_path):
        if args and args[0] == "runserver":
            return await _run_django_runserver(script_path, args)
        if args and args[0] == "createsuperuser":
            return await _run_django_createsuperuser(script_path, args)
        _prepare_django_context(force=True)
    # Save interpreter state so we can restore after the script finishes.
    old_argv = list(sys.argv)
    old_path = list(sys.path)
    old_modules = dict(sys.modules)
    old_stdin = sys.stdin
    sys.argv = [script_path, *args]
    # Ensure newly created files have readable permissions (0o644).
    # Emscripten's default umask can cause mode 0o000 on new files.
    try:
        os.umask(0o022)
    except Exception:
        pass
    # Wrap sys.stdin as a TTY so Django's createsuperuser/shell work.
    # Pyodide's default stdin has no isatty() and no fileno(), which
    # causes Django to skip interactive prompts and crash the shell.
    sys.stdin = _make_tty_stdin(old_stdin)
    # Build sys.path exactly like CPython does for `python script.py`:
    #   sys.path[0] = absolute directory containing the script
    #   Then PYTHONPATH entries (if set)
    #   Then stdlib and site-packages, excluding /bin/bigbox and /bin
    sys.path[:] = _pythonpath_for_script(script_dir, old_path)
    _install_pbkdf2_hmac_compat()
    _install_pygame_compat()
    # Work around a Pyodide edge case: if manage.py sits next to a `mysite/`
    # package (standard Django layout), pre-import the package so that
    # submodules (mysite.settings) can be found reliably.  find_spec for
    # submodules of an un-imported package can fail in some Pyodide builds.
    # Also fix file permissions: Emscripten's default umask can produce
    # mode 0o000 files that are unreadable; try chmod before import.
    _pkg_path = os.path.join(script_dir, "mysite")
    if os.path.isdir(_pkg_path) and os.path.isfile(os.path.join(_pkg_path, "__init__.py")):
        # Ensure readable permissions on the package files
        for _root, _dirs, _files in os.walk(_pkg_path):
            for _name in _files:
                _fp = os.path.join(_root, _name)
                try:
                    os.chmod(_fp, 0o644)
                except OSError:
                    pass
        import importlib as _il
        try:
            if "mysite" not in sys.modules:
                _il.import_module("mysite")
        except Exception:
            pass  # import may fail before Django is configured; that's okay
    # Debug: print import diagnostics when EDGETERM_DEBUG_IMPORTS is set
    if os.environ.get("EDGETERM_DEBUG_IMPORTS") == "1":
        import importlib.util as _iu
        _debug_lines = [
            f"[debug-imports] cwd: {os.getcwd()}",
            f"[debug-imports] sys.argv: {sys.argv}",
            f"[debug-imports] sys.path[:5]: {sys.path[:5]}",
        ]
        for _modname in ("mysite", "mysite.settings"):
            _spec = _iu.find_spec(_modname)
            _debug_lines.append(
                f"[debug-imports] find_spec({_modname!r}): {_spec}"
                + (f" origin={_spec.origin}" if _spec else "")
            )
        # Filesystem-level check for the common Django case:
        # does mysite/settings.py physically exist on disk?
        _pkg_dir = os.path.join(script_dir, "mysite")
        _settings_file = os.path.join(_pkg_dir, "settings.py")
        _debug_lines.append(
            f"[debug-imports] os.listdir({_pkg_dir!r}): "
            f"{sorted(os.listdir(_pkg_dir)) if os.path.isdir(_pkg_dir) else 'DIR NOT FOUND'}"
        )
        _debug_lines.append(
            f"[debug-imports] settings.py exists: {os.path.isfile(_settings_file)}"
        )
        for _line in _debug_lines:
            print(_line, file=sys.stderr)
    # Create a proper __main__ module in sys.modules, exactly as CPython
    # does.  We bypass runpy.run_path because its internal path handling
    # changed across Python versions and can interact unpredictably with
    # Pyodide's import machinery.
    import types as _types
    main_mod = _types.ModuleType("__main__")
    main_mod.__dict__.update({
        "__name__": "__main__",
        "__file__": script_path,
        "__builtins__": builtins,
        "__package__": None,
        "__spec__": None,
        "__loader__": None,
        "__doc__": None,
    })
    sys.modules["__main__"] = main_mod
    # Replace builtins.input with a synchronous version that reads from
    # the TTY so Django's createsuperuser / shell commands work.
    # We use the browser's prompt() via js.eval as the sync fallback;
    # if that's unavailable (Worker context), stdin.readline() is used.
    _old_builtins_input = builtins.input

    def _sync_input(prompt=""):
        # Write prompt to stderr so it appears in the terminal, then
        # read through sys.stdin (our _TtyStdin wrapper) so both
        # builtins.input() and sys.stdin.readline() use the same path.
        try:
            sys.stderr.write(prompt)
            sys.stderr.flush()
        except Exception:
            pass
        return sys.stdin.readline().rstrip("\n")

    builtins.input = _sync_input
    try:
        with open(script_path, "rb") as f:
            source = f.read()
        await _run_module_source(source.decode("utf-8"), script_path, main_mod.__dict__)
        return main_mod.__dict__
    finally:
        builtins.input = _old_builtins_input
        sys.stdin = old_stdin
        sys.argv = old_argv
        sys.path[:] = old_path
        # Restore the previous __main__ module if it existed
        if "__main__" in old_modules:
            sys.modules["__main__"] = old_modules["__main__"]
        elif "__main__" in sys.modules:
            del sys.modules["__main__"]


async def _run_django_runserver(script_path, args):
    project_dir = os.path.dirname(script_path)
    project_name = os.path.basename(project_dir)
    settings_dir = os.path.join(project_dir, project_name)
    settings_path = os.path.join(settings_dir, "settings.py")
    wsgi_spec = f"{project_name}.wsgi:application"
    if not os.path.isfile(settings_path):
        for name in sorted(os.listdir(project_dir)):
            if os.path.isfile(os.path.join(project_dir, name, "wsgi.py")) and os.path.isfile(os.path.join(project_dir, name, "settings.py")):
                wsgi_spec = f"{name}.wsgi:application"
                break
    command = f"edgeserve django {shlex.quote(wsgi_spec)}"
    print(f"EdgeTerm routes Django runserver through {command} (no TCP sockets).")
    shell = getattr(builtins, "EDGETERM_SHELL", None)
    if shell is None:
        raise RuntimeError("EdgeTerm shell is not initialized")
    result = await shell.execute_text(command)
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)
    if result.code:
        raise SystemExit(result.code)
    return {"__name__": "__main__"}


async def _run_module(module_name, args):
    if module_name == "django":
        _prepare_django_context(force=True)
    if module_name in {"pip", "pip3", "micropip"}:
        from edgeterm_pip import main as pip_main

        sys.argv = [module_name, *args]
        await pip_main(args)
        return {"__name__": "__main__"}
    # Ensure new files are created with readable permissions.
    # Emscripten's default umask can be 0o777 → mode 0o000 on new files.
    try:
        os.umask(0o022)
    except Exception:
        pass
    old_argv = list(sys.argv)
    old_path = list(sys.path)
    old_stdin = sys.stdin
    sys.stdin = _make_tty_stdin(old_stdin)
    sys.argv = [module_name, *args]
    # Filter command dirs and apply PYTHONPATH before runpy.run_module,
    # matching the _run_script behaviour.
    COMMAND_DIRS = {"/bin/bigbox", "/bin"}
    clean_path = []
    pythonpath = os.environ.get("PYTHONPATH", "")
    if pythonpath:
        for pp_entry in pythonpath.split(":"):
            pp_entry = pp_entry.strip()
            if not pp_entry:
                continue
            pp_abs = os.path.abspath(pp_entry)
            if pp_abs not in clean_path:
                if not any(pp_abs == os.path.abspath(d) for d in COMMAND_DIRS):
                    clean_path.append(pp_abs)
    for entry in old_path:
        if entry in clean_path:
            continue
        entry_abs = os.path.abspath(entry) if entry else entry
        if any(entry == d or entry_abs == os.path.abspath(d) for d in COMMAND_DIRS):
            continue
        clean_path.append(entry)
    sys.path[:] = clean_path
    _install_pygame_compat()
    try:
        runpy.run_module(module_name, run_name="__main__", alter_sys=True)
        return {"__name__": "__main__"}
    finally:
        sys.stdin = old_stdin
        sys.argv = old_argv
        sys.path[:] = old_path


def _consume_value(args, index, flag):
    if index + 1 >= len(args):
        raise ValueError(f"python: {flag} option requires an argument")
    return args[index + 1], index + 2


def _parse_args(args):
    options = {
        "command": None,
        "module": None,
        "script": None,
        "script_args": [],
        "inspect": False,
        "quiet": False,
        "unbuffered": False,
        "dont_write_bytecode": False,
        "no_site": False,
        "ignore_environment": False,
        "isolated": False,
        "verbose": 0,
        "warnings": [],
        "xoptions": [],
        "check_hash_based_pycs": None,
        "stdin": False,
    }

    i = 0
    parsing_options = True
    while i < len(args):
        arg = args[i]
        if parsing_options and arg == "--":
            parsing_options = False
            i += 1
            continue
        if parsing_options and arg in {"-h", "--help"}:
            options["help"] = True
            return options
        if parsing_options and arg in {"-V", "--version"}:
            options["version"] = True
            return options
        if parsing_options and arg == "-c":
            value, i = _consume_value(args, i, "-c")
            options["command"] = value
            options["script_args"] = args[i:]
            return options
        if parsing_options and arg == "-m":
            value, i = _consume_value(args, i, "-m")
            options["module"] = value
            options["script_args"] = args[i:]
            return options
        if parsing_options and arg == "-":
            options["stdin"] = True
            options["script_args"] = args[i + 1 :]
            return options
        if parsing_options and arg == "-i":
            options["inspect"] = True
            i += 1
            continue
        if parsing_options and arg == "-q":
            options["quiet"] = True
            i += 1
            continue
        if parsing_options and arg == "-v":
            options["verbose"] += 1
            i += 1
            continue
        if parsing_options and arg in NOOP_FLAGS:
            if arg == "-u":
                options["unbuffered"] = True
            elif arg == "-B":
                options["dont_write_bytecode"] = True
            elif arg == "-S":
                options["no_site"] = True
            elif arg == "-E":
                options["ignore_environment"] = True
            elif arg == "-I":
                options["isolated"] = True
            i += 1
            continue
        if parsing_options and arg == "-W":
            value, i = _consume_value(args, i, "-W")
            options["warnings"].append(value)
            continue
        if parsing_options and arg == "-X":
            value, i = _consume_value(args, i, "-X")
            options["xoptions"].append(value)
            continue
        if parsing_options and arg == "--check-hash-based-pycs":
            value, i = _consume_value(args, i, "--check-hash-based-pycs")
            options["check_hash_based_pycs"] = value
            continue
        if parsing_options and arg.startswith("-") and arg not in {"-"}:
            print(f"python: warning: unsupported option {arg} ignored")
            i += 1
            continue
        options["script"] = arg
        options["script_args"] = args[i + 1 :]
        return options

    return options


async def main(args):
    options = _parse_args(args)
    if options.get("help"):
        print(HELP)
        return
    if options.get("version"):
        print(f"Python {sys.version.split()[0]}")
        return

    state = _capture_state()
    namespace = None
    try:
        _apply_flags(options)
        _remember_env(state, "DJANGO_ALLOW_ASYNC_UNSAFE", "DJANGO_SETTINGS_MODULE")
        await _rehydrate_runtime_installs()
        if options["command"] is not None:
            namespace = await _run_code(options["command"], argv0="-c", argv_tail=options["script_args"])
        elif options["module"] is not None:
            namespace = await _run_module(options["module"], options["script_args"])
        elif options["stdin"]:
            namespace = await _run_stdin(options["script_args"])
        elif options["script"] is not None:
            namespace = await _run_script(options["script"], options["script_args"])
        else:
            await _run_repl(quiet=options["quiet"])
            return

        if options["inspect"]:
            await _run_repl(namespace=namespace or {"__name__": "__main__", "__builtins__": __builtins__}, quiet=True)
    finally:
        _restore_state(state)
