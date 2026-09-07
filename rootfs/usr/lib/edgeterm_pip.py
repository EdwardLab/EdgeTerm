import json
import os
import re
import shutil
import site
import sys
from importlib import metadata

import js


VERSION = "EdgeTerm pip wrapper 0.4"
NOOP_FLAGS = {
    "--only-binary",
    "--prefer-binary",
    "--trusted-host",
    "--find-links",
    "--no-cache-dir",
}
VALUE_FLAGS = {
    "--index-url",
    "--extra-index-url",
    "--find-links",
    "--trusted-host",
    "--target",
    "--only-binary",
    "--prefer-binary",
}


def _print(message="", quiet=0):
    if quiet <= 0:
        print(message)


def _warn(message, quiet=0):
    if quiet <= 1:
        print(f"WARNING: {message}")


def _user():
    return os.environ.get("EDGE_USER", "user")


def _user_site_path():
    return f"/home/{_user()}/.local/lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages"


def _state_path():
    return f"/home/{_user()}/.local/share/edgeterm/pip-state.json"


def _ensure_user_site(path=None):
    target = path or _user_site_path()
    os.makedirs(target, exist_ok=True)
    site.addsitedir(target)
    return target


def _ensure_state_dir():
    path = _state_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def _load_state():
    path = _state_path()
    if not os.path.isfile(path):
        return {"installs": {}}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and isinstance(data.get("installs"), dict):
            return data
    except Exception:
        pass
    return {"installs": {}}


def _save_state(state):
    path = _ensure_state_dir()
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)


def _normalize_name(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def _find_requirement_name(requirement):
    requirement = requirement.strip()
    if not requirement or requirement.startswith(("-", "http://", "https://")):
        return None
    match = re.match(r"([A-Za-z0-9_.-]+)", requirement)
    return match.group(1) if match else None


def _read_requirements_file(path):
    resolved = os.path.abspath(path)
    if not os.path.isfile(resolved):
        raise FileNotFoundError(f"requirements file not found: {path}")
    requirements = []
    with open(resolved, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            requirements.append(line)
    return requirements


def _dist_snapshot():
    snapshot = {}
    for dist in metadata.distributions():
        try:
            name = dist.metadata.get("Name")
        except Exception:
            name = None
        if not name:
            continue
        snapshot[_normalize_name(name)] = {"name": name, "version": dist.version}
    return snapshot


def _changed_distributions(before, after, requested_names):
    changed = []
    requested = {_normalize_name(name) for name in requested_names if name}
    for name, info in after.items():
        if name == "micropip":
            continue
        previous = before.get(name)
        if previous != info or name in requested:
            changed.append(info["name"])
    deduped = []
    seen = set()
    for name in changed:
        key = _normalize_name(name)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(name)
    return deduped


def _copy_distribution(name, target_root):
    dist = metadata.distribution(name)
    files = dist.files or []
    copied_files = []
    for file in files:
        src = os.path.abspath(str(dist.locate_file(file)))
        rel = str(file)
        dst = os.path.abspath(os.path.join(target_root, rel))
        if os.path.isfile(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            try:
                same_path = os.path.samefile(src, dst)
            except OSError:
                same_path = src == dst
            if same_path:
                copied_files.append(rel)
                continue
            shutil.copy2(src, dst)
            copied_files.append(rel)
    return copied_files


def _remove_empty_parents(path, stop):
    current = os.path.dirname(path)
    stop = os.path.abspath(stop)
    while current.startswith(stop) and current != stop:
        try:
            os.rmdir(current)
        except OSError:
            break
        current = os.path.dirname(current)


def _remove_recorded_files(target_root, files):
    for rel in sorted(files, key=lambda item: item.count("/"), reverse=True):
        path = os.path.join(target_root, rel)
        if os.path.isfile(path):
            os.remove(path)
            _remove_empty_parents(path, target_root)


def _dist_info(name):
    try:
        return metadata.distribution(name)
    except metadata.PackageNotFoundError:
        return None


def _distribution_lives_under(dist, target_root):
    target_root = os.path.abspath(target_root)
    for file in dist.files or []:
        try:
            located = os.path.abspath(str(dist.locate_file(file)))
        except Exception:
            continue
        if located.startswith(target_root + os.sep) or located == target_root:
            return True
    return False


def _iter_user_distributions():
    user_site = os.path.abspath(_ensure_user_site())
    seen = set()
    for dist in metadata.distributions():
        files = dist.files or []
        for file in files:
            located = os.path.abspath(str(dist.locate_file(file)))
            if located.startswith(user_site + os.sep):
                normalized = _normalize_name(dist.metadata.get("Name", ""))
                if normalized and normalized not in seen:
                    seen.add(normalized)
                    yield dist
                break


def _load_pyodide_package_names():
    try:
        return set(js.pyodide.loadedPackages.to_py())
    except Exception:
        return set()


async def _load_micropip():
    await js.pyodide.loadPackage("micropip")
    import micropip

    return micropip


async def _try_load_pyodide_package(requirement):
    if not requirement:
        return False
    candidate = str(requirement).strip()
    if not candidate:
        return False
    package_name = _find_requirement_name(candidate) or candidate
    normalized_name = _normalize_name(package_name)
    aliases = {
        "pygame": ["pygame-ce", "pygame"],
        "pygame-ce": ["pygame-ce", "pygame"],
    }
    candidates = [candidate]
    if package_name != candidate:
        candidates.append(package_name)
    candidates.extend(aliases.get(normalized_name, []))
    candidates.extend([
        normalized_name,
        normalized_name.replace("-", "_"),
        normalized_name.replace("_", "-"),
    ])
    seen = set()
    for item in candidates:
        item = str(item or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        try:
            await js.pyodide.loadPackage(item)
            return True
        except Exception:
            continue
    return False


def _dist_needs_runtime_rehydrate(dist):
    runtime_suffixes = (".so", ".wasm", ".data", ".js")
    try:
        files = dist.files or []
    except Exception:
        files = []
    for file in files:
        rel = str(file).replace("\\", "/")
        if rel.endswith(runtime_suffixes):
            return True
        if ".libs/" in rel or ".data/" in rel:
            return True
    return False


def _entry_needs_runtime_rehydrate(entry):
    files = entry.get("files", []) or []
    runtime_suffixes = (".so", ".wasm", ".data", ".js")
    for rel in files:
        rel = str(rel).replace("\\", "/")
        if rel.endswith(runtime_suffixes):
            return True
        if ".libs/" in rel or ".data/" in rel:
            return True
    return False


async def rehydrate_runtime_installs():
    _ensure_user_site()
    installs = _load_state().get("installs", {})
    report = {"attempted": [], "loaded": [], "failed": []}
    queued = []
    seen = set()

    for entry in installs.values():
        if not isinstance(entry, dict) or not _entry_needs_runtime_rehydrate(entry):
            continue
        requested = [item for item in (entry.get("requested") or []) if item]
        requirement = requested[0] if requested else entry.get("name")
        display_name = entry.get("name") or requirement
        if not requirement or not display_name:
            continue
        key = _normalize_name(display_name)
        if key in seen:
            continue
        seen.add(key)
        queued.append((display_name, requirement))

    for dist in _iter_user_distributions():
        if not _dist_needs_runtime_rehydrate(dist):
            continue
        display_name = dist.metadata.get("Name", "") or ""
        if not display_name:
            continue
        key = _normalize_name(display_name)
        if key in seen:
            continue
        seen.add(key)
        queued.append((display_name, display_name))

    if not queued:
        return report

    micropip = None
    for display_name, requirement in queued:
        report["attempted"].append(display_name)
        try:
            loaded = await _try_load_pyodide_package(requirement)
            if not loaded:
                if micropip is None:
                    micropip = await _load_micropip()
                await micropip.install(requirement)
            report["loaded"].append(display_name)
        except Exception as err:
            report["failed"].append({"name": display_name, "error": _format_install_error(err)})
    return report


def _format_install_error(err):
    text = str(err)
    lowered = text.lower()
    if "no matching distribution found" in lowered or "can't find a pure python 3 wheel" in lowered:
        return (
            "Package is not available as a Pyodide-compatible wheel. "
            "EdgeTerm can install pure Python wheels and Pyodide wasm packages, "
            "but not packages that require native CPython builds, compilers, or system libraries."
        )
    if "emscripten" in lowered or "wasm32" in lowered:
        return (
            "Package requires a wheel that matches the browser's WebAssembly runtime. "
            "Try a pure Python package or a package included in Pyodide."
        )
    if "subprocess" in lowered or "gcc" in lowered or "rust" in lowered:
        return (
            "Package appears to require native build tools or subprocess execution, "
            "which EdgeTerm cannot provide inside the browser."
        )
    if "socket" in lowered or "network" in lowered:
        return (
            "Package install hit a browser networking/runtime limitation. "
            "EdgeTerm cannot emulate full system sockets or unrestricted native networking."
        )
    return text


def _parse_global_options(args):
    quiet = 0
    verbose = 0
    remaining = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in {"-q", "--quiet"}:
            quiet += 1
            i += 1
            continue
        if arg in {"-v", "--verbose"}:
            verbose += 1
            i += 1
            continue
        remaining = args[i:]
        break
    return quiet, verbose, remaining


def _parse_install_args(args):
    options = {
        "requirements": [],
        "index_urls": [],
        "target": None,
        "user": False,
        "upgrade": False,
        "force_reinstall": False,
        "no_deps": False,
        "dry_run": False,
        "quiet": 0,
        "verbose": 0,
        "warnings": [],
    }

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in {"-q", "--quiet"}:
            options["quiet"] += 1
            i += 1
            continue
        if arg in {"-v", "--verbose"}:
            options["verbose"] += 1
            i += 1
            continue
        if arg in {"-U", "--upgrade"}:
            options["upgrade"] = True
            i += 1
            continue
        if arg == "--force-reinstall":
            options["force_reinstall"] = True
            i += 1
            continue
        if arg == "--no-deps":
            options["no_deps"] = True
            i += 1
            continue
        if arg == "--dry-run":
            options["dry_run"] = True
            i += 1
            continue
        if arg == "--user":
            options["user"] = True
            i += 1
            continue
        if arg in {"-r", "--requirement"}:
            if i + 1 >= len(args):
                raise ValueError(f"{arg} expects a file path")
            options["requirements"].extend(_read_requirements_file(args[i + 1]))
            i += 2
            continue
        if arg in VALUE_FLAGS:
            if i + 1 >= len(args):
                raise ValueError(f"{arg} expects a value")
            value = args[i + 1]
            if arg in {"--index-url", "--extra-index-url"}:
                options["index_urls"].append(value)
            elif arg == "--target":
                options["target"] = os.path.abspath(value)
            else:
                options["warnings"].append(f"{arg} is accepted for compatibility but is a no-op in EdgeTerm.")
            i += 2
            continue
        if arg in NOOP_FLAGS:
            options["warnings"].append(f"{arg} is accepted for compatibility but is a no-op in EdgeTerm.")
            i += 1
            continue
        if arg == "--":
            options["requirements"].extend(args[i + 1 :])
            break
        if arg.startswith("-"):
            options["warnings"].append(f"{arg} is not fully supported in EdgeTerm and will be ignored.")
            i += 1
            continue
        options["requirements"].append(arg)
        i += 1
    return options


def _parse_uninstall_args(args):
    yes = False
    quiet = 0
    verbose = 0
    packages = []
    for arg in args:
        if arg in {"-y", "--yes"}:
            yes = True
        elif arg in {"-q", "--quiet"}:
            quiet += 1
        elif arg in {"-v", "--verbose"}:
            verbose += 1
        elif arg.startswith("-"):
            _warn(f"{arg} is ignored by EdgeTerm uninstall.", quiet)
        else:
            packages.append(arg)
    return yes, quiet, verbose, packages


def _print_help():
    print(
        """pip (EdgeTerm browser-aware wrapper)

Usage:
  pip install <package> [package...]
  pip install -r requirements.txt
  pip uninstall <package> [package...]
  pip list
  pip show <package> [package...]
  pip freeze
  pip check
  pip help
  pip --version

Notes:
  - Uses micropip and Pyodide package loading under the hood
  - Persists installs per workspace user in ~/.local/lib/pythonX.Y/site-packages
  - Supports pure Python wheels and Pyodide-compatible wasm packages
  - Native extension builds, virtualenvs, and full pip resolver parity are out of scope
"""
    )


async def _install(args):
    options = _parse_install_args(args)
    requirements = options["requirements"]
    if not requirements:
        raise ValueError("pip install: expected one or more package names or requirement files")

    target_root = _ensure_user_site(options["target"] or _user_site_path())
    state = _load_state()

    for warning in options["warnings"]:
        _warn(warning, options["quiet"])

    if options["target"] and options["target"] != _user_site_path():
        _warn("Custom --target installs are supported, but only workspace paths are sensible in EdgeTerm.", options["quiet"])

    if options["dry_run"]:
        _print("Would install:", options["quiet"])
        for requirement in requirements:
            _print(f"  {requirement}", options["quiet"])
        return

    if options["force_reinstall"]:
        requested_names = [_find_requirement_name(req) for req in requirements]
        for name in requested_names:
            if name:
                await _uninstall_packages([name], yes=True, quiet=options["quiet"], verbose=options["verbose"], missing_ok=True)

    micropip = await _load_micropip()
    before = _dist_snapshot()
    requested_names = [_find_requirement_name(req) for req in requirements]

    if options["quiet"] <= 0:
        print(f"Installing {' '.join(requirements)} ...")

    kwargs = {}
    if options["index_urls"]:
        kwargs["index_urls"] = options["index_urls"]
    kwargs["deps"] = not options["no_deps"]
    kwargs["verbose"] = options["verbose"] if options["verbose"] else None

    try:
        await micropip.install(requirements, **kwargs)
    except Exception as err:
        raise RuntimeError(_format_install_error(err)) from err

    after = _dist_snapshot()
    changed = _changed_distributions(before, after, requested_names)
    persisted_files = 0
    installs = state.setdefault("installs", {})
    for name in changed:
        dist = _dist_info(name)
        if not dist:
            continue
        normalized = _normalize_name(dist.metadata.get("Name", name))
        previous_entry = installs.get(normalized)
        if (
            previous_entry
            and previous_entry.get("target") == target_root
            and not _distribution_lives_under(dist, target_root)
        ):
            _remove_recorded_files(target_root, previous_entry.get("files", []))
        copied = _copy_distribution(name, target_root)
        persisted_files += len(copied)
        installs[normalized] = {
            "name": dist.metadata.get("Name", name),
            "version": dist.version,
            "target": target_root,
            "files": copied,
            "requested": [req for req in requirements if _normalize_name(_find_requirement_name(req) or req) == normalized] or [dist.metadata.get("Name", name)],
        }
    _save_state(state)

    _print(f"Successfully installed {' '.join(requirements)}", options["quiet"])
    if changed:
        _print(f"Persisted {len(changed)} package(s) ({persisted_files} files) to {target_root}", options["quiet"])
    elif options["quiet"] <= 0:
        print("No new package files were copied; packages may already have been present in the runtime.")

    if options["upgrade"] or options["force_reinstall"]:
        _warn("Reload the page if a package was already imported and does not seem updated.", options["quiet"])


def _user_installs_from_state():
    state = _load_state()
    installs = list(state.get("installs", {}).values())
    installs.sort(key=lambda item: item["name"].lower())
    return installs


def _find_state_entry(name):
    key = _normalize_name(name)
    return _load_state().get("installs", {}).get(key)


def _print_table(rows):
    if not rows:
        print("Package    Version")
        return
    width = max(len("Package"), max(len(row[0]) for row in rows))
    print(f"{'Package':<{width}}  Version")
    print(f"{'-' * width}  {'-' * 7}")
    for name, version in rows:
        print(f"{name:<{width}}  {version}")


def _list_packages():
    rows = [(item["name"], item["version"]) for item in _user_installs_from_state()]
    _print_table(rows)


def _show_packages(names):
    missing = []
    for name in names:
        dist = _dist_info(name)
        entry = _find_state_entry(name)
        if not dist and not entry:
            missing.append(name)
            continue
        if dist:
            meta = dist.metadata
            location = entry["target"] if entry else _user_site_path()
            print(f"Name: {meta.get('Name', name)}")
            print(f"Version: {dist.version}")
            print(f"Summary: {meta.get('Summary', '')}")
            print(f"Home-page: {meta.get('Home-page', '')}")
            print(f"Author: {meta.get('Author', '')}")
            print(f"License: {meta.get('License', '')}")
            print(f"Location: {location}")
            requires = meta.get_all("Requires-Dist", [])
            print(f"Requires: {', '.join(requires) if requires else ''}")
            print()
        else:
            print(f"Name: {entry['name']}")
            print(f"Version: {entry['version']}")
            print(f"Location: {entry['target']}")
            print()
    if missing:
        raise RuntimeError("Package(s) not found: " + ", ".join(missing))


def _freeze_packages():
    installs = _user_installs_from_state()
    for item in installs:
        print(f"{item['name']}=={item['version']}")


def _check_packages():
    installs = _user_installs_from_state()
    missing = []
    for item in installs:
        dist = _dist_info(item["name"])
        if not dist:
            missing.append(item["name"])
    if missing:
        raise RuntimeError("Broken package metadata: " + ", ".join(missing))
    print("No broken requirements found in EdgeTerm's lightweight package check.")


async def _uninstall_packages(packages, yes=False, quiet=0, verbose=0, missing_ok=False):
    if not packages:
        raise ValueError("pip uninstall: expected one or more package names")

    state = _load_state()
    installs = state.setdefault("installs", {})
    removed = []
    missing = []

    for name in packages:
        key = _normalize_name(name)
        entry = installs.get(key)
        if not entry:
            missing.append(name)
            continue
        if not yes:
            _warn(f"Auto-confirming uninstall of {entry['name']} in EdgeTerm.", quiet)
        _remove_recorded_files(entry["target"], entry.get("files", []))
        installs.pop(key, None)
        removed.append(entry["name"])

    _save_state(state)

    if removed:
        _print(f"Successfully uninstalled {' '.join(removed)}", quiet)
    if missing and not missing_ok:
        raise RuntimeError("Package(s) not installed via EdgeTerm pip: " + ", ".join(missing))


async def _dispatch(command, args, quiet, verbose):
    if command == "install":
        await _install(args)
        return
    if command == "uninstall":
        yes, local_quiet, local_verbose, packages = _parse_uninstall_args(args)
        await _uninstall_packages(packages, yes=yes, quiet=max(quiet, local_quiet), verbose=max(verbose, local_verbose))
        return
    if command == "list":
        _list_packages()
        return
    if command == "show":
        if not args:
            raise ValueError("pip show: expected one or more package names")
        _show_packages(args)
        return
    if command == "freeze":
        _freeze_packages()
        return
    if command == "check":
        _check_packages()
        return
    if command in {"help", "-h", "--help"}:
        _print_help()
        return
    raise RuntimeError(f"pip: unsupported command '{command}'")


async def main(args):
    quiet, verbose, remaining = _parse_global_options(args)
    if not remaining:
        _print_help()
        return
    if remaining[0] in {"-V", "--version"}:
        print(VERSION)
        return
    command = remaining[0]
    await _dispatch(command, remaining[1:], quiet, verbose)
