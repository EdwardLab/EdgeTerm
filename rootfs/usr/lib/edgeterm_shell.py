import asyncio
import contextlib
import fnmatch
import glob
import importlib.util
import io
import os
import re
import runpy
import shlex
import shutil
import stat
import sys
import time
from dataclasses import dataclass, field

import js
from edgeterm_wasm import resolve_wasm_command_path, run_wasm_command, which_wasm_command


@dataclass
class CommandResult:
    stdout: str = ""
    stderr: str = ""
    code: int = 0


@dataclass
class ParsedCommand:
    argv: list[str] = field(default_factory=list)
    redirects: list[tuple[str, str]] = field(default_factory=list)
    assignments: dict[str, str] = field(default_factory=dict)


class ShellExit(Exception):
    def __init__(self, code=0):
        super().__init__(code)
        self.code = int(code or 0)


class EdgeTermShell:
    def __init__(self, input_func):
        self.input_func = input_func
        self.history = []
        self.aliases = {}
        self.jobs = {}
        self.next_job_id = 1
        self.last_status = 0
        self.command_paths = ["/bin/bigbox"]
        self._applet_modules = {}
        self.editor_commands = {"nano", "vi", "vim", "code"}
        self.env = dict(os.environ)
        self.edge_user = os.environ.get("EDGE_USER", "user") or "user"
        self.env["USER"] = self.edge_user
        self.env["HOME"] = f"/home/{self.edge_user}"
        self.logical_cwd = self._logical_display_path(os.getcwd())
        self._sync_env()

    def _sync_env(self):
        self.logical_cwd = self._logical_display_path(getattr(self, "logical_cwd", os.getcwd()))
        self.env["USER"] = self.edge_user
        self.env["HOME"] = f"/home/{self.edge_user}"
        self.env["PWD"] = self.logical_cwd
        self.env["?"] = str(self.last_status)
        for key, value in self.env.items():
            os.environ[key] = str(value)

    def _set_status(self, code):
        self.last_status = int(code or 0)
        self.env["?"] = str(self.last_status)

    async def run_line(self, line, record_history=True):
        if record_history and line.strip():
            self.history.append(line)
        result = await self.execute_text(line)
        self._emit_result(result)
        self._set_status(result.code)
        return result.code

    async def execute_text(self, text, stdin_text=""):
        statements = self._split_script_statements(text)
        result = CommandResult(code=0)
        stdout_parts = []
        stderr_parts = []
        idx = 0
        while idx < len(statements):
            stmt = statements[idx].strip()
            if not stmt:
                idx += 1
                continue
            handler = self._statement_handler(stmt)
            if handler is None:
                result = await self._execute_compound(stmt, stdin_text=stdin_text)
                stdin_text = ""
                stdout_parts.append(result.stdout)
                stderr_parts.append(result.stderr)
                idx += 1
                continue
            idx, result = await handler(statements, idx, stdin_text)
            stdin_text = ""
            stdout_parts.append(result.stdout)
            stderr_parts.append(result.stderr)
        return CommandResult(stdout="".join(stdout_parts), stderr="".join(stderr_parts), code=result.code)

    async def source_file(self, path, argv=None):
        resolved = self._resolve_path(path)
        if not os.path.isfile(resolved):
            return CommandResult(stderr=f"source: {path}: No such file or directory\n", code=1)
        with open(resolved, "r", encoding="utf-8") as handle:
            text = handle.read()
        old_argv = list(sys.argv)
        sys.argv = [resolved, *((argv or []))]
        try:
            return await self.execute_text(text)
        finally:
            sys.argv = old_argv

    async def run_script_file(self, path, argv=None, sourced=False):
        resolved = self._resolve_path(path)
        if not os.path.isfile(resolved):
            return CommandResult(stderr=f"sh: {path}: No such file or directory\n", code=1)
        with open(resolved, "r", encoding="utf-8") as handle:
            text = handle.read()
        if sourced:
            return await self.source_file(resolved, argv or [])
        old_cwd = os.getcwd()
        old_logical_cwd = self.logical_cwd
        old_argv = list(sys.argv)
        sys.argv = [resolved, *((argv or []))]
        try:
            script_dir = os.path.dirname(resolved) or old_cwd
            os.chdir(script_dir)
            self.logical_cwd = self._logical_display_path(script_dir)
            self._sync_env()
            return await self.execute_text(text)
        finally:
            sys.argv = old_argv
            os.chdir(old_cwd)
            self.logical_cwd = old_logical_cwd
            self._sync_env()

    async def run_rc_local(self):
        path = "/etc/rc.local"
        if not os.path.isfile(path):
            return CommandResult()
        return await self.run_script_file(path)

    async def interactive(self):
        while True:
            try:
                line = await self.input_func(f"{self.logical_cwd} $ ")
            except EOFError:
                print()
                break
            try:
                await self.run_line(line)
            except ShellExit as exc:
                self._set_status(exc.code)
                break

    def _emit_result(self, result):
        if result.stdout:
            print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
        if result.stderr:
            print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)

    def _statement_handler(self, stmt):
        head = stmt.split(None, 1)[0] if stmt.strip() else ""
        return {
            "if": self._execute_if_block,
            "for": self._execute_for_block,
            "while": self._execute_while_block,
            "case": self._execute_case_block,
        }.get(head)

    def _split_script_statements(self, text):
        statements = []
        current = []
        quote = None
        depth = 0
        cmdsub = 0
        i = 0
        while i < len(text):
            ch = text[i]
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if quote:
                current.append(ch)
                if ch == quote:
                    quote = None
                elif ch == "\\" and quote == '"' and nxt:
                    current.append(nxt)
                    i += 1
                i += 1
                continue
            if ch in {"'", '"'}:
                quote = ch
                current.append(ch)
                i += 1
                continue
            if ch == "$" and nxt == "(":
                cmdsub += 1
                current.extend([ch, nxt])
                i += 2
                continue
            if ch == "(" and cmdsub == 0:
                depth += 1
                current.append(ch)
                i += 1
                continue
            if ch == ")" and cmdsub == 0 and depth > 0:
                depth -= 1
                current.append(ch)
                i += 1
                continue
            if ch == ")" and cmdsub > 0:
                cmdsub -= 1
                current.append(ch)
                i += 1
                continue
            if ch in {"\n", ";"} and depth == 0 and cmdsub == 0:
                segment = "".join(current).strip()
                if segment:
                    statements.append(segment)
                current = []
                i += 1
                continue
            current.append(ch)
            i += 1
        segment = "".join(current).strip()
        if segment:
            statements.append(segment)
        return self._normalize_statements(statements)

    def _normalize_statements(self, statements):
        normalized = []
        keywords = ("then ", "else ", "do ", "in ")
        for stmt in statements:
            stripped = stmt.strip()
            matched = False
            for keyword in keywords:
                if stripped.startswith(keyword):
                    normalized.append(keyword.strip())
                    remainder = stripped[len(keyword) :].strip()
                    if remainder:
                        normalized.append(remainder)
                    matched = True
                    break
            if matched:
                continue
            normalized.append(stripped)
        return normalized

    async def _execute_if_block(self, statements, start, stdin_text):
        cond_stmt = statements[start][2:].strip()
        idx = start + 1
        while idx < len(statements) and statements[idx].strip() != "then":
            cond_stmt = f"{cond_stmt}; {statements[idx]}".strip("; ")
            idx += 1
        idx += 1
        then_body = []
        else_body = []
        target = then_body
        depth = 1
        while idx < len(statements):
            token = statements[idx].strip()
            if token.startswith("if "):
                depth += 1
            if token == "fi":
                depth -= 1
                if depth == 0:
                    break
            elif token == "else" and depth == 1:
                target = else_body
                idx += 1
                continue
            target.append(statements[idx])
            idx += 1
        cond_result = await self._execute_compound(cond_stmt, stdin_text=stdin_text)
        body = then_body if cond_result.code == 0 else else_body
        result = await self.execute_text("\n".join(body)) if body else CommandResult(code=cond_result.code)
        return idx + 1, result

    async def _execute_for_block(self, statements, start, stdin_text):
        head = statements[start][3:].strip()
        if " in " not in head:
            return start + 1, CommandResult(stderr="for: expected 'in'\n", code=2)
        var_name, values = head.split(" in ", 1)
        items = await self._expand_words(values.strip())
        idx = start + 1
        while idx < len(statements) and statements[idx].strip() != "do":
            idx += 1
        idx += 1
        body = []
        depth = 1
        while idx < len(statements):
            token = statements[idx].strip()
            if token.startswith("for ") or token.startswith("while "):
                depth += 1
            if token == "done":
                depth -= 1
                if depth == 0:
                    break
            body.append(statements[idx])
            idx += 1
        result = CommandResult(code=0)
        for item in items:
            self.env[var_name.strip()] = item
            self._sync_env()
            result = await self.execute_text("\n".join(body))
            if result.code != 0:
                break
        return idx + 1, result

    async def _execute_while_block(self, statements, start, stdin_text):
        cond_stmt = statements[start][5:].strip()
        idx = start + 1
        while idx < len(statements) and statements[idx].strip() != "do":
            cond_stmt = f"{cond_stmt}; {statements[idx]}".strip("; ")
            idx += 1
        idx += 1
        body = []
        depth = 1
        while idx < len(statements):
            token = statements[idx].strip()
            if token.startswith("while "):
                depth += 1
            if token == "done":
                depth -= 1
                if depth == 0:
                    break
            body.append(statements[idx])
            idx += 1
        result = CommandResult(code=0)
        guard = 0
        while guard < 10000:
            guard += 1
            cond = await self._execute_compound(cond_stmt, stdin_text=stdin_text)
            if cond.code != 0:
                break
            result = await self.execute_text("\n".join(body))
            if result.code != 0:
                break
        return idx + 1, result

    async def _execute_case_block(self, statements, start, stdin_text):
        head = statements[start][4:].strip()
        word = await self._expand_text(head.split(" in", 1)[0].strip()) if " in" in head else await self._expand_text(head)
        idx = start + 1
        patterns = []
        current_pattern = None
        current_body = []
        while idx < len(statements):
            token = statements[idx].strip()
            if token == "esac":
                if current_pattern is not None:
                    patterns.append((current_pattern, current_body))
                break
            if token.endswith(")") and not token.startswith(";;"):
                if current_pattern is not None:
                    patterns.append((current_pattern, current_body))
                current_pattern = token[:-1].strip()
                current_body = []
            elif token == ";;":
                if current_pattern is not None:
                    patterns.append((current_pattern, current_body))
                    current_pattern = None
                    current_body = []
            else:
                current_body.append(statements[idx])
            idx += 1
        result = CommandResult(code=0)
        for pattern, body in patterns:
            for part in pattern.split("|"):
                if fnmatch.fnmatch(word, part.strip()):
                    result = await self.execute_text("\n".join(body)) if body else CommandResult(code=0)
                    return idx + 1, result
        return idx + 1, result

    async def _execute_compound(self, text, stdin_text=""):
        segments = self._split_logical(text)
        result = CommandResult(code=0)
        stdout_parts = []
        stderr_parts = []
        i = 0
        while i < len(segments):
            op, segment = segments[i]
            if op == "&&" and result.code != 0:
                i += 1
                continue
            if op == "||" and result.code == 0:
                i += 1
                continue
            if op == "&":
                job_id = self.next_job_id
                self.next_job_id += 1
                self.jobs[job_id] = asyncio.create_task(self._execute_pipeline(segment, stdin_text=stdin_text))
                result = CommandResult(stdout=f"[{job_id}] {segment}\n", code=0)
                stdout_parts.append(result.stdout)
                stderr_parts.append(result.stderr)
                i += 1
                continue
            result = await self._execute_pipeline(segment, stdin_text=stdin_text)
            stdout_parts.append(result.stdout)
            stderr_parts.append(result.stderr)
            stdin_text = ""
            i += 1
        return CommandResult(stdout="".join(stdout_parts), stderr="".join(stderr_parts), code=result.code)

    def _split_logical(self, text):
        parts = []
        current = []
        quote = None
        depth = 0
        cmdsub = 0
        op_for_next = None
        i = 0
        while i < len(text):
            ch = text[i]
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if quote:
                current.append(ch)
                if ch == quote:
                    quote = None
                elif ch == "\\" and quote == '"' and nxt:
                    current.append(nxt)
                    i += 1
                i += 1
                continue
            if ch in {"'", '"'}:
                quote = ch
                current.append(ch)
                i += 1
                continue
            if ch == "$" and nxt == "(":
                cmdsub += 1
                current.extend([ch, nxt])
                i += 2
                continue
            if ch == "(" and cmdsub == 0:
                depth += 1
                current.append(ch)
                i += 1
                continue
            if ch == ")" and cmdsub == 0 and depth > 0:
                depth -= 1
                current.append(ch)
                i += 1
                continue
            if ch == ")" and cmdsub > 0:
                cmdsub -= 1
                current.append(ch)
                i += 1
                continue
            if depth == 0 and cmdsub == 0:
                two = ch + nxt
                if two in {"&&", "||"}:
                    segment = "".join(current).strip()
                    if segment:
                        parts.append((op_for_next, segment))
                    current = []
                    op_for_next = two
                    i += 2
                    continue
                if ch in {";", "&"}:
                    segment = "".join(current).strip()
                    if segment:
                        parts.append((op_for_next, segment))
                    current = []
                    op_for_next = ch
                    i += 1
                    continue
            current.append(ch)
            i += 1
        segment = "".join(current).strip()
        if segment:
            parts.append((op_for_next, segment))
        return parts

    async def _execute_pipeline(self, text, stdin_text=""):
        stages = self._split_pipes(text)
        result = CommandResult(code=0)
        current_in = stdin_text
        for index, stage in enumerate(stages):
            result = await self._execute_stage(stage, stdin_text=current_in)
            current_in = result.stdout
            if result.code != 0 and index < len(stages) - 1:
                break
        return result

    def _split_pipes(self, text):
        stages = []
        current = []
        quote = None
        depth = 0
        cmdsub = 0
        i = 0
        while i < len(text):
            ch = text[i]
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if quote:
                current.append(ch)
                if ch == quote:
                    quote = None
                elif ch == "\\" and quote == '"' and nxt:
                    current.append(nxt)
                    i += 1
                i += 1
                continue
            if ch in {"'", '"'}:
                quote = ch
                current.append(ch)
                i += 1
                continue
            if ch == "$" and nxt == "(":
                cmdsub += 1
                current.extend([ch, nxt])
                i += 2
                continue
            if ch == "(" and cmdsub == 0:
                depth += 1
                current.append(ch)
                i += 1
                continue
            if ch == ")" and cmdsub == 0 and depth > 0:
                depth -= 1
                current.append(ch)
                i += 1
                continue
            if ch == ")" and cmdsub > 0:
                cmdsub -= 1
                current.append(ch)
                i += 1
                continue
            if ch == "|" and nxt != "|" and depth == 0 and cmdsub == 0:
                stages.append("".join(current).strip())
                current = []
                i += 1
                continue
            current.append(ch)
            i += 1
        segment = "".join(current).strip()
        if segment:
            stages.append(segment)
        return stages

    async def _execute_stage(self, text, stdin_text=""):
        stripped = text.strip()
        if stripped.startswith("(") and stripped.endswith(")") and self._balanced_group(stripped):
            inner = stripped[1:-1]
            old_env = dict(self.env)
            old_aliases = dict(self.aliases)
            old_cwd = os.getcwd()
            old_logical_cwd = self.logical_cwd
            try:
                result = await self.execute_text(inner, stdin_text=stdin_text)
            finally:
                self.env = old_env
                self.aliases = old_aliases
                os.chdir(old_cwd)
                self.logical_cwd = old_logical_cwd
                self._sync_env()
            return result
        parsed = await self._parse_command(stripped)
        return await self._execute_parsed(parsed, stdin_text=stdin_text)

    def _balanced_group(self, text):
        depth = 0
        quote = None
        for i, ch in enumerate(text):
            if quote:
                if ch == quote:
                    quote = None
                continue
            if ch in {"'", '"'}:
                quote = ch
                continue
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0 and i != len(text) - 1:
                    return False
        return depth == 0

    async def _parse_command(self, text):
        tokens = []
        redirects = []
        current = []
        quoted = False
        pending_redirect = None
        i = 0
        while i < len(text):
            ch = text[i]
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if ch.isspace():
                if current:
                    words = await self._finalize_word("".join(current), quoted)
                    if pending_redirect:
                        if not words:
                            raise RuntimeError(f"redirection {pending_redirect} requires a file")
                        redirects.append((pending_redirect, words[0]))
                        tokens.extend(words[1:])
                        pending_redirect = None
                    else:
                        tokens.extend(words)
                    current = []
                    quoted = False
                i += 1
                continue
            if text.startswith("2>", i):
                if current:
                    words = await self._finalize_word("".join(current), quoted)
                    if pending_redirect:
                        if not words:
                            raise RuntimeError(f"redirection {pending_redirect} requires a file")
                        redirects.append((pending_redirect, words[0]))
                        tokens.extend(words[1:])
                        pending_redirect = None
                    else:
                        tokens.extend(words)
                    current = []
                    quoted = False
                pending_redirect = "2>"
                i += 2
                continue
            if text.startswith("&>", i):
                if current:
                    words = await self._finalize_word("".join(current), quoted)
                    if pending_redirect:
                        if not words:
                            raise RuntimeError(f"redirection {pending_redirect} requires a file")
                        redirects.append((pending_redirect, words[0]))
                        tokens.extend(words[1:])
                        pending_redirect = None
                    else:
                        tokens.extend(words)
                    current = []
                    quoted = False
                pending_redirect = "&>"
                i += 2
                continue
            if text.startswith(">>", i):
                if current:
                    words = await self._finalize_word("".join(current), quoted)
                    if pending_redirect:
                        if not words:
                            raise RuntimeError(f"redirection {pending_redirect} requires a file")
                        redirects.append((pending_redirect, words[0]))
                        tokens.extend(words[1:])
                        pending_redirect = None
                    else:
                        tokens.extend(words)
                    current = []
                    quoted = False
                pending_redirect = ">>"
                i += 2
                continue
            if ch in {">", "<"}:
                if current:
                    words = await self._finalize_word("".join(current), quoted)
                    if pending_redirect:
                        if not words:
                            raise RuntimeError(f"redirection {pending_redirect} requires a file")
                        redirects.append((pending_redirect, words[0]))
                        tokens.extend(words[1:])
                        pending_redirect = None
                    else:
                        tokens.extend(words)
                    current = []
                    quoted = False
                pending_redirect = ch
                i += 1
                continue
            if ch == "'":
                end = text.find("'", i + 1)
                if end == -1:
                    raise RuntimeError("unterminated single quote")
                current.append(text[i + 1 : end])
                quoted = True
                i = end + 1
                continue
            if ch == '"':
                end, expanded = await self._consume_double_quoted(text, i + 1)
                current.append(expanded)
                quoted = True
                i = end
                continue
            if ch == "\\":
                if i + 1 < len(text):
                    current.append(text[i + 1])
                    i += 2
                else:
                    i += 1
                continue
            expanded, i = await self._consume_unquoted(text, i)
            current.append(expanded)
        if current:
            words = await self._finalize_word("".join(current), quoted)
            if pending_redirect:
                if not words:
                    raise RuntimeError(f"redirection {pending_redirect} requires a file")
                redirects.append((pending_redirect, words[0]))
                tokens.extend(words[1:])
                pending_redirect = None
            else:
                tokens.extend(words)
        if pending_redirect:
            raise RuntimeError(f"redirection {pending_redirect} requires a file")

        argv = self._expand_aliases(tokens)
        assignments = {}
        while argv and self._is_assignment(argv[0]):
            key, value = argv.pop(0).split("=", 1)
            assignments[key] = value
        argv = self._expand_aliases(argv)
        return ParsedCommand(argv=argv, redirects=redirects, assignments=assignments)

    def _is_assignment(self, token):
        return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_]*=.*$", token))

    async def _consume_double_quoted(self, text, start):
        current = []
        i = start
        while i < len(text):
            ch = text[i]
            if ch == '"':
                return i + 1, "".join(current)
            if ch == "\\":
                nxt = text[i + 1] if i + 1 < len(text) else ""
                if nxt in {'"', "\\", "$"}:
                    current.append(nxt)
                    i += 2
                    continue
            if ch == "$":
                value, i = await self._consume_dollar(text, i)
                current.append(value)
                continue
            current.append(ch)
            i += 1
        raise RuntimeError("unterminated double quote")

    async def _consume_unquoted(self, text, start):
        ch = text[start]
        if ch == "~" and start == 0:
            return self.env.get("HOME", os.path.expanduser("~")), start + 1
        if ch == "$":
            return await self._consume_dollar(text, start)
        return ch, start + 1

    async def _consume_dollar(self, text, start):
        nxt = text[start + 1] if start + 1 < len(text) else ""
        if nxt == "(":
            depth = 1
            i = start + 2
            quote = None
            content = []
            while i < len(text):
                ch = text[i]
                nn = text[i + 1] if i + 1 < len(text) else ""
                if quote:
                    content.append(ch)
                    if ch == quote:
                        quote = None
                    elif ch == "\\" and quote == '"' and nn:
                        content.append(nn)
                        i += 1
                    i += 1
                    continue
                if ch in {"'", '"'}:
                    quote = ch
                    content.append(ch)
                    i += 1
                    continue
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        result = await self._execute_compound("".join(content))
                        return result.stdout.rstrip("\n"), i + 1
                content.append(ch)
                i += 1
            raise RuntimeError("unterminated command substitution")
        if nxt == "{":
            end = text.find("}", start + 2)
            if end == -1:
                raise RuntimeError("unterminated variable expansion")
            name = text[start + 2 : end]
            return self._variable_value(name), end + 1
        if nxt == "?":
            return str(self.last_status), start + 2
        match = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)", text[start:])
        if match:
            name = match.group(1)
            return self._variable_value(name), start + len(name) + 1
        return "$", start + 1

    def _variable_value(self, name):
        if name == "PWD":
            return self.logical_cwd
        if name == "HOME":
            return self.env.get("HOME", "")
        return str(self.env.get(name, ""))

    async def _finalize_word(self, word, quoted):
        if not word:
            return []
        if not quoted and any(char in word for char in "*?["):
            matches = glob.glob(self._resolve_path(word))
            if matches:
                return [self._display_path(match) for match in matches]
        return [word]

    def _expand_aliases(self, argv):
        if not argv:
            return argv
        seen = set()
        current = list(argv)
        while current and current[0] in self.aliases and current[0] not in seen:
            seen.add(current[0])
            alias_words = shlex.split(self.aliases[current[0]])
            current = alias_words + current[1:]
        return current

    async def _execute_parsed(self, parsed, stdin_text=""):
        argv = parsed.argv
        if not argv and parsed.assignments:
            self.env.update(parsed.assignments)
            self._sync_env()
            return CommandResult(code=0)
        if not argv:
            return CommandResult(code=0)
        stdin_value = stdin_text
        for op, target in parsed.redirects:
            if op == "<":
                path = self._resolve_path(target)
                with open(path, "r", encoding="utf-8") as handle:
                    stdin_value = handle.read()
        saved_env = dict(self.env)
        saved_os = {key: os.environ.get(key) for key in parsed.assignments}
        if parsed.assignments:
            self.env.update(parsed.assignments)
            self._sync_env()
        try:
            result = await self._dispatch_command(argv, stdin_value)
        finally:
            if parsed.assignments:
                self.env = saved_env
                for key, value in saved_os.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
                self._sync_env()
        for op, target in parsed.redirects:
            path = self._resolve_path(target)
            if op == ">":
                self._write_file(path, result.stdout, append=False)
                result.stdout = ""
            elif op == ">>":
                self._write_file(path, result.stdout, append=True)
                result.stdout = ""
            elif op == "2>":
                self._write_file(path, result.stderr, append=False)
                result.stderr = ""
            elif op == "&>":
                self._write_file(path, result.stdout + result.stderr, append=False)
                result.stdout = ""
                result.stderr = ""
        return result

    def _write_file(self, path, data, append=False):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        mode = "a" if append else "w"
        with open(path, mode, encoding="utf-8") as handle:
            handle.write(data)

    async def _dispatch_command(self, argv, stdin_text=""):
        self._sync_env()
        cmd = argv[0]
        args = argv[1:]
        if cmd == "sqlite3" and not stdin_text and self._can_use_sqlite_repl(args):
            return await self._cmd_sqlite3_repl(args)
        if cmd == "jq" and not stdin_text and not args:
            return await self._run_external(["jq", "--help"], stdin_text)
        internal = {
            "cd": self._cmd_cd,
            "pwd": self._cmd_pwd,
            "echo": self._cmd_echo,
            "export": self._cmd_export,
            "unset": self._cmd_unset,
            "alias": self._cmd_alias,
            "unalias": self._cmd_unalias,
            "history": self._cmd_history,
            "exit": self._cmd_exit,
            "clear": self._cmd_clear,
            "source": self._cmd_source,
            ".": self._cmd_source,
            "ls": self._cmd_ls,
            "cat": self._cmd_cat,
            "grep": self._cmd_grep,
            "cp": self._cmd_cp,
            "mv": self._cmd_mv,
            "rm": self._cmd_rm,
            "mkdir": self._cmd_mkdir,
            "touch": self._cmd_touch,
            "head": self._cmd_head,
            "tail": self._cmd_tail,
            "wc": self._cmd_wc,
            "chmod": self._cmd_chmod,
            "env": self._cmd_env,
            "which": self._cmd_which,
            "sh": self._cmd_sh,
            "jobs": self._cmd_jobs,
            "fg": self._cmd_fg,
            "bg": self._cmd_bg,
            "true": self._cmd_true,
            "false": self._cmd_false,
        }
        if cmd in self.editor_commands:
            return await self._cmd_web_editor(cmd, args, stdin_text)
        if cmd in internal:
            return await internal[cmd](args, stdin_text)
        return await self._run_external(argv, stdin_text)

    def _can_use_sqlite_repl(self, args):
        if not args:
            return True
        if len(args) == 1 and not args[0].startswith("-"):
            return True
        return False

    async def _cmd_sqlite3_repl(self, args):
        db_path = None
        temp_db_path = None
        if args:
            candidate = args[0]
            if candidate == ":memory:":
                temp_db_path = self._resolve_path(f"/tmp/edgeterm-sqlite-{int(time.time() * 1000)}.db")
                db_path = temp_db_path
            else:
                db_path = self._resolve_path(candidate)
                os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        else:
            temp_db_path = self._resolve_path(f"/tmp/edgeterm-sqlite-{int(time.time() * 1000)}.db")
            db_path = temp_db_path

        print("SQLite version 3.54.0 2026-05-02 23:40:40")
        print('Enter ".help" for usage hints.')

        buffer = []
        last_code = 0
        try:
            while True:
                prompt = "sqlite> " if not buffer else "   ...> "
                try:
                    line = await self.input_func(prompt)
                except EOFError:
                    print()
                    break

                stripped = line.strip()
                if not buffer and stripped in {".exit", ".quit"}:
                    break
                if not buffer and not stripped:
                    continue
                if not buffer and stripped.startswith(".open "):
                    target = stripped[6:].strip()
                    if target == ":memory:":
                        if temp_db_path and os.path.exists(temp_db_path):
                            try:
                                os.remove(temp_db_path)
                            except OSError:
                                pass
                        temp_db_path = self._resolve_path(f"/tmp/edgeterm-sqlite-{int(time.time() * 1000)}.db")
                        db_path = temp_db_path
                    elif target:
                        db_path = self._resolve_path(target)
                        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
                    continue

                if not buffer and stripped.startswith("."):
                    result = await self._run_sqlite_batch(db_path, stripped)
                    last_code = result.code
                    self._emit_result(result)
                    continue

                buffer.append(line)
                script = "\n".join(buffer).strip()
                if not script:
                    buffer.clear()
                    continue
                if not self._sqlite_statement_complete(script):
                    continue

                result = await self._run_sqlite_batch(db_path, script)
                last_code = result.code
                self._emit_result(result)
                buffer.clear()
        finally:
            if temp_db_path and os.path.exists(temp_db_path):
                try:
                    os.remove(temp_db_path)
                except OSError:
                    pass
        return CommandResult(code=last_code)

    def _sqlite_statement_complete(self, script):
        stripped = script.rstrip()
        if not stripped:
            return False
        if stripped.startswith("."):
            return True
        return stripped.endswith(";")

    async def _run_sqlite_batch(self, db_path, script):
        wasm_result = await run_wasm_command("sqlite3", [db_path, script], "", self.logical_cwd, self.env)
        return CommandResult(
            stdout=wasm_result.get("stdout", ""),
            stderr=wasm_result.get("stderr", ""),
            code=int(wasm_result.get("code", 0) or 0),
        )

    def _resolve_path(self, path):
        expanded = path.replace("~", self.env.get("HOME", "~"), 1) if path.startswith("~") else path
        base = self.logical_cwd if not expanded.startswith("/") else "/"
        return os.path.abspath(expanded if expanded.startswith("/") else os.path.join(base, expanded))

    def _split_flags(self, args):
        """Split combined short flags like -rf into a set of individual flag chars.
        Returns (flag_chars_set, non_flag_args_list)."""
        flags = set()
        leftovers = []
        for arg in args:
            if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1 and arg != "-":
                for ch in arg[1:]:
                    flags.add(ch)
            else:
                leftovers.append(arg)
        return flags, leftovers

    def _display_path(self, path):
        return self._logical_display_path(path)

    def _logical_display_path(self, path):
        path = os.path.abspath(path or "/")
        match = re.search(r"(/workspace-store/[^/]+/rootfs)(/.*)?$", path)
        if match:
            return match.group(2) or "/"
        match = re.search(r"/workspace-store/[^/]+(/home/.*)$", path)
        if match:
            return match.group(1) or "/"
        return path

    async def _cmd_cd(self, args, stdin_text):
        if args and args[0] == "-":
            target = self.env.get("OLDPWD", self.env.get("HOME", "/"))
        else:
            target = args[0] if args else self.env.get("HOME", "/")
        path = self._resolve_path(target)
        if not os.path.isdir(path):
            return CommandResult(stderr=f"cd: {target}: No such file or directory\n", code=1)
        old = self.logical_cwd
        os.chdir(path)
        self.env["OLDPWD"] = old
        output = ""
        if args and args[0] == "-":
            output = self._logical_display_path(path) + "\n"
        if target.startswith("/"):
            self.logical_cwd = os.path.abspath(target)
        else:
            self.logical_cwd = self._logical_display_path(os.path.abspath(os.path.join(old, target)))
        if self.logical_cwd != "/" and self.logical_cwd.endswith("/"):
            self.logical_cwd = self.logical_cwd.rstrip("/")
        self._sync_env()
        return CommandResult(stdout=output, code=0)

    async def _cmd_pwd(self, args, stdin_text):
        return CommandResult(stdout=self.logical_cwd + "\n")

    def _interpret_echo_escapes(self, text):
        """Interpret backslash escape sequences for echo -e."""
        result = []
        i = 0
        while i < len(text):
            if text[i] == "\\" and i + 1 < len(text):
                ch = text[i + 1]
                esc_map = {
                    "n": "\n", "t": "\t", "r": "\r", "\\": "\\",
                    "a": "\a", "b": "\b", "f": "\f", "v": "\v", "e": "\033",
                }
                if ch in esc_map:
                    result.append(esc_map[ch])
                    i += 2
                elif ch == "0":
                    j = i + 2
                    octal = []
                    while j < len(text) and len(octal) < 3 and text[j] in "01234567":
                        octal.append(text[j])
                        j += 1
                    if octal:
                        result.append(chr(int("".join(octal), 8)))
                        i = j - 1
                    else:
                        result.append("\0")
                        i += 1
                elif ch == "x":
                    j = i + 2
                    hx = []
                    while j < len(text) and len(hx) < 2 and text[j] in "0123456789abcdefABCDEF":
                        hx.append(text[j])
                        j += 1
                    if hx:
                        result.append(chr(int("".join(hx), 16)))
                        i = j - 1
                    else:
                        result.append("\\x")
                        i += 1
                else:
                    result.append("\\" + ch)
                    i += 2
            else:
                result.append(text[i])
                i += 1
        return "".join(result)

    async def _cmd_echo(self, args, stdin_text):
        newline = True
        interpret = False
        while args and args[0].startswith("-") and args[0] != "-" and args[0] != "--":
            flag = args[0]
            # Only consume flags that consist entirely of valid echo flag chars
            if all(c in "neE" for c in flag[1:]):
                if "n" in flag:
                    newline = False
                if "e" in flag:
                    interpret = True
                if "E" in flag:
                    interpret = False
                args = args[1:]
            else:
                break
        out = " ".join(args)
        if interpret:
            out = self._interpret_echo_escapes(out)
        return CommandResult(stdout=out + ("" if not newline else "\n"))

    async def _cmd_export(self, args, stdin_text):
        if not args:
            lines = [f"declare -x {k}={self.env[k]!r}" for k in sorted(self.env)]
            return CommandResult(stdout="\n".join(lines) + ("\n" if lines else ""))
        for arg in args:
            if "=" in arg:
                key, value = arg.split("=", 1)
                self.env[key] = value
            else:
                self.env.setdefault(arg, "")
        self._sync_env()
        return CommandResult(code=0)

    async def _cmd_unset(self, args, stdin_text):
        for key in args:
            self.env.pop(key, None)
            os.environ.pop(key, None)
        self._sync_env()
        return CommandResult(code=0)

    async def _cmd_alias(self, args, stdin_text):
        if not args:
            lines = [f"alias {name}='{value}'" for name, value in sorted(self.aliases.items())]
            return CommandResult(stdout="\n".join(lines) + ("\n" if lines else ""))
        for arg in args:
            if "=" in arg:
                name, value = arg.split("=", 1)
                self.aliases[name] = value.strip("'\"")
            else:
                value = self.aliases.get(arg)
                if value is None:
                    return CommandResult(stderr=f"alias: {arg}: not found\n", code=1)
        return CommandResult(code=0)

    async def _cmd_unalias(self, args, stdin_text):
        for name in args:
            self.aliases.pop(name, None)
        return CommandResult(code=0)

    async def _cmd_history(self, args, stdin_text):
        lines = [f"{i + 1:>5}  {line}" for i, line in enumerate(self.history)]
        return CommandResult(stdout="\n".join(lines) + ("\n" if lines else ""))

    async def _cmd_exit(self, args, stdin_text):
        raise ShellExit(int(args[0]) if args else self.last_status)

    async def _cmd_clear(self, args, stdin_text):
        try:
            js.term.clear()
        except Exception:
            pass
        return CommandResult(code=0)

    async def _cmd_source(self, args, stdin_text):
        if not args:
            return CommandResult(stderr="source: filename argument required\n", code=2)
        return await self.source_file(args[0], args[1:])

    def _format_mode(self, mode):
        kind = "d" if stat.S_ISDIR(mode) else "-"
        perms = ""
        for who in ("USR", "GRP", "OTH"):
            for what in ("R", "W", "X"):
                perms += what.lower() if mode & getattr(stat, f"S_I{what}{who}") else "-"
        return kind + perms

    def _format_bytes(self, size):
        for unit in ["B", "K", "M", "G", "T"]:
            if size < 1024:
                return f"{size:.1f}{unit}"
            size /= 1024
        return f"{size:.1f}P"

    async def _cmd_ls(self, args, stdin_text):
        flags, targets = self._split_flags(args)
        show_all = "a" in flags
        long_format = "l" in flags
        human = "h" in flags
        targets = targets or ["."]
        lines = []
        for target in targets:
            path = self._resolve_path(target)
            if not os.path.exists(path):
                return CommandResult(stderr=f"ls: cannot access '{target}': No such file or directory\n", code=1)
            if os.path.isfile(path):
                lines.append(os.path.basename(path))
                continue
            items = sorted(os.listdir(path))
            if not show_all:
                items = [item for item in items if not item.startswith(".")]
            if long_format:
                for name in items:
                    full = os.path.join(path, name)
                    st = os.stat(full)
                    size = self._format_bytes(st.st_size) if human else str(st.st_size)
                    mtime = time.strftime("%b %d %H:%M", time.localtime(st.st_mtime))
                    lines.append(f"{self._format_mode(st.st_mode)} {st.st_nlink:>2} user user {size:>8} {mtime} {name}")
            else:
                lines.append("  ".join(items))
        return CommandResult(stdout="\n".join(lines) + ("\n" if lines else ""))

    async def _cmd_cat(self, args, stdin_text):
        if not args:
            return CommandResult(stdout=stdin_text)
        out = []
        for target in args:
            path = self._resolve_path(target)
            if not os.path.exists(path):
                return CommandResult(stderr=f"cat: {target}: No such file or directory\n", code=1)
            with open(path, "r", encoding="utf-8") as handle:
                out.append(handle.read())
        return CommandResult(stdout="".join(out))

    async def _cmd_grep(self, args, stdin_text):
        flags, leftovers = self._split_flags(args)
        ignore_case = "i" in flags
        recursive = "r" in flags
        pattern = None
        files = []
        for arg in leftovers:
                files.append(arg)
        if pattern is None:
            return CommandResult(stderr="grep: pattern required\n", code=2)
        matcher = pattern.lower() if ignore_case else pattern
        hits = []
        search_files = files or []
        if not search_files:
            for line in stdin_text.splitlines():
                text = line.lower() if ignore_case else line
                if matcher in text:
                    hits.append(line)
        else:
            expanded = []
            for item in search_files:
                path = self._resolve_path(item)
                if os.path.isdir(path) and recursive:
                    for root, _, names in os.walk(path):
                        expanded.extend(os.path.join(root, name) for name in names)
                else:
                    expanded.append(path)
            for path in expanded:
                if not os.path.isfile(path):
                    continue
                with open(path, "r", encoding="utf-8", errors="ignore") as handle:
                    for line in handle.read().splitlines():
                        text = line.lower() if ignore_case else line
                        if matcher in text:
                            prefix = f"{path}:" if len(expanded) > 1 else ""
                            hits.append(prefix + line)
        return CommandResult(stdout="\n".join(hits) + ("\n" if hits else ""), code=0 if hits else 1)

    async def _cmd_cp(self, args, stdin_text):
        flags, paths = self._split_flags(args)
        recursive = "r" in flags or "R" in flags
        force = "f" in flags
        if len(paths) < 2:
            return CommandResult(stderr="cp: missing file operand\n", code=1)
        *sources, dest = [self._resolve_path(path) for path in paths]
        dest_is_dir = os.path.isdir(dest)
        for source in sources:
            if os.path.isdir(source):
                if not recursive:
                    return CommandResult(stderr=f"cp: -r not specified; omitting directory '{source}'\n", code=1)
                target = os.path.join(dest, os.path.basename(source)) if dest_is_dir else dest
                if force and os.path.exists(target):
                    shutil.rmtree(target)
                shutil.copytree(source, target, dirs_exist_ok=True)
            else:
                target = os.path.join(dest, os.path.basename(source)) if dest_is_dir else dest
                os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
                shutil.copy2(source, target)
        return CommandResult(code=0)

    async def _cmd_mv(self, args, stdin_text):
        _flags, paths = self._split_flags(args)
        if len(paths) < 2:
            return CommandResult(stderr="mv: missing file operand\n", code=1)
        *sources, dest = [self._resolve_path(path) for path in paths]
        dest_is_dir = os.path.isdir(dest)
        for source in sources:
            target = os.path.join(dest, os.path.basename(source)) if dest_is_dir else dest
            os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
            shutil.move(source, target)
        return CommandResult(code=0)

    async def _cmd_rm(self, args, stdin_text):
        flags, paths = self._split_flags(args)
        recursive = "r" in flags or "R" in flags
        force = "f" in flags
        if not paths:
            return CommandResult(stderr="rm: missing operand\n", code=1)
        for item in paths:
            path = self._resolve_path(item)
            if not os.path.exists(path):
                if not force:
                    return CommandResult(stderr=f"rm: cannot remove '{item}': No such file or directory\n", code=1)
                continue
            if os.path.isdir(path):
                if not recursive:
                    return CommandResult(stderr=f"rm: cannot remove '{item}': Is a directory\n", code=1)
                shutil.rmtree(path)
            else:
                os.remove(path)
        return CommandResult(code=0)

    async def _cmd_mkdir(self, args, stdin_text):
        flags, paths = self._split_flags(args)
        parents = "p" in flags
        if not paths:
            return CommandResult(stderr="mkdir: missing operand\n", code=1)
        for item in paths:
            path = self._resolve_path(item)
            if parents:
                os.makedirs(path, exist_ok=True)
            else:
                os.mkdir(path)
        return CommandResult(code=0)

    async def _cmd_touch(self, args, stdin_text):
        flags, paths = self._split_flags(args)
        no_create = "c" in flags
        if not paths:
            return CommandResult(stderr="touch: missing file operand\n", code=1)
        now = time.time()
        for item in paths:
            path = self._resolve_path(item)
            if not os.path.exists(path):
                if no_create:
                    continue
                os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "a", encoding="utf-8"):
                os.utime(path, (now, now))
        return CommandResult(code=0)

    async def _cmd_head(self, args, stdin_text):
        count = 10
        files = []
        i = 0
        while i < len(args):
            if args[i] == "-n" and i + 1 < len(args):
                count = int(args[i + 1])
                i += 2
            else:
                files.append(args[i])
                i += 1
        lines = stdin_text.splitlines() if not files else []
        if files:
            for item in files:
                with open(self._resolve_path(item), "r", encoding="utf-8") as handle:
                    lines.extend(handle.read().splitlines())
        return CommandResult(stdout="\n".join(lines[:count]) + ("\n" if lines[:count] else ""))

    async def _cmd_tail(self, args, stdin_text):
        count = 10
        files = []
        i = 0
        while i < len(args):
            if args[i] == "-n" and i + 1 < len(args):
                count = int(args[i + 1])
                i += 2
            else:
                files.append(args[i])
                i += 1
        lines = stdin_text.splitlines() if not files else []
        if files:
            for item in files:
                with open(self._resolve_path(item), "r", encoding="utf-8") as handle:
                    lines.extend(handle.read().splitlines())
        out = lines[-count:]
        return CommandResult(stdout="\n".join(out) + ("\n" if out else ""))

    async def _cmd_wc(self, args, stdin_text):
        text = stdin_text
        label = ""
        if args:
            path = self._resolve_path(args[0])
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
            label = f" {args[0]}"
        lines = len(text.splitlines())
        words = len(text.split())
        bytes_len = len(text.encode("utf-8"))
        return CommandResult(stdout=f"{lines:>8} {words:>8} {bytes_len:>8}{label}\n")

    def _parse_symbolic_mode(self, mode_spec, current_mode):
        """Parse a symbolic mode string like 'u+x', 'go-w', 'a+r', '+x', 'ug=rwx'.
        Returns the new mode integer, or None if the spec is invalid."""
        perm_bits = {"r": 4, "w": 2, "x": 1, "X": 1, "s": 0, "t": 0}

        clauses = []
        i = 0
        s = mode_spec
        while i < len(s):
            # collect who characters
            who = ""
            while i < len(s) and s[i] in "ugoa":
                who += s[i]
                i += 1
            if not who:
                who = "a"  # default: all
            if i >= len(s) or s[i] not in "+-=":
                return None  # invalid symbolic mode
            op = s[i]
            i += 1
            perms = ""
            while i < len(s) and s[i] in "rwxXst":
                perms += s[i]
                i += 1
            if not perms and op != "=":
                return None
            # allow trailing commas between clauses
            if i < len(s) and s[i] == ",":
                i += 1
            clauses.append((who, op, perms))

        new_mode = current_mode
        for who_str, op, perms in clauses:
            # compute the mask of affected who bits
            who_mask = 0
            if "a" in who_str:
                who_mask = stat.S_IRWXU | stat.S_IRWXG | stat.S_IRWXO
            else:
                if "u" in who_str:
                    who_mask |= stat.S_IRWXU
                if "g" in who_str:
                    who_mask |= stat.S_IRWXG
                if "o" in who_str:
                    who_mask |= stat.S_IRWXO

            # compute permission bits from rwx
            perm_val = 0
            for ch in perms:
                if ch in ("s", "t"):
                    # setuid/setgid/sticky — approximate: setuid maps to S_ISUID, etc.
                    if ch == "s" and ("u" in who_str or "a" in who_str):
                        who_mask |= stat.S_ISUID
                    if ch == "s" and ("g" in who_str or "a" in who_str):
                        who_mask |= stat.S_ISGID
                    if ch == "t":
                        who_mask |= stat.S_ISVTX
                else:
                    bit = perm_bits.get(ch, 0)
                    # spread the bit across the relevant who slots
                    if who_mask & stat.S_IRWXU:
                        perm_val |= (bit << 6) if "u" in who_str or "a" in who_str else 0
                    if who_mask & stat.S_IRWXG:
                        perm_val |= (bit << 3) if "g" in who_str or "a" in who_str else 0
                    if who_mask & stat.S_IRWXO:
                        perm_val |= bit if "o" in who_str or "a" in who_str else 0

            if op == "+":
                new_mode |= perm_val
            elif op == "-":
                new_mode &= ~perm_val
            elif op == "=":
                # clear the who bits then set
                clear_mask = who_mask & (stat.S_IRWXU | stat.S_IRWXG | stat.S_IRWXO)
                new_mode &= ~clear_mask
                new_mode |= perm_val

        return new_mode

    async def _cmd_chmod(self, args, stdin_text):
        if len(args) < 2:
            return CommandResult(stderr="chmod: missing operand\n", code=1)
        mode_spec = args[0]
        target = self._resolve_path(args[1])
        if not os.path.exists(target):
            return CommandResult(stderr=f"chmod: cannot access '{args[1]}': No such file or directory\n", code=1)
        try:
            # Try octal first (e.g., 755, 644, 777)
            mode = int(mode_spec, 8)
        except ValueError:
            # Try symbolic mode (e.g., u+x, go-w, a+r)
            try:
                current_mode = os.stat(target).st_mode
                mode = self._parse_symbolic_mode(mode_spec, current_mode)
                if mode is None:
                    return CommandResult(stderr=f"chmod: invalid mode: '{mode_spec}'\n", code=1)
            except OSError as exc:
                return CommandResult(stderr=f"chmod: cannot stat '{args[1]}': {exc}\n", code=1)
        try:
            os.chmod(target, mode)
        except OSError:
            return CommandResult(
                stderr=f"chmod: changing permissions of '{args[1]}': Operation not supported on this filesystem\n",
                code=1,
            )
        return CommandResult(code=0)

    async def _cmd_env(self, args, stdin_text):
        lines = [f"{key}={value}" for key, value in sorted(self.env.items())]
        return CommandResult(stdout="\n".join(lines) + ("\n" if lines else ""))

    async def _cmd_which(self, args, stdin_text):
        if not args:
            return CommandResult(stderr="which: missing operand\n", code=1)
        hits = []
        builtins = {
            "cd",
            "pwd",
            "echo",
            "export",
            "unset",
            "alias",
            "unalias",
            "history",
            "exit",
            "clear",
            "source",
            ".",
            "ls",
            "cat",
            "grep",
            "cp",
            "mv",
            "rm",
            "mkdir",
            "touch",
            "head",
            "tail",
            "wc",
            "chmod",
            "env",
            "which",
            "sh",
            "jobs",
            "fg",
            "bg",
            "true",
            "false",
            "nano",
            "vi",
            "vim",
            "code",
        }
        for name in args:
            if name in builtins:
                hits.append(f"{name}: shell built-in")
                continue
            for path in self.command_paths:
                candidate = os.path.join(path, f"{name}.py")
                if os.path.isfile(candidate):
                    hits.append(candidate)
                    break
            else:
                wasm_hit = which_wasm_command(name)
                if wasm_hit:
                    hits.append(wasm_hit)
                elif name in self.aliases:
                    hits.append(f"{name}: aliased to {self.aliases[name]}")
        return CommandResult(stdout="\n".join(hits) + ("\n" if hits else ""), code=0 if hits else 1)

    async def _cmd_sh(self, args, stdin_text):
        if not args:
            await self.interactive()
            return CommandResult(code=self.last_status)
        try:
            return await self.run_script_file(args[0], args[1:])
        except ShellExit as exc:
            return CommandResult(code=exc.code)

    async def _cmd_jobs(self, args, stdin_text):
        lines = []
        for job_id, task in sorted(self.jobs.items()):
            state = "running" if not task.done() else "done"
            lines.append(f"[{job_id}] {state}")
        return CommandResult(stdout="\n".join(lines) + ("\n" if lines else ""))

    async def _cmd_fg(self, args, stdin_text):
        return CommandResult(stderr="fg: real job control is not available in EdgeTerm\n", code=1)

    async def _cmd_bg(self, args, stdin_text):
        return CommandResult(stderr="bg: real job control is not available in EdgeTerm\n", code=1)

    async def _cmd_true(self, args, stdin_text):
        return CommandResult(code=0)

    async def _cmd_false(self, args, stdin_text):
        return CommandResult(code=1)

    async def _cmd_web_editor(self, cmd, args, stdin_text):
        target = self._editor_target_from_args(args)
        if target:
            path = self._resolve_path(target)
            display_path = self._display_path(path)
            if os.path.isdir(path):
                return CommandResult(stderr=f"{cmd}: {target}: Is a directory\n", code=1)
        else:
            display_path = ""
        try:
            editor_bridge = js.window.EdgeTermEditor
            opened = await editor_bridge.open(display_path)
            label = str(opened or display_path or "editor")
            return CommandResult(stdout=f"Opened {label} in the web editor.\n", code=0)
        except Exception as exc:
            return CommandResult(stderr=f"{cmd}: failed to open web editor: {exc}\n", code=1)

    def _editor_target_from_args(self, args):
        for arg in args:
            if not arg:
                continue
            if arg == "--":
                continue
            if arg.startswith("+"):
                continue
            if arg.startswith("-"):
                continue
            return arg
        return ""

    async def _run_external(self, argv, stdin_text):
        cmd = argv[0]
        args = argv[1:]
        if "/" in cmd or cmd.startswith("."):
            path = self._resolve_path(cmd)
            if os.path.isfile(path):
                return await self._run_script_or_file(path, args, stdin_text)
        for directory in self.command_paths:
            applet = os.path.join(directory, f"{cmd}.py")
            if os.path.isfile(applet):
                return await self._run_applet(applet, cmd, args, stdin_text)
        try:
            wasm_result = await run_wasm_command(cmd, args, stdin_text, self.logical_cwd, self.env)
            if wasm_result.get("found"):
                return CommandResult(
                    stdout=wasm_result.get("stdout", ""),
                    stderr=wasm_result.get("stderr", ""),
                    code=int(wasm_result.get("code", 0) or 0),
                )
        except Exception as exc:
            return CommandResult(stderr=f"{cmd}: {exc}\n", code=1)
        return CommandResult(stderr=f"{cmd}: command not found\n", code=127)

    async def _run_script_or_file(self, path, args, stdin_text):
        wasm_command = resolve_wasm_command_path(path)
        if wasm_command:
            wasm_result = await run_wasm_command(wasm_command, args, stdin_text, self.logical_cwd, self.env)
            return CommandResult(
                stdout=wasm_result.get("stdout", ""),
                stderr=wasm_result.get("stderr", ""),
                code=int(wasm_result.get("code", 0) or 0),
            )
        try:
            with open(path, "r", encoding="utf-8") as handle:
                first = handle.readline()
        except Exception:
            first = ""
        if first.startswith("#!"):
            shebang = first[2:].strip()
            if "python" in shebang:
                return await self._run_python_script(path, args, stdin_text)
            if any(shell_name in shebang for shell_name in ("sh", "bash", "ash")):
                try:
                    return await self.run_script_file(path, args)
                except ShellExit as exc:
                    return CommandResult(code=exc.code)
            return CommandResult(stderr=f"{path}: unsupported interpreter '{shebang}' in EdgeTerm\n", code=126)
        if path.endswith(".sh"):
            try:
                return await self.run_script_file(path, args)
            except ShellExit as exc:
                return CommandResult(code=exc.code)
        if path.endswith(".py"):
            return await self._run_python_script(path, args, stdin_text)
        return CommandResult(stderr=f"{path}: cannot execute file in EdgeTerm\n", code=126)

    async def _run_python_script(self, path, args, stdin_text):
        python_applet = os.path.join("/bin/bigbox", "python.py")
        return await self._run_applet(python_applet, "python", [path, *args], stdin_text)

    async def _run_applet(self, applet_path, cmd_name, args, stdin_text):
        stdout_buffer = io.StringIO()
        stderr_buffer = io.StringIO()
        old_stdin = sys.stdin
        old_argv = list(sys.argv)
        old_path = list(sys.path)
        self._sync_env()
        # Only replace stdin when there is piped/stdin text.  For
        # interactive commands (no stdin piped), keep the real stdin
        # so that input() / readline() can read from the terminal.
        if stdin_text:
            sys.stdin = io.StringIO(stdin_text)
        # Bigbox applets import each other (e.g. gunzip imports gzip).
        # Add /bin/bigbox to sys.path ONLY during module load so top-level
        # imports resolve, then remove it before main() so user code never
        # sees /bin/bigbox on sys.path and stdlib modules (gzip, json, etc.)
        # are never shadowed.
        applet_dir = os.path.dirname(os.path.abspath(applet_path))
        path_had_applet_dir = applet_dir in sys.path
        if not path_had_applet_dir:
            sys.path.insert(0, applet_dir)
        try:
            sys.argv = [cmd_name, *args]
            mod = self._applet_modules.get(applet_path)
            with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
                if mod is None:
                    spec = importlib.util.spec_from_file_location(f"bigbox.{cmd_name}", applet_path)
                    mod = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(mod)
                    self._applet_modules[applet_path] = mod
                # Module is loaded; cross-applet imports are cached in
                # sys.modules. Remove /bin/bigbox from sys.path before
                # calling main() so user code cannot import from here and
                # stdlib modules (gzip, json, etc.) are never shadowed.
                if not path_had_applet_dir:
                    sys.path.pop(0)
                if hasattr(mod, "main"):
                    result = mod.main(args)
                    if hasattr(result, "__await__"):
                        result = await result
                    code = result if isinstance(result, int) else 0
                else:
                    code = 0
            return CommandResult(stdout=stdout_buffer.getvalue(), stderr=stderr_buffer.getvalue(), code=code)
        except ShellExit as exc:
            return CommandResult(stdout=stdout_buffer.getvalue(), stderr=stderr_buffer.getvalue(), code=exc.code)
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
            return CommandResult(stdout=stdout_buffer.getvalue(), stderr=stderr_buffer.getvalue(), code=code)
        except Exception as exc:
            return CommandResult(stdout=stdout_buffer.getvalue(), stderr=stderr_buffer.getvalue() + f"{cmd_name}: error: {exc}\n", code=1)
        finally:
            sys.stdin = old_stdin
            sys.argv = old_argv
            sys.path[:] = old_path
            self._sync_env()
