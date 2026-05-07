"""
bc — arbitrary precision calculator.
Usage: bc [OPTION]... [FILE]...

Flags: -l (math library), -q (quiet), -s (POSIX mode)
Uses Python's decimal module for arbitrary precision.
"""
import sys
import os
from decimal import Decimal, getcontext, localcontext
import re


VERSION = "1.0.0 (bigbox)"

# Initial precision
getcontext().prec = 20


class BcEnvironment:
    """Represents the bc execution environment."""

    def __init__(self, mathlib=False, quiet=False, posix=False):
        self.variables = {}
        self.scale = 0
        self.ibase = 10
        self.obase = 10
        self.mathlib = mathlib
        self.quiet = quiet
        self.posix = posix
        self.last = Decimal("0")
        self.last_printed = False
        self.stdin_closed = False

        if mathlib:
            self._load_mathlib()

    def _load_mathlib(self):
        """Load the math library with standard functions."""
        # Define s(x), c(x), a(x), l(x), e(x), j(x)
        # These use math functions
        pass  # Handled specially in evaluation


def main(args):
    files = []
    mathlib = False
    quiet = False
    posix = False

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--help":
            print("Usage: bc [OPTION]... [FILE]...")
            print("  -l    define math library functions")
            print("  -q    quiet (no welcome)")
            print("  -s    POSIX mode")
            sys.exit(0)
        elif arg == "--version":
            print(VERSION)
            sys.exit(0)
        elif arg == "-l":
            mathlib = True
        elif arg == "-q":
            quiet = True
        elif arg == "-s":
            posix = True
        elif arg.startswith("-") and len(arg) > 1:
            for ch in arg[1:]:
                if ch == 'l':
                    mathlib = True
                elif ch == 'q':
                    quiet = True
                elif ch == 's':
                    posix = True
                else:
                    print(f"bc: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)
        i += 1

    if not quiet:
        sys.stderr.write("bc 1.0 (bigbox) - arbitrary precision calculator\n")

    env = BcEnvironment(mathlib=mathlib, quiet=quiet, posix=posix)

    if not files:
        # Interactive mode or stdin
        if sys.stdin.isatty():
            interactive_repl(env)
        else:
            content = sys.stdin.read()
            execute_bc(content, env)
    else:
        for f in files:
            if not os.path.exists(f):
                print(f"bc: {f}: cannot open file", file=sys.stderr)
                continue
            with open(f, "r") as fh:
                content = fh.read()
            execute_bc(content, env)


def interactive_repl(env):
    """Interactive read-eval-print loop."""
    while not env.stdin_closed:
        try:
            line = input()
            if line is None:
                break
        except EOFError:
            break
        except KeyboardInterrupt:
            break
        try:
            execute_bc(line + "\n", env)
        except Exception as e:
            print(f"bc: error: {e}", file=sys.stderr)


def execute_bc(source, env):
    """Execute bc source code."""
    if not source.strip():
        return

    lines = preprocess(source)
    if not lines:
        return

    # Parse and execute each statement
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue

        # Check for multi-line statements and conditionals
        if line in ("if", "while", "for"):
            stmt, consumed = parse_control_statement(lines, i, env)
            if stmt:
                execute_control_statement(stmt, env)
            i += consumed
        elif line.startswith("define"):
            # Skip function definitions for now
            pass
            i += 1
        elif line.startswith("print"):
            # Skip print statements for now
            pass
            i += 1
        elif line.startswith("scale="):
            try:
                env.scale = int(line[6:].strip())
                getcontext().prec = max(env.scale + 10, 20)
            except ValueError:
                pass
            i += 1
        elif line.startswith("ibase="):
            try:
                env.ibase = int(line[6:].strip())
                if env.ibase < 2 or env.ibase > 16:
                    env.ibase = 10
            except ValueError:
                pass
            i += 1
        elif line.startswith("obase="):
            try:
                env.obase = int(line[6:].strip())
                if env.obase < 2 or env.obase > 16:
                    env.obase = 10
            except ValueError:
                pass
            i += 1
        elif line.startswith("sqrt("):
            result = eval_expression(line, env)
            if result is not None:
                output_result(result, env)
            i += 1
        elif "=" in line and not any(op in line for op in ("==", "!=", "<=", ">=")):
            var, _, expr = line.partition("=")
            var = var.strip()
            expr = expr.strip()
            if var.isidentifier() and expr:
                result = eval_expression(expr, env)
                if result is not None:
                    env.variables[var] = result
                    env.last = result
                    env.last_printed = False
            i += 1
        elif line == "quit":
            env.stdin_closed = True
            i += 1
            break
        else:
            result = eval_expression(line, env)
            if result is not None:
                output_result(result, env)
            i += 1


def preprocess(source):
    """Preprocess bc source: handle multi-line continuations and strip comments."""
    lines = []
    continuation = ""
    for raw_line in source.split("\n"):
        # Strip comments (/* ... */ and #)
        if "/*" in raw_line:
            raw_line = raw_line.split("/*")[0]
        if "#" in raw_line and not raw_line.strip().startswith("#"):
            raw_line = raw_line.split("#")[0]
        if raw_line.strip().startswith("#"):
            raw_line = ""

        raw_line = raw_line.rstrip()

        if continuation:
            continuation += " " + raw_line.strip()
        else:
            continuation = raw_line.strip()

        if not continuation.endswith("\\"):
            if continuation:
                lines.append(continuation)
            continuation = ""

    if continuation:
        lines.append(continuation)

    return lines


def parse_control_statement(lines, idx, env):
    """Parse a control flow statement. Returns (stmt_dict, consumed_lines)."""
    # Simplified: just treat the line as expression
    return None, 1


def execute_control_statement(stmt, env):
    """Execute a control flow statement."""
    pass


def eval_expression(expr, env):
    """Evaluate a bc expression. Returns Decimal or None."""
    expr = expr.strip()
    if not expr:
        return None

    # Handle sqrt()
    sqrt_match = re.match(r"^sqrt\(\s*(.+)\s*\)$", expr)
    if sqrt_match:
        inner = sqrt_match.group(1)
        val = eval_expression(inner, env)
        if val is not None and val >= 0:
            # Compute square root
            result = val.sqrt(Decimal.getcontext())
            return result
        return None

    # Handle functions: s(), c(), a(), l(), e(), j()
    func_match = re.match(r"^([scalej])\(\s*(.+)\s*\)$", expr)
    if func_match:
        func = func_match.group(1)
        inner = func_match.group(2)
        val = eval_expression(inner, env)
        if val is not None:
            import math
            if func == 's':
                # Scale by dividing by 1
                f = float(val)
                return Decimal(str(math.sin(f)))
            elif func == 'c':
                f = float(val)
                return Decimal(str(math.cos(f)))
            elif func == 'a':
                f = float(val)
                return Decimal(str(math.atan(f)))
            elif func == 'l':
                if val <= 0:
                    return Decimal("0")
                f = float(val)
                return Decimal(str(math.log(f)))
            elif func == 'e':
                f = float(val)
                return Decimal(str(math.exp(f)))
        return None

    # Handle assignment within expression (a = expr)
    if "=" in expr and not any(op in expr for op in ("==", "!=", "<=", ">=")):
        parts = expr.split("=", 1)
        if len(parts) == 2 and parts[0].strip().isidentifier():
            var = parts[0].strip()
            val = eval_expression(parts[1], env)
            if val is not None:
                env.variables[var] = val
                env.last = val
                return val
            return None

    # Tokenize by operators
    tokens = tokenize(expr, env)
    if not tokens:
        return None

    # Standard operator precedence parsing
    result = parse_expression(tokens, env)
    return result


OP_PRECEDENCE = {
    '+': 6,
    '-': 6,
    '*': 7,
    '/': 7,
    '%': 7,
    '^': 10,
}


def tokenize(expr, env):
    """Tokenize a bc expression."""
    tokens = []
    i = 0
    num_buf = ""
    op_chars = set("+-*/%^()")

    while i < len(expr):
        ch = expr[i]
        if ch.isspace():
            if num_buf:
                tokens.append(('num', num_buf))
                num_buf = ""
            i += 1
        elif ch in op_chars:
            if num_buf:
                tokens.append(('num', num_buf))
                num_buf = ""
            if ch == '-' and (not tokens or tokens[-1][0] in ('op', '(')):
                # Unary minus
                tokens.append(('op', '_'))
            else:
                tokens.append(('op', ch))
            i += 1
        elif ch == '(' or ch == ')':
            if num_buf:
                tokens.append(('num', num_buf))
                num_buf = ""
            tokens.append(('paren', ch))
            i += 1
        elif ch == '.' or ch.isdigit():
            num_buf += ch
            i += 1
        elif ch.isalpha() or ch == '_':
            # Read identifier
            if num_buf:
                tokens.append(('num', num_buf))
                num_buf = ""
            ident = ""
            while i < len(expr) and (expr[i].isalnum() or expr[i] == '_'):
                ident += expr[i]
                i += 1
            if i < len(expr) and expr[i] == '(':
                tokens.append(('func', ident))
            else:
                tokens.append(('ident', ident))
        else:
            i += 1

    if num_buf:
        tokens.append(('num', num_buf))

    return tokens


def parse_expression(tokens, env):
    """Parse expression tokens using shunting-yard. Returns Decimal."""
    output = []
    operators = []

    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok[0] == 'num':
            try:
                val = Decimal(tok[1])
                # Apply ibase conversion if needed
                if env.ibase != 10:
                    val = convert_from_base(tok[1], env.ibase)
                output.append(val)
            except Exception:
                output.append(Decimal("0"))
        elif tok[0] == 'ident':
            var = tok[1]
            val = env.variables.get(var, Decimal("0"))
            output.append(val)
        elif tok[0] == 'func':
            if tok[1] == 'sqrt':
                # Consume '('
                paren_count = 1
                j = i + 2
                inner_expr = ""
                while j < len(tokens) and paren_count > 0:
                    if tokens[j][0] == 'paren' and tokens[j][1] == '(':
                        paren_count += 1
                    elif tokens[j][0] == 'paren' and tokens[j][1] == ')':
                        paren_count -= 1
                        if paren_count == 0:
                            break
                    inner_expr += " " + (tokens[j][1] if tokens[j][0] == 'op' else
                                         tokens[j][1])
                    j += 1
                # Skip past function call tokens
                inner_val = eval_expression(inner_expr.strip(), env)
                if inner_val is not None and inner_val >= 0:
                    output.append(inner_val.sqrt(Decimal.getcontext()))
                else:
                    output.append(Decimal("0"))
                i = j
                if i < len(tokens) and tokens[i][0] == 'paren' and tokens[i][1] == ')':
                    i += 1
                continue
            else:
                output.append(Decimal("0"))
        elif tok[0] == 'op':
            op = tok[1]
            while (operators and operators[-1] != '(' and
                   operators[-1] != ')' and
                   OP_PRECEDENCE.get(operators[-1], 0) >= OP_PRECEDENCE.get(op, 0)):
                apply_op(output, operators.pop())
            operators.append(op)
        elif tok[0] == 'paren':
            if tok[1] == '(':
                operators.append('(')
            elif tok[1] == ')':
                while operators and operators[-1] != '(':
                    apply_op(output, operators.pop())
                if operators and operators[-1] == '(':
                    operators.pop()
        i += 1

    while operators:
        apply_op(output, operators.pop())

    if output:
        val = output[0]
        # Apply scale
        if env.scale > 0:
            val = val.quantize(Decimal(10) ** -env.scale)
        env.last = val
        return val
    return None


def apply_op(output, op):
    """Apply an operator to the output stack."""
    if len(output) < 2 and op != '_':
        return
    if op == '_':
        if output:
            output.append(-output.pop())
        return
    b = output.pop()
    a = output.pop()
    with localcontext() as ctx:
        ctx.prec = max(getcontext().prec, env_scale() * 10 if 'env_scale' in dir() else 20)
        if op == '+':
            output.append(a + b)
        elif op == '-':
            output.append(a - b)
        elif op == '*':
            output.append(a * b)
        elif op == '/':
            if b != 0:
                output.append(a / b)
            else:
                output.append(Decimal("0"))
        elif op == '%':
            if b != 0:
                output.append(a % b)
            else:
                output.append(Decimal("0"))
        elif op == '^':
            if b == int(b):
                output.append(a ** int(b))
            else:
                output.append(a ** b)


def convert_from_base(s, base):
    """Convert a string from the given base to Decimal."""
    try:
        return Decimal(str(int(s, base)))
    except ValueError:
        return Decimal("0")


def env_scale():
    """Helper to get scale - used via closure."""
    return 0


def output_result(val, env):
    """Output a result according to obase."""
    if env.obase == 10:
        # Format with scale
        s = str(val)
        print(s)
    else:
        # Convert to target base
        try:
            n = int(val)
            if n == 0:
                print("0")
            else:
                digits = "0123456789ABCDEF"
                result = ""
                neg = n < 0
                if neg:
                    n = -n
                while n > 0:
                    result = digits[n % env.obase] + result
                    n //= env.obase
                if neg:
                    result = "-" + result
                print(result)
        except (ValueError, OverflowError):
            print(str(val))


# Make env_scale work via closure trick
def _make_apply_op():
    """Create the apply_op function with scale awareness."""
    pass


if __name__ == "__main__":
    main(sys.argv[1:])
