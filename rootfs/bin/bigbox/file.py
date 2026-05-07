"""
file - determine file type.
"""
import os
import stat
import sys

import bigbox_utils


# Magic byte signatures
MAGIC_PATTERNS = [
    # (name, offset, bytes, mime_type)
    ("ELF", 0, b"\x7fELF", "application/x-elf"),
    ("PNG image", 0, b"\x89PNG\r\n\x1a\n", "image/png"),
    ("JPEG image", 0, b"\xff\xd8\xff", "image/jpeg"),
    ("GIF image", 0, b"GIF8", "image/gif"),
    ("PDF document", 0, b"%PDF", "application/pdf"),
    ("ZIP archive", 0, b"PK\x03\x04", "application/zip"),
    ("gzip compressed", 0, b"\x1f\x8b\x08", "application/gzip"),
    ("bzip2 compressed", 0, b"BZh", "application/x-bzip2"),
    ("XZ compressed", 0, b"\xfd7zXZ\x00", "application/x-xz"),
    ("WebM/Matroska video", 0, b"\x1a\x45\xdf\xa3", "video/webm"),
    ("MP4 video", 0, b"\x00\x00\x00\x18ftyp", "video/mp4"),
    ("MP4 video (short)", 4, b"ftyp", "video/mp4"),
    ("MP3 audio (ID3)", 0, b"ID3", "audio/mpeg"),
    ("RIFF (AVI/WAV)", 0, b"RIFF", "audio/x-wav"),
    ("BMP image", 0, b"BM", "image/bmp"),
    ("TIFF image (LE)", 0, b"II\x2a\x00", "image/tiff"),
    ("TIFF image (BE)", 0, b"MM\x00\x2a", "image/tiff"),
    ("WebP image", 8, b"WEBP", "image/webp"),
    ("ICO image", 0, b"\x00\x00\x01\x00", "image/x-icon"),
    ("Debian package", 0, b"!<arch>\ndebian", "application/vnd.debian.binary-package"),
    ("RAR archive", 0, b"Rar!\x1a\x07\x00", "application/vnd.rar"),
    ("RAR archive (v5)", 0, b"Rar!\x1a\x07\x01", "application/vnd.rar"),
    ("7z archive", 0, b"7z\xbc\xaf\x27\x1c", "application/x-7z-compressed"),
    ("SQLite database", 0, b"SQLite format 3\x00", "application/x-sqlite3"),
    ("Windows PE (exe)", 0, b"MZ", "application/x-dosexec"),
    ("Mach-O binary", 0, b"\xfe\xed\xfa\xce", "application/x-mach-binary"),
    ("Mach-O binary (64-bit)", 0, b"\xfe\xed\xfa\xcf", "application/x-mach-binary"),
    ("Mach-O binary (reverse)", 0, b"\xce\xfa\xed\xfe", "application/x-mach-binary"),
    ("Mach-O binary (64-bit rev)", 0, b"\xcf\xfa\xed\xfe", "application/x-mach-binary"),
    ("Java class file", 0, b"\xca\xfe\xba\xbe", "application/x-java-class"),
    ("TrueType font", 0, b"\x00\x01\x00\x00\x00", "font/ttf"),
    ("OpenType font", 0, b"OTTO", "font/otf"),
    ("WOFF font", 0, b"wOFF", "font/woff"),
    ("WOFF2 font", 0, b"wOF2", "font/woff2"),
    ("PCAP packet capture", 0, b"\xd4\xc3\xb2\xa1", "application/vnd.tcpdump.pcap"),
    ("PCAP (nanosec)", 0, b"\xa1\xb2\xc3\xd4", "application/vnd.tcpdump.pcap"),
]


def check_magic(data):
    """Check magic bytes and return (name, mime_type) or (None, None)."""
    for name, offset, magic, mime in MAGIC_PATTERNS:
        if len(data) >= offset + len(magic):
            if data[offset:offset + len(magic)] == magic:
                return name, mime
    return None, None


def is_text(data):
    """Heuristic: check if data appears to be text (no nulls, mostly printable)."""
    if len(data) == 0:
        return True
    try:
        text = data.decode("utf-8", errors="strict")
        # Check for null bytes
        if b"\x00" in data:
            return False
        return True
    except (UnicodeDecodeError, UnicodeError):
        pass
    return False


def check_text_type(text):
    """Try to identify the type of a text file."""
    lines = text.splitlines()
    total_lines = len(lines)

    # Empty file
    if not text.strip():
        return "empty"

    # Check shebang
    if lines and lines[0].startswith("#!"):
        shebang = lines[0]
        if "python" in shebang.lower():
            return "Python script"
        elif "bash" in shebang.lower() or "sh" in shebang.lower():
            return "shell script"
        elif "perl" in shebang.lower():
            return "Perl script"
        elif "ruby" in shebang.lower():
            return "Ruby script"
        elif "node" in shebang.lower() or "js" in shebang.lower():
            return "Node.js script"
        elif "lua" in shebang.lower():
            return "Lua script"
        elif "php" in shebang.lower():
            return "PHP script"
        elif "awk" in shebang.lower():
            return "AWK script"
        else:
            return "script"

    # Check for HTML
    html_indicators = ["<!DOCTYPE html", "<html", "<head", "<body", "<div", "<script", "<style"]
    first_content = "\n".join(lines[:min(20, total_lines)]).lower()
    for indicator in html_indicators:
        if indicator in first_content:
            return "HTML document"

    # Check for XML
    if text.strip().startswith("<?xml"):
        return "XML document"

    # Check for JSON: first non-empty line starts with { or [
    for line in lines:
        stripped = line.strip()
        if stripped:
            if stripped.startswith("{") or stripped.startswith("["):
                try:
                    import json
                    json.loads(text)
                    return "JSON data"
                except (ValueError, json.JSONDecodeError):
                    pass
            break

    # Check for Python
    python_keywords = ["def ", "import ", "from ", "class ", "if __name__", "print("]
    for keyword in python_keywords:
        if keyword in text:
            return "Python script"

    # Check for Markdown
    md_indicators = ["# ", "## ", "### ", "**", "---", "```"]
    for indicator in md_indicators:
        if indicator in text:
            return "Markdown document"

    # Check for shell
    shell_chars = ["$(", "`", "echo ", "export ", "if [", "fi", "done", "while ", "for "]
    shell_count = sum(1 for c in shell_chars if c in text)
    if shell_count >= 3:
        return "shell script"

    # Check for CSV
    if total_lines > 1:
        first_line = lines[0].strip()
        if "," in first_line and not first_line.startswith("#"):
            num_commas = first_line.count(",")
            if num_commas >= 2:
                # Check consistency across lines
                consistent = True
                for line in lines[1:min(6, total_lines)]:
                    if line.strip() and line.count(",") != num_commas:
                        consistent = False
                        break
                if consistent:
                    return "CSV text"

    # Check for YAML
    yaml_indicators = [": ", "---", "  "]
    yaml_count = sum(1 for c in yaml_indicators if c in text)
    if yaml_count >= 2 and total_lines > 2:
        return "YAML document"

    return "ASCII text"


def identify_file(path, brief=False, mime=False):
    """Identify the type of a file. Returns a description string."""
    if not os.path.lexists(path):
        return f"cannot open '{path}' (No such file or directory)"

    # Check for symlink first
    if os.path.islink(path):
        target = os.readlink(path)
        link_to = os.path.realpath(path) if os.path.exists(path) else path
        if brief:
            return f"symbolic link to {target}"
        if mime:
            return "inode/symlink"
        return f"symbolic link to {target}"

    # Check for directory
    if os.path.isdir(path):
        if brief:
            return "directory"
        if mime:
            return "inode/directory"
        return "directory"

    # Read the file bytes
    try:
        with open(path, "rb") as f:
            data = f.read(4096)
    except (OSError, PermissionError) as e:
        if brief:
            return f"cannot read ({e})"
        return f"cannot read '{path}': {e}"

    if not data:
        if brief:
            return "empty"
        if mime:
            return "inode/x-empty"
        return "empty"

    # Check magic bytes
    name, mime_type = check_magic(data)
    if name:
        if mime:
            return mime_type
        if brief:
            return name
        return name

    # Check if it's text
    if is_text(data):
        text = data.decode("utf-8", errors="replace")
        text_type = check_text_type(text)
        if mime:
            if text_type == "Python script":
                return "text/x-python"
            elif text_type == "shell script":
                return "text/x-shellscript"
            elif text_type == "JSON data":
                return "application/json"
            elif "HTML" in text_type:
                return "text/html"
            elif "XML" in text_type:
                return "text/xml"
            elif "CSV" in text_type:
                return "text/csv"
            return "text/plain"
        if brief:
            return text_type
        return text_type

    # Binary data not matched by magic
    if mime:
        return "application/octet-stream"
    if brief:
        return "data"
    return "data"


def main(args):
    brief = False
    mime = False
    targets = []

    for arg in args:
        if arg == "--":
            continue
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            for ch in arg[1:]:
                if ch == "b":
                    brief = True
                elif ch == "i":
                    mime = True
                else:
                    print(f"file: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: file [-bi] FILE...", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: file [-bi] FILE...")
            print("  -b    brief output (omit filename)")
            print("  -i    output MIME type instead")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("file (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)

    if not targets:
        print("file: missing operand", file=sys.stderr)
        print("Usage: file [-bi] FILE...", file=sys.stderr)
        sys.exit(1)

    # Expand globs
    targets = bigbox_utils.expand_globs(targets)

    exit_code = 0
    for target in targets:
        result = identify_file(target, brief=brief, mime=mime)
        if result.startswith("cannot"):
            print(f"file: {target}: {result}", file=sys.stderr)
            exit_code = 1
        elif brief:
            print(result)
        else:
            print(f"{target}: {result}")

    sys.exit(exit_code)
