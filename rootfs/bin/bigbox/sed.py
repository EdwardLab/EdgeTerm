#!/usr/bin/env python3
"""
sed.py - A stream editor implementation.

Usage: sed [OPTION]... [SCRIPT] [FILE]...
   or: sed [OPTION]... -f SCRIPTFILE [FILE]...

A self-contained Python module with ``def main(args)``.
"""

import os
import re
import sys
import shutil

# ---------------------------------------------------------------------------
# Help & version
# ---------------------------------------------------------------------------

VERSION = "1.0.0 (edgeos-sed)"

HELP_TEXT = """\
Usage: sed [OPTION]... [SCRIPT] [FILE]... or sed [OPTION]... -f SCRIPTFILE [FILE]...

Stream editor.  Operates on the contents of FILE(s) or standard input.

Options:
  -n, --quiet, --silent     suppress automatic printing of pattern space
  -e SCRIPT, --expression=SCRIPT
                             add the script to the commands to be executed
  -f SCRIPTFILE, --file=SCRIPTFILE
                             add the contents of SCRIPTFILE to the commands
  -i[SUFFIX], --in-place[=SUFFIX]
                             edit files in place (makes backup if SUFFIX supplied)
  -E, -r, --regex-extended  use extended regular expressions
  -s, --separate            treat files as separate rather than a single continuous
                             stream
      --help                display this help and exit
      --version             output version information and exit

Script commands (addresses may be line numbers, $, /pattern/, or ranges):
  s/pattern/replacement/flags   substitute (g=global, i=case-insensitive,
                                   p=print, NUMBER=occurrence)
  d                             delete pattern space
  p                             print pattern space
  a TEXT                        append TEXT after the line
  i TEXT                        insert TEXT before the line
  c TEXT                        change (replace) the line with TEXT
  =                             print current line number
  q                             quit without further processing
  y/source/dest/                transliterate characters
  n                             read next line into pattern space
  N                             append next line to pattern space
  { cmd1; cmd2; ... }           command group

Addresses:
  NUMBER                        line number
  $                             last line
  /regex/                       regular expression pattern
  addr1,addr2                   range of addresses
  !                             negate the address

Character classes in regex: \\d \\w \\s \\D \\W \\S
"""

# ---------------------------------------------------------------------------
# Character class expansion  (exposed here so both address and s/// reuse it)
# ---------------------------------------------------------------------------

_CLASS_MAP = {
    'd': r'[0-9]',
    'w': r'[a-zA-Z0-9_]',
    's': r'[ \t\r\n\f\v]',
    'D': r'[^0-9]',
    'W': r'[^a-zA-Z0-9_]',
    'S': r'[^ \t\r\n\f\v]',
}


def _expand_classes(pattern):
    """Replace \\d, \\w, \\s, \\D, \\W, \\S with real character classes."""
    result = []
    i = 0
    while i < len(pattern):
        if pattern[i] == '\\' and i + 1 < len(pattern) and pattern[i + 1] in _CLASS_MAP:
            result.append(_CLASS_MAP[pattern[i + 1]])
            i += 2
        else:
            result.append(pattern[i])
            i += 1
    return ''.join(result)


# ---------------------------------------------------------------------------
# command-line parsing
# ---------------------------------------------------------------------------

class _SedOptions:
    def __init__(self):
        self.scripts = []
        self.script_files = []
        self.in_place = None  # None = no -i, '' = -i (no suffix), str = -iSUFFIX
        self.n_flag = False
        self.extended_regex = False  # -E / -r
        self.separate = False  # -s


def _parse_args(argv):
    opts = _SedOptions()
    positional = []
    i = 1
    while i < len(argv):
        arg = argv[i]

        if arg == '--help':
            sys.stdout.write(HELP_TEXT)
            sys.exit(0)
        if arg == '--version':
            sys.stdout.write(f"sed.py {VERSION}\n")
            sys.exit(0)

        if arg in ('--quiet', '--silent'):
            opts.n_flag = True
            i += 1
            continue
        if arg == '-n':
            opts.n_flag = True
            i += 1
            continue

        if arg == '-e':
            i += 1
            if i >= len(argv):
                sys.stderr.write("sed: -e: no script argument\n")
                sys.exit(2)
            opts.scripts.append(argv[i])
            i += 1
            continue
        if arg.startswith('--expression='):
            opts.scripts.append(arg[len('--expression='):])
            i += 1
            continue

        if arg == '-f':
            i += 1
            if i >= len(argv):
                sys.stderr.write("sed: -f: no file argument\n")
                sys.exit(2)
            opts.script_files.append(argv[i])
            i += 1
            continue
        if arg.startswith('--file='):
            opts.script_files.append(arg[len('--file='):])
            i += 1
            continue

        if arg == '-i' or arg.startswith('-i'):
            opts.in_place = arg[2:] if arg != '-i' else ''
            i += 1
            continue
        if arg == '--in-place':
            opts.in_place = ''
            i += 1
            continue
        if arg.startswith('--in-place='):
            opts.in_place = arg[len('--in-place='):]
            i += 1
            continue

        if arg in ('-E', '-r', '--regex-extended'):
            opts.extended_regex = True
            i += 1
            continue

        if arg in ('-s', '--separate'):
            opts.separate = True
            i += 1
            continue

        if arg.startswith('-') and arg != '-' and not arg.startswith('--'):
            sys.stderr.write(f"sed: unknown option: {arg}\n")
            sys.exit(2)

        positional.append(arg)
        i += 1

    # Grab script from first positional arg if none via -e/-f
    if not opts.scripts and not opts.script_files:
        if positional:
            opts.scripts.append(positional.pop(0))
        else:
            sys.stderr.write("sed: no script or -f given\n")
            sys.exit(2)

    for path in opts.script_files:
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                opts.scripts.append(fh.read())
        except OSError as e:
            sys.stderr.write(f"sed: cannot open {path}: {e}\n")
            sys.exit(2)

    return opts, positional


# ---------------------------------------------------------------------------
# Script parsing  --  turns script text into a list of command objects
# ---------------------------------------------------------------------------

class _Cmd:
    """A single sed command with addresses and metadata."""
    __slots__ = ('addr_start', 'addr_end', 'negate', 'op', 'args')

    def __init__(self):
        self.addr_start = None   # int, '$', str (regex), or None
        self.addr_end = None
        self.negate = False
        self.op = ''             # 's', 'd', 'p', 'a', 'i', 'c', '=', 'q', 'y', 'n', 'N', '{'
        self.args = None         # varies by op


# -- lexical helpers --------------------------------------------------------

class _Lexer:
    """Split a sed-script string into tokens, respecting delimiters."""

    def __init__(self, text):
        self.text = text
        self.pos = 0
        self.len = len(text)

    def done(self):
        return self.pos >= self.len

    def peek(self):
        if self.done():
            return ''
        return self.text[self.pos]

    def next(self):
        if self.done():
            return ''
        ch = self.text[self.pos]
        self.pos += 1
        return ch

    def skip_ws(self):
        while not self.done() and self.peek() in (' ', '\t'):
            self.pos += 1

    def skip_comment(self):
        """Skip from # to end of line."""
        while not self.done() and self.peek() not in ('\n', '\r'):
            self.pos += 1

    def read_until(self, chars, include_delim=True):
        """Read characters until one from *chars* is seen.
        Returns (text_read, delimiter_char).
        Handles backslash escapes.
        """
        buf = []
        while not self.done():
            ch = self.next()
            if ch == '\\':
                buf.append(ch)
                if not self.done():
                    buf.append(self.next())
            elif ch in chars:
                if include_delim:
                    buf.append(ch)
                return ''.join(buf), ch
            else:
                buf.append(ch)
        return ''.join(buf), ''


def _tokenize(s):
    """Return list of tokens from script string *s*.

    Tokens are: words (including /.../ patterns), '{', '}', ';', and
    special composite tokens for s/// and y///.
    """
    lex = _Lexer(s)
    tokens = []

    while not lex.done():
        ch = lex.peek()

        if ch in (' ', '\t'):
            lex.pos += 1
            continue
        if ch in ('\n', '\r'):
            # newline acts as command separator (like semicolon)
            lex.pos += 1
            # skip blank lines but emit one separator
            if tokens and tokens[-1] != ';':
                tokens.append(';')
            continue
        if ch == '#':
            lex.skip_comment()
            # A comment acts like a newline separator if neighbours aren't already
            if tokens and tokens[-1] != ';':
                tokens.append(';')
            continue
        if ch == ';':
            tokens.append(';')
            lex.pos += 1
            continue
        if ch == '{':
            tokens.append('{')
            lex.pos += 1
            continue
        if ch == '}':
            tokens.append('}')
            lex.pos += 1
            continue
        if ch == '!':
            tokens.append('!')
            lex.pos += 1
            continue
        if ch == ',':
            tokens.append(',')
            lex.pos += 1
            continue
        if ch == '=':
            tokens.append('=')
            lex.pos += 1
            continue
        if ch == 's':
            # s///  --  collect everything else on this logical line as one token
            buf = [ch]
            lex.pos += 1
            while not lex.done():
                c2 = lex.peek()
                if c2 in (';', '{', '}'):
                    break
                if c2 in ('\n', '\r'):
                    # newlines inside s/// are collapsed to spaces
                    lex.pos += 1
                    buf.append(' ')
                    continue
                if c2 == '\\':
                    buf.append(lex.next())
                    if not lex.done():
                        buf.append(lex.next())
                else:
                    buf.append(lex.next())
            tokens.append(''.join(buf))
            continue

        if ch == 'y':
            buf = [ch]
            lex.pos += 1
            while not lex.done():
                c2 = lex.peek()
                if c2 in (';', '{', '}'):
                    break
                if c2 in ('\n', '\r'):
                    lex.pos += 1
                    buf.append(' ')
                    continue
                if c2 == '\\':
                    buf.append(lex.next())
                    if not lex.done():
                        buf.append(lex.next())
                else:
                    buf.append(lex.next())
            tokens.append(''.join(buf))
            continue

        # default: read a word (stop at whitespace, ; { } ! ,)
        word, _ = lex.read_until(';{}!, \t\n\r')
        tokens.append(word)

    # Strip leading/trailing ';' and collapse runs
    clean = []
    for t in tokens:
        if t in (';', ''):
            if clean and clean[-1] != ';':
                clean.append(';')
        else:
            clean.append(t)
    if clean and clean[-1] == ';':
        clean.pop()
    if clean and clean[0] == ';':
        clean.pop(0)
    return clean


# -- address parsing --------------------------------------------------------

def _parse_addr(token):
    """Parse an address value from a single token string.

    Returns an address value:
      - int for line numbers
      - '$' for last line
      - str for regex patterns
    Returns None if token is not an address.
    """
    if token == '$':
        return '$'
    try:
        return int(token)
    except ValueError:
        pass
    # /pattern/  or  \\pattern\\  etc.
    if token and token[0] in ('/', '\\', '|', ':', '%', '~', '@', '!', '#', '^', '+', '=', '.'):
        delim = token[0]
        # Find closing delimiter
        closed = _find_closing_delim(token, 0, delim)
        if closed is not None:
            # Return the pattern string (without delimiters) with classes expanded
            pattern = token[1:closed]
            # If there are trailing flags (shouldn't here, but be safe), ignore
            rv = _expand_classes(pattern)
            return rv
    return None


def _find_closing_delim(text, start, delim):
    """Find matching closing delimiter starting at *start* (which should be the delim char itself).
    Returns the index of the closing delim, or None.
    """
    i = start + 1
    while i < len(text):
        if text[i] == '\\':
            i += 2
        elif text[i] == delim:
            return i
        else:
            i += 1
    return None


# -- command parsing --------------------------------------------------------

def _parse_commands(tokens, pos, extended_regex):
    """Parse commands from *tokens* starting at *pos*.

    Returns a list of _Cmd objects.  Handles { } grouping.
    """
    commands = []
    while pos < len(tokens):
        tok = tokens[pos]

        if tok == '}':
            # unexpected closing brace at top level
            sys.stderr.write("sed: unexpected '}'\n")
            sys.exit(2)
        if tok == ';':
            pos += 1
            continue

        cmd = _Cmd()

        # Try to parse one or two addresses
        addr1 = _parse_addr(tok)
        if addr1 is not None:
            cmd.addr_start = addr1
            pos += 1
            # Check for range: next token could be ',' or ';' acting as range separator
            if pos < len(tokens) and tokens[pos] == ',':
                pos += 1
                if pos < len(tokens):
                    addr2 = _parse_addr(tokens[pos])
                    if addr2 is not None:
                        cmd.addr_end = addr2
                        pos += 1
                if cmd.addr_end is None:
                    cmd.addr_end = addr1  # default to single addr
            else:
                cmd.addr_end = cmd.addr_start

        # Check for negation '!'
        if pos < len(tokens) and tokens[pos] == '!':
            cmd.negate = True
            pos += 1

        # Now expect the command letter
        if pos >= len(tokens):
            # bare address with no command = print (like p)
            cmd.op = 'p'
            commands.append(cmd)
            break

        op_tok = tokens[pos]
        pos += 1

        # -- text-append commands: a, i, c --
        if op_tok in ('a', 'i', 'c'):
            cmd.op = op_tok
            cmd.args = ''
            # Collect remaining tokens on this line (until } or ;) as text
            while pos < len(tokens) and tokens[pos] not in (';', '{', '}'):
                if cmd.args:
                    cmd.args += ' '
                cmd.args += tokens[pos]
                pos += 1
            commands.append(cmd)
            continue

        # -- s /// --
        if op_tok.startswith('s') and len(op_tok) > 1:
            cmd.op = 's'
            cmd.args = op_tok
            commands.append(cmd)
            continue

        # -- y /// --
        if op_tok.startswith('y') and len(op_tok) > 1:
            cmd.op = 'y'
            cmd.args = op_tok
            commands.append(cmd)
            continue

        # -- single-letter / simple commands --
        if op_tok in ('d', 'p', '=', 'q', 'n', 'N'):
            cmd.op = op_tok
            commands.append(cmd)
            continue

        # -- { opens a group --
        if op_tok == '{':
            child_cmds, pos = _parse_group(tokens, pos + 1, extended_regex)
            g = _Cmd()
            g.addr_start = cmd.addr_start
            g.addr_end = cmd.addr_end
            g.negate = cmd.negate
            g.op = '{'
            g.args = child_cmds
            commands.append(g)
            # _parse_group advances past the closing '}'
            continue

        # -- } is handled by _parse_group wrapper --
        if op_tok == '}':
            break

        # -- unknown --
        sys.stderr.write(f"sed: unknown command: '{op_tok}'\n")
        sys.exit(2)

    return commands


def _parse_group(tokens, pos, extended_regex):
    """Parse a { ... } group.  Returns (commands_list, new_pos)."""
    cmds = []
    brace_depth = 1
    while pos < len(tokens):
        tok = tokens[pos]
        if tok == '{':
            brace_depth += 1
            # Handle nested groups
            sub, pos = _parse_group(tokens, pos + 1, extended_regex)
            g = _Cmd()
            g.op = '{'
            g.args = sub
            cmds.append(g)
            continue
        if tok == '}':
            brace_depth -= 1
            pos += 1
            if brace_depth == 0:
                return cmds, pos
            continue
        if tok == ';':
            pos += 1
            continue

        cmd = _Cmd()
        addr1 = _parse_addr(tok)
        if addr1 is not None:
            cmd.addr_start = addr1
            pos += 1
            if pos < len(tokens) and tokens[pos] == ',':
                pos += 1
                if pos < len(tokens):
                    addr2 = _parse_addr(tokens[pos])
                    if addr2 is not None:
                        cmd.addr_end = addr2
                        pos += 1
                if cmd.addr_end is None:
                    cmd.addr_end = cmd.addr_start
            else:
                cmd.addr_end = cmd.addr_start

        if pos < len(tokens) and tokens[pos] == '!':
            cmd.negate = True
            pos += 1

        if pos >= len(tokens):
            cmd.op = 'p'
            cmds.append(cmd)
            break

        op_tok = tokens[pos]
        pos += 1

        if op_tok in ('a', 'i', 'c'):
            cmd.op = op_tok
            cmd.args = ''
            while pos < len(tokens) and tokens[pos] not in (';', '{', '}'):
                if cmd.args:
                    cmd.args += ' '
                cmd.args += tokens[pos]
                pos += 1
            cmds.append(cmd)
            continue
        if op_tok.startswith('s') and len(op_tok) > 1:
            cmd.op = 's'
            cmd.args = op_tok
            cmds.append(cmd)
            continue
        if op_tok.startswith('y') and len(op_tok) > 1:
            cmd.op = 'y'
            cmd.args = op_tok
            cmds.append(cmd)
            continue
        if op_tok in ('d', 'p', '=', 'q', 'n', 'N', '{'):
            if op_tok == '{':
                sub, pos = _parse_group(tokens, pos, extended_regex)
                g = _Cmd()
                g.addr_start = cmd.addr_start
                g.addr_end = cmd.addr_end
                g.negate = cmd.negate
                g.op = '{'
                g.args = sub
                cmds.append(g)
            else:
                cmd.op = op_tok
                cmds.append(cmd)
            continue
        if op_tok == '}':
            # this shouldn't happen but be safe
            break

        sys.stderr.write(f"sed: unknown command: '{op_tok}'\n")
        sys.exit(2)

    return cmds, pos


# -- full compilation -------------------------------------------------------

def _compile(texts, extended_regex):
    """Compile one or more script texts into a list of _Cmd objects."""
    full_script = '\n'.join(texts)
    tokens = _tokenize(full_script)
    commands, _ = _parse_commands(tokens, 0, extended_regex)
    return commands


# ---------------------------------------------------------------------------
# s/// and y/// arg parsing
# ---------------------------------------------------------------------------

_S_RE = re.compile(
    r'^s'            # leading s
    r'(.)'           # delimiter (group 1)
    r'(.*?)'         # pattern (group 2, non-greedy)
    r'\1'            # same delimiter
    r'(.*?)'         # replacement (group 3, non-greedy)
    r'\1'            # same delimiter
    r'(.*)$'         # flags (group 4)
)


def _parse_s_args(text, extended_regex):
    """Parse s/// command text.  Returns (compiled_regex, replacement_str, flags_str)."""
    m = _S_RE.match(text)
    if not m:
        sys.stderr.write(f"sed: bad s/// expression: {text}\n")
        sys.exit(2)
    delim = m.group(1)
    raw_pattern = _expand_classes(m.group(2))
    replacement = m.group(3)
    flags = m.group(4)

    # Unescape delimiters in pattern / replacement
    raw_pattern = raw_pattern.replace(f'\\{delim}', delim)
    replacement = replacement.replace(f'\\{delim}', delim)

    regex_flags = re.MULTILINE
    if extended_regex:
        # GNU sed -E behavior approximates basic RE, but Python doesn't have
        # that distinction -- it's always "extended".  We still set the flag
        # because some constructs differ, but for most patterns it's fine.
        pass

    try:
        compiled = re.compile(raw_pattern, regex_flags)
    except re.error as e:
        sys.stderr.write(f"sed: regex error in s///: {e}\n")
        sys.exit(2)

    return compiled, replacement, flags


def _parse_y_args(text):
    """Parse y/// command text.  Returns a str.translate table."""
    m = re.match(r'^y(.)(.+?)\1(.+?)\1?$', text)
    if not m:
        sys.stderr.write(f"sed: bad y/// expression: {text}\n")
        sys.exit(2)
    source = m.group(2)
    dest = m.group(3)
    if len(source) != len(dest):
        sys.stderr.write("sed: y/// strings must be equal length\n")
        sys.exit(2)
    return str.maketrans(source, dest)


# ---------------------------------------------------------------------------
# backreference replacement
# ---------------------------------------------------------------------------

def _expand_repl(matchobj, replacement):
    """Return *replacement* with \\1..\\9, &, \\& expanded."""
    out = []
    i = 0
    while i < len(replacement):
        if replacement[i] == '\\' and i + 1 < len(replacement):
            ch = replacement[i + 1]
            if '1' <= ch <= '9':
                idx = int(ch)
                try:
                    out.append(matchobj.group(idx) or '')
                except IndexError:
                    out.append('')
                i += 2
            elif ch == '&':
                out.append(matchobj.group(0))
                i += 2
            elif ch == '\\':
                out.append('\\')
                i += 2
            elif ch == 'n':
                out.append('\n')
                i += 2
            elif ch == 't':
                out.append('\t')
                i += 2
            else:
                out.append(ch)
                i += 2
        elif replacement[i] == '&' and (i == 0 or replacement[i - 1] != '\\'):
            out.append(matchobj.group(0))
            i += 1
        else:
            out.append(replacement[i])
            i += 1
    return ''.join(out)


# ---------------------------------------------------------------------------
# address matching & range tracking
# ---------------------------------------------------------------------------

def _match_addr(addr, lineno, pattern, total):
    """Does *addr* match?  *addr* can be None (match anything), int, '$', or str (regex)."""
    if addr is None:
        return True
    if addr == '$':
        return lineno == total
    if isinstance(addr, int):
        return lineno == addr
    # regex string
    try:
        return bool(re.search(addr, pattern))
    except re.error:
        return False


def _resolve_ranges(commands, lineno, pattern, total, range_flags):
    """Resolve address condition for each command, updating range state.

    Returns a list of (cmd, matched) pairs.
    """
    result = []
    for cmd in commands:
        if cmd.op == '{':
            # group: check if the group's address matches, then recurse
            if cmd.addr_start is None and cmd.addr_end is None:
                result.extend(_resolve_ranges(cmd.args, lineno, pattern, total, range_flags))
            else:
                grp_match = _check_single(cmd, lineno, pattern, total, range_flags)
                if grp_match:
                    result.extend(_resolve_ranges(cmd.args, lineno, pattern, total, range_flags))
            continue

        matched = _check_single(cmd, lineno, pattern, total, range_flags)
        result.append((cmd, matched))
    return result


def _check_single(cmd, lineno, pattern, total, range_flags):
    """Check if a single (non-group) command matches the current line."""
    start = cmd.addr_start
    end = cmd.addr_end

    # No address => always match
    if start is None and end is None:
        return not cmd.negate

    # Range
    if start is not None and end is not None and start != end:
        key = id(cmd)
        active = range_flags.get(key, False)

        if active:
            # Currently inside the range
            if _match_addr(end, lineno, pattern, total):
                range_flags[key] = False  # close after this line
            return not cmd.negate
        else:
            # Not yet in range; open if start matches
            if _match_addr(start, lineno, pattern, total):
                if _match_addr(end, lineno, pattern, total):
                    range_flags[key] = False  # start==end on this line
                else:
                    range_flags[key] = True
                return not cmd.negate
            return cmd.negate  # if negated we still apply when not in range

    # Single address
    if start is not None:
        hit = _match_addr(start, lineno, pattern, total)
        return hit if not cmd.negate else (not hit)
    if end is not None:
        hit = _match_addr(end, lineno, pattern, total)
        return hit if not cmd.negate else (not hit)

    return not cmd.negate


# ---------------------------------------------------------------------------
# execution engine
# ---------------------------------------------------------------------------

def _process_lines(lines, commands, options, output_writer):
    """Process *lines* (list of strings with trailing newlines) through *commands*.

    Writes output via ``output_writer.write(str)``.
    """
    total = len(lines)
    state = _EngineState(options.n_flag)

    for raw_line in lines:
        if state.quit:
            break

        state.lineno += 1
        state.pattern = raw_line.rstrip('\n').rstrip('\r')
        state.deleted = False

        _exec_all(commands, state, options, total)

        # Default print unless -n, deleted, or quit
        if not state.deleted and not state.quit:
            if not state.n_flag:
                output_writer.write(state.pattern + '\n')

        # Drain buffered output
        _flush_output(state, output_writer)

        # Handle n and N: read-ahead
        if state.next_line_flag:
            if state.lineno < total:
                state.lineno += 1
                next_line = lines[state.lineno - 1].rstrip('\n').rstrip('\r')
                if state.append_flag:
                    state.pattern = state.pattern + '\n' + next_line
                    state.append_flag = False
                else:
                    state.pattern = next_line
                state.next_line_flag = False
                state.deleted = False

                _exec_all(commands, state, options, total)

                if not state.deleted and not state.quit:
                    if not state.n_flag:
                        output_writer.write(state.pattern + '\n')

                _flush_output(state, output_writer)
            else:
                # No more lines -- EOF
                if not state.n_flag:
                    output_writer.write(state.pattern + '\n')
                _flush_output(state, output_writer)
                break

        # If the line was deleted (and we didn't read-ahead), continue
        if state.deleted and not state.quit:
            continue

    _flush_output(state, output_writer)


def _flush_output(state, writer):
    for line in state.output:
        writer.write(line + '\n')
    state.output.clear()


class _EngineState:
    __slots__ = (
        'n_flag', 'pattern', 'hold', 'lineno',
        'quit', 'deleted', 'output', 'range_flags',
        'next_line_flag', 'append_flag',
    )

    def __init__(self, n_flag):
        self.n_flag = n_flag
        self.pattern = ''
        self.hold = ''
        self.lineno = 0
        self.quit = False
        self.deleted = False
        self.output = []
        self.range_flags = {}
        self.next_line_flag = False  # set by n or N
        self.append_flag = False  # True for N, False for n


def _exec_all(commands, state, options, total):
    """Run all *commands* against the current state."""
    resolved = _resolve_ranges(commands, state.lineno, state.pattern, total, state.range_flags)
    for cmd, matched in resolved:
        if state.quit or state.deleted:
            break
        if not matched:
            continue
        _exec_one(cmd, state, options)


def _exec_one(cmd, state, options):
    """Execute a single command (op) on *state*."""
    op = cmd.op

    if op == 's':
        _do_substitute(cmd, state, options)
    elif op == 'd':
        state.deleted = True
    elif op == 'p':
        state.output.append(state.pattern)
    elif op == 'q':
        if not state.n_flag:
            state.output.append(state.pattern)
        state.quit = True
    elif op == '=':
        state.output.append(str(state.lineno))
    elif op == 'n':
        state.next_line_flag = True
        state.deleted = True
    elif op == 'N':
        state.next_line_flag = True
        state.append_flag = True
        state.deleted = True
    elif op == 'a':
        if cmd.args is not None:
            for ln in cmd.args.split('\n') if '\n' in cmd.args else [cmd.args]:
                state.output.append(ln)
        else:
            state.output.append('')
    elif op == 'i':
        if cmd.args is not None:
            for ln in cmd.args.split('\n') if '\n' in cmd.args else [cmd.args]:
                state.output.append(ln)
        else:
            state.output.append('')
    elif op == 'c':
        state.deleted = True
        if cmd.args is not None:
            for ln in cmd.args.split('\n') if '\n' in cmd.args else [cmd.args]:
                state.output.append(ln)
        else:
            state.output.append('')
    elif op == 'y':
        if not hasattr(cmd, '_parsed_y'):
            cmd._parsed_y = _parse_y_args(cmd.args)
        state.pattern = state.pattern.translate(cmd._parsed_y)


def _do_substitute(cmd, state, options):
    """Execute a pre-parsed s/// command."""
    if not hasattr(cmd, '_parsed_s'):
        cmd._parsed_s = _parse_s_args(cmd.args, options.extended_regex)
    compiled, replacement, flags_raw = cmd._parsed_s

    # Parse flags
    global_flag = False
    case_insensitive = False
    print_flag = False
    nth = 0

    for ch in flags_raw:
        if ch == 'g':
            global_flag = True
        elif ch == 'i':
            case_insensitive = True
        elif ch == 'p':
            print_flag = True
        elif ch.isdigit():
            nth = nth * 10 + int(ch)

    regex = compiled
    if case_insensitive:
        # Re-compile with IGNORECASE if not already
        if not (regex.flags & re.IGNORECASE):
            regex = re.compile(regex.pattern, regex.flags | re.IGNORECASE)

    # Do the substitution
    if global_flag:
        def _replacer(m):
            return _expand_repl(m, replacement)
        state.pattern, _ = regex.subn(_replacer, state.pattern)
    elif nth > 0:
        def _replacer_nth(m):
            _replacer_nth.cnt += 1
            if _replacer_nth.cnt == nth:
                return _expand_repl(m, replacement)
            return m.group(0)
        _replacer_nth.cnt = 0
        state.pattern = regex.sub(_replacer_nth, state.pattern)
    else:
        def _replacer_one(m):
            return _expand_repl(m, replacement)
        state.pattern = regex.sub(_replacer_one, state.pattern, count=1)

    if print_flag and not state.n_flag:
        state.output.append(state.pattern)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main(args=None):
    """Entry point.  *args* defaults to sys.argv[1:]."""
    if args is None:
        args = sys.argv[1:]

    options, files = _parse_args(args)

    # Compile commands once
    commands = _compile(options.scripts, options.extended_regex)

    if not files:
        files = ['-']

    if options.in_place is not None:
        _main_inplace(files, commands, options)
    else:
        _main_stdout(files, commands, options)
    return 0


def _main_stdout(files, commands, options):
    """Non in-place: write to stdout."""
    if not options.separate:
        # Single stream across all files
        all_lines = []
        for f in files:
            all_lines.extend(_read_lines(f))
        _process_lines(all_lines, commands, options, sys.stdout)
    else:
        for f in files:
            lines = _read_lines(f)
            _process_lines(lines, commands, options, sys.stdout)


def _main_inplace(files, commands, options):
    """In-place editing (-i)."""
    for f in files:
        if f == '-':
            sys.stderr.write("sed: cannot edit stdin in-place\n")
            sys.exit(2)
        if not os.path.isfile(f):
            sys.stderr.write(f"sed: cannot read {f}\n")
            continue

        lines = _read_lines(f)
        buf = []
        writer = _ListWriter(buf)
        _process_lines(lines, commands, options, writer)

        # Backup
        suffix = options.in_place
        if suffix:
            shutil.copy2(f, f + suffix)

        with open(f, 'w', encoding='utf-8') as fh:
            fh.write(''.join(buf))


def _read_lines(path):
    """Return list of lines (with trailing newlines) from *path* or stdin."""
    if path == '-':
        return sys.stdin.readlines()
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return fh.readlines()
    except OSError as e:
        sys.stderr.write(f"sed: cannot read {path}: {e}\n")
        return []


class _ListWriter:
    """A file-like object that appends written strings to a list."""
    def __init__(self, buf):
        self.buf = buf

    def write(self, s):
        self.buf.append(s)


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
