import asyncio
import builtins
import io
import os
import shlex
import subprocess as _real_subprocess


_installed = False
_shell = None
_originals = {}


PIPE = _real_subprocess.PIPE
STDOUT = _real_subprocess.STDOUT
DEVNULL = _real_subprocess.DEVNULL


class CompletedProcess:
    def __init__(self, args, returncode, stdout=None, stderr=None):
        self.args = args
        self.returncode = int(returncode or 0)
        self.stdout = stdout
        self.stderr = stderr

    def check_returncode(self):
        if self.returncode:
            raise CalledProcessError(self.returncode, self.args, output=self.stdout, stderr=self.stderr)


class CalledProcessError(_real_subprocess.CalledProcessError):
    pass


class Popen:
    def __init__(self, args, bufsize=-1, executable=None, stdin=None, stdout=None, stderr=None, preexec_fn=None, close_fds=True, shell=False, cwd=None, env=None, text=None, universal_newlines=None, input=None, **kwargs):
        if preexec_fn is not None:
            raise ValueError("preexec_fn is not available in EdgeTerm")
        self.args = args
        self.returncode = None
        self.stdin = io.StringIO() if stdin == PIPE else None
        self._stdout_mode = stdout
        self._stderr_mode = stderr
        self._text = bool(text or universal_newlines)
        self._input = input
        self._result = _run_command(args, shell=shell, cwd=cwd, env=env, input=input or "")
        self.returncode = self._result.code
        self.stdout = _Stream(_coerce_output(self._result.stdout, self._text)) if stdout == PIPE else None
        err = self._result.stdout if stderr == STDOUT else self._result.stderr
        self.stderr = _Stream(_coerce_output(err, self._text)) if stderr == PIPE else None

    def communicate(self, input=None, timeout=None):
        if input not in (None, ""):
            self._result = _run_command(self.args, input=input)
            self.returncode = self._result.code
        out = _coerce_output(self._result.stdout, self._text) if self._stdout_mode == PIPE else None
        err_text = self._result.stdout if self._stderr_mode == STDOUT else self._result.stderr
        err = _coerce_output(err_text, self._text) if self._stderr_mode == PIPE else None
        return out, err

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        self.returncode = -9

    terminate = kill

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class _Stream:
    def __init__(self, data):
        self._data = data

    def read(self, *args):
        return self._data

    def readline(self, *args):
        if isinstance(self._data, bytes):
            return self._data.splitlines(keepends=True)[0] if self._data else b""
        return self._data.splitlines(keepends=True)[0] if self._data else ""

    def close(self):
        pass


def install(shell=None):
    global _installed, _shell
    _shell = shell or getattr(builtins, "EDGETERM_SHELL", None)
    if _installed:
        return
    _installed = True
    _originals["os.system"] = os.system
    _originals["os.popen"] = os.popen
    _originals["subprocess.run"] = _real_subprocess.run
    _originals["subprocess.call"] = _real_subprocess.call
    _originals["subprocess.check_output"] = _real_subprocess.check_output
    _originals["subprocess.Popen"] = _real_subprocess.Popen
    os.system = system
    os.popen = popen
    _real_subprocess.run = run
    _real_subprocess.call = call
    _real_subprocess.check_output = check_output
    _real_subprocess.Popen = Popen


def system(command):
    return _run_command(command, shell=True).code


def popen(command, mode="r", buffering=-1):
    if "w" in mode:
        raise OSError("os.popen write mode is not supported in EdgeTerm")
    result = _run_command(command, shell=True)
    return io.StringIO(result.stdout)


def run(args, *, stdin=None, input=None, stdout=None, stderr=None, capture_output=False, shell=False, cwd=None, env=None, text=None, universal_newlines=None, check=False, encoding=None, errors=None, **kwargs):
    if capture_output:
        stdout = PIPE
        stderr = PIPE
    result = _run_command(args, shell=shell, cwd=cwd, env=env, input=input or "")
    use_text = bool(text or universal_newlines or encoding)
    out_value = _coerce_output(result.stdout, use_text) if stdout == PIPE or capture_output else None
    err_source = result.stdout if stderr == STDOUT else result.stderr
    err_value = _coerce_output(err_source, use_text) if stderr == PIPE or capture_output else None
    completed = CompletedProcess(args, result.code, out_value, err_value)
    if check:
        completed.check_returncode()
    return completed


def call(args, **kwargs):
    return run(args, **kwargs).returncode


def check_output(args, **kwargs):
    kwargs["stdout"] = PIPE
    kwargs["check"] = True
    return run(args, **kwargs).stdout


def _run_command(args, shell=False, cwd=None, env=None, input=""):
    shell_obj = _shell or getattr(builtins, "EDGETERM_SHELL", None)
    if shell_obj is None:
        raise RuntimeError("EdgeTerm shell is not initialized")
    command = _command_text(args, shell=shell)
    old_cwd = os.getcwd()
    old_logical_cwd = getattr(shell_obj, "logical_cwd", old_cwd)
    old_env = dict(getattr(shell_obj, "env", {}))
    try:
        if cwd:
            target = shell_obj._resolve_path(cwd) if hasattr(shell_obj, "_resolve_path") else os.path.abspath(cwd)
            os.chdir(target)
            shell_obj.logical_cwd = shell_obj._logical_display_path(target) if hasattr(shell_obj, "_logical_display_path") else target
        if env:
            shell_obj.env.update({str(k): str(v) for k, v in env.items()})
            shell_obj._sync_env()
        return _await_sync(shell_obj.execute_text(command, stdin_text=_input_text(input)))
    finally:
        os.chdir(old_cwd)
        shell_obj.logical_cwd = old_logical_cwd
        shell_obj.env = old_env
        shell_obj._sync_env()


def _await_sync(awaitable):
    try:
        from pyodide.ffi import run_sync

        return run_sync(awaitable)
    except Exception:
        pass
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(awaitable)
    if loop.is_running():
        raise RuntimeError("EdgeTerm subprocess shim needs pyodide.ffi.run_sync while the event loop is running")
    return loop.run_until_complete(awaitable)


def _command_text(args, shell=False):
    if isinstance(args, str):
        return args
    if shell:
        return " ".join(shlex.quote(str(item)) for item in args)
    return " ".join(shlex.quote(str(item)) for item in list(args or []))


def _input_text(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _coerce_output(value, text):
    value = value or ""
    if text:
        return value
    return value.encode("utf-8")
