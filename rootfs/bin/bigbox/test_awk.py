"""Quick smoke tests for awk.py."""
import sys

# sys.path for cross-applet imports is handled by _run_applet in the shell.
import awk


def test_tokenizer():
    print("=== Tokenizer Tests ===")

    # Test basic tokenization
    tokens = awk.tokenize('{ print $1, $2 }')
    types = [t.type for t in tokens]
    print(f"'{'{ print $1, $2 }'}' -> {types}")
    assert awk.TOK_LBRACE in types
    assert awk.TOK_PRINT in types or awk.TOK_WORD in types
    assert awk.TOK_DOLLAR in types

    # Test regex pattern
    tokens = awk.tokenize('/foo/ { print }')
    types = [t.type for t in tokens]
    print(f"'/foo/ {{ print }}' -> {types}")
    assert awk.TOK_REGEX in types

    # Test BEGIN/END
    tokens = awk.tokenize('BEGIN { print "start" } END { print "end" }')
    types = [t.type for t in tokens]
    print(f"BEGIN/END -> {types}")
    assert awk.TOK_BEGIN in types
    assert awk.TOK_END in types

    # Test string
    tokens = awk.tokenize('{ print "hello world" }')
    print(f"string literal -> {tokens}")

    print("Tokenizer tests passed!")
    return True


def test_parser():
    print("\n=== Parser Tests ===")

    tokens = awk.tokenize('{ print $1, $2 }')
    parser = awk.Parser(tokens)
    prog = parser.parse_program()
    print(f"'{'{ print $1, $2 }'}' -> {prog}")
    assert len(prog.blocks) == 1
    assert not prog.blocks[0].is_begin
    assert not prog.blocks[0].is_end

    # BEGIN/END
    tokens = awk.tokenize('BEGIN { print "start" } { print $0 } END { print "done" }')
    parser = awk.Parser(tokens)
    prog = parser.parse_program()
    print(f"BEGIN/END program -> {len(prog.blocks)} blocks")
    begin_blocks = [b for b in prog.blocks if b.is_begin]
    end_blocks = [b for b in prog.blocks if b.is_end]
    regular = [b for b in prog.blocks if not b.is_begin and not b.is_end]
    assert len(begin_blocks) == 1
    assert len(end_blocks) == 1
    assert len(regular) == 1

    # Regex pattern
    tokens = awk.tokenize('/foo/ { print $0 }')
    parser = awk.Parser(tokens)
    prog = parser.parse_program()
    print(f"regex pattern -> {prog}")
    assert len(prog.blocks) == 1
    pattern = prog.blocks[0].pattern
    assert isinstance(pattern, awk.RegexLiteral), f"Expected RegexLiteral, got {type(pattern)}"

    # NR pattern
    tokens = awk.tokenize('NR == 5 { print }')
    parser = awk.Parser(tokens)
    prog = parser.parse_program()
    print(f"NR==5 pattern -> {prog}")

    print("Parser tests passed!")
    return True


def test_runtime():
    print("\n=== Runtime Tests ===")

    rt = awk.AwkRuntime()

    # Test field splitting
    rt.set_record("hello world foo")
    assert rt.NF == 3
    assert rt.get_field(1) == "hello"
    assert rt.get_field(2) == "world"
    assert rt.get_field(3) == "foo"
    print(f"Fields: $0='{rt.get_record()}', NF={rt.NF}, $1='{rt.get_field(1)}', $2='{rt.get_field(2)}'")

    # Test custom FS
    rt2 = awk.AwkRuntime(fs=",")
    rt2.set_record("a,b,c")
    assert rt2.NF == 3
    assert rt2.get_field(1) == "a"
    assert rt2.get_field(2) == "b"
    assert rt2.get_field(3) == "c"
    assert rt2.get_field(0) == "a,b,c"
    print(f"Custom FS=',' -> NF={rt2.NF}, $1='{rt2.get_field(1)}'")

    # Test $NF
    assert rt.get_field(rt.NF) == "foo"
    print(f"\$NF = '{rt.get_field(rt.NF)}'")

    # Test variables
    rt.set_var("x", 42)
    assert rt.get_var("x") == "42"
    print(f"var x = {rt.get_var('x')}")

    # Test NR, FNR
    rt.NR = 5
    rt.FNR = 3
    assert rt.get_var("NR") == 5.0
    assert rt.get_var("FNR") == 3.0
    print(f"NR={rt.NR}, FNR={rt.FNR}")

    # Test arrays
    arr = rt.get_array("arr")
    arr["hello"] = "world"
    assert rt.get_array("arr")["hello"] == "world"
    print(f"array arr['hello'] = '{rt.get_array('arr')['hello']}'")

    print("Runtime tests passed!")
    return True


def test_functions():
    print("\n=== Function Tests ===")

    # Test to_number and to_string
    assert awk.to_number(42) == 42.0
    assert awk.to_number("3.14") == 3.14
    assert awk.to_number("abc") == 0.0
    assert awk.to_string(42) == "42"
    assert awk.to_string(3.14) == "3.14"
    print("to_number/to_string: OK")

    # Test is_truthy
    assert awk.is_truthy(1) == True
    assert awk.is_truthy(0) == False
    assert awk.is_truthy("hello") == True
    assert awk.is_truthy("") == False
    assert awk.is_truthy("0") == False
    print("is_truthy: OK")

    # Test sprintf
    result = awk.do_sprintf("%s %d", ["hello", 42])
    assert result == "hello 42", f"Got {result!r}"
    print(f"sprintf: '{result}'")

    result = awk.do_sprintf("%.2f", [3.14159])
    assert result == "3.14"
    print(f"sprintf float: '{result}'")

    # Evaluator function tests
    rt = awk.AwkRuntime()
    rt.set_record("foo bar baz")
    ev = awk.AwkEvaluator(rt)

    # length
    result = ev.eval_expr(awk.FuncCall("length", [awk.StrLiteral("hello")]))
    assert result == 5.0, f"length('hello') = {result}"
    print(f"length('hello') = {result}")

    # substr
    result = ev.eval_expr(awk.FuncCall("substr", [awk.StrLiteral("hello"), awk.NumLiteral(2), awk.NumLiteral(3)]))
    assert result == "ell", f"substr('hello', 2, 3) = {result!r}"
    print(f"substr('hello', 2, 3) = '{result}'")

    # tolower/toupper
    result = ev.eval_expr(awk.FuncCall("tolower", [awk.StrLiteral("HELLO")]))
    assert result == "hello"
    result = ev.eval_expr(awk.FuncCall("toupper", [awk.StrLiteral("hello")]))
    assert result == "HELLO"
    print("tolower/toupper: OK")

    # index
    result = ev.eval_expr(awk.FuncCall("index", [awk.StrLiteral("hello"), awk.StrLiteral("ll")]))
    assert result == 3.0, f"index('hello', 'll') = {result}"
    print(f"index('hello', 'll') = {result}")

    print("Function tests passed!")
    return True


def test_evaluator():
    print("\n=== Evaluator Tests ===")
    rt = awk.AwkRuntime()
    ev = awk.AwkEvaluator(rt)

    # Test binary ops
    result = ev.eval_expr(awk.BinaryOp(awk.TOK_PLUS, awk.NumLiteral(3), awk.NumLiteral(4)))
    assert result == 7.0, f"3+4 = {result}"
    print(f"3+4 = {result}")

    result = ev.eval_expr(awk.BinaryOp(awk.TOK_STAR, awk.NumLiteral(3), awk.NumLiteral(4)))
    assert result == 12.0
    print(f"3*4 = {result}")

    # Test string concat
    result = ev.eval_expr(awk.BinaryOp("concat", awk.StrLiteral("hello "), awk.StrLiteral("world")))
    assert result == "hello world"
    print(f"'hello ' concat 'world' = '{result}'")

    # Test comparison
    result = ev.eval_expr(awk.BinaryOp(awk.TOK_EQ_EQ, awk.NumLiteral(5), awk.NumLiteral(5)))
    assert result == 1.0
    result = ev.eval_expr(awk.BinaryOp(awk.TOK_GT, awk.NumLiteral(5), awk.NumLiteral(3)))
    assert result == 1.0
    print("comparisons: OK")

    # Test pattern matching
    rt.set_record("hello world")
    result = ev.pattern_matches(awk.RegexLiteral("hello"))
    assert result == True, f"regex match 'hello' in 'hello world' = {result}"
    result = ev.pattern_matches(awk.RegexLiteral("xyz"))
    assert result == False
    print("regex pattern matching: OK")

    # Test field ref
    result = ev.eval_expr(awk.FieldRef(awk.NumLiteral(1)))
    assert result == "hello"
    result = ev.eval_expr(awk.FieldRef(awk.NumLiteral(2)))
    assert result == "world"
    print(f"field refs: \$1='{ev.eval_expr(awk.FieldRef(awk.NumLiteral(1)))}', \$2='{ev.eval_expr(awk.FieldRef(awk.NumLiteral(2)))}'")

    # Test ternary
    result = ev.eval_expr(
        awk.TernaryOp(
            awk.BinaryOp(awk.TOK_EQ_EQ, awk.NumLiteral(1), awk.NumLiteral(1)),
            awk.StrLiteral("yes"),
            awk.StrLiteral("no")
        )
    )
    assert result == "yes"
    print("ternary: OK")

    # Test assignments
    ev.eval_expr(awk.Assign(awk.VarRef("x"), "=", awk.NumLiteral(42)))
    assert rt.get_var("x") == "42"
    print(f"assignment: x = {rt.get_var('x')}")

    print("Evaluator tests passed!")
    return True


def test_full_program():
    print("\n=== Full Program Tests ===")

    # Test through main with test data
    test_data = "apple 10\nbanana 20\ncherry 30\n"

    # Create a temp file
    import tempfile
    import io

    # Save stdin
    old_stdin = sys.stdin
    old_stdout = sys.stdout

    # Test 1: print second field
    sys.stdin = io.StringIO(test_data)
    sys.stdout = io.StringIO()
    try:
        awk.main(['{ print $2 }'])
    except SystemExit as e:
        pass
    output = sys.stdout.getvalue()
    expected = "10\n20\n30\n"
    assert output == expected, f"Got {output!r}, expected {expected!r}"
    print(f"Test '{{ print \$2 }}': OK ({output.strip().split(chr(10))})")

    # Test 2: regex pattern
    sys.stdin = io.StringIO(test_data)
    sys.stdout = io.StringIO()
    try:
        awk.main(['/apple/ { print $1 }'])
    except SystemExit as e:
        pass
    output = sys.stdout.getvalue()
    assert "apple" in output
    print(f"Test '/apple/ {{ print \$1 }}': OK ({output.strip()})")

    # Test 3: NR filter
    sys.stdin = io.StringIO(test_data)
    sys.stdout = io.StringIO()
    try:
        awk.main(['NR == 2 { print }'])
    except SystemExit as e:
        pass
    output = sys.stdout.getvalue()
    assert "banana" in output
    print(f"Test 'NR == 2 {{ print }}': OK ({output.strip()})")

    # Test 4: custom FS
    csv_data = "a,b,c\nd,e,f\n"
    sys.stdin = io.StringIO(csv_data)
    sys.stdout = io.StringIO()
    try:
        awk.main(['-F,', '{ print $2 }'])
    except SystemExit as e:
        pass
    output = sys.stdout.getvalue()
    assert "b" in output and "e" in output
    print(f"Test '-F,' CSV: OK ({output.strip().split(chr(10))})")

    # Test 5: -v variable
    sys.stdin = io.StringIO(test_data)
    sys.stdout = io.StringIO()
    try:
        awk.main(['-v', 'sep=,', '{ print $1, sep, $2 }'])
    except SystemExit as e:
        pass
    output = sys.stdout.getvalue()
    assert "," in output
    print(f"Test '-v' variable: OK ({output.strip().split(chr(10))})")

    sys.stdin = old_stdin
    sys.stdout = old_stdout

    print("Full program tests passed!")
    return True


if __name__ == "__main__":
    results = []
    results.append(test_tokenizer())
    results.append(test_parser())
    results.append(test_runtime())
    results.append(test_functions())
    results.append(test_evaluator())
    results.append(test_full_program())

    print("\n" + "=" * 40)
    all_pass = all(results)
    print(f"{'ALL TESTS PASSED!' if all_pass else 'SOME TESTS FAILED!'}")
    sys.exit(0 if all_pass else 1)
