import os
import re
import sys
import bigbox_utils


VERSION = "fmt (EdgeTerm bigbox)"


def main(args):
    width = 75
    uniform_spacing = False
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "fmt",
                "[-w WIDTH] [-u] [FILE...]",
                [("-w WIDTH", "maximum line width (default: 75)"),
                 ("-u", "uniform spacing: one space between words, two after sentences"),
                 ("", "With no FILE, or when FILE is -, read standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-u":
            uniform_spacing = True
        elif arg == "-w" and i + 1 < len(args):
            i += 1
            width = int(args[i])
        elif arg.startswith("-w") and len(arg) > 2:
            width = int(arg[2:])
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "u":
                    uniform_spacing = True
                elif ch == "w":
                    print(f"fmt: option requires an argument -- 'w'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"fmt: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)
        i += 1

    lines = bigbox_utils.read_input(files)
    paragraphs = split_paragraphs(lines)
    output_paragraphs(paragraphs, width, uniform_spacing)


def split_paragraphs(lines):
    """Split lines into paragraphs separated by blank lines."""
    paragraphs = []
    current = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            if current:
                paragraphs.append(current)
                current = []
        else:
            current.append(stripped)

    if current:
        paragraphs.append(current)

    return paragraphs


def output_paragraphs(paragraphs, width, uniform_spacing):
    """Re-wrap and output paragraphs."""
    for p_idx, para in enumerate(paragraphs):
        if p_idx > 0:
            sys.stdout.write("\n")

        # Join all lines into one text
        text = " ".join(para)

        if uniform_spacing:
            text = uniformize_spacing(text)

        # Re-wrap to width
        words = text.split()
        line = ""
        for word in words:
            if line and len(line) + 1 + len(word) > width:
                sys.stdout.write(line + "\n")
                line = word
            elif line:
                line += " " + word
            else:
                line = word

        if line:
            sys.stdout.write(line + "\n")


def uniformize_spacing(text):
    """Convert to uniform spacing: one space between words, two after sentences."""
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\.  +', '.  ', text)
    text = re.sub(r'\. ', '.  ', text)
    return text
