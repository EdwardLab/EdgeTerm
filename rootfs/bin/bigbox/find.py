import fnmatch
import os
import shutil
import stat
import subprocess
import sys
import time

VERSION = "find (EdgeTerm bigbox) 1.0"


def print_help():
    print("Usage: find [-H] [-L] [-P] [PATH...] [EXPRESSION]")
    print("Search for files in a directory hierarchy.")
    print("")
    print("Expressions:")
    print("  -name PATTERN      file name matches pattern (case-sensitive)")
    print("  -iname PATTERN     file name matches pattern (case-insensitive)")
    print("  -type TYPE         file type: f (regular), d (directory), l (symlink)")
    print("  -size [+-]N[c/k/M/G]  file size (c=bytes, k=KB, M=MB, G=GB)")
    print("  -mtime [+-]N       modified N days ago")
    print("  -mmin [+-]N        modified N minutes ago")
    print("  -empty             file is empty (regular file or directory)")
    print("  -maxdepth N        descend at most N levels")
    print("  -mindepth N        don't apply tests at levels less than N")
    print("  -print             print file path (default)")
    print("  -print0            print file path followed by NUL")
    print("  -delete            delete found files/directories")
    print("  -exec CMD {} \\;    execute command for each file")
    print("  -ls                list in ls -dils format")
    print("  -path PATTERN      whole path matches pattern")
    print("  -newer FILE        file modified more recently than FILE")
    print("  -a                 AND (default operator)")
    print("  -o                 OR")
    print("  -not, !            negate following expression")
    print("")
    print("      --help         display this help and exit")
    print("      --version      output version information and exit")


def parse_size_spec(spec):
    """Parse -size specification. Returns (min, max) in bytes or None."""
    if not spec:
        return None
    spec = spec.strip()
    if not spec:
        return None

    negative = spec.startswith("-")
    positive = spec.startswith("+")
    if negative or positive:
        num_part = spec[1:]
    else:
        num_part = spec

    if not num_part:
        return None

    multiplier = 1
    if num_part[-1].upper() == "C":
        num_part = num_part[:-1]
    elif num_part[-1].upper() == "K":
        multiplier = 1024
        num_part = num_part[:-1]
    elif num_part[-1].upper() == "M":
        multiplier = 1024 * 1024
        num_part = num_part[:-1]
    elif num_part[-1].upper() == "G":
        multiplier = 1024 * 1024 * 1024
        num_part = num_part[:-1]

    try:
        num = int(num_part)
    except ValueError:
        return None

    size = num * multiplier
    if negative:
        return (0, size - 1)
    elif positive:
        return (size + 1, float("inf"))
    else:
        return (size, size)


def size_matches(st_size, spec):
    """Check if file size matches the -size specification."""
    if spec is None:
        return True
    low, high = spec
    if high == float("inf"):
        return st_size >= low
    return low <= st_size <= high


def parse_time_spec(spec):
    """Parse +/-N time spec. Returns (min, max) in same units, or None."""
    if not spec:
        return None
    spec = spec.strip()
    negative = spec.startswith("-")
    positive = spec.startswith("+")
    if negative or positive:
        num_part = spec[1:]
    else:
        num_part = spec

    try:
        num = int(num_part)
    except ValueError:
        return None

    if negative:
        return (0, num - 1)
    elif positive:
        return (num + 1, float("inf"))
    else:
        return (num, num)


def mtime_matches(st_mtime, now, spec):
    """Check if file mtime matches -mtime spec (in days)."""
    if spec is None:
        return True
    age_days = (now - st_mtime) / 86400.0
    low, high = spec
    if high == float("inf"):
        return age_days >= low
    return low <= age_days <= high


def mmin_matches(st_mtime, now, spec):
    """Check if file mtime matches -mmin spec (in minutes)."""
    if spec is None:
        return True
    age_min = (now - st_mtime) / 60.0
    low, high = spec
    if high == float("inf"):
        return age_min >= low
    return low <= age_min <= high


class Expression:
    """Represents a parsed find expression."""

    def __init__(self, name, args=None, negate=False):
        self.name = name
        self.args = args if args is not None else []
        self.negate = negate
        self.is_action = name in ("print", "print0", "delete", "ls", "exec")

    def evaluate(self, filepath, dirpath, filename, st, now):
        """Evaluate this expression for the given file."""
        result = self._do_evaluate(filepath, dirpath, filename, st, now)
        if self.negate:
            return not result
        return result

    def _do_evaluate(self, filepath, dirpath, filename, st, now):
        if self.name == "name":
            return fnmatch.fnmatch(filename, self.args[0])
        elif self.name == "iname":
            return fnmatch.fnmatch(filename.lower(), self.args[0].lower())
        elif self.name == "type":
            t = self.args[0]
            if t == "f":
                return st is not None and stat.S_ISREG(st.st_mode)
            elif t == "d":
                return st is not None and stat.S_ISDIR(st.st_mode)
            elif t == "l":
                return st is not None and stat.S_ISLNK(st.st_mode)
            return False
        elif self.name == "size":
            if st is None:
                return False
            spec = parse_size_spec(self.args[0])
            return size_matches(st.st_size, spec)
        elif self.name == "mtime":
            if st is None:
                return False
            spec = parse_time_spec(self.args[0])
            return mtime_matches(st.st_mtime, now, spec)
        elif self.name == "mmin":
            if st is None:
                return False
            spec = parse_time_spec(self.args[0])
            return mmin_matches(st.st_mtime, now, spec)
        elif self.name == "empty":
            if st is None:
                return False
            if stat.S_ISREG(st.st_mode):
                return st.st_size == 0
            if stat.S_ISDIR(st.st_mode):
                try:
                    return len(os.listdir(filepath)) == 0
                except (PermissionError, OSError):
                    return False
            return False
        elif self.name == "path":
            return fnmatch.fnmatch(filepath, self.args[0])
        elif self.name == "newer":
            if st is None:
                return False
            try:
                ref_st = os.stat(self.args[0])
                return st.st_mtime > ref_st.st_mtime
            except OSError:
                return False
        elif self.name == "true":
            return True
        elif self.name == "false":
            return False
        # Actions always return True (they should be executed separately)
        return True


class CompoundExpression:
    """AND or OR combination of expressions."""

    def __init__(self, op, left, right):
        self.op = op  # 'a' for AND, 'o' for OR
        self.left = left
        self.right = right

    def evaluate(self, filepath, dirpath, filename, st, now):
        left_result = evaluate_expr(self.left, filepath, dirpath, filename, st, now)
        if self.op == 'a':
            if not left_result:
                return False
            return evaluate_expr(self.right, filepath, dirpath, filename, st, now)
        else:  # OR
            if left_result:
                return True
            return evaluate_expr(self.right, filepath, dirpath, filename, st, now)


def evaluate_expr(expr, filepath, dirpath, filename, st, now):
    """Evaluate an expression tree."""
    if isinstance(expr, CompoundExpression):
        return expr.evaluate(filepath, dirpath, filename, st, now)
    elif isinstance(expr, Expression):
        return expr.evaluate(filepath, dirpath, filename, st, now)
    elif isinstance(expr, bool):
        return expr
    return True


def ls_format(filepath, st):
    """Format file in ls -dils style."""
    mode = stat.filemode(st.st_mode)
    nlink = st.st_nlink
    uid = st.st_uid
    gid = st.st_gid
    size = st.st_size
    mtime = time.strftime("%b %d %H:%M", time.localtime(st.st_mtime))
    inode = st.st_ino
    blocks = st.st_blocks
    return f"{inode:>8} {blocks:>4} {mode} {nlink:>3} {uid} {gid} {size:>8} {mtime} {filepath}"


def delete_file(filepath, st):
    """Delete a file or empty directory."""
    try:
        if st is not None and stat.S_ISDIR(st.st_mode):
            os.rmdir(filepath)
        else:
            os.unlink(filepath)
    except OSError as e:
        print(f"find: cannot delete '{filepath}': {e}", file=sys.stderr)


def parse_expressions(args):
    """Parse expression arguments into a tree structure."""
    if not args:
        # Default: -print
        return [Expression("print")], True

    # First pass: split on -o (OR) operators to build OR groups
    exprs = []
    i = 0
    while i < len(args):
        arg = args[i]
        expr = None

        if arg == "-not" or arg == "!":
            if i + 1 < len(args):
                i += 1
                sub = parse_single_expression(args, i)
                if sub:
                    sub.negate = not sub.negate
                    expr = sub
                    i += 1 if sub.name != "exec" else 3 if sub.args else 2
                    i = min(i, len(args))
        elif arg == "-a":
            # AND is implicit, skip
            i += 1
            continue
        elif arg == "-o":
            # Will handle OR grouping below
            exprs.append(("o", None))
            i += 1
            continue
        elif arg == "(":
            # Parenthesized group - not fully implemented, treat as passthrough
            i += 1
            continue
        elif arg == ")":
            i += 1
            continue
        else:
            sub = parse_single_expression(args, i)
            if sub:
                expr = sub
                if sub.name == "exec":
                    i += 3 + len(sub.args)
                elif sub.name in ("name", "iname", "type", "size", "mtime", "mmin", "path", "newer"):
                    i += 2
                elif sub.name == "maxdepth":
                    i += 2
                elif sub.name == "mindepth":
                    i += 2
                else:
                    i += 1
            else:
                i += 1

        if expr:
            exprs.append(("e", expr))

    # Special case: if we only have OR markers, something went wrong
    filtered = [(kind, e) for kind, e in exprs if kind == "e"]

    # Build expression tree from AND/OR
    if not filtered:
        return [Expression("print")], True

    # Separate actions from tests
    actions = [e for _, e in filtered if isinstance(e, Expression) and e.is_action]
    tests = [e for _, e in filtered if not (isinstance(e, Expression) and e.is_action)]

    if not actions:
        actions.append(Expression("print"))

    return tests + actions, False


def parse_single_expression(args, i):
    """Parse a single expression starting at index i."""
    if i >= len(args):
        return None
    arg = args[i]

    if arg in ("-name", "-iname", "-type", "-path"):
        if i + 1 < len(args):
            return Expression(arg[1:], [args[i + 1]])
        print(f"find: missing argument to '{arg}'", file=sys.stderr)
        return Expression("false")
    elif arg == "-size":
        if i + 1 < len(args):
            return Expression("size", [args[i + 1]])
        print("find: missing argument to '-size'", file=sys.stderr)
        return Expression("false")
    elif arg == "-mtime":
        if i + 1 < len(args):
            return Expression("mtime", [args[i + 1]])
        print("find: missing argument to '-mtime'", file=sys.stderr)
        return Expression("false")
    elif arg == "-mmin":
        if i + 1 < len(args):
            return Expression("mmin", [args[i + 1]])
        print("find: missing argument to '-mmin'", file=sys.stderr)
        return Expression("false")
    elif arg == "-newer":
        if i + 1 < len(args):
            return Expression("newer", [args[i + 1]])
        print("find: missing argument to '-newer'", file=sys.stderr)
        return Expression("false")
    elif arg == "-maxdepth":
        if i + 1 < len(args):
            try:
                val = int(args[i + 1])
                return Expression("maxdepth", [val])
            except ValueError:
                print(f"find: invalid argument to '-maxdepth': {args[i + 1]}", file=sys.stderr)
                return Expression("false")
        print("find: missing argument to '-maxdepth'", file=sys.stderr)
        return Expression("false")
    elif arg == "-mindepth":
        if i + 1 < len(args):
            try:
                val = int(args[i + 1])
                return Expression("mindepth", [val])
            except ValueError:
                print(f"find: invalid argument to '-mindepth': {args[i + 1]}", file=sys.stderr)
                return Expression("false")
        print("find: missing argument to '-mindepth'", file=sys.stderr)
        return Expression("false")
    elif arg == "-empty":
        return Expression("empty")
    elif arg == "-print":
        return Expression("print")
    elif arg == "-print0":
        return Expression("print0")
    elif arg == "-delete":
        return Expression("delete")
    elif arg == "-ls":
        return Expression("ls")
    elif arg == "-exec":
        # Collect up to \;
        parts = []
        j = i + 1
        while j < len(args) and args[j] != ";":
            parts.append(args[j])
            j += 1
        if j >= len(args):
            print("find: missing terminating ';' for '-exec'", file=sys.stderr)
            return Expression("false")
        return Expression("exec", parts)
    elif arg in ("-a", "-o", "-not", "!"):
        return None
    elif arg.startswith("-"):
        print(f"find: unknown predicate '{arg}'", file=sys.stderr)
        return Expression("true")

    return None


def main(args):
    if not args:
        print("Usage: find [PATH...] [EXPRESSION]")
        print("Try 'find --help' for more information.")
        return

    if "--help" in args:
        print_help()
        return
    if "--version" in args:
        print(VERSION)
        return

    # Separate paths from expressions
    paths = []
    expr_args = []
    in_expr = False
    for arg in args:
        if arg.startswith("-") and arg not in ("-", "--"):
            if arg in ("-H", "-L", "-P"):
                continue
            in_expr = True
        if in_expr:
            expr_args.append(arg)
        else:
            paths.append(arg)

    if not paths:
        paths = ["."]

    # Parse expressions
    exprs, is_default = parse_expressions(expr_args)

    # Extract non-test options
    maxdepth = None
    mindepth = 0
    actions = []
    tests = []
    for expr in exprs:
        if isinstance(expr, Expression):
            if expr.name == "maxdepth":
                maxdepth = expr.args[0]
            elif expr.name == "mindepth":
                mindepth = expr.args[0]
            elif expr.is_action:
                actions.append(expr)
            else:
                tests.append(expr)
    if not actions:
        actions = [Expression("print")]

    now = time.time()

    for start_path in paths:
        start_path = start_path.rstrip(os.sep) or "."
        try:
            walker = os.walk(start_path, followlinks=False)
        except PermissionError:
            print(f"find: '{start_path}': Permission denied", file=sys.stderr)
            continue
        except FileNotFoundError:
            print(f"find: '{start_path}': No such file or directory", file=sys.stderr)
            continue

        for dirpath, dirnames, filenames in walker:
            # Calculate depth
            rel = os.path.relpath(dirpath, start_path)
            depth = 0 if rel == "." else rel.count(os.sep) + 1

            # Apply mindepth/maxdepth for directory itself
            dir_skip = False
            if maxdepth is not None and depth > maxdepth:
                dir_skip = True
            if depth < mindepth:
                dir_skip = True

            # Prune subdirectories if at maxdepth
            if maxdepth is not None and depth >= maxdepth:
                dirnames.clear()

            # Process directory entry
            if not dir_skip:
                try:
                    st = os.stat(dirpath)
                except PermissionError:
                    st = None

                matched = True
                for test in tests:
                    if not evaluate_expr(test, dirpath, dirpath, os.path.basename(dirpath) or start_path, st, now):
                        matched = False
                        break

                if matched:
                    for action in actions:
                        if action.name == "print":
                            print(dirpath)
                        elif action.name == "print0":
                            sys.stdout.write(dirpath + "\0")
                        elif action.name == "delete":
                            delete_file(dirpath, st)
                        elif action.name == "ls":
                            if st:
                                print(ls_format(dirpath, st))
                        elif action.name == "exec":
                            if action.args:
                                cmd = [a.replace("{}", dirpath) for a in action.args]
                                try:
                                    subprocess.run(cmd)
                                except OSError as e:
                                    print(f"find: '{cmd[0]}': {e}", file=sys.stderr)

            # Process files
            for filename in filenames:
                filepath = os.path.join(dirpath, filename)
                file_depth = depth + 1

                if maxdepth is not None and file_depth > maxdepth:
                    continue
                if file_depth < mindepth:
                    continue

                try:
                    st = os.lstat(filepath)
                except PermissionError:
                    st = None

                matched = True
                for test in tests:
                    if not evaluate_expr(test, filepath, dirpath, filename, st, now):
                        matched = False
                        break

                if matched:
                    for action in actions:
                        if action.name == "print":
                            print(filepath)
                        elif action.name == "print0":
                            sys.stdout.write(filepath + "\0")
                        elif action.name == "delete":
                            delete_file(filepath, st)
                        elif action.name == "ls":
                            if st:
                                print(ls_format(filepath, st))
                        elif action.name == "exec":
                            if action.args:
                                cmd = [a.replace("{}", filepath) for a in action.args]
                                try:
                                    subprocess.run(cmd)
                                except OSError as e:
                                    print(f"find: '{cmd[0]}': {e}", file=sys.stderr)
