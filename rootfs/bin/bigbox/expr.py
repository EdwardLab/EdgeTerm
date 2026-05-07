"""
expr — evaluate expressions.
Usage: expr EXPRESSION

Exit codes: 0 if non-zero/non-null, 1 if zero/null, 2 if invalid.
"""
import re
import sys


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        print("Usage: expr EXPRESSION", file=sys.stderr)
        sys.exit(2)
    if args[0] == "--help":
        print("Usage: expr EXPRESSION")
        print("Evaluate expressions and print result.")
        print("Operators: + - * / % = != < <= > >= & | match substr index length")
        print("Exit: 0 if non-zero/non-null, 1 if zero/null, 2 if invalid")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    # Collect all args into a list of tokens for the expression parser
    result = evaluate(args)
    if result is None:
        sys.exit(2)

    # Determine exit code based on result type
    if isinstance(result, str):
        print(result)
        if result == "":
            sys.exit(1)
        sys.exit(0)
    elif isinstance(result, int):
        print(result)
        if result == 0:
            sys.exit(1)
        sys.exit(0)
    else:
        # Should not reach here
        sys.exit(1)


def evaluate(tokens):
    """Evaluate a list of expression tokens. Supports all expr operators."""
    # Handle unary + operator first: + TOKEN forces string interpretation
    if len(tokens) >= 2 and tokens[0] == "+":
        # The rest is a string argument
        rest = tokens[1:]
        val = parse_string_arg(rest)
        if val is None:
            return None
        return val

    if len(tokens) == 1:
        val = parse_string_arg(tokens)
        return val

    # Binary operators
    if len(tokens) == 3:
        left = parse_string_arg([tokens[0]])
        op = tokens[1]
        right = parse_string_arg([tokens[2]])
        if left is None or right is None:
            return None
        return evaluate_binary(left, op, right)

    # substr STRING POS LENGTH (4 args)
    if len(tokens) == 4 and tokens[0] == "substr":
        return op_substr(tokens[1], tokens[2], tokens[3])

    # index STRING CHARS (3 args)
    if len(tokens) == 3 and tokens[0] == "index":
        return op_index(tokens[1], tokens[2])

    # match STRING REGEX (3 args)
    if len(tokens) == 3 and tokens[0] == "match":
        return op_match(tokens[1], tokens[2])

    # length STRING (2 args)
    if len(tokens) == 2 and tokens[0] == "length":
        return op_length(tokens[1])

    # More complex expression: could be nested or have more tokens
    # Fallback: try to parse as binary with last two tokens as left, op, right
    # Actually expr is simple: it doesn't do nested parsing.
    # Let's try harder with the tokens
    if len(tokens) >= 3:
        # Scan for operator in the middle
        ops = {"+", "-", "*", "/", "%", "=", "!=", "<", "<=", ">", ">=", "&", "|"}
        for i, tok in enumerate(tokens):
            if tok in ops:
                left_tokens = tokens[:i]
                right_tokens = tokens[i+1:]
                left = parse_string_arg(left_tokens)
                right = parse_string_arg(right_tokens)
                if left is None or right is None:
                    return None
                return evaluate_binary(left, tok, right)

    # If we get here, try to parse as a single string
    val = parse_string_arg(tokens)
    if val is None:
        print("expr: syntax error", file=sys.stderr)
        return None
    return val


def parse_string_arg(tokens):
    """Parse a list of tokens as a string. Joins with space."""
    if not tokens:
        return ""
    return " ".join(tokens)


def parse_int(s):
    """Try to parse a string as an integer."""
    s = s.strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def evaluate_binary(left, op, right):
    """Evaluate a binary operation."""
    if op == "&":
        # Both non-empty
        if left != "" and right != "" and left != "0" and right != "0":
            return left if left != "" else right
        return "0"
    elif op == "|":
        # First non-empty
        if left != "" and left != "0":
            return left
        if right != "" and right != "0":
            return right
        return "0"
    elif op in ("+", "-", "*", "/", "%"):
        # Arithmetic operators
        lnum = parse_int(left)
        rnum = parse_int(right)
        if lnum is None or rnum is None:
            print("expr: non-integer argument", file=sys.stderr)
            return None
        if op == "+":
            return lnum + rnum
        elif op == "-":
            return lnum - rnum
        elif op == "*":
            return lnum * rnum
        elif op == "/":
            if rnum == 0:
                print("expr: division by zero", file=sys.stderr)
                return None
            # expr does integer division (truncated toward zero)
            return int(lnum / rnum)
        elif op == "%":
            if rnum == 0:
                print("expr: division by zero", file=sys.stderr)
                return None
            return lnum % rnum
    elif op == "=":
        # String equality
        if left == right:
            return "1"
        return "0"
    elif op == "!=":
        if left != right:
            return "1"
        return "0"
    elif op in ("<", "<=", ">", ">="):
        # Try numeric comparison first, then lexicographic
        lnum = parse_int(left)
        rnum = parse_int(right)
        if lnum is not None and rnum is not None:
            result = False
            if op == "<":
                result = lnum < rnum
            elif op == "<=":
                result = lnum <= rnum
            elif op == ">":
                result = lnum > rnum
            elif op == ">=":
                result = lnum >= rnum
            return "1" if result else "0"
        else:
            # Lexicographic comparison
            result = False
            if op == "<":
                result = left < right
            elif op == "<=":
                result = left <= right
            elif op == ">":
                result = left > right
            elif op == ">=":
                result = left >= right
            return "1" if result else "0"
    else:
        print(f"expr: unknown operator '{op}'", file=sys.stderr)
        return None


def op_substr(s, pos_str, len_str):
    """substr STRING POS LENGTH - extract substring."""
    try:
        pos = int(pos_str)
        length = int(len_str)
    except ValueError:
        print("expr: non-integer argument for substr", file=sys.stderr)
        return None
    if pos < 1:
        pos = 1
    # expr uses 1-based indexing
    start = pos - 1
    if start >= len(s):
        return ""
    return s[start:start + length]


def op_index(s, chars):
    """index STRING CHARS - find first position of any char."""
    for i, c in enumerate(s):
        if c in chars:
            return i + 1  # 1-based
    return 0


def op_match(s, regex):
    """match STRING REGEX - anchored match at beginning."""
    try:
        m = re.match(regex, s)
    except re.error:
        print("expr: invalid regular expression", file=sys.stderr)
        return None
    if m:
        return str(len(m.group(0)))
    return 0


def op_length(s):
    """length STRING - length of string."""
    return len(s)


if __name__ == "__main__":
    main(sys.argv[1:])
