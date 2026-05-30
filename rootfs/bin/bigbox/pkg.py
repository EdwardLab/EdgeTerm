"""pkg - EdgeTerm browser-native binary package manager."""

import base64
import builtins
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import time
import zipfile
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

try:
    import js
except Exception:  # pragma: no cover - host-side syntax checks
    js = None

try:
    from pyodide.http import pyfetch
except Exception:  # pragma: no cover - host-side syntax checks
    pyfetch = None


VERSION = "0.1.0"
INDEX_FORMAT = "edgeterm-pkg-index-v1"
ARCH = "wasm32-emscripten"
SOURCES_LIST = "/etc/sources.list"
PKG_LIB = "/var/lib/pkg"
LISTS_DIR = f"{PKG_LIB}/lists"
INSTALLED_DIR = f"{PKG_LIB}/installed"
STATUS_PATH = f"{PKG_LIB}/status.json"
LIB_CACHE_DIR = f"{PKG_LIB}/cache"
CACHE_DIR = "/var/cache/pkg"
PACKAGES_DIR = "/packages"
BIN_DIR = "/bin"


HELP = """EdgeTerm pkg - browser-native package manager

Usage:
  pkg <command> [options] [arguments]

Commands:
  update                 Update package indexes
  install <pkg>          Install a package
  remove <pkg>           Remove a package
  purge <pkg>            Remove package and config/state
  upgrade                Upgrade installed packages
  list                   List packages
  search <query>         Search packages
  info <pkg>             Show package information
  files <pkg>            List installed files
  which <command>        Show package providing command
  depends <pkg>          Show dependencies
  rdepends <pkg>         Show reverse dependencies
  verify                 Verify installed packages
  doctor                 Diagnose package problems
  clean                  Clear package cache
  autoremove             Remove unused dependencies
  source                 Manage package sources
  help                   Show help

Options:
  -h, --help             Show help
  -v, --version          Show version
  -y, --yes              Assume yes
  -q, --quiet            Less output
  --verbose              More output
  --no-scripts           Do not run install/remove scripts
  --reinstall            Reinstall package
  --dry-run              Show planned actions only
"""


SOURCE_HELP = """Usage:
  pkg source list
  pkg source add <url>
  pkg source remove <url>

Source formats in /etc/sources.list:
  repo <url> [index.json]
      Fetch a direct index URL, or <url>/index.json when no index is given.

  deb <base-url> <channel> <component>
      Fetch <base-url>/dists/<channel>/<component>/index.json.

Blank lines and lines beginning with # are ignored.
"""


class PkgError(Exception):
    pass


@dataclass
class Options:
    yes: bool = False
    quiet: bool = False
    verbose: bool = False
    no_scripts: bool = False
    reinstall: bool = False
    dry_run: bool = False


def log(message, options=None):
    if options and options.quiet:
        return
    print(f"[PKG] {message}")


def warn(message):
    print(f"pkg: warning: {message}", file=sys.stderr)


def ensure_dirs():
    for path in (PKG_LIB, LISTS_DIR, INSTALLED_DIR, LIB_CACHE_DIR, CACHE_DIR, PACKAGES_DIR, BIN_DIR, os.path.dirname(SOURCES_LIST)):
        os.makedirs(path, exist_ok=True)
    if not os.path.exists(SOURCES_LIST):
        with open(SOURCES_LIST, "w", encoding="utf-8") as handle:
            handle.write("# EdgeTerm package sources\n")


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def write_json(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 256), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checksum_matches(path, expected):
    if not expected:
        return True
    value = str(expected)
    if value.startswith("sha256-"):
        value = value.split("-", 1)[1]
    return sha256_file(path).lower() == value.lower()


def human_size(size):
    try:
        size = float(size)
    except Exception:
        return "unknown"
    for unit in ("B", "K", "M", "G"):
        if size < 1024:
            return f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}T"


def version_key(version):
    parts = []
    for item in re.split(r"([0-9]+|[A-Za-z]+)", str(version or "0")):
        if not item or item in ".-_+~":
            continue
        parts.append((0, int(item)) if item.isdigit() else (1, item.lower()))
    return parts


def compare_versions(left, right):
    a = version_key(left)
    b = version_key(right)
    max_len = max(len(a), len(b))
    for idx in range(max_len):
        av = a[idx] if idx < len(a) else (0, 0)
        bv = b[idx] if idx < len(b) else (0, 0)
        if av < bv:
            return -1
        if av > bv:
            return 1
    return 0


def parse_dependency(dep):
    text = str(dep or "").strip()
    match = re.match(r"^([A-Za-z0-9_.+-]+)\s*(>=|<=|=|>|<)?\s*(.*)$", text)
    if not match:
        raise PkgError(f"invalid dependency: {dep}")
    name, op, version = match.groups()
    return name, op or "", version.strip()


def dependency_satisfied(version, op, required):
    if not op:
        return True
    cmp = compare_versions(version, required)
    return {
        "=": cmp == 0,
        ">=": cmp >= 0,
        "<=": cmp <= 0,
        ">": cmp > 0,
        "<": cmp < 0,
    }.get(op, False)


def normalize_manifest(manifest, package_name=None):
    data = dict(manifest or {})
    name = str(data.get("name") or package_name or "").strip()
    if not name:
        raise PkgError("manifest missing package name")
    data["name"] = name
    data["version"] = str(data.get("version") or "0")
    data.setdefault("description", "")
    data.setdefault("license", "")
    data.setdefault("runtime", data.get("type") or "emscripten")
    data.setdefault("type", data.get("runtime") or "emscripten-cli")
    data.setdefault("arch", ARCH)
    data.setdefault("dependencies", data.get("requires") or [])
    data.setdefault("optionalDependencies", [])
    data.setdefault("provides", [])
    data.setdefault("conflicts", [])
    data.setdefault("tags", [])
    data.setdefault("scripts", {})
    data.setdefault("env", {})
    data.setdefault("checksums", {})
    if "bin" not in data and data.get("entry"):
        data["bin"] = {str(data["entry"]): str(data.get("js") or data["entry"])}
    data.setdefault("bin", {})
    return data


def package_files(root):
    files = []
    if not os.path.isdir(root):
        return files
    for current, dirs, names in os.walk(root):
        dirs.sort()
        names.sort()
        for name in names:
            full = os.path.join(current, name)
            files.append(os.path.relpath(full, root).replace(os.sep, "/"))
    return files


def load_status():
    ensure_dirs()
    status = read_json(STATUS_PATH, {"format": "edgeterm-pkg-status-v1", "installed": {}, "auto": {}, "updatedAt": None})
    status.setdefault("format", "edgeterm-pkg-status-v1")
    status.setdefault("installed", {})
    status.setdefault("auto", {})
    migrate_installed_packages(status)
    return status


def save_status(status):
    status["updatedAt"] = now_iso()
    write_json(STATUS_PATH, status)


def migrate_installed_packages(status):
    os.makedirs(PACKAGES_DIR, exist_ok=True)
    installed = status.setdefault("installed", {})
    for name in sorted(os.listdir(PACKAGES_DIR)):
        root = f"{PACKAGES_DIR}/{name}"
        manifest_path = f"{root}/package.json"
        if not os.path.isfile(manifest_path):
            continue
        try:
            manifest = normalize_manifest(read_json(manifest_path), name)
            manifest["name"] = name
        except Exception as exc:
            warn(f"skipping invalid installed manifest {manifest_path}: {exc}")
            continue
        key = manifest["name"]
        if key not in installed:
            installed[key] = {
                "name": key,
                "version": manifest["version"],
                "status": "installed",
                "manual": True,
                "source": "local-migration",
                "installedAt": now_iso(),
                "manifest": manifest,
                "files": package_files(root),
            }
            write_json(f"{INSTALLED_DIR}/{key}.json", installed[key])


def parse_sources():
    ensure_dirs()
    sources = []
    with open(SOURCES_LIST, "r", encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            kind = parts[0]
            if kind == "repo":
                if len(parts) < 2:
                    raise PkgError(f"{SOURCES_LIST}:{lineno}: repo source needs a URL")
                base = parts[1]
                index = parts[2] if len(parts) > 2 else "index.json"
                url = base if base.endswith(".json") else join_source_url(base, index)
                sources.append({"type": "repo", "url": url, "raw": line})
            elif kind == "deb":
                if len(parts) < 4:
                    raise PkgError(f"{SOURCES_LIST}:{lineno}: deb source needs: deb <url> <channel> <component>")
                base, channel, component = parts[1], parts[2], parts[3]
                url = join_source_url(base, "dists", channel, component, "index.json")
                sources.append({"type": "deb", "url": url, "base": base, "channel": channel, "component": component, "raw": line})
            else:
                raise PkgError(f"{SOURCES_LIST}:{lineno}: unknown source type: {kind}")
    return sources


def source_list_text():
    ensure_dirs()
    with open(SOURCES_LIST, "r", encoding="utf-8") as handle:
        return handle.read()


def source_id(url):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", url).strip("_")[:120] or "source"


def is_remote_url(value):
    parsed = urlparse(str(value))
    return parsed.scheme in ("http", "https")


def join_source_url(base, *parts):
    if is_remote_url(base):
        return urljoin(base.rstrip("/") + "/", "/".join(parts))
    return os.path.join(base, *parts).replace(os.sep, "/")


async def fetch_via_proxy(url):
    if pyfetch is None:
        raise PkgError("network fetch is only available inside EdgeTerm")
    response = await pyfetch(
        "/__edgeterm_http_proxy",
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps({"url": url, "method": "GET", "headers": {}}),
    )
    if not response.ok:
        raise PkgError(f"proxy failed with HTTP {response.status}")
    data = await response.json()
    if not data.get("ok"):
        raise PkgError(data.get("error") or "proxy request failed")
    return base64.b64decode(data.get("body_base64", "") or "")


async def fetch_bytes(url):
    parsed = urlparse(str(url))
    if parsed.scheme in ("", "file") or (len(parsed.scheme) == 1 and os.name == "nt"):
        path = parsed.path if parsed.scheme == "file" else str(url)
        with open(path, "rb") as handle:
            return handle.read()
    if pyfetch is None:
        raise PkgError("network fetch is only available inside EdgeTerm")
    try:
        response = await pyfetch(url, method="GET", redirect="follow")
        raw = bytes(await response.bytes())
        if response.ok and response.status != 0:
            return raw
        if response.status and response.status != 0:
            raise PkgError(f"HTTP {response.status} {getattr(response, 'status_text', '')}".strip())
    except Exception as exc:
        if "Failed to fetch" not in str(exc):
            raise PkgError(f"unable to fetch {url}: {exc}")
    return await fetch_via_proxy(url)


def validate_index(index, source):
    if not isinstance(index, dict):
        raise PkgError(f"invalid index from {source}: root must be an object")
    if index.get("format") != INDEX_FORMAT:
        raise PkgError(f"invalid index from {source}: expected format {INDEX_FORMAT}")
    packages = index.get("packages")
    if not isinstance(packages, list):
        raise PkgError(f"invalid index from {source}: packages must be a list")
    normalized = []
    for item in packages:
        if not isinstance(item, dict):
            raise PkgError(f"invalid package entry in {source}")
        pkg = normalize_manifest(item, item.get("name"))
        if not pkg.get("url") and not pkg.get("external"):
            raise PkgError(f"invalid package entry {pkg['name']}: missing url")
        pkg["source"] = source
        normalized.append(pkg)
    index = dict(index)
    index["packages"] = normalized
    return index


async def cmd_update(options):
    sources = parse_sources()
    if not sources:
        raise PkgError("source list is empty, run: pkg source add <url>")
    log("Reading package lists...", options)
    count = 0
    for source in sources:
        url = source["url"]
        log(f"Fetching {url}", options)
        raw = await fetch_bytes(url)
        try:
            index = validate_index(json.loads(raw.decode("utf-8")), url)
        except UnicodeDecodeError:
            raise PkgError(f"invalid index from {url}: not UTF-8 JSON")
        path = f"{LISTS_DIR}/{source_id(url)}.json"
        index["_source"] = source
        index["_fetchedAt"] = now_iso()
        write_json(path, index)
        count += len(index["packages"])
    log(f"Done. {count} packages available.", options)
    return 0


def load_indexes():
    ensure_dirs()
    indexes = []
    for name in sorted(os.listdir(LISTS_DIR)):
        if name.endswith(".json"):
            try:
                indexes.append(read_json(f"{LISTS_DIR}/{name}"))
            except Exception as exc:
                warn(f"ignoring bad package list {name}: {exc}")
    return indexes


def package_candidates(name):
    candidates = []
    for index in load_indexes():
        source_url = (index.get("_source") or {}).get("url") or index.get("_source", {}).get("raw") or ""
        for pkg in index.get("packages", []):
            if pkg.get("name") == name or name in pkg.get("provides", []):
                item = dict(pkg)
                item["_indexSource"] = source_url
                candidates.append(item)
    return sorted(candidates, key=lambda p: version_key(p.get("version")), reverse=True)


def available_packages():
    result = {}
    for index in load_indexes():
        for pkg in index.get("packages", []):
            name = pkg["name"]
            current = result.get(name)
            if current is None or compare_versions(pkg.get("version"), current.get("version")) > 0:
                result[name] = dict(pkg)
    return result


def select_package(spec):
    if "=" in spec and not re.search(r"[<>]", spec):
        name, wanted_version = spec.split("=", 1)
    else:
        name, wanted_version = spec, ""
    candidates = package_candidates(name)
    if wanted_version:
        candidates = [pkg for pkg in candidates if pkg.get("version") == wanted_version]
    if not candidates:
        raise PkgError(f"package not found: {spec}")
    return candidates[0]


def resolve_dependencies(specs, status, include_installed=False):
    plan = []
    visiting = []
    visited = set()

    def visit(spec, manual):
        pkg = select_package(spec)
        name = pkg["name"]
        if name in visiting:
            cycle = " -> ".join([*visiting[visiting.index(name):], name])
            raise PkgError(f"dependency cycle detected: {cycle}")
        if name in visited:
            return
        installed = status.get("installed", {}).get(name)
        if installed and not include_installed and dependency_satisfied(installed.get("version"), "", ""):
            visited.add(name)
            return
        visiting.append(name)
        for dep in pkg.get("dependencies", []) or []:
            dep_name, op, dep_version = parse_dependency(dep)
            installed_dep = status.get("installed", {}).get(dep_name)
            if installed_dep and dependency_satisfied(installed_dep.get("version"), op, dep_version):
                continue
            dep_spec = f"{dep_name}={dep_version}" if op == "=" and dep_version else dep_name
            dep_pkg = select_package(dep_spec)
            if op and not dependency_satisfied(dep_pkg.get("version"), op, dep_version):
                raise PkgError(f"missing dependency for {name}: {dep}")
            visit(dep_spec, False)
        visiting.pop()
        visited.add(name)
        plan.append((pkg, manual))

    for spec in specs:
        visit(spec, True)
    return plan


def resolve_package_url(pkg):
    url = str(pkg.get("url") or "")
    parsed = urlparse(url)
    if is_remote_url(url) or url.startswith("/"):
        return url
    source = pkg.get("_indexSource") or pkg.get("source") or ""
    if is_remote_url(source):
        if source.endswith(".json"):
            return urljoin(source.rsplit("/", 1)[0] + "/", url)
        return urljoin(source.rstrip("/") + "/", url)
    base = os.path.dirname(source) if source.endswith(".json") else source
    return os.path.join(base, url).replace(os.sep, "/")


def resolve_package_asset_url(pkg, key):
    value = str(pkg.get(key) or "")
    if not value:
        return ""
    parsed = urlparse(value)
    if is_remote_url(value) or value.startswith("/"):
        return value
    source = pkg.get("_indexSource") or pkg.get("source") or ""
    if is_remote_url(source):
        if source.endswith(".json"):
            return urljoin(source.rsplit("/", 1)[0] + "/", value)
        return urljoin(source.rstrip("/") + "/", value)
    base = os.path.dirname(source) if source.endswith(".json") else source
    return os.path.join(base, value).replace(os.sep, "/")


def safe_archive_members_tar(tf):
    members = tf.getmembers()
    for member in members:
        name = member.name
        if name.startswith("/") or ".." in name.split("/"):
            raise PkgError(f"unsafe archive path: {name}")
    return members


def extract_archive(archive_path, dest):
    tmp = f"{dest}.extract-{int(time.time() * 1000)}"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    try:
        if archive_path.endswith((".tar.gz", ".tgz", ".tar")):
            mode = "r:gz" if archive_path.endswith((".tar.gz", ".tgz")) else "r"
            with tarfile.open(archive_path, mode) as tf:
                tf.extractall(tmp, members=safe_archive_members_tar(tf))
        elif archive_path.endswith(".zip"):
            with zipfile.ZipFile(archive_path) as zf:
                for info in zf.infolist():
                    name = info.filename
                    if name.startswith("/") or ".." in name.split("/"):
                        raise PkgError(f"unsafe archive path: {name}")
                zf.extractall(tmp)
        else:
            raise PkgError("unsupported package archive; use .tar.gz, .tgz, .tar, or .zip")
        payload = tmp
        entries = [entry for entry in os.listdir(tmp) if entry not in (".", "..")]
        if len(entries) == 1 and os.path.isdir(os.path.join(tmp, entries[0])) and os.path.exists(os.path.join(tmp, entries[0], "package.json")):
            payload = os.path.join(tmp, entries[0])
        shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(payload, dest)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def run_script(script, manifest, phase, options):
    if options.no_scripts or not script:
        return 0
    if not options.yes:
        print(f"pkg: package {manifest['name']} wants to run {phase}: {script}")
        print("pkg: treating package scripts as trusted package code; use -y to suppress this warning")
    shell = getattr(builtins, "EDGETERM_SHELL", None)
    if shell is None:
        raise PkgError(f"cannot run {phase}: EdgeTerm shell is unavailable")
    old_env = dict(os.environ)
    env = {
        "PKG_NAME": manifest["name"],
        "PKG_VERSION": manifest["version"],
        "PKG_ROOT": PACKAGES_DIR,
        "PKG_PATH": f"{PACKAGES_DIR}/{manifest['name']}",
        **{str(k): str(v) for k, v in (manifest.get("env") or {}).items()},
    }
    try:
        os.environ.update(env)
        shell.env.update(env)
        result = await shell.execute_text(str(script))
        if result.stdout:
            print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
        if result.stderr:
            print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)
        return int(result.code or 0)
    finally:
        os.environ.clear()
        os.environ.update(old_env)
        if hasattr(shell, "env"):
            shell.env.update(old_env)


def register_binaries(manifest, options):
    registered = []
    root = f"{PACKAGES_DIR}/{manifest['name']}"
    for command, target in (manifest.get("bin") or {}).items():
        link_path = f"{BIN_DIR}/{command}"
        target_path = f"{root}/{target}"
        if not os.path.exists(target_path):
            warn(f"binary target missing for {command}: {target_path}")
            continue
        try:
            if os.path.lexists(link_path):
                if os.path.islink(link_path) and os.readlink(link_path).startswith(root):
                    os.unlink(link_path)
                else:
                    continue
            os.symlink(target_path, link_path)
            registered.append(link_path)
            log(f"Registering binary: {link_path}", options)
        except Exception as exc:
            warn(f"could not register {command}: {exc}")
    return registered


def unregister_binaries(record, options):
    manifest = record.get("manifest") or {}
    root = f"{PACKAGES_DIR}/{record.get('name') or manifest.get('name')}"
    for command in (manifest.get("bin") or {}):
        link_path = f"{BIN_DIR}/{command}"
        try:
            if os.path.islink(link_path) and os.readlink(link_path).startswith(root):
                os.unlink(link_path)
                log(f"Removing binary: {link_path}", options)
        except Exception as exc:
            warn(f"could not remove binary {command}: {exc}")


async def install_one(pkg, manual, status, options):
    name = pkg["name"]
    version = pkg["version"]
    current = status["installed"].get(name)
    if current and current.get("version") == version and not options.reinstall:
        log(f"{name} is already installed ({version}).", options)
        if manual:
            current["manual"] = True
        return
    if options.dry_run:
        log(f"Would install {name} {version}", options)
        return
    log(f"Installing {name} {version}...", options)
    if pkg.get("external"):
        manifest = normalize_manifest(pkg, name)
        manifest["name"] = name
        if manifest.get("assetRoot"):
            manifest["assetRoot"] = resolve_package_asset_url(pkg, "assetRoot")
        package_root = f"{PACKAGES_DIR}/{name}"
        if current:
            unregister_binaries(current, options)
            shutil.rmtree(package_root, ignore_errors=True)
        os.makedirs(package_root, exist_ok=True)
        write_json(f"{package_root}/package.json", manifest)
        record = {
            "name": name,
            "version": manifest["version"],
            "status": "installed",
            "manual": bool(manual),
            "source": pkg.get("source") or pkg.get("_indexSource") or "",
            "archive": "",
            "installedAt": now_iso(),
            "manifest": manifest,
            "files": package_files(package_root),
            "registered": [],
            "sha256": "",
            "size": pkg.get("size", 0),
            "external": True,
        }
        status["installed"][name] = record
        write_json(f"{INSTALLED_DIR}/{name}.json", record)
        return
    url = resolve_package_url(pkg)
    archive_name = os.path.basename(urlparse(url).path) or f"{name}-{version}.tar.gz"
    archive_path = f"{CACHE_DIR}/{archive_name}"
    if not os.path.exists(archive_path) or not checksum_matches(archive_path, pkg.get("sha256")):
        raw = await fetch_bytes(url)
        with open(archive_path, "wb") as handle:
            handle.write(raw)
    if pkg.get("sha256") and not checksum_matches(archive_path, pkg.get("sha256")):
        raise PkgError(f"checksum mismatch for {name}")
    package_root = f"{PACKAGES_DIR}/{name}"
    if current:
        unregister_binaries(current, options)
    extract_archive(archive_path, package_root)
    manifest_path = f"{package_root}/package.json"
    if os.path.isfile(manifest_path):
        manifest = normalize_manifest(read_json(manifest_path), name)
        manifest["name"] = name
        write_json(manifest_path, manifest)
    else:
        manifest = normalize_manifest(pkg, name)
        manifest["name"] = name
        write_json(manifest_path, manifest)
    pre = (manifest.get("scripts") or {}).get("preinstall")
    if await run_script(pre, manifest, "preinstall", options) != 0:
        shutil.rmtree(package_root, ignore_errors=True)
        raise PkgError(f"preinstall failed for {name}")
    files = package_files(package_root)
    registered = register_binaries(manifest, options)
    record = {
        "name": name,
        "version": manifest["version"],
        "status": "installed",
        "manual": bool(manual),
        "source": pkg.get("source") or pkg.get("_indexSource") or "",
        "archive": archive_path,
        "installedAt": now_iso(),
        "manifest": manifest,
        "files": files,
        "registered": registered,
        "sha256": pkg.get("sha256", ""),
        "size": pkg.get("size", 0),
    }
    post = (manifest.get("scripts") or {}).get("postinstall")
    if await run_script(post, manifest, "postinstall", options) != 0:
        record["status"] = "partial"
        status["installed"][name] = record
        write_json(f"{INSTALLED_DIR}/{name}.json", record)
        save_status(status)
        raise PkgError(f"postinstall failed for {name}; package marked partial, run: pkg doctor")
    status["installed"][name] = record
    write_json(f"{INSTALLED_DIR}/{name}.json", record)


async def cmd_install(args, options):
    if not args:
        raise PkgError("missing package name")
    status = load_status()
    log("Resolving dependencies...", options)
    plan = resolve_dependencies(args, status, include_installed=options.reinstall)
    if not plan:
        log("Nothing to do.", options)
        return 0
    for pkg, manual in plan:
        await install_one(pkg, manual, status, options)
    save_status(status)
    log("Done.", options)
    return 0


async def remove_one(name, purge, status, options):
    record = status["installed"].get(name)
    if not record:
        raise PkgError(f"package is not installed: {name}")
    manifest = record.get("manifest") or {}
    if not options.dry_run:
        script = (manifest.get("scripts") or {}).get("preremove")
        if await run_script(script, manifest, "preremove", options) != 0:
            raise PkgError(f"preremove failed for {name}")
    log(f"Removing {name}...", options)
    if not options.dry_run:
        unregister_binaries(record, options)
        shutil.rmtree(f"{PACKAGES_DIR}/{name}", ignore_errors=True)
        if purge:
            shutil.rmtree(f"/var/lib/{name}", ignore_errors=True)
            shutil.rmtree(f"/etc/{name}", ignore_errors=True)
        script = (manifest.get("scripts") or {}).get("postremove")
        code = await run_script(script, manifest, "postremove", options)
        if code != 0:
            warn(f"postremove failed for {name}")
        status["installed"].pop(name, None)
        try:
            os.remove(f"{INSTALLED_DIR}/{name}.json")
        except FileNotFoundError:
            pass


async def cmd_remove(args, purge, options):
    if not args:
        raise PkgError("missing package name")
    status = load_status()
    for name in args:
        await remove_one(name, purge, status, options)
    save_status(status)
    log("Done.", options)
    return 0


async def cmd_upgrade(options):
    status = load_status()
    targets = []
    for name, record in status["installed"].items():
        candidates = package_candidates(name)
        if candidates and compare_versions(candidates[0].get("version"), record.get("version")) > 0:
            targets.append(name)
    if not targets:
        log("All packages are up to date.", options)
        return 0
    return await cmd_install(targets, Options(**{**options.__dict__, "reinstall": True}))


def format_pkg_line(pkg, installed=None):
    marker = " [installed]" if installed else ""
    return f"{pkg.get('name')} {pkg.get('version')}{marker} - {pkg.get('description', '')}".rstrip()


def cmd_list(args):
    status = load_status()
    installed_only = "--installed" in args
    available_only = "--available" in args
    if installed_only:
        for name, record in sorted(status["installed"].items()):
            print(format_pkg_line(record.get("manifest") or record, record))
        return 0
    available = available_packages()
    if available_only:
        for name, pkg in sorted(available.items()):
            print(format_pkg_line(pkg, status["installed"].get(name)))
        return 0
    names = sorted(set(available) | set(status["installed"]))
    for name in names:
        pkg = available.get(name) or (status["installed"].get(name, {}).get("manifest") or status["installed"].get(name))
        print(format_pkg_line(pkg, status["installed"].get(name)))
    return 0


def cmd_search(args):
    if not args:
        raise PkgError("missing search query")
    query = " ".join(args).lower()
    for name, pkg in sorted(available_packages().items()):
        haystack = " ".join([
            name,
            str(pkg.get("description", "")),
            " ".join(pkg.get("tags") or []),
            " ".join((pkg.get("bin") or {}).keys()),
            " ".join(pkg.get("provides") or []),
        ]).lower()
        if query in haystack:
            print(format_pkg_line(pkg))
    return 0


def installed_or_available(name):
    status = load_status()
    record = status["installed"].get(name)
    if record:
        return record.get("manifest") or record, record
    candidates = package_candidates(name)
    if candidates:
        return candidates[0], None
    raise PkgError(f"package not found: {name}")


def cmd_info(args):
    if not args:
        raise PkgError("missing package name")
    pkg, record = installed_or_available(args[0])
    fields = [
        ("Package", pkg.get("name")),
        ("Version", pkg.get("version")),
        ("Status", record.get("status") if record else "available"),
        ("Description", pkg.get("description")),
        ("License", pkg.get("license")),
        ("Homepage", pkg.get("homepage")),
        ("Runtime", pkg.get("runtime")),
        ("Type", pkg.get("type")),
        ("Arch", pkg.get("arch")),
        ("Size", human_size(pkg.get("size") or (record or {}).get("size") or 0)),
        ("Source", pkg.get("source") or (record or {}).get("source")),
        ("Dependencies", ", ".join(pkg.get("dependencies") or []) or "none"),
        ("Binaries", ", ".join((pkg.get("bin") or {}).keys()) or "none"),
        ("Tags", ", ".join(pkg.get("tags") or []) or "none"),
    ]
    for key, value in fields:
        if value not in (None, ""):
            print(f"{key:<13} {value}")
    return 0


def cmd_files(args):
    if not args:
        raise PkgError("missing package name")
    status = load_status()
    record = status["installed"].get(args[0])
    if not record:
        raise PkgError(f"package is not installed: {args[0]}")
    for rel in record.get("files") or package_files(f"{PACKAGES_DIR}/{args[0]}"):
        print(f"{PACKAGES_DIR}/{args[0]}/{rel}")
    return 0


def cmd_which(args):
    if not args:
        raise PkgError("missing command name")
    command = args[0]
    status = load_status()
    for name, record in sorted(status["installed"].items()):
        if command in ((record.get("manifest") or {}).get("bin") or {}):
            print(f"{command}: {name} ({PACKAGES_DIR}/{name})")
            return 0
    for name, pkg in sorted(available_packages().items()):
        if command in (pkg.get("bin") or {}):
            print(f"{command}: {name} (available)")
            return 0
    raise PkgError(f"no package provides command: {command}")


def cmd_depends(args, reverse=False):
    if not args:
        raise PkgError("missing package name")
    name = args[0]
    if reverse:
        hits = []
        for pkg_name, pkg in available_packages().items():
            for dep in pkg.get("dependencies") or []:
                dep_name, _, _ = parse_dependency(dep)
                if dep_name == name:
                    hits.append(pkg_name)
        for item in sorted(hits):
            print(item)
        return 0
    pkg, _ = installed_or_available(name)
    deps = pkg.get("dependencies") or []
    if not deps:
        print(f"{pkg.get('name')} has no dependencies")
    else:
        for dep in deps:
            print(dep)
    return 0


def cmd_clean(options):
    shutil.rmtree(CACHE_DIR, ignore_errors=True)
    shutil.rmtree(LIB_CACHE_DIR, ignore_errors=True)
    os.makedirs(CACHE_DIR, exist_ok=True)
    os.makedirs(LIB_CACHE_DIR, exist_ok=True)
    log("Package cache cleared.", options)
    return 0


async def cmd_autoremove(options):
    status = load_status()
    needed = set()
    for record in status["installed"].values():
        if record.get("manual", True):
            for dep in (record.get("manifest") or {}).get("dependencies") or []:
                needed.add(parse_dependency(dep)[0])
    removable = [name for name, record in status["installed"].items() if not record.get("manual", True) and name not in needed]
    if not removable:
        log("Nothing to autoremove.", options)
        return 0
    for name in removable:
        await remove_one(name, False, status, options)
    save_status(status)
    log("Done.", options)
    return 0


def verify_record(name, record, doctor=False):
    problems = []
    root = f"{PACKAGES_DIR}/{name}"
    manifest = record.get("manifest") or {}
    if not os.path.isdir(root):
        problems.append(f"{name}: missing package directory")
        return problems
    manifest_path = f"{root}/package.json"
    if not os.path.isfile(manifest_path):
        problems.append(f"{name}: missing package.json")
    else:
        try:
            normalize_manifest(read_json(manifest_path), name)
        except Exception as exc:
            problems.append(f"{name}: invalid manifest: {exc}")
    for rel in record.get("files") or []:
        if not os.path.exists(f"{root}/{rel}"):
            problems.append(f"{name}: missing file: /packages/{name}/{rel}")
    for rel, expected in (manifest.get("checksums") or {}).items():
        path = f"{root}/{rel}"
        if os.path.exists(path) and not checksum_matches(path, expected):
            problems.append(f"{name}: checksum mismatch: /packages/{name}/{rel}")
    if doctor:
        for asset in (manifest.get("wasm"), manifest.get("js")):
            if asset and not os.path.exists(f"{root}/{asset}"):
                problems.append(f"{name}: missing runtime asset: {asset}")
        for cmd, target in (manifest.get("bin") or {}).items():
            if not os.path.exists(f"{root}/{target}"):
                problems.append(f"{name}: missing binary target: {target}")
            link = f"{BIN_DIR}/{cmd}"
            if os.path.lexists(link) and os.path.islink(link) and not os.path.exists(link):
                problems.append(f"{name}: broken command shim: {link}")
        for dep in manifest.get("dependencies") or []:
            dep_name, op, dep_version = parse_dependency(dep)
            installed = load_status()["installed"].get(dep_name)
            if not installed or not dependency_satisfied(installed.get("version"), op, dep_version):
                problems.append(f"{name}: unsatisfied dependency: {dep}")
    return problems


def cmd_verify(doctor=False):
    status = load_status()
    problems = []
    for name, record in sorted(status["installed"].items()):
        problems.extend(verify_record(name, record, doctor=doctor))
    if problems:
        for problem in problems:
            print(f"pkg: {problem}", file=sys.stderr)
        return 1
    print("pkg: all installed packages verified" if not doctor else "pkg: doctor found no problems")
    return 0


def cmd_source(args):
    ensure_dirs()
    command = args[0] if args else "list"
    if command in ("-h", "--help", "help"):
        print(SOURCE_HELP.strip())
        return 0
    if command == "list":
        text = source_list_text().rstrip()
        print(text if text else "# no package sources configured")
        return 0
    if command == "add":
        if len(args) < 2:
            raise PkgError("missing source URL")
        url = args[1]
        line = f"repo {url} index.json"
        text = source_list_text()
        if url in text:
            log("Source already exists.")
            return 0
        with open(SOURCES_LIST, "a", encoding="utf-8") as handle:
            if text and not text.endswith("\n"):
                handle.write("\n")
            handle.write(line + "\n")
        log(f"Added source: {url}")
        return 0
    if command == "remove":
        if len(args) < 2:
            raise PkgError("missing source URL")
        url = args[1]
        lines = source_list_text().splitlines()
        kept = [line for line in lines if url not in line]
        if len(kept) == len(lines):
            raise PkgError(f"source not found: {url}")
        with open(SOURCES_LIST, "w", encoding="utf-8") as handle:
            handle.write("\n".join(kept).rstrip() + "\n")
        log(f"Removed source: {url}")
        return 0
    raise PkgError(f"unknown source command: {command}")


def parse_global_args(argv):
    options = Options()
    rest = []
    for arg in argv:
        if arg in ("-h", "--help"):
            rest.append(arg)
        elif arg in ("-v", "--version"):
            rest.append(arg)
        elif arg in ("-y", "--yes"):
            options.yes = True
        elif arg in ("-q", "--quiet"):
            options.quiet = True
        elif arg == "--verbose":
            options.verbose = True
        elif arg == "--no-scripts":
            options.no_scripts = True
        elif arg == "--reinstall":
            options.reinstall = True
        elif arg == "--dry-run":
            options.dry_run = True
        else:
            rest.append(arg)
    return options, rest


async def main(argv):
    ensure_dirs()
    options, args = parse_global_args(list(argv))
    if not args or args[0] in ("help", "-h", "--help"):
        print(HELP.strip())
        return 0
    if args[0] in ("-v", "--version"):
        print(f"pkg {VERSION}")
        return 0
    command, tail = args[0], args[1:]
    try:
        if command == "update":
            return await cmd_update(options)
        if command == "install":
            return await cmd_install(tail, options)
        if command == "remove":
            return await cmd_remove(tail, False, options)
        if command == "purge":
            return await cmd_remove(tail, True, options)
        if command == "upgrade":
            return await cmd_upgrade(options)
        if command == "list":
            return cmd_list(tail)
        if command == "search":
            return cmd_search(tail)
        if command in ("info", "show"):
            return cmd_info(tail)
        if command == "files":
            return cmd_files(tail)
        if command == "which":
            return cmd_which(tail)
        if command == "depends":
            return cmd_depends(tail)
        if command == "rdepends":
            return cmd_depends(tail, reverse=True)
        if command == "clean":
            return cmd_clean(options)
        if command == "autoremove":
            return await cmd_autoremove(options)
        if command == "verify":
            return cmd_verify(False)
        if command == "doctor":
            return cmd_verify(True)
        if command == "source":
            return cmd_source(tail)
        raise PkgError(f"unknown command: {command}")
    except PkgError as exc:
        print(f"pkg: {exc}", file=sys.stderr)
        return 1
