"""patch — apply a diff file to an original.

Usage: patch [OPTION]... [ORIGFILE [PATCHFILE]]
  -p NUM   strip NUM leading path components (default 0)
  -R       reverse patch
  -b       make backup files
  --dry-run  don't actually change files
  -i FILE  read patch from FILE
  -o FILE  output to FILE
  --help   display this help
  --version  output version information
"""
import os
import re
import sys


def parse_hunk_header(line):
    """Parse @@ -old_start,old_count +new_start,new_count @@"""
    m = re.match(r'^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@', line)
    if not m:
        return None
    old_start = int(m.group(1))
    old_count = int(m.group(2) or 1)
    new_start = int(m.group(3))
    new_count = int(m.group(4) or 1)
    return old_start, old_count, new_start, new_count


def apply_patch(original_lines, patch_text, reverse=False):
    """Apply unified diff patch to original content."""
    patch_lines = patch_text.splitlines(keepends=True)

    if reverse:
        # Swap old and new in hunks
        new_patch = []
        for line in patch_lines:
            if line.startswith('--- '):
                new_patch.append(line.replace('--- ', '+++ ', 1))
            elif line.startswith('+++ '):
                new_patch.append(line.replace('+++ ', '--- ', 1))
            elif line.startswith('-'):
                new_patch.append('+' + line[1:])
            elif line.startswith('+'):
                new_patch.append('-' + line[1:])
            else:
                new_patch.append(line)
        patch_lines = new_patch

    result = list(original_lines)
    i = 0
    errors = []

    while i < len(patch_lines):
        line = patch_lines[i]
        if line.startswith('@@'):
            hunk = parse_hunk_header(line)
            if not hunk:
                errors.append(f"invalid hunk header: {line.strip()}")
                break
            old_start, old_count, new_start, new_count = hunk
            i += 1

            # Build the hunk content
            hunk_old = []  # expected old context
            hunk_new = []  # replacement new lines

            while i < len(patch_lines) and not patch_lines[i].startswith('@@') \
                    and not patch_lines[i].startswith('--- ') \
                    and not (patch_lines[i].startswith('diff ') and i > 0):
                hunk_line = patch_lines[i]
                if hunk_line.startswith(' '):
                    hunk_old.append(hunk_line[1:])
                    hunk_new.append(hunk_line[1:])
                elif hunk_line.startswith('-'):
                    hunk_old.append(hunk_line[1:])
                elif hunk_line.startswith('+'):
                    hunk_new.append(hunk_line[1:])
                elif hunk_line == '\\ No newline at end of file\n':
                    pass  # just a note
                i += 1

            # Find the position in original
            old_idx = old_start - 1  # 0-indexed
            if old_idx < 0:
                old_idx = 0

            # Verify context matches
            match_ok = True
            for j, expected in enumerate(hunk_old):
                expected = expected.rstrip('\n')
                if old_idx + j < len(result):
                    actual = result[old_idx + j].rstrip('\n')
                    if expected != actual:
                        match_ok = False
                        break
                elif expected.strip():
                    match_ok = False
                    break

            if not match_ok:
                errors.append(f"Hunk failed at line {old_start}")
                # Skip this hunk
                continue

            # Apply the hunk
            result[old_idx:old_idx + len(hunk_old)] = hunk_new

        elif line.startswith('--- ') or line.startswith('+++ ') or line.startswith('diff '):
            i += 1
        elif line.startswith('Index:') or line.startswith('==='):
            i += 1
        else:
            i += 1

    return result, errors


def main(args):
    strip = 0
    reverse = False
    backup = False
    dry_run = False
    patch_file = None
    output_file = None
    positional = []
    i = 0

    while i < len(args):
        arg = args[i]
        if arg == '-p' and i + 1 < len(args):
            strip = int(args[i + 1])
            i += 2
        elif arg.startswith('-p'):
            strip = int(arg[2:])
            i += 1
        elif arg == '-R':
            reverse = True
            i += 1
        elif arg == '-b':
            backup = True
            i += 1
        elif arg == '--dry-run':
            dry_run = True
            i += 1
        elif arg == '-i' and i + 1 < len(args):
            patch_file = args[i + 1]
            i += 2
        elif arg == '-o' and i + 1 < len(args):
            output_file = args[i + 1]
            i += 2
        elif arg == '--help':
            print("Usage: patch [OPTION]... [ORIGFILE [PATCHFILE]]")
            print("  -p NUM   strip NUM leading path components")
            print("  -R       reverse patch")
            print("  -b       make backup files")
            print("  --dry-run  don't change files")
            print("  -i FILE  read patch from FILE")
            print("  -o FILE  output to FILE")
            print("  --help   display this help")
            sys.exit(0)
        elif arg == '--version':
            print("patch (EdgeTerm bigbox)")
            sys.exit(0)
        elif not arg.startswith('-'):
            positional.append(arg)
            i += 1
        else:
            i += 1

    if positional:
        orig_file = positional[0]
    else:
        print("patch: missing original file", file=sys.stderr)
        sys.exit(2)

    if len(positional) > 1 and not patch_file:
        patch_file = positional[1]

    # Read patch
    if patch_file and patch_file != '-':
        with open(patch_file, 'r', encoding='utf-8') as f:
            patch_text = f.read()
    else:
        patch_text = sys.stdin.read()

    # Read original
    if not os.path.exists(orig_file):
        print(f"patch: {orig_file}: No such file or directory", file=sys.stderr)
        sys.exit(2)

    with open(orig_file, 'r', encoding='utf-8') as f:
        original_lines = f.readlines()

    # Apply
    result_lines, errors = apply_patch(original_lines, patch_text, reverse)

    if errors:
        for e in errors:
            print(f"patch: {e}", file=sys.stderr)

    # Output
    result_text = ''.join(result_lines)

    if dry_run:
        print("--- dry run, no changes made ---")
        sys.stdout.write(result_text)
    elif output_file:
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(result_text)
    else:
        if backup:
            backup_name = orig_file + '.orig'
            with open(backup_name, 'w', encoding='utf-8') as f:
                f.write(''.join(original_lines))
        with open(orig_file, 'w', encoding='utf-8') as f:
            f.write(result_text)

    sys.exit(0 if not errors else 1)
