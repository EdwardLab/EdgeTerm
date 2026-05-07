"""
Terminal session recorder -- script command for EdgeTerm/bigbox.

Since this runs in Pyodide and cannot actually intercept real terminal I/O,
it simulates recording by:
  - Capturing stdin (line-by-line) and echoing to stdout while writing to file, or
  - Running a specified command and capturing its output.

Usage: script [OPTION]... [FILE]
"""

import os
import sys
import time
import subprocess


def main(args):
    append_mode = False
    command = None
    quiet = False
    timing_file = None
    return_exitcode = False
    flush = False
    force = False
    filename = "typescript"

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--help":
            print("Usage: script [OPTION]... [FILE]")
            print("Record terminal session to FILE (default: typescript).")
            print("")
            print("  -a             append to output file")
            print("  -c COMMAND     run COMMAND and record its output")
            print("  -q             quiet mode (no start/done messages)")
            print("  -t TIMINGFILE  output timing data to TIMINGFILE")
            print("  --return       return exit code of child process")
            print("  -f             flush output after each write")
            print("  --force        overwrite existing output file")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            return
        if arg == "--version":
            print("script (edgeos-bigbox) 1.0")
            return
        if arg == "-a":
            append_mode = True
        elif arg == "-q":
            quiet = True
        elif arg == "-f":
            flush = True
        elif arg == "--return":
            return_exitcode = True
        elif arg == "--force":
            force = True
        elif arg == "-c":
            i += 1
            if i >= len(args):
                print("script: option requires an argument -- 'c'", file=sys.stderr)
                sys.exit(1)
            command = args[i]
        elif arg == "-t":
            i += 1
            if i >= len(args):
                print("script: option requires an argument -- 't'", file=sys.stderr)
                sys.exit(1)
            timing_file = args[i]
        elif arg.startswith("-"):
            print(f"script: invalid option -- '{arg[1:]}'", file=sys.stderr)
            sys.exit(1)
        else:
            filename = arg
        i += 1

    # Check if output file exists
    if not append_mode and not force and os.path.exists(filename):
        print(f"script: output file '{filename}' already exists", file=sys.stderr)
        print("Use --force to overwrite or -a to append.", file=sys.stderr)
        sys.exit(1)

    mode = "a" if append_mode else "w"
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")

    if not quiet:
        print(f"Script started, output file is {filename}")

    start_time = time.time()

    try:
        with open(filename, mode, encoding="utf-8", errors="replace") as f:
            # Write header
            if not append_mode:
                f.write(f"Script started on {timestamp}\n")
                if flush:
                    f.flush()

            if command is not None:
                # Run command via subprocess
                _run_command(command, f, timing_file, flush, start_time)
            else:
                # Interactive mode: read stdin line by line
                _interactive_mode(f, timing_file, flush, start_time)

            # Write footer
            end_timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
            if not append_mode:
                f.write(f"Script done on {end_timestamp}\n")
                if flush:
                    f.flush()
    except (IOError, OSError) as e:
        print(f"script: cannot write '{filename}': {e}", file=sys.stderr)
        sys.exit(1)

    if not quiet:
        print(f"Script done, output file is {filename}")


def _run_command(command, outfile, timing_file, flush, start_time):
    """Execute a command and write its output to the file."""
    line_count = 0

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        stdout = result.stdout
        stderr = result.stderr

        for line in stdout.splitlines(keepends=True):
            outfile.write(line)
            line_count += 1
            if flush:
                outfile.flush()

        if stderr:
            for line in stderr.splitlines(keepends=True):
                outfile.write(line)
                line_count += 1
                if flush:
                    outfile.flush()

    except subprocess.TimeoutExpired:
        outfile.write("[command timed out]\n")
    except Exception as e:
        outfile.write(f"[command error: {e}]\n")

    # Write timing data if requested
    if timing_file:
        elapsed = time.time() - start_time
        _write_timing(timing_file, line_count, elapsed)


def _interactive_mode(outfile, timing_file, flush, start_time):
    """Read from stdin line by line, echo to stdout and write to file."""
    line_count = 0

    try:
        for line in sys.stdin:
            sys.stdout.write(line)
            sys.stdout.flush()
            outfile.write(line)
            line_count += 1
            if flush:
                outfile.flush()

            # Write timing data per line if requested
            if timing_file:
                elapsed = time.time() - start_time
                _write_timing(timing_file, line_count, elapsed)
    except (KeyboardInterrupt, EOFError):
        pass

    # Final timing write
    if timing_file:
        elapsed = time.time() - start_time
        _write_timing(timing_file, line_count, elapsed)


def _write_timing(timing_file, line_count, elapsed):
    """Write simplified timing data: elapsed seconds and line count."""
    try:
        with open(timing_file, "a", encoding="utf-8") as tf:
            tf.write(f"{elapsed:.6f} {line_count}\n")
    except (IOError, OSError) as e:
        print(f"script: cannot write timing file '{timing_file}': {e}", file=sys.stderr)
