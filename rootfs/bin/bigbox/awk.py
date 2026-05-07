"""
awk -- pattern scanning and processing language.

Usage: awk [OPTION]... PROGRAM [FILE]...
   or: awk [OPTION]... -f PROGFILE [FILE]...

Options:
  -F FS      use FS as the field separator (default: whitespace)
  -v VAR=VAL assign variable before program execution
  -f FILE    read program from file
  -W compat  compatibility mode (stub, accepted)
"""

import re
import sys
import math
import random

VERSION = "1.0.0 (bigbox)"


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------

# Token types
TOK_EOF = "EOF"
TOK_NUMBER = "NUMBER"
TOK_STRING = "STRING"
TOK_REGEX = "REGEX"
TOK_WORD = "WORD"
TOK_LBRACE = "LBRACE"
TOK_RBRACE = "RBRACE"
TOK_LPAREN = "LPAREN"
TOK_RPAREN = "RPAREN"
TOK_LBRACKET = "LBRACKET"
TOK_RBRACKET = "RBRACKET"
TOK_SEMICOLON = "SEMICOLON"
TOK_COMMA = "COMMA"
TOK_DOLLAR = "DOLLAR"
TOK_TILDE = "TILDE"
TOK_BANG_TILDE = "BANG_TILDE"
TOK_PLUS = "PLUS"
TOK_MINUS = "MINUS"
TOK_STAR = "STAR"
TOK_SLASH = "SLASH"
TOK_PERCENT = "PERCENT"
TOK_CARET = "CARET"
TOK_PLUS_PLUS = "PLUS_PLUS"
TOK_MINUS_MINUS = "MINUS_MINUS"
TOK_EQ = "EQ"
TOK_EQ_EQ = "EQ_EQ"
TOK_BANG_EQ = "BANG_EQ"
TOK_LT = "LT"
TOK_LT_EQ = "LT_EQ"
TOK_GT = "GT"
TOK_GT_EQ = "GT_EQ"
TOK_AMP_AMP = "AMP_AMP"
TOK_PIPE_PIPE = "PIPE_PIPE"
TOK_BANG = "BANG"
TOK_QUESTION = "QUESTION"
TOK_COLON = "COLON"
TOK_PLUS_EQ = "PLUS_EQ"
TOK_MINUS_EQ = "MINUS_EQ"
TOK_STAR_EQ = "STAR_EQ"
TOK_SLASH_EQ = "SLASH_EQ"
TOK_PERCENT_EQ = "PERCENT_EQ"
TOK_CARET_EQ = "CARET_EQ"
TOK_NEWLINE = "NEWLINE"
TOK_IN = "IN"
TOK_DELETE = "DELETE"
TOK_PRINT = "PRINT"
TOK_PRINTF = "PRINTF"
TOK_IF = "IF"
TOK_ELSE = "ELSE"
TOK_WHILE = "WHILE"
TOK_FOR = "FOR"
TOK_BREAK = "BREAK"
TOK_CONTINUE = "CONTINUE"
TOK_NEXT = "NEXT"
TOK_EXIT = "EXIT"
TOK_RETURN = "RETURN"
TOK_DO = "DO"
TOK_BEGIN = "BEGIN"
TOK_END = "END"
TOK_FUNCTION = "FUNCTION"
TOK_MATCH = "MATCH"
TOK_NOT_MATCH = "NOT_MATCH"

# Keywords
KEYWORDS = {
    "if": TOK_IF,
    "else": TOK_ELSE,
    "while": TOK_WHILE,
    "for": TOK_FOR,
    "do": TOK_DO,
    "break": TOK_BREAK,
    "continue": TOK_CONTINUE,
    "next": TOK_NEXT,
    "exit": TOK_EXIT,
    "return": TOK_RETURN,
    "print": TOK_PRINT,
    "printf": TOK_PRINTF,
    "in": TOK_IN,
    "delete": TOK_DELETE,
    "BEGIN": TOK_BEGIN,
    "END": TOK_END,
    "function": TOK_FUNCTION,
    "match": TOK_MATCH,
    "sub": TOK_WORD,
    "gsub": TOK_WORD,
    "length": TOK_WORD,
    "substr": TOK_WORD,
    "index": TOK_WORD,
    "split": TOK_WORD,
    "tolower": TOK_WORD,
    "toupper": TOK_WORD,
    "sprintf": TOK_WORD,
    "int": TOK_WORD,
    "sqrt": TOK_WORD,
    "rand": TOK_WORD,
    "srand": TOK_WORD,
    "system": TOK_WORD,
    "close": TOK_WORD,
    "print": TOK_PRINT,
    "printf": TOK_PRINTF,
    "if": TOK_IF,
    "else": TOK_ELSE,
    "while": TOK_WHILE,
    "for": TOK_FOR,
    "break": TOK_BREAK,
    "continue": TOK_CONTINUE,
    "next": TOK_NEXT,
    "exit": TOK_EXIT,
    "BEGIN": TOK_BEGIN,
    "END": TOK_END,
    "function": TOK_FUNCTION,
}


class Token:
    __slots__ = ("type", "value")

    def __init__(self, typ, value=None):
        self.type = typ
        self.value = value

    def __repr__(self):
        if self.value is not None:
            return f"Token({self.type}, {self.value!r})"
        return f"Token({self.type})"


def tokenize(text):
    """Tokenize AWK program text. Returns list of Tokens."""
    tokens = []
    i = 0
    length = len(text)

    while i < length:
        ch = text[i]

        # Whitespace (non-newline) -- skip but track for string concat
        if ch in " \t\r":
            i += 1
            continue

        # Newline -- always a token separator
        if ch == "\n":
            tokens.append(Token(TOK_NEWLINE))
            i += 1
            continue

        # Comment (# ...)
        if ch == "#":
            while i < length and text[i] != "\n":
                i += 1
            continue

        # String literals: "..."
        if ch == '"':
            i += 1
            s = []
            while i < length:
                if text[i] == "\\":
                    i += 1
                    if i < length:
                        esc = text[i]
                        if esc == "n":
                            s.append("\n")
                        elif esc == "t":
                            s.append("\t")
                        elif esc == "\\":
                            s.append("\\")
                        elif esc == '"':
                            s.append('"')
                        else:
                            s.append("\\" + esc)
                        i += 1
                elif text[i] == '"':
                    i += 1
                    break
                else:
                    s.append(text[i])
                    i += 1
            tokens.append(Token(TOK_STRING, "".join(s)))
            continue

        # Regex literals: /.../
        if ch == "/":
            # We need to distinguish regex from division. Context matters.
            # A regex appears where a pattern is expected: at start of program,
            # after {, ;, newline, or logical ops.
            # Heuristic: / at start or after operator/brace is a regex.
            prev_tok = tokens[-1] if tokens else None
            is_regex = (
                prev_tok is None
                or prev_tok.type in (TOK_LBRACE, TOK_SEMICOLON, TOK_NEWLINE,
                                     TOK_LPAREN, TOK_EQ_EQ, TOK_BANG_EQ,
                                     TOK_LT, TOK_LT_EQ, TOK_GT, TOK_GT_EQ,
                                     TOK_AMP_AMP, TOK_PIPE_PIPE, TOK_BANG,
                                     TOK_TILDE, TOK_BANG_TILDE, TOK_COMMA,
                                     TOK_IF, TOK_WHILE, TOK_FOR,
                                     TOK_PLUS, TOK_MINUS, TOK_STAR, TOK_SLASH,
                                     TOK_PERCENT, TOK_CARET,
                                     TOK_QUESTION, TOK_COLON,
                                     TOK_EQ, TOK_PLUS_EQ, TOK_MINUS_EQ,
                                     TOK_STAR_EQ, TOK_SLASH_EQ, TOK_PERCENT_EQ,
                                     TOK_CARET_EQ,
                                     TOK_DO, TOK_RETURN, TOK_IN)
            )
            if is_regex:
                i += 1
                s = []
                while i < length and text[i] != "/":
                    if text[i] == "\\":
                        i += 1
                        if i < length:
                            s.append(text[i])
                            i += 1
                    else:
                        s.append(text[i])
                        i += 1
                if i < length:
                    i += 1  # skip closing /
                tokens.append(Token(TOK_REGEX, "".join(s)))
                continue

        # Multi-character operators
        rest = text[i:]

        # Two-char operators
        if rest.startswith("++"):
            tokens.append(Token(TOK_PLUS_PLUS))
            i += 2
            continue
        if rest.startswith("--"):
            tokens.append(Token(TOK_MINUS_MINUS))
            i += 2
            continue
        if rest.startswith("=="):
            tokens.append(Token(TOK_EQ_EQ))
            i += 2
            continue
        if rest.startswith("!="):
            tokens.append(Token(TOK_BANG_EQ))
            i += 2
            continue
        if rest.startswith("<="):
            tokens.append(Token(TOK_LT_EQ))
            i += 2
            continue
        if rest.startswith(">="):
            tokens.append(Token(TOK_GT_EQ))
            i += 2
            continue
        if rest.startswith("&&"):
            tokens.append(Token(TOK_AMP_AMP))
            i += 2
            continue
        if rest.startswith("||"):
            tokens.append(Token(TOK_PIPE_PIPE))
            i += 2
            continue
        if rest.startswith("!~"):
            tokens.append(Token(TOK_BANG_TILDE))
            i += 2
            continue
        if rest.startswith("~"):
            tokens.append(Token(TOK_TILDE))
            i += 1
            continue
        if rest.startswith("+="):
            tokens.append(Token(TOK_PLUS_EQ))
            i += 2
            continue
        if rest.startswith("-="):
            tokens.append(Token(TOK_MINUS_EQ))
            i += 2
            continue
        if rest.startswith("*="):
            tokens.append(Token(TOK_STAR_EQ))
            i += 2
            continue
        if rest.startswith("/="):
            tokens.append(Token(TOK_SLASH_EQ))
            i += 2
            continue
        if rest.startswith("%="):
            tokens.append(Token(TOK_PERCENT_EQ))
            i += 2
            continue
        if rest.startswith("^="):
            tokens.append(Token(TOK_CARET_EQ))
            i += 2
            continue
        if rest.startswith(">>"):
            # Redirection target -- treat as >
            tokens.append(Token(TOK_GT))
            i += 2
            continue
        if rest.startswith("|&"):
            # Two-way pipe -- treat as |
            tokens.append(Token(TOK_WORD, "|&"))
            i += 2
            continue
        if rest.startswith("|"):
            # Pipe to command
            tokens.append(Token(TOK_WORD, "|"))
            i += 1
            continue

        # ~ handled above, but the 2-char check consumed 2 chars. Fix: re-check.
        # Actually let's redo this properly.
        if ch == "~":
            tokens.append(Token(TOK_TILDE))
            i += 1
            continue

        # Single-character operators
        single_map = {
            "{": TOK_LBRACE, "}": TOK_RBRACE,
            "(": TOK_LPAREN, ")": TOK_RPAREN,
            "[": TOK_LBRACKET, "]": TOK_RBRACKET,
            ";": TOK_SEMICOLON, ",": TOK_COMMA,
            "+": TOK_PLUS, "-": TOK_MINUS,
            "*": TOK_STAR,
            "%": TOK_PERCENT, "^": TOK_CARET,
            "!": TOK_BANG,
            "?": TOK_QUESTION, ":": TOK_COLON,
            "$": TOK_DOLLAR,
            "=": TOK_EQ,
            "<": TOK_LT, ">": TOK_GT,
            "/": TOK_SLASH,
        }
        if ch in single_map:
            tokens.append(Token(single_map[ch]))
            i += 1
            continue

        # Numbers
        if ch.isdigit() or (ch == "." and i + 1 < length and text[i + 1].isdigit()):
            start = i
            if text[i] == "0" and i + 1 < length and text[i + 1] in "xX":
                i += 2
                while i < length and (text[i].isdigit() or text[i] in "abcdefABCDEF"):
                    i += 1
            else:
                while i < length and (text[i].isdigit() or text[i] == "."):
                    i += 1
                # Handle scientific notation
                if i < length and text[i] in "eE":
                    i += 1
                    if i < length and text[i] in "+-":
                        i += 1
                    while i < length and text[i].isdigit():
                        i += 1
            tokens.append(Token(TOK_NUMBER, text[start:i]))
            continue

        # Words (variables, function names, keywords)
        if ch.isalpha() or ch == "_":
            start = i
            while i < length and (text[i].isalnum() or text[i] == "_"):
                i += 1
            word = text[start:i]
            tok_type = KEYWORDS.get(word, TOK_WORD)
            tokens.append(Token(tok_type, word))
            continue

        # Skip any other character
        i += 1

    tokens.append(Token(TOK_EOF))
    return tokens


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

class ASTNode:
    """Base AST node."""
    __slots__ = ()


class Program(ASTNode):
    __slots__ = ("blocks",)

    def __init__(self):
        self.blocks = []  # list of PatternAction

    def __repr__(self):
        return f"Program({self.blocks})"


class PatternAction(ASTNode):
    __slots__ = ("pattern", "actions", "is_begin", "is_end")

    def __init__(self, pattern=None, actions=None, is_begin=False, is_end=False):
        self.pattern = pattern
        self.actions = actions if actions else []
        self.is_begin = is_begin
        self.is_end = is_end

    def __repr__(self):
        return f"PatternAction(pattern={self.pattern}, actions={self.actions}, begin={self.is_begin}, end={self.is_end})"


# Expression nodes
class NumLiteral(ASTNode):
    __slots__ = ("value",)

    def __init__(self, value):
        self.value = value

    def __repr__(self):
        return f"Num({self.value})"


class StrLiteral(ASTNode):
    __slots__ = ("value",)

    def __init__(self, value):
        self.value = value

    def __repr__(self):
        return f"Str({self.value!r})"


class RegexLiteral(ASTNode):
    __slots__ = ("pattern",)

    def __init__(self, pattern):
        self.pattern = pattern

    def __repr__(self):
        return f"Regex(/{self.pattern}/)"


class VarRef(ASTNode):
    __slots__ = ("name",)

    def __init__(self, name):
        self.name = name

    def __repr__(self):
        return f"Var({self.name})"


class FieldRef(ASTNode):
    __slots__ = ("expr",)

    def __init__(self, expr):
        self.expr = expr

    def __repr__(self):
        return f"Field({self.expr})"


class ArrayAccess(ASTNode):
    __slots__ = ("name", "index")

    def __init__(self, name, index):
        self.name = name
        self.index = index

    def __repr__(self):
        return f"Array({self.name}[{self.index}])"


class UnaryOp(ASTNode):
    __slots__ = ("op", "expr")

    def __init__(self, op, expr):
        self.op = op
        self.expr = expr

    def __repr__(self):
        return f"Unary({self.op} {self.expr})"


class BinaryOp(ASTNode):
    __slots__ = ("op", "left", "right")

    def __init__(self, op, left, right):
        self.op = op
        self.left = left
        self.right = right

    def __repr__(self):
        return f"Binary({self.left} {self.op} {self.right})"


class TernaryOp(ASTNode):
    __slots__ = ("cond", "true_expr", "false_expr")

    def __init__(self, cond, true_expr, false_expr):
        self.cond = cond
        self.true_expr = true_expr
        self.false_expr = false_expr

    def __repr__(self):
        return f"Ternary({self.cond} ? {self.true_expr} : {self.false_expr})"


class MatchOp(ASTNode):
    __slots__ = ("left", "regex", "negate")

    def __init__(self, left, regex, negate=False):
        self.left = left
        self.regex = regex
        self.negate = negate

    def __repr__(self):
        return f"Match({self.left} {'!~' if self.negate else '~'} /{self.regex.pattern}/)"


class Assign(ASTNode):
    __slots__ = ("target", "op", "value")

    def __init__(self, target, op, value):
        self.target = target  # VarRef or FieldRef or ArrayAccess
        self.op = op
        self.value = value

    def __repr__(self):
        return f"Assign({self.target} {self.op} {self.value})"


class PreIncDec(ASTNode):
    __slots__ = ("op", "target")

    def __init__(self, op, target):
        self.op = op  # "++" or "--"
        self.target = target

    def __repr__(self):
        return f"Pre{self.op}({self.target})"


class PostIncDec(ASTNode):
    __slots__ = ("op", "target")

    def __init__(self, op, target):
        self.op = op
        self.target = target

    def __repr__(self):
        return f"Post{self.op}({self.target})"


class FuncCall(ASTNode):
    __slots__ = ("name", "args")

    def __init__(self, name, args):
        self.name = name
        self.args = args

    def __repr__(self):
        return f"Call({self.name}({self.args}))"


# Statement nodes
class PrintStmt(ASTNode):
    __slots__ = ("args", "redirect")

    def __init__(self, args=None, redirect=None):
        self.args = args if args else []
        self.redirect = redirect

    def __repr__(self):
        return f"Print({self.args})"


class PrintfStmt(ASTNode):
    __slots__ = ("args", "redirect")

    def __init__(self, args=None, redirect=None):
        self.args = args if args else []
        self.redirect = redirect

    def __repr__(self):
        return f"Printf({self.args})"


class IfStmt(ASTNode):
    __slots__ = ("cond", "true_branch", "false_branch")

    def __init__(self, cond, true_branch, false_branch=None):
        self.cond = cond
        self.true_branch = true_branch
        self.false_branch = false_branch

    def __repr__(self):
        return f"If({self.cond}, {self.true_branch}, else={self.false_branch})"


class WhileStmt(ASTNode):
    __slots__ = ("cond", "body")

    def __init__(self, cond, body):
        self.cond = cond
        self.body = body

    def __repr__(self):
        return f"While({self.cond}, {self.body})"


class ForStmt(ASTNode):
    __slots__ = ("init", "cond", "incr", "body")

    def __init__(self, init, cond, incr, body):
        self.init = init
        self.cond = cond
        self.incr = incr
        self.body = body

    def __repr__(self):
        return f"For({self.init}; {self.cond}; {self.incr})"


class ForInStmt(ASTNode):
    __slots__ = ("var", "array", "body")

    def __init__(self, var, array, body):
        self.var = var
        self.array = array
        self.body = body

    def __repr__(self):
        return f"ForIn({self.var} in {self.array})"


class BreakStmt(ASTNode):
    __slots__ = ()

    def __repr__(self):
        return "Break"


class ContinueStmt(ASTNode):
    __slots__ = ()

    def __repr__(self):
        return "Continue"


class NextStmt(ASTNode):
    __slots__ = ()

    def __repr__(self):
        return "Next"


class ExitStmt(ASTNode):
    __slots__ = ("code",)

    def __init__(self, code=None):
        self.code = code

    def __repr__(self):
        return f"Exit({self.code})"


class DeleteStmt(ASTNode):
    __slots__ = ("array", "key")

    def __init__(self, array, key=None):
        self.array = array  # VarRef
        self.key = key  # optional expression

    def __repr__(self):
        return f"Delete({self.array}[{self.key}])"


class ExprStmt(ASTNode):
    __slots__ = ("expr",)

    def __init__(self, expr):
        self.expr = expr

    def __repr__(self):
        return f"ExprStmt({self.expr})"


# Parser exception
class ParseError(Exception):
    pass


class Parser:
    """Recursive-descent parser for AWK."""

    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0
        self.current = self.tokens[0]

    def advance(self):
        self.pos += 1
        if self.pos < len(self.tokens):
            self.current = self.tokens[self.pos]
        else:
            self.current = Token(TOK_EOF)

    def peek(self, offset=0):
        idx = self.pos + offset
        if idx < len(self.tokens):
            return self.tokens[idx]
        return Token(TOK_EOF)

    def expect(self, typ, value=None):
        if self.current.type != typ:
            raise ParseError(f"Expected {typ}, got {self.current.type} ({self.current.value})")
        if value is not None and self.current.value != value:
            raise ParseError(f"Expected {value}, got {self.current.value}")
        tok = self.current
        self.advance()
        return tok

    def skip_newlines(self):
        while self.current.type == TOK_NEWLINE:
            self.advance()

    def parse_program(self):
        """program := (rule newline)* rule?"""
        prog = Program()
        self.skip_newlines()

        while self.current.type != TOK_EOF:
            rule = self.parse_rule()
            if rule is not None:
                prog.blocks.append(rule)
            self.skip_newlines()
            # Allow semicolons as separators between rules
            while self.current.type == TOK_SEMICOLON:
                self.advance()
                self.skip_newlines()

        return prog

    def parse_rule(self):
        """rule := (pattern { action }) | (pattern) | ({ action }) | BEGIN { action } | END { action }"""
        if self.current.type == TOK_BEGIN:
            self.advance()
            self.skip_newlines()
            self.expect(TOK_LBRACE)
            actions = self.parse_actions()
            return PatternAction(is_begin=True, actions=actions)
        elif self.current.type == TOK_END:
            self.advance()
            self.skip_newlines()
            self.expect(TOK_LBRACE)
            actions = self.parse_actions()
            return PatternAction(is_end=True, actions=actions)

        # Peek ahead to determine pattern/action structure
        # rule: pattern { action }
        # rule: pattern (no brace = default action)
        # rule: { action } (no pattern)
        if self.current.type == TOK_LBRACE:
            self.advance()
            actions = self.parse_actions()
            return PatternAction(pattern=None, actions=actions)

        # Parse pattern then optionally { action }
        pattern = self.parse_pattern()
        pa = PatternAction(pattern=pattern)

        self.skip_newlines()
        if self.current.type == TOK_LBRACE:
            self.advance()
            pa.actions = self.parse_actions()
        else:
            # No braces: default action is { print }
            pa.actions = [PrintStmt(args=[])]

        return pa

    def parse_pattern(self):
        """pattern := expr | range ("," expr) | BEGIN | END"""
        # Handle empty pattern (just action)
        # if the next meaningful token is {, there's no pattern
        # We already handled that case above.

        # Check for range pattern: expr1 , expr2
        left = self.parse_expr()
        if self.current.type == TOK_COMMA:
            self.advance()
            right = self.parse_expr()
            return BinaryOp(",", left, right)
        return left

    def parse_actions(self):
        """action := stmt (";" | newline)* stmt ... }"""
        actions = []
        while self.current.type != TOK_RBRACE and self.current.type != TOK_EOF:
            self.skip_newlines()
            if self.current.type == TOK_SEMICOLON:
                self.advance()
                continue
            stmt = self.parse_stmt()
            if stmt is not None:
                actions.append(stmt)
            self.skip_newlines()
            if self.current.type == TOK_SEMICOLON:
                self.advance()

        if self.current.type == TOK_RBRACE:
            self.advance()  # consume }
        return actions

    def parse_stmt(self):
        """stmt := print | printf | if | while | for | do | break | continue | next | exit | delete | expr"""
        if self.current.type == TOK_PRINT:
            return self.parse_print()
        elif self.current.type == TOK_PRINTF:
            return self.parse_printf()
        elif self.current.type == TOK_IF:
            return self.parse_if()
        elif self.current.type == TOK_WHILE:
            return self.parse_while()
        elif self.current.type == TOK_FOR:
            return self.parse_for()
        elif self.current.type == TOK_DO:
            return self.parse_do()
        elif self.current.type == TOK_BREAK:
            self.advance()
            return BreakStmt()
        elif self.current.type == TOK_CONTINUE:
            self.advance()
            return ContinueStmt()
        elif self.current.type == TOK_NEXT:
            self.advance()
            return NextStmt()
        elif self.current.type == TOK_EXIT:
            self.advance()
            if self.current.type == TOK_NUMBER or self.current.type == TOK_LPAREN:
                # exit code can be a number or expression
                code = self.parse_primary_expr()
            else:
                code = None
            return ExitStmt(code)
        elif self.current.type == TOK_DELETE:
            return self.parse_delete()
        elif self.current.type == TOK_LBRACE:
            # Block statement { stmt; stmt; ... }
            self.advance()
            body = []
            while self.current.type != TOK_RBRACE and self.current.type != TOK_EOF:
                self.skip_newlines()
                s = self.parse_stmt()
                if s is not None:
                    body.append(s)
                self.skip_newlines()
                if self.current.type == TOK_SEMICOLON:
                    self.advance()
            if self.current.type == TOK_RBRACE:
                self.advance()
            # Return as a list of statements (treated as a block by the evaluator)
            return body
        else:
            # Expression statement
            expr = self.parse_expr()
            return ExprStmt(expr)

    def parse_print(self):
        self.advance()
        args = []
        redirect = None

        # Check for redirection
        # print > file, print >> file, print | cmd
        if self.current.type == TOK_GT:
            self.advance()
            redirect = (">", self.parse_expr())
            return PrintStmt(args, redirect)
        elif (self.current.type == TOK_WORD and self.current.value == "|"):
            self.advance()
            redirect = ("|", self.parse_expr())
            return PrintStmt(args, redirect)

        # Parse comma-separated expressions
        while self.current.type not in (TOK_NEWLINE, TOK_RBRACE, TOK_SEMICOLON,
                                         TOK_EOF, TOK_GT):
            if self.current.type == TOK_COMMA:
                self.advance()
                continue
            expr = self.parse_expr()
            args.append(expr)
            if self.current.type == TOK_COMMA:
                continue
            # Check for redirection after arguments
            if self.current.type == TOK_GT:
                self.advance()
                redirect = (">", self.parse_expr())
                break
            if self.current.type == TOK_WORD and self.current.value == ">":
                self.advance()
                redirect = (">", self.parse_expr())
                break
            if self.current.type == TOK_WORD and self.current.value == ">>":
                self.advance()
                redirect = (">>", self.parse_expr())
                break
            if (self.current.type == TOK_WORD and self.current.value == "|"):
                self.advance()
                redirect = ("|", self.parse_expr())
                break
            break

        return PrintStmt(args, redirect)

    def parse_printf(self):
        self.advance()
        args = []
        redirect = None

        while self.current.type not in (TOK_NEWLINE, TOK_RBRACE, TOK_SEMICOLON, TOK_EOF):
            if self.current.type == TOK_COMMA:
                self.advance()
                continue
            expr = self.parse_expr()
            args.append(expr)
            if self.current.type == TOK_COMMA:
                continue
            # Check for redirection
            if self.current.type == TOK_GT:
                self.advance()
                redirect = (">", self.parse_expr())
                break
            if self.current.type == TOK_WORD and self.current.value == ">":
                self.advance()
                redirect = (">", self.parse_expr())
                break
            if self.current.type == TOK_WORD and self.current.value == ">>":
                self.advance()
                redirect = (">>", self.parse_expr())
                break
            if (self.current.type == TOK_WORD and self.current.value == "|"):
                self.advance()
                redirect = ("|", self.parse_expr())
                break
            break

        return PrintfStmt(args, redirect)

    def parse_if(self):
        self.advance()
        self.skip_newlines()
        self.expect(TOK_LPAREN)
        cond = self.parse_expr()
        self.expect(TOK_RPAREN)
        self.skip_newlines()
        true_branch = self.parse_stmt()
        self.skip_newlines()
        false_branch = None
        if self.current.type == TOK_ELSE:
            self.advance()
            self.skip_newlines()
            false_branch = self.parse_stmt()
        return IfStmt(cond, true_branch, false_branch)

    def parse_while(self):
        self.advance()
        self.skip_newlines()
        self.expect(TOK_LPAREN)
        cond = self.parse_expr()
        self.expect(TOK_RPAREN)
        self.skip_newlines()
        body = self.parse_stmt()
        return WhileStmt(cond, body)

    def parse_for(self):
        self.advance()
        self.skip_newlines()
        self.expect(TOK_LPAREN)

        # Check for "for (var in array)"
        if self.current.type == TOK_WORD:
            # Peek ahead to see if it's "var in"
            save_pos = self.pos
            tok1 = self.current
            self.advance()
            if self.current.type == TOK_IN:
                self.advance()
                array_expr = self.parse_expr()
                self.expect(TOK_RPAREN)
                self.skip_newlines()
                body = self.parse_stmt()
                return ForInStmt(tok1.value, array_expr, body)
            else:
                # Restore for regular for loop
                self.pos = save_pos
                self.current = self.tokens[self.pos]

        # Regular for loop: for (init; cond; incr)
        init = self.parse_expr()
        self.expect(TOK_SEMICOLON)
        cond = self.parse_expr()
        self.expect(TOK_SEMICOLON)
        incr = self.parse_expr()
        self.expect(TOK_RPAREN)
        self.skip_newlines()
        body = self.parse_stmt()
        return ForStmt(init, cond, incr, body)

    def parse_do(self):
        self.advance()
        self.skip_newlines()
        body = self.parse_stmt()
        self.skip_newlines()
        self.expect(TOK_WORD, "while")
        self.skip_newlines()
        self.expect(TOK_LPAREN)
        cond = self.parse_expr()
        self.expect(TOK_RPAREN)
        # Wrap in while loop with do-while semantics
        return WhileStmt(cond, body)

    def parse_delete(self):
        self.advance()
        name = self.expect(TOK_WORD).value
        if self.current.type == TOK_LBRACKET:
            self.advance()
            key = self.parse_expr()
            self.expect(TOK_RBRACKET)
        else:
            key = None
        return DeleteStmt(name, key)

    # ---- Expression parsing ----
    # Precedence (lowest to highest):
    # 1. ? : (ternary)
    # 2. ||
    # 3. &&
    # 4. ~ !~ (match)
    # 5. == != < <= > >= (relational)
    # 6. string concatenation (implicit, space between operands)
    # 7. + - (additive)
    # 8. * / % (multiplicative)
    # 9. ^ (power, right-associative)
    # 10. unary + - !
    # 11. ++ -- (pre)
    # 12. $ (field reference)
    # 13. primary (number, string, var, array, funcall, parens, regex)

    def parse_expr(self):
        return self.parse_ternary()

    def parse_ternary(self):
        expr = self.parse_logical_or()
        while self.current.type == TOK_QUESTION:
            self.advance()
            true_expr = self.parse_expr()
            self.expect(TOK_COLON)
            false_expr = self.parse_expr()
            expr = TernaryOp(expr, true_expr, false_expr)
        return expr

    def parse_logical_or(self):
        left = self.parse_logical_and()
        while self.current.type == TOK_PIPE_PIPE:
            self.advance()
            right = self.parse_logical_and()
            left = BinaryOp("||", left, right)
        return left

    def parse_logical_and(self):
        left = self.parse_match()
        while self.current.type == TOK_AMP_AMP:
            self.advance()
            right = self.parse_match()
            left = BinaryOp("&&", left, right)
        return left

    def parse_match(self):
        left = self.parse_relational()
        while self.current.type in (TOK_TILDE, TOK_BANG_TILDE):
            negate = self.current.type == TOK_BANG_TILDE
            self.advance()
            right = self.parse_relational()
            if isinstance(right, RegexLiteral):
                left = MatchOp(left, right, negate)
            else:
                # Treat as ~ operator with string on right
                left = BinaryOp("!~" if negate else "~", left, right)
        return left

    def parse_relational(self):
        left = self.parse_concat()
        while self.current.type in (TOK_EQ_EQ, TOK_BANG_EQ, TOK_LT, TOK_GT, TOK_LT_EQ, TOK_GT_EQ):
            op = self.current.type
            self.advance()
            right = self.parse_concat()
            left = BinaryOp(op, left, right)
        return left

    def parse_concat(self):
        """String concatenation: implicit operator between expressions."""
        left = self.parse_additive()
        while True:
            # Concatenation happens when two expressions appear adjacently
            # without an operator between them. After an expression, the next
            # token must be a primary expression start for concat to apply.
            # But NOT if we're in a comma-separated list or after certain tokens.
            tok = self.current
            if tok.type in (TOK_NUMBER, TOK_STRING, TOK_REGEX, TOK_WORD,
                            TOK_LPAREN, TOK_DOLLAR, TOK_PLUS_PLUS, TOK_MINUS_MINUS,
                            TOK_LBRACKET):
                # Check that we're not in a context where concat shouldn't apply
                # e.g., after an operator that's already been handled
                right = self.parse_additive()
                left = BinaryOp("concat", left, right)
            else:
                break
        return left

    def parse_additive(self):
        left = self.parse_multiplicative()
        while self.current.type in (TOK_PLUS, TOK_MINUS):
            op = self.current.type
            self.advance()
            right = self.parse_multiplicative()
            left = BinaryOp(op, left, right)
        return left

    def parse_multiplicative(self):
        left = self.parse_power()
        while self.current.type in (TOK_STAR, TOK_SLASH, TOK_PERCENT):
            op = self.current.type
            self.advance()
            right = self.parse_power()
            left = BinaryOp(op, left, right)
        return left

    def parse_power(self):
        left = self.parse_unary()
        if self.current.type == TOK_CARET:
            self.advance()
            right = self.parse_power()  # right-associative
            left = BinaryOp("^", left, right)
        return left

    def parse_unary(self):
        if self.current.type == TOK_PLUS:
            self.advance()
            return UnaryOp("+", self.parse_unary())
        elif self.current.type == TOK_MINUS:
            self.advance()
            return UnaryOp("-", self.parse_unary())
        elif self.current.type == TOK_BANG:
            self.advance()
            return UnaryOp("!", self.parse_unary())
        elif self.current.type == TOK_PLUS_PLUS:
            self.advance()
            target = self.parse_field_ref()
            return PreIncDec("++", target)
        elif self.current.type == TOK_MINUS_MINUS:
            self.advance()
            target = self.parse_field_ref()
            return PreIncDec("--", target)
        return self.parse_postfix()

    def parse_postfix(self):
        target = self.parse_field_ref()
        if self.current.type == TOK_PLUS_PLUS:
            self.advance()
            return PostIncDec("++", target)
        elif self.current.type == TOK_MINUS_MINUS:
            self.advance()
            return PostIncDec("--", target)
        return target

    def parse_field_ref(self):
        if self.current.type == TOK_DOLLAR:
            self.advance()
            expr = self.parse_primary_expr()
            return FieldRef(expr)
        return self.parse_primary()

    def parse_primary(self):
        expr = self.parse_primary_expr()
        # Array access: arr[expr]
        if self.current.type == TOK_LBRACKET:
            self.advance()
            index = self.parse_expr()
            self.expect(TOK_RBRACKET)
            if isinstance(expr, VarRef):
                return ArrayAccess(expr.name, index)
            raise ParseError("Invalid array access")
        return expr

    def parse_primary_expr(self):
        if self.current.type == TOK_NUMBER:
            tok = self.current
            self.advance()
            val = tok.value
            if "." in val or "e" in val or "E" in val:
                return NumLiteral(float(val))
            return NumLiteral(int(val, 0) if val.startswith("0x") or val.startswith("0X") else int(val))
        elif self.current.type == TOK_STRING:
            tok = self.current
            self.advance()
            return StrLiteral(tok.value)
        elif self.current.type == TOK_REGEX:
            tok = self.current
            self.advance()
            return RegexLiteral(tok.value)
        elif self.current.type == TOK_LPAREN:
            self.advance()
            expr = self.parse_expr()
            self.expect(TOK_RPAREN)
            return expr
        elif self.current.type == TOK_WORD:
            name = self.current.value
            self.advance()
            # Check if it's a function call
            if self.current.type == TOK_LPAREN:
                self.advance()
                args = []
                while self.current.type != TOK_RPAREN and self.current.type != TOK_EOF:
                    self.skip_newlines()
                    arg = self.parse_expr()
                    args.append(arg)
                    if self.current.type == TOK_COMMA:
                        self.advance()
                        self.skip_newlines()
                self.expect(TOK_RPAREN)
                return FuncCall(name, args)
            return VarRef(name)
        elif self.current.type == TOK_IN:
            # bare "in" keyword - used in for loops, shouldn't appear here
            self.advance()
            return VarRef("in")
        elif self.current.type == TOK_DOLLAR:
            # Can start with $ for field ref even without unary
            self.advance()
            expr = self.parse_primary_expr()
            return FieldRef(expr)
        else:
            raise ParseError(f"Unexpected token: {self.current.type} ({self.current.value})")

    def parse_primary_expr_for_field(self):
        """Parse a primary expression that can follow $."""
        return self.parse_primary_expr()


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------

class AwkRuntime:
    """Runtime state for AWK program execution."""

    def __init__(self, fs=None, variables=None):
        # Built-in variables
        self.NR = 0
        self.NF = 0
        self.FNR = 0
        self.FS = fs if fs else " "
        self.OFS = " "
        self.ORS = "\n"
        self.RS = "\n"
        self.RSTART = 0
        self.RLENGTH = 0
        self.FILENAME = ""

        # Current record data
        self._record = ""  # $0
        self._fields = []  # $1, $2, ...

        # User variables (including -v assignments)
        self.vars = {}
        if variables:
            self.vars.update(variables)

        # Arrays
        self.arrays = {}

        # Program state
        self.done = False
        self._exit_code = 0
        self._skip_remaining = False  # for "next"
        self._loop_break = False
        self._loop_continue = False

        # Regex cache
        self._re_cache = {}

        # Redirection files
        self._open_files = {}

        # For tracking range patterns
        self._range_active = {}  # map from tuple(id(ast_node)) -> bool

        # Random seed
        random.seed()

    def get_var(self, name):
        """Get a variable value."""
        # Built-in variables
        if name == "NR":
            return float(self.NR)
        elif name == "NF":
            return float(self.NF)
        elif name == "FS":
            return self.FS
        elif name == "OFS":
            return self.OFS
        elif name == "ORS":
            return self.ORS
        elif name == "RS":
            return self.RS
        elif name == "RSTART":
            return float(self.RSTART)
        elif name == "RLENGTH":
            return float(self.RLENGTH)
        elif name == "FILENAME":
            return self.FILENAME
        elif name == "FNR":
            return float(self.FNR)
        elif name == "ARGC":
            return 0.0
        elif name == "ARGV":
            return ""
        elif name == "ENVIRON":
            return ""
        elif name == "SUBSEP":
            return "\x1c"
        elif name == "CONVFMT":
            return "%.6g"
        elif name == "OFMT":
            return "%.6g"
        return self.vars.get(name, "")

    def set_var(self, name, value):
        """Set a variable value."""
        str_val = to_string(value)
        num_val = to_number(value)
        if name == "NR":
            self.NR = int(num_val)
        elif name == "NF":
            self.NF = int(num_val)
            self._update_fields_from_nf()
        elif name == "FS":
            self.FS = str_val
        elif name == "OFS":
            self.OFS = str_val
        elif name == "ORS":
            self.ORS = str_val
        elif name == "RS":
            self.RS = str_val
        elif name == "RSTART":
            self.RSTART = int(num_val)
        elif name == "RLENGTH":
            self.RLENGTH = int(num_val)
        elif name == "FILENAME":
            self.FILENAME = str_val
        elif name == "FNR":
            self.FNR = int(num_val)
        else:
            self.vars[name] = str_val

    def get_array(self, name):
        if name not in self.arrays:
            self.arrays[name] = {}
        return self.arrays[name]

    def set_record(self, record):
        """Set $0 and parse fields."""
        self._record = record
        self._parse_fields()

    def get_record(self):
        return self._record

    def set_field(self, n, value):
        """Set $n and possibly NF."""
        sval = to_string(value)
        if n == 0:
            self._record = sval
            self._parse_fields()
            return

        # Extend fields array if needed
        while len(self._fields) < n:
            self._fields.append("")
        self._fields[n - 1] = sval
        if n > self.NF:
            self.NF = n
        # Reconstruct $0
        self._rebuild_record()

    def get_field(self, n):
        """Get $n value."""
        n_int = int(to_number(n)) if not isinstance(n, int) else n
        if n_int < 0:
            return ""
        if n_int == 0:
            return self._record
        if n_int <= len(self._fields):
            return self._fields[n_int - 1]
        return ""

    def _parse_fields(self):
        """Split $0 into fields using FS."""
        if not self._record:
            self._fields = []
            self.NF = 0
            return

        if self.FS == " " or self.FS is None:
            # Default: split on whitespace, skip leading/trailing, empty fields not returned
            fields = self._record.split()
            self._fields = fields
            self.NF = len(fields)
        elif self.FS == "":
            # Empty FS: split into individual characters
            self._fields = list(self._record)
            self.NF = len(self._fields)
        elif len(self.FS) == 1:
            # Single character separator
            if self._record.endswith(self.FS):
                self._fields = self._record.split(self.FS)
            else:
                self._fields = self._record.split(self.FS)
            self.NF = len(self._fields)
        else:
            # Regex separator
            try:
                result = re.split(self.FS, self._record)
                self._fields = result
                self.NF = len(self._fields)
            except re.error:
                self._fields = [self._record]
                self.NF = 1

    def _rebuild_record(self):
        """Reconstruct $0 from fields using OFS."""
        self._record = self.OFS.join(self._fields)

    def _update_fields_from_nf(self):
        """Adjust fields array when NF is explicitly set."""
        while len(self._fields) > self.NF:
            self._fields.pop()
        while len(self._fields) < self.NF:
            self._fields.append("")

    def get_regex(self, pattern_str):
        """Compile and cache a regex pattern."""
        # Convert AWK regex to Python regex
        if pattern_str not in self._re_cache:
            self._re_cache[pattern_str] = re.compile(pattern_str)
        return self._re_cache[pattern_str]

    def close_file(self, filename):
        """Close a redirection file."""
        s = to_string(filename)
        if s in self._open_files:
            self._open_files[s].close()
            del self._open_files[s]
            return 1
        return 0


def to_string(val):
    """Convert a value to string (AWK semantics)."""
    if isinstance(val, bool):
        return "1" if val else "0"
    if isinstance(val, float):
        if val == int(val) and not (abs(val) >= 2**53):
            return str(int(val))
        return str(val)
    if isinstance(val, int):
        return str(val)
    if val is None:
        return ""
    return str(val)


def to_number(val):
    """Convert a value to number (AWK semantics)."""
    if isinstance(val, (int, float)):
        return val
    s = str(val).strip()
    if not s:
        return 0.0
    try:
        if s.startswith("0x") or s.startswith("0X"):
            return float(int(s, 16))
        return float(s)
    except (ValueError, TypeError):
        # Try to extract leading numeric portion
        m = re.match(r"^(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)", s)
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                pass
        return 0.0


def is_truthy(val):
    """Check truthiness: non-zero number and non-empty string."""
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return val != 0
    if isinstance(val, str):
        return val != "" and val != "0"
    return val != "" and val != 0


def flatten_stmts(stmt):
    """If stmt is a list (block), return it; otherwise wrap in list."""
    if isinstance(stmt, list):
        return stmt
    return [stmt]


class AwkEvaluator:
    """Evaluates parsed AWK AST."""

    def __init__(self, rt):
        self.rt = rt

    def eval_expr(self, node):
        """Evaluate an expression node and return a value (string or number)."""
        if node is None:
            return ""

        if isinstance(node, NumLiteral):
            return node.value
        elif isinstance(node, StrLiteral):
            return node.value
        elif isinstance(node, RegexLiteral):
            return node.pattern  # Used as string in some contexts
        elif isinstance(node, VarRef):
            return self.rt.get_var(node.name)
        elif isinstance(node, FieldRef):
            n = to_number(self.eval_expr(node.expr))
            return self.rt.get_field(int(n))
        elif isinstance(node, ArrayAccess):
            arr = self.rt.get_array(node.name)
            idx = to_string(self.eval_expr(node.index))
            return arr.get(idx, "")
        elif isinstance(node, UnaryOp):
            val = self.eval_expr(node.expr)
            if node.op == "+":
                return to_number(val)
            elif node.op == "-":
                return -to_number(val)
            elif node.op == "!":
                return 1.0 if not is_truthy(val) else 0.0
            return val
        elif isinstance(node, BinaryOp):
            return self._eval_binary(node)
        elif isinstance(node, TernaryOp):
            cond = self.eval_expr(node.cond)
            if is_truthy(cond):
                return self.eval_expr(node.true_expr)
            return self.eval_expr(node.false_expr)
        elif isinstance(node, MatchOp):
            return self._eval_match(node)
        elif isinstance(node, FuncCall):
            return self._eval_func_call(node)
        elif isinstance(node, PostIncDec):
            return self._eval_postinc(node)
        elif isinstance(node, PreIncDec):
            return self._eval_preinc(node)
        elif isinstance(node, Assign):
            return self._eval_assign(node)
        elif isinstance(node, ExprStmt):
            return self.eval_expr(node.expr)
        elif isinstance(node, (int, float, str)):
            return node
        return ""

    def _eval_binary(self, node):
        op_token_type = node.op
        left = self.eval_expr(node.left)
        right = self.eval_expr(node.right)

        if isinstance(op_token_type, str):
            op = op_token_type
        else:
            # Map token type to string
            token_to_op = {
                TOK_PLUS: "+", TOK_MINUS: "-", TOK_STAR: "*",
                TOK_SLASH: "/", TOK_PERCENT: "%", TOK_CARET: "^",
                TOK_EQ_EQ: "==", TOK_BANG_EQ: "!=",
                TOK_LT: "<", TOK_LT_EQ: "<=", TOK_GT: ">", TOK_GT_EQ: ">=",
                TOK_AMP_AMP: "&&", TOK_PIPE_PIPE: "||",
                TOK_PLUS: "+", TOK_EQ: "=",
            }
            op = token_to_op.get(op_token_type, str(op_token_type))

        if op == "concat":
            return to_string(left) + to_string(right)
        elif op == "+":
            return to_number(left) + to_number(right)
        elif op == "-":
            return to_number(left) - to_number(right)
        elif op == "*":
            return to_number(left) * to_number(right)
        elif op == "/":
            r = to_number(right)
            if r == 0:
                return 0.0
            return to_number(left) / r
        elif op == "%":
            r = to_number(right)
            if r == 0:
                return 0.0
            return to_number(left) % to_number(right)
        elif op == "^":
            return to_number(left) ** to_number(right)
        elif op in ("==", "!="):
            # AWK string comparison
            s_left = to_string(left)
            s_right = to_string(right)
            if op == "==":
                return 1.0 if s_left == s_right else 0.0
            return 1.0 if s_left != s_right else 0.0
        elif op in ("<", "<=", ">", ">="):
            # Try numeric comparison first
            n_left = to_number(left)
            n_right = to_number(right)
            # If both look numeric, compare numerically
            s_left = to_string(left).strip()
            s_right = to_string(right).strip()
            try:
                float(s_left)
                float(s_right)
                use_numeric = True
            except ValueError:
                use_numeric = False

            if use_numeric:
                if op == "<":
                    return 1.0 if n_left < n_right else 0.0
                elif op == "<=":
                    return 1.0 if n_left <= n_right else 0.0
                elif op == ">":
                    return 1.0 if n_left > n_right else 0.0
                elif op == ">=":
                    return 1.0 if n_left >= n_right else 0.0
            else:
                # String comparison
                if op == "<":
                    return 1.0 if s_left < s_right else 0.0
                elif op == "<=":
                    return 1.0 if s_left <= s_right else 0.0
                elif op == ">":
                    return 1.0 if s_left > s_right else 0.0
                elif op == ">=":
                    return 1.0 if s_left >= s_right else 0.0
        elif op == "&&":
            return 1.0 if is_truthy(left) and is_truthy(right) else 0.0
        elif op == "||":
            return 1.0 if is_truthy(left) or is_truthy(right) else 0.0
        elif op == ",":
            # Range operator - handled at pattern level
            return 1.0
        elif op == "=":
            # Assignment
            if isinstance(node.left, VarRef):
                self.rt.set_var(node.left.name, right)
                return right
            elif isinstance(node.left, FieldRef):
                n = int(to_number(self.eval_expr(node.left.expr)))
                self.rt.set_field(n, right)
                return right
            elif isinstance(node.left, ArrayAccess):
                arr = self.rt.get_array(node.left.name)
                idx = to_string(self.eval_expr(node.left.index))
                arr[idx] = to_string(right)
                return right
            return right
        elif op == "+=":
            val = to_number(left) + to_number(right)
            if isinstance(node.left, VarRef):
                self.rt.set_var(node.left.name, val)
            elif isinstance(node.left, FieldRef):
                n = int(to_number(self.eval_expr(node.left.expr)))
                self.rt.set_field(n, val)
            return val
        elif op == "-=":
            val = to_number(left) - to_number(right)
            if isinstance(node.left, VarRef):
                self.rt.set_var(node.left.name, val)
            return val
        elif op == "*=":
            val = to_number(left) * to_number(right)
            if isinstance(node.left, VarRef):
                self.rt.set_var(node.left.name, val)
            return val
        elif op == "/=":
            r = to_number(right)
            val = to_number(left) / r if r != 0 else 0.0
            if isinstance(node.left, VarRef):
                self.rt.set_var(node.left.name, val)
            return val
        elif op == "%=":
            r = to_number(right)
            val = to_number(left) % r if r != 0 else 0.0
            if isinstance(node.left, VarRef):
                self.rt.set_var(node.left.name, val)
            return val
        elif op == "^=":
            val = to_number(left) ** to_number(right)
            if isinstance(node.left, VarRef):
                self.rt.set_var(node.left.name, val)
            return val
        elif op == "~":
            return 1.0 if to_string(left).find(to_string(right)) >= 0 else 0.0
        elif op == "!~":
            return 1.0 if to_string(left).find(to_string(right)) < 0 else 0.0
        return ""

    def _eval_match(self, node):
        """Evaluate match expression (str ~ /re/ or str !~ /re/)."""
        left_str = to_string(self.eval_expr(node.left))
        try:
            regex = self.rt.get_regex(node.regex.pattern)
        except re.error:
            return 1.0 if node.negate else 0.0

        m = regex.search(left_str)
        if m:
            self.rt.RSTART = m.start() + 1  # 1-indexed
            self.rt.RLENGTH = m.end() - m.start()
            return 0.0 if node.negate else 1.0
        else:
            self.rt.RSTART = 0
            self.rt.RLENGTH = -1
            return 1.0 if node.negate else 0.0

    def _eval_func_call(self, node):
        name = node.name
        args = [self.eval_expr(a) for a in node.args]

        if name == "length":
            if args:
                s = to_string(args[0])
            else:
                s = self.rt.get_record()
            return float(len(s))

        elif name == "substr":
            s = to_string(args[0]) if len(args) > 0 else ""
            pos = int(to_number(args[1])) if len(args) > 1 else 1
            if pos < 1:
                pos = 1
            start = pos - 1
            if start >= len(s):
                return ""
            if len(args) >= 3:
                length = int(to_number(args[2]))
                if length < 0:
                    return ""
                return s[start:start + length]
            return s[start:]

        elif name == "index":
            if len(args) < 2:
                return 0.0
            s = to_string(args[0])
            find = to_string(args[1])
            idx = s.find(find)
            return float(idx + 1) if idx >= 0 else 0.0

        elif name == "split":
            if len(args) < 2:
                return 0.0
            s = to_string(args[0])
            arr_name = ""
            if isinstance(node.args[1], VarRef):
                arr_name = node.args[1].name
            elif isinstance(node.args[1], str):
                arr_name = str(node.args[1])
            sep = to_string(args[2]) if len(args) >= 3 else self.rt.FS

            if sep == " " or sep is None:
                parts = s.split()
            elif sep == "":
                parts = list(s)
            elif len(sep) == 1:
                parts = s.split(sep)
            else:
                parts = re.split(sep, s)

            arr = {}
            for i, part in enumerate(parts):
                arr[str(i + 1)] = part
            if arr_name:
                self.rt.arrays[arr_name] = arr
            return float(len(parts))

        elif name == "match":
            if len(args) < 2:
                return 0.0
            s = to_string(args[0])
            # Second arg should be a regex literal in node
            pat = to_string(args[1])
            try:
                regex = re.compile(pat)
            except re.error:
                return 0.0
            m = regex.search(s)
            if m:
                self.rt.RSTART = m.start() + 1
                self.rt.RLENGTH = m.end() - m.start()
                return float(m.start() + 1)
            self.rt.RSTART = 0
            self.rt.RLENGTH = -1
            return 0.0

        elif name == "sub":
            if len(args) < 2:
                return 0.0
            pat = to_string(args[0])
            repl = to_string(args[1])
            target_idx = 2 if len(args) >= 3 else -1
            if target_idx >= 0:
                target = to_string(args[2])
            else:
                target = self.rt.get_record()

            try:
                regex = re.compile(pat)
            except re.error:
                return 0.0
            result, count = regex.subn(repl, target, count=1)
            if target_idx >= 0:
                # Can't modify string literal; need array or var
                pass
            else:
                self.rt.set_record(result)
            return float(count)

        elif name == "gsub":
            if len(args) < 2:
                return 0.0
            pat = to_string(args[0])
            repl = to_string(args[1])
            target_idx = 2 if len(args) >= 3 else -1
            if target_idx >= 0:
                target = to_string(args[2])
            else:
                target = self.rt.get_record()

            try:
                regex = re.compile(pat)
            except re.error:
                return 0.0
            result, count = regex.subn(repl, target)
            if target_idx >= 0:
                pass
            else:
                self.rt.set_record(result)
            return float(count)

        elif name == "tolower":
            return to_string(args[0]).lower() if args else ""

        elif name == "toupper":
            return to_string(args[0]).upper() if args else ""

        elif name == "sprintf":
            if not args:
                return ""
            fmt = to_string(args[0])
            return do_sprintf(fmt, [to_string(a) for a in args[1:]])

        elif name == "int":
            if not args:
                return 0.0
            return float(int(to_number(args[0])))

        elif name == "sqrt":
            if not args:
                return 0.0
            return math.sqrt(to_number(args[0]))

        elif name == "rand":
            return random.random()

        elif name == "srand":
            if args:
                random.seed(int(to_number(args[0])))
            else:
                random.seed()
            return 0.0

        elif name == "system":
            # Skip for sandbox safety
            return -1.0

        elif name == "close":
            if args:
                return float(self.rt.close_file(args[0]))
            return 0.0

        return ""

    def _eval_assign(self, node):
        value = self.eval_expr(node.value)
        target = node.target
        if isinstance(target, VarRef):
            self.rt.set_var(target.name, value)
        elif isinstance(target, FieldRef):
            n = int(to_number(self.eval_expr(target.expr)))
            self.rt.set_field(n, value)
        elif isinstance(target, ArrayAccess):
            arr = self.rt.get_array(target.name)
            idx = to_string(self.eval_expr(target.index))
            arr[idx] = to_string(value)
            return value
        return value

    def _eval_preinc(self, node):
        target = node.target
        if isinstance(target, VarRef):
            val = to_number(self.rt.get_var(target.name)) + 1
            self.rt.set_var(target.name, val)
            return val
        elif isinstance(target, FieldRef):
            n = int(to_number(self.eval_expr(target.expr)))
            val = to_number(self.rt.get_field(n)) + 1
            self.rt.set_field(n, val)
            return val
        return 0.0

    def _eval_postinc(self, node):
        target = node.target
        if isinstance(target, VarRef):
            old = to_number(self.rt.get_var(target.name))
            self.rt.set_var(target.name, old + 1)
            return old
        elif isinstance(target, FieldRef):
            n = int(to_number(self.eval_expr(target.expr)))
            old = to_number(self.rt.get_field(n))
            self.rt.set_field(n, old + 1)
            return old
        return 0.0

    def pattern_matches(self, pattern_node):
        """Evaluate a pattern against the current record. Returns bool."""
        if pattern_node is None:
            # No pattern means match every record
            return True

        # Special pattern: BEGIN and END are handled separately
        # Range pattern: expr1 , expr2
        if isinstance(pattern_node, BinaryOp) and pattern_node.op == ",":
            node_id = id(pattern_node)
            active = self.rt._range_active.get(node_id, False)
            left_val = self.eval_expr(pattern_node.left)
            right_val = self.eval_expr(pattern_node.right)

            if not active:
                if is_truthy(left_val):
                    self.rt._range_active[node_id] = True
                    # Check if also ends on this line
                    if is_truthy(right_val):
                        self.rt._range_active[node_id] = False
                    return True
                return False
            else:
                if is_truthy(right_val):
                    self.rt._range_active[node_id] = False
                return True

        # Regular expression-only pattern: if the entire pattern is a RegexLiteral
        if isinstance(pattern_node, RegexLiteral):
            try:
                regex = self.rt.get_regex(pattern_node.pattern)
                m = regex.search(self.rt.get_record())
                if m:
                    self.rt.RSTART = m.start() + 1
                    self.rt.RLENGTH = m.end() - m.start()
                return m is not None
            except re.error:
                return False

        # Unary ! with regex
        if isinstance(pattern_node, UnaryOp) and pattern_node.op == "!":
            inner = pattern_node.expr
            if isinstance(inner, RegexLiteral):
                try:
                    regex = self.rt.get_regex(inner.pattern)
                    return regex.search(self.rt.get_record()) is None
                except re.error:
                    return True
            return not is_truthy(self.eval_expr(inner))

        # Evaluate as expression
        val = self.eval_expr(pattern_node)
        return is_truthy(val)

    def exec_stmt(self, stmt):
        """Execute a single statement. May return special signals."""
        if self.rt.done:
            return

        # Block (list of statements)
        if isinstance(stmt, list):
            for s in stmt:
                self.exec_stmt(s)
                if self.rt._loop_break or self.rt._loop_continue or self.rt.done or self.rt._skip_remaining:
                    return
            return

        if isinstance(stmt, PrintStmt):
            self._exec_print(stmt)
        elif isinstance(stmt, PrintfStmt):
            self._exec_printf(stmt)
        elif isinstance(stmt, IfStmt):
            self._exec_if(stmt)
        elif isinstance(stmt, WhileStmt):
            self._exec_while(stmt)
        elif isinstance(stmt, ForStmt):
            self._exec_for(stmt)
        elif isinstance(stmt, ForInStmt):
            self._exec_forin(stmt)
        elif isinstance(stmt, BreakStmt):
            self.rt._loop_break = True
        elif isinstance(stmt, ContinueStmt):
            self.rt._loop_continue = True
        elif isinstance(stmt, NextStmt):
            self.rt._skip_remaining = True
        elif isinstance(stmt, ExitStmt):
            if stmt.code is not None:
                code = self.eval_expr(stmt.code)
                self.rt._exit_code = int(to_number(code))
            self.rt.done = True
        elif isinstance(stmt, DeleteStmt):
            self._exec_delete(stmt)
        elif isinstance(stmt, ExprStmt):
            self.eval_expr(stmt.expr)
        elif isinstance(stmt, Assign):
            self._eval_assign(stmt)
        else:
            # Fallback: try evaluating as expression
            try:
                self.eval_expr(stmt)
            except Exception:
                pass

    def _exec_print(self, stmt):
        parts = []
        if stmt.args:
            for i, arg in enumerate(stmt.args):
                if i > 0:
                    parts.append(self.rt.OFS)
                parts.append(to_string(self.eval_expr(arg)))
        else:
            parts.append(self.rt.get_record())

        output = "".join(parts) + self.rt.ORS

        if stmt.redirect:
            mode, target = stmt.redirect
            filename = to_string(self.eval_expr(target))
            if mode == ">":
                f = open(filename, "w")
                self.rt._open_files[filename] = f
                f.write(output)
            elif mode == ">>":
                f = open(filename, "a")
                self.rt._open_files[filename] = f
                f.write(output)
            elif mode == "|":
                # Pipe -- skip for sandbox safety
                pass
        else:
            sys.stdout.write(output)

    def _exec_printf(self, stmt):
        if not stmt.args:
            return
        fmt = to_string(self.eval_expr(stmt.args[0]))
        args = [self.eval_expr(a) for a in stmt.args[1:]]
        output = do_sprintf(fmt, args)

        if stmt.redirect:
            mode, target = stmt.redirect
            filename = to_string(self.eval_expr(target))
            if mode == ">":
                f = open(filename, "w")
                self.rt._open_files[filename] = f
                f.write(output)
            elif mode == ">>":
                f = open(filename, "a")
                self.rt._open_files[filename] = f
                f.write(output)
        else:
            sys.stdout.write(output)

    def _exec_if(self, stmt):
        cond = is_truthy(self.eval_expr(stmt.cond))
        if cond:
            for s in flatten_stmts(stmt.true_branch):
                self.exec_stmt(s)
                if self.rt._loop_break or self.rt._loop_continue or self.rt.done or self.rt._skip_remaining:
                    return
        elif stmt.false_branch is not None:
            for s in flatten_stmts(stmt.false_branch):
                self.exec_stmt(s)
                if self.rt._loop_break or self.rt._loop_continue or self.rt.done or self.rt._skip_remaining:
                    return

    def _exec_while(self, stmt):
        # Simple while loop
        while not self.rt.done:
            cond = is_truthy(self.eval_expr(stmt.cond))
            if not cond:
                break
            self.rt._loop_break = False
            self.rt._loop_continue = False
            for s in flatten_stmts(stmt.body):
                self.exec_stmt(s)
                if self.rt._loop_break or self.rt.done:
                    break
                if self.rt._loop_continue:
                    break
                if self.rt._skip_remaining:
                    return
        self.rt._loop_break = False
        self.rt._loop_continue = False

    def _exec_for(self, stmt):
        self.eval_expr(stmt.init)
        while not self.rt.done:
            cond = is_truthy(self.eval_expr(stmt.cond))
            if not cond:
                break
            self.rt._loop_break = False
            self.rt._loop_continue = False
            for s in flatten_stmts(stmt.body):
                self.exec_stmt(s)
                if self.rt._loop_break or self.rt.done:
                    break
                if self.rt._loop_continue:
                    break
                if self.rt._skip_remaining:
                    return
            self.eval_expr(stmt.incr)
        self.rt._loop_break = False
        self.rt._loop_continue = False

    def _exec_forin(self, stmt):
        arr = self.rt.get_array(stmt.array)
        keys = list(arr.keys())
        for key in keys:
            if self.rt.done:
                break
            self.rt.set_var(stmt.var, key)
            self.rt._loop_break = False
            self.rt._loop_continue = False
            for s in flatten_stmts(stmt.body):
                self.exec_stmt(s)
                if self.rt._loop_break or self.rt.done:
                    break
                if self.rt._loop_continue:
                    break
                if self.rt._skip_remaining:
                    return
        self.rt._loop_break = False
        self.rt._loop_continue = False

    def _exec_delete(self, stmt):
        arr = self.rt.get_array(stmt.array)
        if stmt.key is not None:
            idx = to_string(self.eval_expr(stmt.key))
            if idx in arr:
                del arr[idx]
        else:
            # Delete entire array
            arr.clear()


SPRINTF_FLAGS = re.compile(r'%(\d*\.\d+|[+-]?\d*\.?\d*)?([diouxXfFeEgGaAcCs%])')


def do_sprintf(fmt, args):
    """Implement sprintf formatting (subset of C printf)."""
    result = []
    arg_pos = 0
    i = 0
    while i < len(fmt):
        if fmt[i] == "%" and i + 1 < len(fmt):
            # Parse format specifier
            start = i
            i += 1
            # Flags
            flags = ""
            while i < len(fmt) and fmt[i] in "-+ #0":
                flags += fmt[i]
                i += 1
            # Width
            width = ""
            while i < len(fmt) and fmt[i].isdigit():
                width += fmt[i]
                i += 1
            # Precision
            precision = ""
            if i < len(fmt) and fmt[i] == ".":
                precision = "."
                i += 1
                while i < len(fmt) and fmt[i].isdigit():
                    precision += fmt[i]
                    i += 1
            # Length modifier (ignore)
            while i < len(fmt) and fmt[i] in "hlL":
                i += 1
            # Conversion specifier
            if i >= len(fmt):
                result.append(fmt[start:i])
                break
            conv = fmt[i]
            i += 1

            if conv == "%":
                result.append("%")
                continue

            if arg_pos >= len(args):
                result.append(fmt[start:i])
                continue

            arg = args[arg_pos]
            arg_pos += 1

            # Build Python format spec
            py_fmt = "%"
            if flags:
                py_fmt += flags
            py_fmt += width + precision

            if conv == "d" or conv == "i":
                py_fmt += "d"
                try:
                    val = int(to_number(arg))
                except (ValueError, TypeError):
                    val = 0
                result.append(py_fmt % val)
            elif conv == "u":
                py_fmt += "d"
                try:
                    val = int(to_number(arg))
                except (ValueError, TypeError):
                    val = 0
                result.append(py_fmt % abs(val))
            elif conv == "o":
                py_fmt += "o"
                try:
                    val = int(to_number(arg))
                except (ValueError, TypeError):
                    val = 0
                result.append(py_fmt % val)
            elif conv in ("x", "X"):
                py_fmt += conv
                try:
                    val = int(to_number(arg))
                except (ValueError, TypeError):
                    val = 0
                result.append(py_fmt % val)
            elif conv in ("f", "F"):
                py_fmt += "f" if conv == "f" else "F"
                result.append(py_fmt % to_number(arg))
            elif conv in ("e", "E"):
                py_fmt += conv
                result.append(py_fmt % to_number(arg))
            elif conv in ("g", "G"):
                py_fmt += conv
                result.append(py_fmt % to_number(arg))
            elif conv == "c":
                py_fmt += "c"
                try:
                    val = int(to_number(arg))
                except (ValueError, TypeError):
                    val = 0
                if 0 <= val < 256:
                    result.append(chr(val))
                else:
                    result.append("")
            elif conv == "s":
                py_fmt += "s"
                result.append(py_fmt % to_string(arg))
            else:
                result.append(fmt[start:i])
        else:
            result.append(fmt[i])
            i += 1

    return "".join(result)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main(args):
    """Main entry point for awk."""
    if not args:
        print("Usage: awk [OPTION]... PROGRAM [FILE]...", file=sys.stderr)
        print("   or: awk [OPTION]... -f PROGFILE [FILE]...", file=sys.stderr)
        sys.exit(1)

    if args[0] == "--help":
        print("Usage: awk [OPTION]... PROGRAM [FILE]...")
        print("   or: awk [OPTION]... -f PROGFILE [FILE]...")
        print()
        print("Pattern scanning and processing language.")
        print()
        print("Options:")
        print("  -F FS      use FS as the field separator")
        print("  -v VAR=VAL assign variable before program execution")
        print("  -f FILE    read program from file")
        print("  -W compat  compatibility mode (stub)")
        print("      --help     display this help and exit")
        print("      --version  output version information and exit")
        sys.exit(0)

    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    # Parse options
    program = None
    prog_files = []
    files = []
    fs = None
    variables = {}
    i = 0

    while i < len(args) and args[i].startswith("-"):
        opt = args[i]
        if opt == "--":
            i += 1
            break
        if opt == "-F" and i + 1 < len(args):
            i += 1
            fs = args[i]
            i += 1
        elif opt.startswith("-F") and len(opt) > 2:
            fs = opt[2:]
            i += 1
        elif opt == "-v" and i + 1 < len(args):
            i += 1
            var_assign = args[i]
            if "=" in var_assign:
                eq_idx = var_assign.index("=")
                var_name = var_assign[:eq_idx]
                var_val = var_assign[eq_idx + 1:]
                variables[var_name] = var_val
            i += 1
        elif opt.startswith("-v") and len(opt) > 2:
            var_assign = opt[2:]
            if "=" in var_assign:
                eq_idx = var_assign.index("=")
                var_name = var_assign[:eq_idx]
                var_val = var_assign[eq_idx + 1:]
                variables[var_name] = var_val
            i += 1
        elif opt == "-f" and i + 1 < len(args):
            i += 1
            prog_files.append(args[i])
            i += 1
        elif opt.startswith("-f") and len(opt) > 2:
            prog_files.append(opt[2:])
            i += 1
        elif opt == "-W" and i + 1 < len(args):
            # Compatibility mode
            i += 2
        elif opt.startswith("-W"):
            i += 1
        else:
            print(f"awk: unknown option: {opt}", file=sys.stderr)
            sys.exit(1)

    # Remaining arguments: first is program (if no -f), rest are files
    remaining = args[i:]

    if prog_files:
        # Read program from files
        prog_text_parts = []
        for pf in prog_files:
            try:
                with open(pf, "r", encoding="utf-8", errors="replace") as f:
                    prog_text_parts.append(f.read())
            except FileNotFoundError:
                print(f"awk: {pf}: No such file or directory", file=sys.stderr)
                sys.exit(1)
        program = "\n".join(prog_text_parts)
        files = remaining
    elif remaining:
        # First remaining arg is the program
        program = remaining[0]
        files = remaining[1:]
    else:
        print("awk: no program specified", file=sys.stderr)
        sys.exit(1)

    # Tokenize and parse
    try:
        tokens = tokenize(program)
        parser = Parser(tokens)
        prog = parser.parse_program()
    except ParseError as e:
        print(f"awk: parse error: {e}", file=sys.stderr)
        sys.exit(1)

    # Create runtime
    rt = AwkRuntime(fs=fs, variables=variables)
    evaluator = AwkEvaluator(rt)

    # Separate BEGIN, END, and regular blocks
    begin_blocks = [b for b in prog.blocks if b.is_begin]
    end_blocks = [b for b in prog.blocks if b.is_end]
    regular_blocks = [b for b in prog.blocks if not b.is_begin and not b.is_end]

    # Execute BEGIN blocks
    for block in begin_blocks:
        for stmt in block.actions:
            evaluator.exec_stmt(stmt)
            if rt.done:
                sys.exit(rt._exit_code)

    # Process input files
    if not files:
        files = ["-"]  # stdin

    for filename in files:
        rt.FILENAME = filename
        rt.FNR = 0

        try:
            if filename == "-":
                fh = sys.stdin
            else:
                fh = open(filename, "r", encoding="utf-8", errors="replace")
        except FileNotFoundError:
            print(f"awk: {filename}: No such file or directory", file=sys.stderr)
            continue
        except IsADirectoryError:
            print(f"awk: {filename}: Is a directory", file=sys.stderr)
            continue

        with fh:
            if rt.RS == "\n":
                for line in fh:
                    line = line.rstrip("\n").rstrip("\r")
                    if rt.done:
                        break
                    rt.NR += 1
                    rt.FNR += 1
                    rt.set_record(line)
                    _process_regular_blocks(evaluator, rt, regular_blocks)
                    rt._skip_remaining = False
            else:
                # Multi-character RS
                data = fh.read()
                records = data.split(rt.RS)
                for rec in records:
                    if rt.done:
                        break
                    rt.NR += 1
                    rt.FNR += 1
                    rt.set_record(rec.rstrip("\n").rstrip("\r"))
                    _process_regular_blocks(evaluator, rt, regular_blocks)
                    rt._skip_remaining = False

        if filename != "-":
            try:
                fh.close()
            except Exception:
                pass

    # Execute END blocks
    rt._skip_remaining = False
    for block in end_blocks:
        for stmt in block.actions:
            evaluator.exec_stmt(stmt)
            if rt.done:
                sys.exit(rt._exit_code)

    sys.exit(rt._exit_code)


def _process_regular_blocks(evaluator, rt, blocks):
    """Process all regular (non-BEGIN/END) blocks for the current record."""
    for block in blocks:
        if rt._skip_remaining or rt.done:
            break
        if evaluator.pattern_matches(block.pattern):
            for stmt in block.actions:
                if rt._skip_remaining or rt.done:
                    break
                evaluator.exec_stmt(stmt)


if __name__ == "__main__":
    main(sys.argv[1:])
