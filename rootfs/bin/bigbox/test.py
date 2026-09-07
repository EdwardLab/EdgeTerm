"""POSIX-style test utility for EdgeTerm."""

import os
import sys


def evaluate(args):
    if not args:
        return False

    if args[0] == "!":
        return not evaluate(args[1:])

    if len(args) == 1:
        return bool(args[0])

    if len(args) == 2:
        operator, value = args
        predicates = {
            "-e": os.path.exists,
            "-f": os.path.isfile,
            "-d": os.path.isdir,
            "-s": lambda path: os.path.isfile(path) and os.path.getsize(path) > 0,
            "-r": lambda path: os.access(path, os.R_OK),
            "-w": lambda path: os.access(path, os.W_OK),
            "-x": lambda path: os.access(path, os.X_OK),
            "-L": os.path.islink,
            "-h": os.path.islink,
            "-n": lambda text: bool(text),
            "-z": lambda text: not text,
        }
        predicate = predicates.get(operator)
        if predicate is None:
            raise ValueError(f"unknown unary operator: {operator}")
        return bool(predicate(value))

    if len(args) == 3:
        left, operator, right = args
        if operator in {"=", "=="}:
            return left == right
        if operator == "!=":
            return left != right
        if operator in {"-eq", "-ne", "-gt", "-ge", "-lt", "-le"}:
            a = int(left)
            b = int(right)
            return {
                "-eq": a == b,
                "-ne": a != b,
                "-gt": a > b,
                "-ge": a >= b,
                "-lt": a < b,
                "-le": a <= b,
            }[operator]

    raise ValueError("unsupported expression")


def main(args):
    try:
        success = evaluate(list(args))
    except (TypeError, ValueError) as exc:
        print(f"test: {exc}", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(0 if success else 1)
