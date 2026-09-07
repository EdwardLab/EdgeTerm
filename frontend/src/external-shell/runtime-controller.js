import { DEFAULT_APT_REPOSITORY_URL, fetchRepositoryIndex, parseDebianPackageIndex, verifyRepositoryIndex } from "./repository.js";
export { parseDebianPackageIndex } from "./repository.js";

function runtimeError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function isMissingDormantSessionError(error) {
  if (String(error?.code || "") === "external_shell_session_missing") return true;
  return String(error?.name || "") === "ErrnoError" && Number(error?.errno) === 10;
}

function firstCommands(source) {
  const segments = [];
  let current = "";
  let quote = "";
  let escaped = false;
  const push = () => {
    if (current.trim()) segments.push(current);
    current = "";
  };
  const value = String(source || "");
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "`" || (character === "$" && value[index + 1] === "(")) {
      push();
      if (character === "$") index += 1;
      continue;
    }
    if ([";", "|", "&", "\n"].includes(character)) {
      push();
      if ((character === "|" || character === "&") && value[index + 1] === character) {
        index += 1;
      }
      continue;
    }
    current += character;
  }
  push();
  return segments
    .map((part) => part.trim().replace(/^[({]+/, ""))
    .map((part) => part.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*([^\s)]+)/)?.[1] || "")
    .map((command) => command.replace(/^.*\//, ""))
    .filter(Boolean);
}

function parseSimpleShellWords(source) {
  const words = [];
  let current = "";
  let quote = "";
  let active = false;
  const value = String(source || "");
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && quote !== "'") {
      const next = value[index + 1];
      if (!next) return null;
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next)) {
        current += "\\";
      } else if (next !== "\n") {
        current += next;
        index += 1;
      } else {
        index += 1;
      }
      active = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      active = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      active = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (active) words.push(current);
      current = "";
      active = false;
      continue;
    }
    if (["$", "`", ";", "&", "<", ">", "(", ")", "{", "}"].includes(character)) return null;
    current += character;
    active = true;
  }
  if (quote) return null;
  if (active) words.push(current);
  return words;
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function isFlexAdapterCommand(source) {
  const words = parseSimpleShellWords(source);
  return Boolean(words?.length && ["flex", "flex++"].includes(words[0].replace(/^.*\//, "")));
}

const PYTHON_SHELL_COMMANDS = new Set([
  "bigbox",
  "column",
  "curl",
  "dir",
  "django-admin",
  "edgeasgi",
  "edgeflask",
  "edgepkg",
  "edgeserve",
  "exit",
  "file",
  "fmt",
  "flock",
  "iconv",
  "join",
  "locate",
  "micropip",
  "mkfifo",
  "nice",
  "npm",
  "npx",
  "node",
  "pathchk",
  "php",
  "pip",
  "pip3",
  "pkg",
  "script",
  "setsid",
  "python",
  "python3",
  "sqlite3",
  "vdir",
  "vmstat",
  "watch",
  "wget",
  "whereis",
  "wine",
  "wine11",
  "winecfg",
  "wineconsole",
  "winetricks",
  "zip",
]);

const PACKAGE_OVERRIDE_COMMANDS = new Set([
  "curl",
  "dir",
  "file",
  "fmt",
  "join",
  "mkfifo",
  "pathchk",
  "php",
  "sqlite3",
  "vdir",
  "wget",
  "zip",
]);

const INSTALL_REQUIRED_OVERRIDE_COMMANDS = new Set(["php"]);

const PACKAGE_SYSTEM_MOUNTS = [
  "/usr",
  "/opt",
  "/etc",
  "/var",
];

const PACKAGE_SYSTEM_SUBTREES = new Map([
  ["/usr", ["/usr/local"]],
  ["/opt", ["/opt"]],
  ["/etc", ["/etc/apt"]],
  ["/var", ["/var/cache/apt", "/var/lib/apt", "/var/lib/dpkg", "/var/log/apt"]],
]);

const PACKAGE_STATE_LAYOUT = "3";
const PACKAGE_SYSTEM_STATE_MAX_BYTES = 768 * 1024 * 1024;
const PACKAGE_SYSTEM_EXCLUDES = [
  "bash-completion",
  "doc",
  "emacs",
  "Help",
  "info",
  "locale",
  "man",
  "vim",
];

const INTERACTIVE_SHELL_BUILTINS = new Set([
  ".",
  "alias",
  "cd",
  "eval",
  "exec",
  "export",
  "read",
  "set",
  "shift",
  "source",
  "trap",
  "umask",
  "unalias",
  "unset",
]);

const PERSISTENT_SEQUENCE_BUILTINS = new Set(
  [...INTERACTIVE_SHELL_BUILTINS].filter((command) => command !== "cd"),
);

const PERSISTENT_BUSYBOX_COMMANDS = new Set([
  "ar", "ash", "awk", "base64", "basename", "bunzip2", "bzcat", "bzip2",
  "cat", "chgrp", "chmod", "chown", "cksum", "cmp", "comm", "cp", "cpio",
  "cut", "date", "dd", "diff", "dirname", "du", "echo", "env", "expand",
  "expr", "false", "find", "fold", "grep", "gzip", "gunzip", "head", "id",
  "install", "ln", "ls", "mkdir", "mktemp", "mv", "paste", "patch", "printf",
  "ps", "pwd", "readlink", "realpath", "rm", "rmdir", "run-parts", "sed", "seq",
  "sh", "sha256sum", "sleep", "sort", "stat", "tail", "tar", "tee", "test",
  "touch", "tr", "true", "truncate", "tty", "uname", "uniq", "unlink", "unxz",
  "unzip", "wc", "which", "whoami", "xargs", "xz", "yes", "zcat",
]);

function isInteractiveForegroundCommand(source) {
  const value = String(source || "").trim();
  if (!value || /[;<>&|\n`]|\$\(/.test(value)) return false;
  const commands = firstCommands(value);
  return commands.length === 1 && !INTERACTIVE_SHELL_BUILTINS.has(commands[0]);
}

export function isExternalShellCommand(source) {
  const value = String(source || "").trim();
  if (!value || value === "exit") return false;
  if (/\b(?:manage\.py|import\s+|from\s+\S+\s+import\s+)\b/.test(value)) return false;
  const commands = firstCommands(value);
  return commands.length > 0 && commands.every((command) => !PYTHON_SHELL_COMMANDS.has(command));
}

export function isExternalShellSessionEntry(source) {
  return /^(?:busybox\s+)?(?:ash|sh)(?:\s+-i)?$/.test(String(source || "").trim());
}

export function needsWorkspacePackageRepository(source) {
  const value = String(source || "").trim();
  if (!/^(?:sudo\s+)?(?:apt|apt-get)\b/.test(value)) return false;
  return !/^(?:sudo\s+)?apt(?:-get)?\s+(?:--version|list|show|search|policy)(?:\s|$)/.test(value);
}

export function isNonInteractiveAptTransaction(source) {
  const value = String(source || "").trim();
  if (!/^(?:sudo\s+)?apt(?:-get)?\b/.test(value)) return false;
  return /(?:^|\s)(?:-y|--yes)(?:\s|$)/.test(value);
}

export function isInteractiveAptTransaction(source) {
  const words = parseSimpleShellWords(String(source || "").trim());
  if (!words?.length) return false;
  const program = words[0].replace(/^.*\//, "");
  if (!["apt", "apt-get"].includes(program)) return false;
  if (words.some((word) => ["-y", "--yes", "--assume-yes"].includes(word))) return false;
  const operations = new Set([
    "install",
    "reinstall",
    "remove",
    "purge",
    "upgrade",
    "full-upgrade",
    "dist-upgrade",
    "autoremove",
  ]);
  return words.slice(1).some((word) => operations.has(word));
}

export function addAptExecutionOption(source, option) {
  const value = String(source || "").trim();
  const requestedOption = String(option || "").trim();
  if (!value || !requestedOption) return value;
  return value.replace(
    /^(\s*(?:sudo\s+)?apt(?:-get)?)(\s+)/,
    `$1 ${requestedOption}$2`,
  );
}

export function isAptMetadataRefresh(source) {
  const words = parseSimpleShellWords(String(source || "").trim());
  if (!words?.length) return false;
  const program = words[0].replace(/^.*\//, "");
  return ["apt", "apt-get"].includes(program) && words.slice(1).includes("update");
}

export function referencesInstalledPackageFilesystem(source) {
  const words = parseSimpleShellWords(String(source || "").trim());
  const program = String(words?.[0] || "").replace(/^.*\//, "");
  if (["apt", "apt-get"].includes(program) && words.some((word) => ["remove", "purge", "autoremove", "upgrade", "full-upgrade", "dist-upgrade"].includes(word))) return true;
  if (program === "dpkg" && words.some((word) => ["-r", "--remove", "-P", "--purge"].includes(word))) return true;
  return /(?:^|[\s'"=])\/(?:usr\/local|opt)(?:\/|[\s'";]|$)/.test(String(source || ""));
}

const INTERACTIVE_TERMINAL_PROGRAMS = new Set([
  "ash",
  "bash",
  "dialog",
  "ed",
  "hexedit",
  "less",
  "lua",
  "mujs",
  "nano",
  "nc",
  "ncdu",
  "netcat",
  "openssl",
  "picoc",
  "qjs",
  "quickjs",
  "rsync",
  "sftp",
  "sh",
  "sqlite3",
  "squirrel",
  "ssh",
  "tclsh",
]);

const DIRECT_RUNTIME_PROGRAMS = new Set([
  "apt",
  "apt-cache",
  "apt-config",
  "apt-get",
  "apt-mark",
  "dpkg",
  "dpkg-deb",
  "dpkg-query",
]);

function isDirectRuntimeCommand(source) {
  const words = parseSimpleShellWords(source);
  if (!words?.length) return false;
  return DIRECT_RUNTIME_PROGRAMS.has(String(words[0] || "").replace(/^.*\//, ""));
}

function isStandaloneRuntimeCommand(source) {
  const value = String(source || "").trim();
  const words = parseSimpleShellWords(value);
  if (!words?.length || firstCommands(value).length !== 1) return false;
  const program = String(words[0] || "").replace(/^.*\//, "");
  if (INTERACTIVE_SHELL_BUILTINS.has(program)) return false;
  return !/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]);
}

function isBundledStandaloneRuntimeCommand(source) {
  const words = parseSimpleShellWords(source);
  if (!words?.length || !isStandaloneRuntimeCommand(source)) return false;
  return PERSISTENT_BUSYBOX_COMMANDS.has(String(words[0] || "").replace(/^.*\//, ""));
}

export function shouldHydrateRuntimeFilesystemInBatches({ files = [], systemMounts = [] } = {}) {
  const entries = [
    ...(Array.isArray(files) ? files : []),
    ...(Array.isArray(systemMounts)
      ? systemMounts.flatMap((mount) => Array.isArray(mount?.files) ? mount.files : [])
      : []),
  ];
  if (entries.length > 0) return true;
  let encodedBytes = 0;
  for (const entry of entries) {
    encodedBytes += String(entry?.path || "").length;
    if (typeof entry?.data === "string") encodedBytes += entry.data.length;
    else if (entry?.data?.byteLength) encodedBytes += Number(entry.data.byteLength || 0);
    if (encodedBytes > 8 * 1024 * 1024) return true;
  }
  return false;
}

export function requiresInteractiveTerminal(source) {
  if (isInteractiveAptTransaction(source)) return true;
  const words = parseSimpleShellWords(String(source || "").trim());
  if (!words?.length) return false;
  const program = words[0].replace(/^.*\//, "");
  if (!INTERACTIVE_TERMINAL_PROGRAMS.has(program)) return false;
  if (["ash", "bash", "dash", "sh"].includes(program) && words.includes("-c")) return false;
  return !words.slice(1).some((word) => [
    "-h", "--help", "-V", "--version", "-version", "version",
  ].includes(word));
}

export function rewriteAptCommandWithArchives(source, archivePaths = []) {
  const value = String(source || "").trim();
  const paths = archivePaths.map((path) => String(path || "")).filter(Boolean);
  if (!paths.length) return value;
  const match = value.match(/^(?:sudo\s+)?(apt(?:-get)?)\s+(.+)$/);
  if (!match) return value;
  const tokens = match[2].trim().split(/\s+/).filter(Boolean);
  const operations = new Set(["install", "reinstall", "upgrade", "full-upgrade", "dist-upgrade"]);
  const operationIndex = tokens.findIndex((token) => operations.has(token));
  if (operationIndex < 0) return value;
  const flags = tokens.filter((token, index) => index !== operationIndex && token.startsWith("-"));
  if (tokens[operationIndex] === "reinstall" && !flags.includes("--reinstall")) {
    flags.unshift("--reinstall");
  }
  return [match[1], "install", ...flags, ...paths].join(" ");
}

export function parseInstalledPackageVersions(source) {
  const versions = new Map();
  for (const stanza of String(source || "").split(/\n\s*\n/)) {
    const name = stanza.match(/^Package:\s*(\S+)$/m)?.[1] || "";
    const version = stanza.match(/^Version:\s*(\S+)$/m)?.[1] || "";
    const status = stanza.match(/^Status:\s*(.+)$/m)?.[1] || "";
    if (name && version && /\binstalled\b/.test(status)) versions.set(name, version);
  }
  return versions;
}

const DPKG_STATUS_METADATA_FIELDS = [
  "Priority",
  "Section",
  "Installed-Size",
  "Maintainer",
  "Pre-Depends",
  "Depends",
  "Recommends",
  "Suggests",
  "Breaks",
  "Conflicts",
  "Replaces",
  "Provides",
  "Homepage",
  "Description",
];

function appendDebianControlField(lines, name, value) {
  const parts = String(value || "").split("\n");
  if (!parts[0]) return;
  lines.push(`${name}: ${parts[0]}`);
  for (const part of parts.slice(1)) lines.push(` ${part || "."}`);
}

export function buildRecoveredDpkgStatus(packages, installedMetadata) {
  const stanzas = [];
  const records = installedMetadata instanceof Map
    ? [...installedMetadata.values()]
    : Array.isArray(installedMetadata)
      ? installedMetadata
      : [];
  records.sort((left, right) => String(left?.package || "").localeCompare(String(right?.package || "")));
  for (const metadata of records) {
    const packageName = String(metadata?.package || "").trim();
    const version = String(metadata?.version || "").trim();
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(packageName) || !version) continue;
    const fields = packages?.get?.(packageName) || {};
    const lines = [
      `Package: ${packageName}`,
      "Status: install ok installed",
      `Architecture: ${String(fields.Architecture || metadata?.architecture || "wasm32-wasix")}`,
      `Version: ${version}`,
    ];
    for (const name of DPKG_STATUS_METADATA_FIELDS) {
      appendDebianControlField(lines, name, fields[name]);
    }
    stanzas.push(lines.join("\n"));
  }
  return stanzas.length ? `${stanzas.join("\n\n")}\n` : "";
}

export function buildRecoveredDpkgFileLists(installedMetadata) {
  const lists = new Map();
  const records = installedMetadata instanceof Map
    ? [...installedMetadata.values()]
    : Array.isArray(installedMetadata)
      ? installedMetadata
      : [];
  for (const metadata of records) {
    const packageName = String(metadata?.package || "").trim();
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(packageName)) continue;
    const paths = new Set([
      String(metadata?.manifestPath || `/usr/local/share/edgeterm/commands/${packageName}.json`),
    ]);
    for (const command of Array.isArray(metadata?.commands) ? metadata.commands : []) {
      const name = String(command?.name || command || "").replace(/^.*\//, "");
      if (!/^[A-Za-z_][A-Za-z0-9_+.-]*$/.test(name)) continue;
      paths.add(`/usr/local/bin/${name}`);
      paths.add(`/usr/local/sbin/${name}`);
    }
    lists.set(packageName, `${[...paths].sort().join("\n")}\n`);
  }
  return lists;
}

export function aptArchiveSelection(source, packages, installedVersions = new Map()) {
  const command = String(source || "").trim();
  const match = command.match(
    /^(?:sudo\s+)?apt(?:-get)?\s+(?:[^\s]+\s+)*(install|reinstall|upgrade|full-upgrade|dist-upgrade)\b(.*)$/,
  );
  if (!match) return [];
  const operation = match[1];
  if (["upgrade", "full-upgrade", "dist-upgrade"].includes(operation)) {
    return [...packages.entries()]
      .filter(([name, fields]) => (
        installedVersions.has(name)
        && installedVersions.get(name) !== String(fields.Version || "")
      ))
      .map(([name]) => name);
  }
  const requested = match[2]
    .trim()
    .split(/\s+/)
    .filter((token) => token && !token.startsWith("-") && !token.includes("/"))
    .map((token) => token.split("=")[0])
    .filter((name) => packages.has(name));
  const selected = new Set();
  const addPackage = (name, { force = false } = {}) => {
    if (!packages.has(name) || selected.has(name)) return;
    if (
      !force
      && installedVersions.get(name) === String(packages.get(name).Version || "")
    ) return;
    const dependencies = String(packages.get(name).Depends || "")
      .split(",")
      .map((entry) => entry.split("|")[0].trim().split(/\s+/)[0])
      .filter(Boolean);
    for (const dependency of dependencies) addPackage(dependency);
    selected.add(name);
  };
  for (const name of requested) addPackage(name, { force: operation === "reinstall" });
  return [...selected];
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function filesystemEntryText(entry) {
  if (entry?.encoding === "base64") {
    return new TextDecoder().decode(base64ToBytes(entry.data));
  }
  return String(entry?.text ?? entry?.data ?? "");
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function isBufferedExternalPipeline(source) {
  const value = String(source || "");
  let quote = "";
  let escaped = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let segmentStart = 0;
  let pipelines = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") parenDepth += 1;
    else if (character === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (!parenDepth && !braceDepth && (character === ";" || character === "\n" || character === "&")) return false;
    else if (!parenDepth && !braceDepth && character === "|") {
      if (value[index - 1] === ">" || value[index - 1] === "|" || value[index + 1] === "|") return false;
      if (!value.slice(segmentStart, index).trim()) return false;
      pipelines += 1;
      segmentStart = index + 1;
    }
  }
  return pipelines > 0 && !quote && !parenDepth && !braceDepth && Boolean(value.slice(segmentStart).trim());
}

export function isBufferedInteractiveShellCommand(source) {
  const value = String(source || "").trim();
  if (!value || isExternalShellSessionEntry(value)) return false;
  if (/^(?:flex|flex\+\+)(?:\s|$)/.test(value)) return true;
  if (/^yamlfmt(?:\s|$)/.test(value)) return true;
  if (/^pwd(?:\s|$)/.test(value)) return true;
  if (/^(?:bison|byacc|curl|dig|fd|host|hyperfine|ninja|nslookup|rsync|wget|yacc)(?:\s|$)/.test(value)) return true;
  if (/^(?:cp|install|ln|mkdir|mv|rm|rmdir|touch|truncate)(?:\s|$)/.test(value)) return true;
  if (/^dash\s+(?:-c\s+|[^-\s])/.test(value)) return true;
  if (/^less\s+.*(?:-[^\s]*F|--quit-if-one-screen)(?:\s|$)/.test(value)) return true;
  if (isBufferedExternalPipeline(value)) return true;

  let quote = "";
  let escaped = false;
  let hasControlSyntax = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else if (
        quote === '"'
        && (character === "`" || (character === "$" && value[index + 1] === "("))
      ) {
        hasControlSyntax = true;
        quote = "";
        break;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "`" || character === ";" || character === "&"
      || character === "|" || character === "<" || character === ">"
      || character === "\n" || (character === "$" && value[index + 1] === "(")) {
      hasControlSyntax = true;
      break;
    }
  }
  if (!hasControlSyntax || quote || escaped) return false;
  const commands = firstCommands(value);
  return commands.length > 0
    && commands.every((command) => !PERSISTENT_SEQUENCE_BUILTINS.has(command) && command !== "exit");
}

export function expandShellLastStatus(source, status) {
  const value = String(source || "");
  const replacement = String(Number(status || 0));
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      output += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = "";
        output += character;
      } else if (quote !== "'" && character === "$" && value[index + 1] === "?") {
        output += replacement;
        index += 1;
      } else {
        output += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === "$" && value[index + 1] === "?") {
      output += replacement;
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

export function splitTopLevelCommandSequence(source) {
  const value = String(source || "");
  if (/(?:^|[;\n]|&&|\|\|)\s*(?:if|for|while|until|case|select)\b/.test(value)) {
    return splitCompoundCommandSequence(value);
  }
  const commands = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let operator = "";
  let substitutionDepth = 0;
  const append = (end, nextOperator) => {
    const command = value.slice(start, end).trim();
    if (!command) return false;
    commands.push({ source: command, operator });
    operator = nextOperator;
    return true;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "$" && value[index + 1] === "(") {
      substitutionDepth += 1;
      index += 1;
      continue;
    }
    if (substitutionDepth) {
      if (character === "(") substitutionDepth += 1;
      else if (character === ")") substitutionDepth -= 1;
      continue;
    }
    let delimiter = "";
    let width = 1;
    if (character === ";" || character === "\n") delimiter = ";";
    else if (character === "&" && value[index + 1] === "&") {
      delimiter = "&&";
      width = 2;
    } else if (character === "|" && value[index + 1] === "|") {
      delimiter = "||";
      width = 2;
    } else if (character === "&") {
      return null;
    }
    if (!delimiter) continue;
    if (!append(index, delimiter)) return null;
    index += width - 1;
    start = index + 1;
  }
  if (quote || escaped || substitutionDepth || commands.length === 0 || !append(value.length, "")) {
    return null;
  }
  const persistentBuiltins = new Set([
    ".", "alias", "eval", "exec", "export", "read", "set", "shift",
    "source", "trap", "umask", "unalias", "unset",
  ]);
  if (commands.some((entry) => persistentBuiltins.has(firstCommands(entry.source)[0] || ""))) {
    return null;
  }
  return commands;
}

function splitCompoundCommandSequence(value) {
  const commands = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let substitutionDepth = 0;
  let compoundDepth = 0;
  let commandPosition = true;
  let word = "";
  let operator = "";
  const append = (end, nextOperator) => {
    const source = value.slice(start, end).trim();
    if (!source) return false;
    commands.push({ source, operator });
    operator = nextOperator;
    return true;
  };
  const flushWord = () => {
    if (!word) return;
    if (commandPosition && ["case", "for", "if", "select", "until", "while"].includes(word)) compoundDepth += 1;
    else if (["done", "esac", "fi"].includes(word)) compoundDepth = Math.max(0, compoundDepth - 1);
    commandPosition = ["do", "elif", "else", "then"].includes(word);
    word = "";
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"' || character === "`") { flushWord(); quote = character; continue; }
    if (character === "$" && value[index + 1] === "(") { flushWord(); substitutionDepth += 1; index += 1; continue; }
    if (substitutionDepth) { if (character === "(") substitutionDepth += 1; else if (character === ")") substitutionDepth -= 1; continue; }
    if (/[A-Za-z0-9_]/.test(character)) { word += character; continue; }
    flushWord();
    let delimiter = "";
    let width = 1;
    if (character === ";" || character === "\n") delimiter = ";";
    else if (character === "&" && value[index + 1] === "&") { delimiter = "&&"; width = 2; }
    else if (character === "|" && value[index + 1] === "|") { delimiter = "||"; width = 2; }
    else if (character === "&" && !compoundDepth) return null;
    if (!delimiter) continue;
    commandPosition = true;
    if (compoundDepth) { index += width - 1; continue; }
    if (!append(index, delimiter)) return null;
    index += width - 1;
    start = index + 1;
  }
  flushWord();
  if (quote || escaped || substitutionDepth || compoundDepth || !append(value.length, "")) return null;
  for (let index = commands.length - 2; index >= 0; index -= 1) {
    if (!/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;]+\s*)+$/.test(commands[index].source)) continue;
    commands[index + 1] = {
      ...commands[index + 1],
      source: `${commands[index].source}; ${commands[index + 1].source}`,
      operator: commands[index].operator,
    };
    commands.splice(index, 1);
  }
  return commands.length > 1 ? commands : null;
}

const JUST_QUERY_OPTIONS = new Set([
  "--choose",
  "--completions",
  "--dump",
  "--evaluate",
  "--help",
  "--list",
  "--show",
  "--summary",
  "--variables",
  "--version",
]);

export function isJustRecipeCommand(source) {
  const value = String(source || "").trim();
  if (!/^just(?:\s|$)/.test(value) || /(?:^|\s)--dry-run(?:\s|$)/.test(value)) return false;
  const tokens = value.split(/\s+/).slice(1);
  return !tokens.some((token) => JUST_QUERY_OPTIONS.has(token.split("=")[0]));
}

export function justDryRunCommand(source) {
  const value = String(source || "").trim();
  return value.replace(/^just\b/, "just --dry-run --no-highlight");
}

export function parseJustDryRunCommands(source) {
  return String(source || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const MAKE_QUERY_OPTIONS = new Set([
  "--dry-run",
  "--help",
  "--just-print",
  "--print-data-base",
  "--question",
  "--recon",
  "--version",
  "-h",
  "-n",
  "-p",
  "-q",
  "-v",
]);

export function isMakeRecipeCommand(source) {
  const value = String(source || "").trim();
  if (!/^make(?:\s|$)/.test(value)) return false;
  const tokens = value.split(/\s+/).slice(1);
  return !tokens.some((token) => MAKE_QUERY_OPTIONS.has(token.split("=")[0]));
}

export function makeDryRunCommand(source) {
  const value = String(source || "").trim();
  return value.replace(/^make\b/, "make --dry-run --no-print-directory");
}

export function mayChangeInteractiveCwd(source) {
  return /(?:^|[;&|(\n]\s*)(?:builtin\s+)?(?:cd|\.)(?:$|[\s;&|)])/.test(String(source || ""));
}

export function mayChangeInteractiveFiles(source) {
  const value = String(source || "");
  if (/(?:^|[^<])>{1,2}|<>/.test(value)) return true;
  return /(?:^|[;&|(\n]\s*)(?:busybox\s+)?(?:apt|apt-cache|apt-get|bison|byacc|chmod|chown|chgrp|cp|cpio|curl|dd|dpkg|dpkg-deb|dpkg-query|ed|hexedit|install|ln|make|mkdir|mkfifo|mknod|mv|nano|ninja|patch|rm|rmdir|rsync|tar|tee|touch|truncate|unzip|wget|yacc)(?:$|[\s;&|)])/.test(value)
    || /(?:^|[;&|(\n]\s*)(?:7z|7za|7zr)\s+(?:a|d|e|rn|u|x)(?:$|\s)/.test(value)
    || /(?:^|[;&|(\n]\s*)(?:busybox\s+)?sed\s+[^;&|\n]*-[^;&|\n\s]*i/.test(value)
    || /(?:^|[;&|(\n]\s*)shfmt\s+[^;&|\n]*(?:^|\s)(?:-w|--write)(?:\s|$)/.test(value);
}

function isReadOnlyRuntimeSnapshotExit(error, source) {
  return !mayChangeInteractiveFiles(source)
    && /Unable to (?:persist|snapshot) mount \/bin: entry not found/.test(
      String(error?.message || error || ""),
    );
}

export function requiresPersistentShellExpansion(source) {
  const value = String(source || "");
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'") {
      quote = quote === "'" ? "" : (quote || "'");
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? "" : (quote || '"');
      continue;
    }
    if (quote === "'") continue;
    if (character === "$" && value[index + 1] !== "(") return true;
    if (!quote && ["*", "?", "["].includes(character)) return true;
    if (!quote && character === "~" && (index === 0 || /\s/.test(value[index - 1]))) return true;
  }
  return false;
}

class ExternalShellWorkerClient {
  constructor({
    url,
    onProgress = () => {},
    onOutput = () => {},
    onCwd = () => {},
    onSync = () => {},
    onExit = () => {},
    onCommandExit = () => {},
    onError = () => {},
    onCrash = () => {},
  } = {}) {
    this.url = url;
    this.onProgress = onProgress;
    this.onOutput = onOutput;
    this.onCwd = onCwd;
    this.onSync = onSync;
    this.onExit = onExit;
    this.onCommandExit = onCommandExit;
    this.onError = onError;
    this.onCrash = onCrash;
    this.worker = null;
    this.workerGeneration = 0;
    this.workerReady = null;
    this.resolveWorkerReady = null;
    this.rejectWorkerReady = null;
    this.pending = new Map();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const workerUrl = new URL(this.url, globalThis.location?.href || "http://localhost/");
    workerUrl.searchParams.set("attempt", String(++this.workerGeneration));
    this.worker = new Worker(workerUrl, { type: "module" });
    this.workerReady = new Promise((resolve, reject) => {
      this.resolveWorkerReady = resolve;
      this.rejectWorkerReady = reject;
    });
    this.worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "bootstrap-stage") {
        if (message.stage === "ready") {
          this.resolveWorkerReady?.();
          this.resolveWorkerReady = null;
          this.rejectWorkerReady = null;
        }
        return;
      }
      if (message.type === "bootstrap-error") {
        const error = runtimeError(
          message.error?.code || "external_shell_worker_bootstrap_failed",
          message.error?.message || "The external shell worker could not load its runtime modules.",
          {
            recoverable: message.error?.recoverable !== false,
            stack: String(message.error?.stack || ""),
          },
        );
        console.error(`[EXTERNAL SHELL] Worker bootstrap failed\n${error.message}\n${error.stack || ""}`);
        this.rejectWorkerReady?.(error);
        this.resolveWorkerReady = null;
        this.rejectWorkerReady = null;
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
        this.onCrash(error);
        return;
      }
      if (message.type === "wasmer-runtime-panic") {
        console.error(`[EXTERNAL SHELL] WASIX runtime panic\n${String(message.message || "Unknown panic")}`);
        return;
      }
      if (message.type === "progress") {
        this.onProgress(message);
        return;
      }
      if (message.type === "interactive-output") {
        this.onOutput(message);
        return;
      }
      if (message.type === "command-output") {
        this.onOutput(message);
        return;
      }
      if (message.type === "interactive-cwd") {
        this.onCwd(message);
        return;
      }
      if (message.type === "interactive-sync") {
        this.onSync(message);
        return;
      }
      if (message.type === "interactive-exit") {
        this.onExit(message);
        return;
      }
      if (message.type === "interactive-command-exit") {
        this.onCommandExit(message);
        return;
      }
      if (message.type === "interactive-error") {
        this.onError(message);
        return;
      }
      const requestId = String(message.requestId || "");
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      if (message.type === "result") pending.resolve(message.result);
      else {
        pending.reject(runtimeError(
          message.error?.code || "external_shell_worker_failed",
          message.error?.message || "The external shell worker failed.",
          { recoverable: message.error?.recoverable !== false },
        ));
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      console.error([
        "[EXTERNAL SHELL] Worker crash details",
        String(event.message || ""),
        `${String(event.filename || "unknown")}:${Number(event.lineno || 0)}:${Number(event.colno || 0)}`,
        String(event.error?.stack || "No stack was provided."),
      ].join("\n"));
      const error = runtimeError(
        "external_shell_worker_crashed",
        event.message || "The external shell worker stopped unexpectedly.",
        { recoverable: true },
      );
      this.rejectWorkerReady?.(error);
      this.resolveWorkerReady = null;
      this.rejectWorkerReady = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
      this.onCrash(error);
    };
    return this.worker;
  }

  request(type, payload = {}, { timeoutMs = 0 } = {}) {
    const requestId = crypto.randomUUID();
    const worker = this.ensureWorker();
    const promise = new Promise((resolve, reject) => {
      let timer = null;
      const finish = (handler) => (value) => {
        if (timer) clearTimeout(timer);
        handler(value);
      };
      this.pending.set(requestId, {
        resolve: finish(resolve),
        reject: finish(reject),
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.delete(requestId)) return;
          const error = runtimeError(
            type === "prepare" ? "external_shell_prepare_timeout" : "external_shell_request_timeout",
            type === "prepare"
              ? "The external shell startup check did not finish in time."
              : "The external shell request did not finish in time.",
            { recoverable: true },
          );
          reject(error);
          this.worker?.terminate();
          this.worker = null;
          this.workerReady = null;
          this.resolveWorkerReady = null;
          this.rejectWorkerReady = null;
        }, timeoutMs);
      }
    });
    this.workerReady
      .then(() => worker.postMessage({ type, requestId, payload }))
      .catch((error) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.reject(error);
      });
    return promise;
  }

  cancel() {
    const error = runtimeError("external_shell_cancelled", "The external shell command was cancelled.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = null;
    this.resolveWorkerReady = null;
    this.rejectWorkerReady = null;
  }

  resetWorker() {
    if (this.pending.size) {
      throw runtimeError(
        "external_shell_worker_busy",
        "The external shell worker still has active requests.",
      );
    }
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = null;
    this.resolveWorkerReady = null;
    this.rejectWorkerReady = null;
  }
}

export class EdgeTermExternalShellRuntime {
  constructor({
    fs,
    assetUrl,
    packageRepositoryUrl = globalThis.EDGETERM_PACKAGE_REPOSITORY_URL || DEFAULT_APT_REPOSITORY_URL,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    output = () => {},
    progress = () => {},
    confirm = async () => true,
    onCwd = () => {},
    onStatus = () => {},
  } = {}) {
    this.fs = fs;
    this.assetUrl = assetUrl;
    this.packageRepositoryUrl = String(packageRepositoryUrl || DEFAULT_APT_REPOSITORY_URL).replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.output = output;
    this.progress = progress;
    this.confirm = confirm;
    this.onStatus = onStatus;
    this.client = new ExternalShellWorkerClient({
      url: assetUrl("external-runtime/external-runtime-worker-v261-apt-repository.js"),
      onProgress: (event) => {
        this.state.phase = String(event.phase || this.state.phase);
        this.progress(event);
        this.onStatus(this.status());
      },
      onOutput: (event) => {
        if (event.sessionId && event.sessionId !== this.state.sessionId) return;
        this.output(String(event.stream || "stdout"), String(event.data || ""), { streaming: true });
      },
      onCwd: (event) => {
        if (event.sessionId !== this.state.sessionId) return;
        if (this.state.interactiveDormant) return;
        this.state.cwd = String(event.cwd || this.state.cwd || "/home/user");
        onCwd(this.state.cwd);
        this.onStatus(this.status());
      },
      onSync: (event) => {
        if (event.sessionId !== this.state.sessionId) return;
        this.state.installedCommands = Array.isArray(event.installedCommands)
          ? event.installedCommands.map((command) => String(command))
          : this.state.installedCommands;
        this.enqueueChanges(event.workspaceRoot, event.changes, event.systemChanges);
      },
      onExit: (event) => {
        if (event.sessionId !== this.state.sessionId) return;
        Object.assign(this.state, {
          phase: "ready",
          running: false,
          interactive: false,
          interactiveDormant: false,
          sessionId: "",
        });
        this.onStatus(this.status());
      },
      onCommandExit: async (event) => {
        if (event.sessionId !== this.state.sessionId) return;
        await this.syncing.catch(() => {});
        await this.persisting.catch(() => {});
        if (Array.isArray(event.installedCommands)) {
          this.state.installedCommands = event.installedCommands.map((command) => String(command));
        }
        this.state.cwd = String(event.cwd || this.state.cwd || "/home/user");
        this.state.foreground = false;
        this.state.phase = this.state.interactiveDormant ? "ready" : "interactive";
        this.state.lastExitCode = Number(event.exitCode || 0);
        onCwd(this.state.cwd);
        this.onStatus(this.status());
      },
      onError: (event) => {
        if (event.sessionId !== this.state.sessionId) return;
        this.state.lastError = {
          code: String(event.error?.code || "external_shell_session_failed"),
          message: String(event.error?.message || "The BusyBox ash session reported an error."),
        };
        this.onStatus(this.status());
      },
      onCrash: (error) => {
        Object.assign(this.state, {
          phase: "fallback",
          ready: false,
          available: false,
          running: false,
          interactive: false,
          sessionId: "",
          lastError: { code: error.code, message: error.message },
        });
        this.preparing = null;
        this.onStatus(this.status());
      },
    });
    this.state = {
      phase: "idle",
      ready: false,
      available: null,
      running: false,
      interactive: false,
      interactiveDormant: false,
      foreground: false,
      sessionId: "",
      runtime: "busybox-wasix",
      version: "",
      license: "",
      posixProfile: "",
      sourceRepository: "",
      cwd: "/home/user",
      installedCommands: [],
      packageRepositoryMounted: false,
      workspaceFingerprint: "",
      lastError: null,
    };
    this.preparing = null;
    this.warming = null;
    this.syncing = Promise.resolve();
    this.persisting = Promise.resolve();
    this.packageRepositoryPaths = new Set();
    this.stagedAptArchivePaths = [];
    this.runtimePackageArchivePaths = [];
    this.aptMetadataReady = false;
    this.packageStateChecked = false;
    this.systemMountCache = new Map();
    this.systemMountCacheKey = crypto.randomUUID();
    this.sessionHydratedCommands = new Set();
  }

  status() {
    return { ...this.state };
  }

  runtimeConfigUrl() {
    const value = this.assetUrl("external-runtime/runtime-config.json");
    try {
      return new URL(value, globalThis.location?.href || "http://localhost/").href;
    } catch {
      return value;
    }
  }

  shouldHandle(source) {
    const value = String(source || "").trim();
    const commands = firstCommands(value);
    if (
      !this.state.interactive
      && !this.state.interactiveDormant
      && commands.length === 1
      && INTERACTIVE_SHELL_BUILTINS.has(commands[0])
    ) {
      return false;
    }
    const installedCommands = new Set(this.state.installedCommands || []);
    const hasShellControl = commands.length > 1 && /[;|&<>\n`]|\$\(/.test(value);
    if (
      commands.length > 0
      && !/\b(?:manage\.py|import\s+|from\s+\S+\s+import\s+)\b/.test(value)
      && commands.every(
        (command) => installedCommands.has(command)
          || !PYTHON_SHELL_COMMANDS.has(command)
          || (hasShellControl && PACKAGE_OVERRIDE_COMMANDS.has(command)),
      )
    ) {
      return true;
    }
    if (this.state.interactive || this.state.interactiveDormant) {
      if (value === "exit") return true;
      if (/\b(?:manage\.py|import\s+|from\s+\S+\s+import\s+)\b/.test(value)) return false;
      return commands.length > 0 && commands.every(
        (command) => installedCommands.has(command) || !PYTHON_SHELL_COMMANDS.has(command),
      );
    }
    return isExternalShellCommand(source);
  }

  mayRouteInstalledCommand(source) {
    const commands = firstCommands(source);
    return commands.length > 0 && (
      commands.some((command) => PACKAGE_OVERRIDE_COMMANDS.has(command))
      || (commands.length > 1 && /[;|&<>\n`]|\$\(/.test(String(source || "")))
    );
  }

  async refreshInstalledCommands() {
    const commands = new Set(this.state.installedCommands || []);
    let entries = [];
    try {
      await this.fs.ensureReady?.();
      entries = await this.fs.readTree("/usr/local/share/edgeterm/commands", {
        includeDirectories: false,
        maxFiles: 2_000,
        maxBytes: 16 * 1024 * 1024,
      });
    } catch {
      return commands;
    }
    for (const entry of entries) {
      const path = String(entry?.path || "").replace(/^\/+/, "");
      if (!path.endsWith(".json")) continue;
      try {
        let source = filesystemEntryText(entry);
        if (!source) {
          const name = path.split("/").pop();
          source = String(await this.fs.readText(`/usr/local/share/edgeterm/commands/${name}`));
        }
        const metadata = JSON.parse(source);
        if (metadata?.schema !== "edgeterm.package-commands.v1") continue;
        for (const command of Array.isArray(metadata.commands) ? metadata.commands : []) {
          const name = String(command?.name || command || "").replace(/^.*\//, "");
          if (name) commands.add(name);
        }
      } catch {
      }
    }
    this.state.installedCommands = [...commands];
    return commands;
  }

  async readInstalledPackageMetadata() {
    let entries = [];
    try {
      await this.fs.ensureReady?.();
      entries = await this.fs.readTree("/usr/local/share/edgeterm/commands", {
        includeNodeModules: true,
        includeDirectories: false,
        maxFiles: 2_000,
        maxBytes: 16 * 1024 * 1024,
      });
    } catch {
      return new Map();
    }
    const packages = new Map();
    for (const entry of entries) {
      try {
        const metadata = JSON.parse(filesystemEntryText(entry));
        const packageName = String(metadata?.package || "").trim();
        const version = String(metadata?.version || "").trim();
        if (
          metadata?.schema !== "edgeterm.package-commands.v1"
          || !/^[a-z0-9][a-z0-9+.-]*$/.test(packageName)
          || !version
        ) continue;
        packages.set(packageName, {
          ...metadata,
          package: packageName,
          version,
          manifestPath: `/usr/local/share/edgeterm/commands/${String(entry?.path || `${packageName}.json`).replace(/^.*\//, "")}`,
        });
      } catch {
      }
    }
    return packages;
  }

  async ensureInstalledPackageState(root) {
    if (this.packageStateChecked) return false;
    await this.fs.ensureReady?.();
    let status = "";
    try {
      status = String(await this.fs.readText("/var/lib/dpkg/status"));
    } catch {
      status = "";
    }
    const installedVersions = parseInstalledPackageVersions(status);
    const installedMetadata = await this.readInstalledPackageMetadata();
    if (!installedMetadata.size) {
      this.packageStateChecked = true;
      return false;
    }
    const recoveryMarker = "/var/lib/dpkg/.edgeterm-manifest-recovery-v1";
    if (installedVersions.size) {
      let existingLists = new Set();
      try {
        const entries = await this.fs.readTree("/var/lib/dpkg/info", {
          includeDirectories: false,
          metadataOnly: true,
          maxFiles: 10_000,
          maxBytes: 64 * 1024 * 1024,
        });
        existingLists = new Set(entries.map((entry) => String(entry?.path || "").replace(/^.*\//, "")));
      } catch {
      }
      let recoveredLists = 0;
      await this.fs.mkdir("/var/lib/dpkg/info");
      const recoveredFileLists = new Map(buildRecoveredDpkgFileLists(installedMetadata));
      for (const packageName of installedVersions.keys()) {
        if (existingLists.has(`${packageName}.list`)) continue;
        const fileList = recoveredFileLists.get(packageName) || "";
        await this.fs.writeText(`/var/lib/dpkg/info/${packageName}.list`, fileList);
        recoveredLists += 1;
      }
      await this.fs.writeText(recoveryMarker, "1\n");
      await this.fs.flush?.();
      if (recoveredLists) this.systemMountCache.clear();
      this.packageStateChecked = true;
      return recoveredLists > 0;
    }

    const repositoryRoot = `${String(root || "/home/user").replace(/\/+$/, "")}/apt-repository`;
    await this.fs.mkdir(repositoryRoot);
    const { indexText, packages } = await this.loadPackageIndex(repositoryRoot);
    const recoveredStatus = buildRecoveredDpkgStatus(packages, installedMetadata);
    if (!recoveredStatus || parseInstalledPackageVersions(recoveredStatus).size !== installedMetadata.size) {
      throw runtimeError(
        "external_shell_package_recovery_invalid",
        "Installed package records could not be reconstructed from package metadata.",
        { recoverable: true },
      );
    }
    await this.fs.mkdir("/var/lib/dpkg");
    await this.fs.writeText(`${repositoryRoot}/Packages`, indexText);
    await this.fs.writeText("/var/lib/dpkg/status-old", status);
    await this.fs.writeText("/var/lib/dpkg/status", recoveredStatus);
    await this.fs.mkdir("/var/lib/dpkg/info");
    for (const [packageName, fileList] of buildRecoveredDpkgFileLists(installedMetadata)) {
      await this.fs.writeText(`/var/lib/dpkg/info/${packageName}.list`, fileList);
    }
    await this.fs.writeText(recoveryMarker, "1\n");
    try {
      await this.fs.removeTree("/var/lib/apt/lists");
    } catch {
    }
    await this.fs.mkdir("/var/lib/apt/lists");
    await this.fs.mkdir("/var/lib/apt/lists/partial");
    for (const cachePath of [
      "/var/cache/apt/pkgcache.bin",
      "/var/cache/apt/srcpkgcache.bin",
    ]) {
      try {
        await this.fs.removeTree(cachePath);
      } catch {
      }
    }
    await this.fs.flush?.();
    this.systemMountCache.clear();
    this.aptMetadataReady = false;
    this.packageStateChecked = true;
    return true;
  }

  async applyChanges(root, changes, { persist = true } = {}) {
    let pendingFiles = [];
    const flushFiles = async () => {
      if (!pendingFiles.length) return;
      const entries = pendingFiles;
      pendingFiles = [];
      await this.fs.writeFiles(entries);
    };
    for (const entry of changes || []) {
      const path = `${root}/${String(entry.path || "").replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
      if (entry.deleted || entry.dir) {
        await flushFiles();
        if (entry.deleted) await this.fs.removeTree(path);
        else await this.fs.mkdir(path);
        continue;
      }
      pendingFiles.push({ ...entry, path });
      if (pendingFiles.length >= 200) await flushFiles();
    }
    await flushFiles();
    if ((changes || []).length && persist) {
      await this.fs.flush();
    }
  }

  async resolvePersistedCwd(root, candidate) {
    const workspaceRoot = String(root || "/home/user").replace(/\/+$/, "") || "/";
    const target = String(candidate || workspaceRoot).replace(/\/+$/, "") || "/";
    if (
      typeof this.fs.readTree !== "function"
      || target === workspaceRoot
      || target === "/"
      || target === "/tmp"
      || target.startsWith("/tmp/")
      || !target.startsWith(`${workspaceRoot}/`)
    ) {
      return target;
    }
    try {
      await this.fs.readTree(target, { maxEntries: 1, maxBytes: 1 });
      return target;
    } catch {
      return workspaceRoot;
    }
  }

  async applySystemChanges(groups, { persist = true } = {}) {
    let changed = false;
    for (const group of groups || []) {
      const root = String(group?.path || "").replace(/\/+$/, "");
      if (!PACKAGE_SYSTEM_MOUNTS.includes(root)) {
        throw runtimeError(
          "external_shell_mount_forbidden",
          `The system mount is not allowed: ${root}`,
          { recoverable: false },
        );
      }
      const prefixes = (PACKAGE_SYSTEM_SUBTREES.get(root) || [root])
        .map((subtree) => subtree.slice(root.length).replace(/^\/+/, ""));
      const changes = (group.changes || []).filter((entry) => {
        const path = String(entry?.path || "").replace(/^\/+/, "");
        return prefixes.some((prefix) => !prefix || path === prefix || path.startsWith(`${prefix}/`));
      });
      if (changes.length) changed = true;
      await this.applyChanges(root, changes, { persist: false });
    }
    if (changed) this.systemMountCache.clear();
    if ((groups || []).some((group) => group?.changes?.length) && persist) {
      await this.fs.flush();
    }
  }

  enqueueChanges(root, changes, systemChanges = []) {
    this.syncing = this.syncing
      .catch(() => {})
      .then(async () => {
        await this.applyChanges(String(root || "/home/user"), changes, { persist: false });
        await this.applySystemChanges(systemChanges, { persist: false });
      });
    const applied = this.syncing;
    this.persisting = this.persisting
      .catch(() => {})
      .then(() => applied)
      .then(() => (
        (changes || []).length
        || (systemChanges || []).some((group) => group?.changes?.length)
      ) ? this.fs.flush() : undefined);
    return this.syncing;
  }

  async writeInput(data) {
    if (
      (!this.state.interactive && !this.state.interactiveDormant)
      || !this.state.sessionId
    ) return false;
    await this.client.request("interactive-write", {
      sessionId: this.state.sessionId,
      data: String(data ?? ""),
    });
    return true;
  }

  async interrupt() {
    let delivered = false;
    try {
      delivered = await this.writeInput("\u0003");
    } catch {
      delivered = false;
    }
    if (!this.state.foreground) return delivered;
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (this.state.foreground) {
      this.cancel();
      return true;
    }
    return delivered;
  }

  shouldFallback(error) {
    return error?.recoverable !== false && [
      "external_shell_config_unavailable",
      "external_shell_disabled",
      "external_shell_manifest_unavailable",
      "external_shell_artifact_unavailable",
      "external_shell_manifest_invalid",
      "external_shell_size_mismatch",
      "external_shell_checksum_mismatch",
      "external_shell_cross_origin_isolation_required",
      "external_shell_entrypoint_missing",
      "external_shell_smoke_failed",
      "external_shell_worker_crashed",
      "external_shell_worker_failed",
      "external_shell_prepare_failed",
      "external_shell_prepare_timeout",
      "external_shell_request_timeout",
    ].includes(String(error?.code || ""));
  }

  async prepare() {
    if (this.state.ready) return this.status();
    if (this.preparing) return await this.preparing;
    this.state.phase = "preparing";
    this.onStatus(this.status());
    const configUrl = this.runtimeConfigUrl();
    this.preparing = this.client.request(
      "prepare",
      { configUrl },
      { timeoutMs: 60_000 },
    );
    try {
      const result = await this.preparing;
      Object.assign(this.state, {
        phase: "ready",
        ready: true,
        available: true,
        version: String(result.version || ""),
        license: String(result.license || ""),
        posixProfile: String(result.posixProfile || ""),
        sourceRepository: String(result.sourceRepository || ""),
        lastError: null,
      });
      return this.status();
    } catch (error) {
      Object.assign(this.state, {
        phase: "fallback",
        ready: false,
        available: false,
        lastError: { code: String(error.code || "external_shell_prepare_failed"), message: error.message },
      });
      throw error;
    } finally {
      this.preparing = null;
      this.onStatus(this.status());
    }
  }

  async readRuntimeFilesystem(root, {
    includePackageRepository = true,
    omitInstalledPayload = false,
  } = {}) {
    try {
      await this.fs.ensureReady?.();
    } catch (error) {
      throw runtimeError(
        "external_shell_workspace_state_read_failed",
        `Unable to load workspace state: ${String(error?.message || error)}`,
        { cause: error, recoverable: true },
      );
    }
    const packageStateMarker = `${String(root || "/home/user").replace(/\/+$/, "")}/.edgeterm/package-state-layout`;
    let packageStateLayout = "";
    try {
      packageStateLayout = String(await this.fs.readText(packageStateMarker)).trim();
    } catch {
      packageStateLayout = "";
    }
    if (packageStateLayout !== PACKAGE_STATE_LAYOUT) {
      await this.fs.writeText(packageStateMarker, `${PACKAGE_STATE_LAYOUT}\n`);
      await this.fs.flush?.();
    }
    for (const path of PACKAGE_SYSTEM_MOUNTS) {
      try {
        await this.fs.mkdir(path);
      } catch (error) {
        throw runtimeError(
          "external_shell_package_root_prepare_failed",
          `Unable to prepare package root ${path}: ${String(error?.message || error)}`,
          { cause: error, recoverable: true },
        );
      }
    }
    let files;
    try {
      const selectedArchivePaths = includePackageRepository
        ? (this.runtimePackageArchivePaths.length
          ? this.runtimePackageArchivePaths
          : this.stagedAptArchivePaths)
        : [];
      files = await this.fs.readTree(root, {
        includeNodeModules: false,
        includeDirectories: true,
        exclude: ["apt-repository"],
        maxFiles: 50_000,
        maxBytes: 256 * 1024 * 1024,
      });
      if (selectedArchivePaths.length) {
        const rootPrefix = `${String(root || "/home/user").replace(/\/+$/, "")}/`;
        for (const archivePath of selectedArchivePaths) {
          if (!archivePath.startsWith(`${rootPrefix}apt-repository/`)) {
            throw new Error(`Package archive is outside the workspace repository: ${archivePath}`);
          }
          const relativePath = archivePath.slice(rootPrefix.length);
          let archive = null;
          if (typeof this.fs.readBinary === "function") {
            archive = await this.fs.readBinary(archivePath);
          } else {
            const parent = archivePath.slice(0, archivePath.lastIndexOf("/"));
            const basename = archivePath.slice(archivePath.lastIndexOf("/") + 1);
            const entries = await this.fs.readTree(parent, {
              includeNodeModules: true,
              includeDirectories: false,
              maxFiles: 100,
              maxBytes: 64 * 1024 * 1024,
            });
            archive = entries.find((entry) => String(entry.path || "") === basename);
          }
          if (!archive) throw new Error(`Package archive is unavailable: ${archivePath}`);
          files.push({ ...archive, path: relativePath });
        }
      }
    } catch (error) {
      throw runtimeError(
        "external_shell_workspace_tree_read_failed",
        `Unable to read workspace files from ${root}: ${String(error?.message || error)}`,
        { cause: error, recoverable: true },
      );
    }
    const cacheKey = this.runtimePackageArchivePaths.length || this.stagedAptArchivePaths.length
      ? "targeted"
      : omitInstalledPayload
        ? "metadata"
        : "full";
    let systemMounts = this.systemMountCache.get(cacheKey);
    if (!systemMounts) {
      systemMounts = [];
      for (const path of PACKAGE_SYSTEM_MOUNTS) {
        const files = [];
        if (
          omitInstalledPayload
          && path === "/opt"
        ) {
          systemMounts.push({ path, files });
          continue;
        }
        if (omitInstalledPayload && path === "/usr") {
          try {
            const metadata = await this.fs.readTree("/usr/local/share/edgeterm/commands", {
              includeNodeModules: true,
              includeDirectories: true,
              maxFiles: 2_000,
              maxBytes: 16 * 1024 * 1024,
            });
            for (const entry of metadata) {
              files.push({
                ...entry,
                path: `local/share/edgeterm/commands/${String(entry.path || "")}`.replace(/\/{2,}/g, "/"),
              });
            }
          } catch {
          }
          systemMounts.push({ path, files });
          continue;
        }
        for (const subtree of PACKAGE_SYSTEM_SUBTREES.get(path) || [path]) {
          if (omitInstalledPayload && subtree === "/var/cache/apt") continue;
          try {
            await this.fs.mkdir(subtree);
          } catch (error) {
            throw runtimeError(
              "external_shell_package_path_prepare_failed",
              `Unable to prepare package path ${subtree}: ${String(error?.message || error)}`,
              { cause: error, recoverable: true },
            );
          }
          const prefix = subtree.slice(path.length).replace(/^\/+/, "");
          let entries;
          try {
            entries = await this.fs.readTree(subtree, {
              includeNodeModules: true,
              includeDirectories: true,
              exclude: subtree === "/usr/local" ? PACKAGE_SYSTEM_EXCLUDES : [],
              maxFiles: 50_000,
              maxBytes: PACKAGE_SYSTEM_STATE_MAX_BYTES,
            });
          } catch (error) {
            throw runtimeError(
              "external_shell_package_state_read_failed",
              `Unable to load package state from ${subtree}: ${String(error?.message || error)}`,
              { cause: error, recoverable: true },
            );
          }
          for (const entry of entries) {
            files.push({
              ...entry,
              path: [prefix, String(entry.path || "")].filter(Boolean).join("/"),
            });
          }
        }
        systemMounts.push({ path, files });
      }
      this.systemMountCache.set(cacheKey, systemMounts);
    }
    return { files, systemMounts };
  }

  async installedPackagesForCommand(command) {
    const requestedCommands = new Set(firstCommands(command));
    if (!requestedCommands.size) return [];
    let entries;
    try {
      entries = await this.fs.readTree("/usr/local/share/edgeterm/commands", {
        includeNodeModules: true,
        includeDirectories: false,
        maxFiles: 2_000,
        maxBytes: 8 * 1024 * 1024,
      });
    } catch {
      return [];
    }
    const packages = new Set();
    for (const entry of entries) {
      try {
        const metadata = JSON.parse(filesystemEntryText(entry));
        if (!Array.isArray(metadata.commands)) continue;
        if (!metadata.commands.some((name) => requestedCommands.has(String(name)))) continue;
        const packageName = String(metadata.package || "").trim();
        if (/^[a-z0-9][a-z0-9+.-]*$/.test(packageName)) packages.add(packageName);
      } catch {
      }
    }
    return [...packages];
  }

  async installedPackages() {
    try {
      await this.fs.ensureReady?.();
      const versions = parseInstalledPackageVersions(await this.fs.readText("/var/lib/dpkg/status"));
      return [...versions.entries()].map(([name, version]) => ({ name, version }));
    } catch {
      return [];
    }
  }

  async stageInstalledCommandArchives(root, command) {
    const packages = await this.installedPackagesForCommand(command);
    if (!packages.length) return false;
    await this.stageAptRepository(
      root,
      `apt reinstall ${packages.join(" ")}`,
    );
    if (!this.stagedAptArchivePaths.length) return false;
    this.runtimePackageArchivePaths = [...this.stagedAptArchivePaths];
    this.stagedAptArchivePaths = [];
    return true;
  }

  async readInstalledPackagePayloads(packages) {
    const grouped = new Map(PACKAGE_SYSTEM_MOUNTS.map((path) => [path, []]));
    for (const packageName of packages) {
      let paths;
      try {
        paths = String(await this.fs.readText(`/var/lib/dpkg/info/${packageName}.list`))
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
      for (const path of paths) {
        const root = PACKAGE_SYSTEM_MOUNTS.find(
          (candidate) => path === candidate || path.startsWith(`${candidate}/`),
        );
        if (!root || path === root || path.includes("..")) continue;
        try {
          const entry = await this.fs.readBinary(path);
          grouped.get(root).push({
            ...entry,
            path: path.slice(root.length).replace(/^\/+/, ""),
          });
        } catch {
        }
      }
    }
    return [...grouped.entries()]
      .filter(([, files]) => files.length)
      .map(([path, files]) => ({ path, files }));
  }

  async aptNoopInstall(command, root) {
    const words = parseSimpleShellWords(command);
    if (!words?.length || !["apt", "apt-get"].includes(words[0].replace(/^.*\//, ""))) return null;
    const operationIndex = words.findIndex((word) => word === "install");
    if (operationIndex < 0 || words.includes("--reinstall")) return null;
    const requested = words
      .slice(operationIndex + 1)
      .filter((word) => word && !word.startsWith("-") && !word.includes("/"));
    if (!requested.length) return null;
    const names = requested.map((word) => word.split("=")[0]);
    let packages;
    let installedVersions;
    try {
      const repositoryRoot = `${String(root || "/home/user").replace(/\/+$/, "")}/apt-repository`;
      packages = parseDebianPackageIndex(await this.fs.readText(`${repositoryRoot}/Packages`));
      installedVersions = parseInstalledPackageVersions(await this.fs.readText("/var/lib/dpkg/status"));
    } catch {
      return null;
    }
    if (!names.every((name) => packages.has(name) && installedVersions.has(name))) return null;
    if (aptArchiveSelection(command, packages, installedVersions).length) return null;
    return names.map((name) => ({ name, version: installedVersions.get(name) }));
  }

  async readRuntimeFilesystemWithArchiveFallback(root, options = {}) {
    if (this.runtimePackageArchivePaths.length) {
      return await this.readRuntimeFilesystem(root, {
        ...options,
        includePackageRepository: true,
        omitInstalledPayload: true,
      });
    }
    if (options.command && await this.stageInstalledCommandArchives(root, options.command)) {
      return await this.readRuntimeFilesystem(root, {
        ...options,
        includePackageRepository: true,
        omitInstalledPayload: true,
      });
    }
    try {
      return await this.readRuntimeFilesystem(root, options);
    } catch (error) {
      const code = String(error?.code || "");
      const message = String(error?.message || "");
      const packageStateTooLarge = code === "external_shell_package_state_read_failed"
        && /(?:file|size) limit|filesystem exceeds/i.test(message);
      if (!packageStateTooLarge) throw error;
      await this.stageAptRepository(root, "apt update", { includeInstalledPayload: true });
      return await this.readRuntimeFilesystem(root, {
        ...options,
        includePackageRepository: true,
        omitInstalledPayload: true,
      });
    }
  }

  async fingerprintWorkspace(root) {
    if (typeof this.fs.generation === "function") {
      try {
        return String(await this.fs.generation(root));
      } catch {
      }
    }
    if (typeof this.fs.fingerprint !== "function") return "";
    try {
      return String(await this.fs.fingerprint(root, {
        includeNodeModules: false,
        exclude: ["apt-repository"],
        maxFiles: 50_000,
        maxBytes: 256 * 1024 * 1024,
      }));
    } catch {
      return "";
    }
  }

  async stopDormantSession() {
    if (!this.state.interactiveDormant || !this.state.sessionId) return;
    const sessionId = this.state.sessionId;
    try {
      await this.client.request(
        "interactive-stop",
        { sessionId },
        { timeoutMs: 12_000 },
      );
      await this.syncing.catch(() => {});
      await this.persisting.catch(() => {});
    } catch (error) {
      if (String(error?.code || "") !== "external_shell_session_missing") throw error;
    } finally {
      this.resetDormantSessionState();
    }
  }

  async notifyWorkspaceChanged() {
    await this.stopDormantSession();
  }

  resetDormantSessionState() {
    Object.assign(this.state, {
      phase: "ready",
      running: false,
      interactive: false,
      interactiveDormant: false,
      foreground: false,
      sessionId: "",
      packageRepositoryMounted: false,
      workspaceFingerprint: "",
    });
    this.packageRepositoryPaths.clear();
    this.sessionHydratedCommands.clear();
    this.aptMetadataReady = false;
    this.onStatus(this.status());
  }

  installedRuntimeCommands(source) {
    const installed = new Set(this.state.installedCommands || []);
    return [...new Set(firstCommands(source))].filter((program) => (
      program
      && !PERSISTENT_BUSYBOX_COMMANDS.has(program)
      && !INTERACTIVE_SHELL_BUILTINS.has(program)
      && installed.has(program)
    ));
  }

  async ensureInstalledRuntimeAvailable(source, root, cwd) {
    const commands = this.installedRuntimeCommands(source);
    if (!commands.length || commands.every((command) => this.sessionHydratedCommands.has(command))) {
      return;
    }
    const packages = await this.installedPackagesForCommand(source);
    const systemMounts = await this.readInstalledPackagePayloads(packages);
    if (systemMounts.length) {
      const result = await this.client.request(
        "interactive-add-package-payload",
        {
          sessionId: this.state.sessionId,
          systemMounts,
        },
        { timeoutMs: 60_000 },
      );
      if (Array.isArray(result.installedCommands)) {
        this.state.installedCommands = result.installedCommands.map((command) => String(command));
      }
      for (const command of commands) this.sessionHydratedCommands.add(command);
      return;
    }
    if (!await this.stageInstalledCommandArchives(root, source)) {
      throw runtimeError(
        "external_shell_installed_archive_missing",
        `The installed command payload is unavailable: ${commands.join(", ")}`,
        { recoverable: true },
      );
    }
    const rootPrefix = `${String(root || "/home/user").replace(/\/+$/, "")}/`;
    const archivePaths = [...this.runtimePackageArchivePaths];
    const files = [];
    for (const archivePath of archivePaths) {
      const archive = await this.fs.readBinary(archivePath);
      files.push({
        ...archive,
        path: archivePath.slice(rootPrefix.length),
      });
    }
    let result;
    try {
      result = await this.client.request(
        "interactive-add-package-archives",
        {
          sessionId: this.state.sessionId,
          workspaceRoot: root,
          archivePaths,
          files,
        },
        { timeoutMs: 120_000 },
      );
    } finally {
      this.runtimePackageArchivePaths = [];
    }
    if (Array.isArray(result.installedCommands)) {
      this.state.installedCommands = result.installedCommands.map((command) => String(command));
    }
    for (const command of commands) this.sessionHydratedCommands.add(command);
  }

  async persistStagedPackagePayloads(root, cwd = root, stagedArchivePaths = this.stagedAptArchivePaths) {
    const archivePaths = [...new Set(stagedArchivePaths.map((path) => String(path || "")))]
      .filter(Boolean);
    if (!archivePaths.length) return { changedSystemFiles: 0, installedCommands: [] };
    if (!this.state.sessionId || (!this.state.interactive && !this.state.interactiveDormant)) {
      await this.warmup(String(cwd || root), root, { omitInstalledPayload: true });
    }
    const rootPrefix = `${String(root || "/home/user").replace(/\/+$/, "")}/`;
    const files = [];
    for (const archivePath of archivePaths) {
      const archive = await this.fs.readBinary(archivePath);
      files.push({ ...archive, path: archivePath.slice(rootPrefix.length) });
    }
    const result = await this.client.request(
      "interactive-add-package-archives",
      {
        sessionId: this.state.sessionId,
        workspaceRoot: root,
        archivePaths,
        files,
      },
      { timeoutMs: 180_000 },
    );
    await this.applySystemChanges(result.systemChanges || []);
    if (Array.isArray(result.installedCommands)) {
      this.state.installedCommands = result.installedCommands.map((command) => String(command));
      for (const command of this.state.installedCommands) this.sessionHydratedCommands.add(command);
    }
    this.packageStateChecked = false;
    this.systemMountCache.clear();
    await this.fs.flush?.();
    return result;
  }

  async ensureDormantSession(root, cwd, { omitInstalledPayload = false } = {}) {
    const runStage = async (stage, operation) => {
      try {
        return await operation();
      } catch (error) {
        throw runtimeError(
          "external_shell_dormant_start_failed",
          `Unable to start the local command session during ${stage}: ${String(error?.message || error)}`,
          { cause: error, recoverable: true, stage },
        );
      }
    };
    if (this.state.interactiveDormant && this.state.sessionId) {
      const currentFingerprint = await this.fingerprintWorkspace(root);
      if (
        this.state.workspaceFingerprint
        && currentFingerprint
        && currentFingerprint !== this.state.workspaceFingerprint
      ) {
        await this.stopDormantSession();
      } else {
        return;
      }
    }
    await runStage("workspace readiness", async () => await this.fs.ensureReady?.());
    await runStage("package state preparation", async () => await this.ensureInstalledPackageState(root));
    const filesystem = await runStage(
      "workspace read",
      async () => await this.readRuntimeFilesystemWithArchiveFallback(root, {
        includePackageRepository: false,
        omitInstalledPayload,
      }),
    );
    const workspaceFiles = Array.isArray(filesystem.files) ? filesystem.files : [];
    const systemMounts = Array.isArray(filesystem.systemMounts) ? filesystem.systemMounts : [];
    const emptySystemMounts = systemMounts.map((mount) => ({
      path: mount.path,
      files: [],
    }));
    this.progress({
      phase: "hydrate",
      message: `Starting the local command session for ${workspaceFiles.length} workspace entries.`,
    });
    console.info("[EXTERNAL SHELL] Hydration plan", {
      workspaceEntries: workspaceFiles.length,
      systemMounts: systemMounts.map((mount) => ({
        path: mount.path,
        entries: Array.isArray(mount?.files) ? mount.files.length : 0,
      })),
      packageArchives: this.runtimePackageArchivePaths.length,
    });
    const session = await runStage("runtime process creation", async () => await this.client.request(
      "interactive-start",
      {
        configUrl: this.runtimeConfigUrl(),
        cwd: String(cwd || root),
        workspaceRoot: root,
        packageArchivePaths: this.runtimePackageArchivePaths,
        files: [],
        systemMounts: emptySystemMounts,
      },
      { timeoutMs: 180_000 },
    ));
    console.info("[EXTERNAL SHELL] Empty session ready", { sessionId: session.sessionId });
    const fileBatchSize = 1024;
    for (let offset = 0; offset < workspaceFiles.length; offset += fileBatchSize) {
      this.progress({
        phase: "hydrate",
        message: `Loading workspace entries ${offset + 1}-${Math.min(offset + fileBatchSize, workspaceFiles.length)} of ${workspaceFiles.length}.`,
      });
      await runStage(`workspace batch ${Math.floor(offset / fileBatchSize) + 1}`, async () => await this.client.request(
        "interactive-add-files",
        {
          sessionId: session.sessionId,
          files: workspaceFiles.slice(offset, offset + fileBatchSize),
          configureRepository: false,
          finalize: offset + fileBatchSize >= workspaceFiles.length,
        },
        { timeoutMs: 60_000 },
      ));
      console.info("[EXTERNAL SHELL] Workspace batch ready", {
        offset,
        entries: Math.min(fileBatchSize, workspaceFiles.length - offset),
      });
    }
    const mountBatches = [];
    for (const mount of systemMounts) {
      const mountFiles = Array.isArray(mount.files) ? mount.files : [];
      for (let offset = 0; offset < mountFiles.length; offset += fileBatchSize) {
        mountBatches.push({
          path: mount.path,
          files: mountFiles.slice(offset, offset + fileBatchSize),
        });
      }
    }
    for (let index = 0; index < mountBatches.length; index += 1) {
      const mount = mountBatches[index];
      this.progress({
        phase: "hydrate",
        message: `Loading system package data ${index + 1} of ${mountBatches.length}.`,
      });
      await runStage(`package data batch ${index + 1}`, async () => await this.client.request(
        "interactive-add-package-payload",
        {
          sessionId: session.sessionId,
          systemMounts: [mount],
          refreshMetadata: false,
        },
        { timeoutMs: 60_000 },
      ));
      console.info("[EXTERNAL SHELL] System batch ready", {
        index,
        path: mount.path,
        entries: mount.files.length,
      });
    }
    const hydratedCommands = await runStage("command metadata refresh", async () => await this.client.request(
      "interactive-add-package-payload",
      { sessionId: session.sessionId, systemMounts: [], refreshMetadata: true },
      { timeoutMs: 60_000 },
    ));
    this.progress({ phase: "hydrate", message: "Local command session ready." });
    Object.assign(this.state, {
      phase: "ready",
      running: false,
      interactive: false,
      interactiveDormant: true,
      foreground: false,
      sessionId: String(session.sessionId || ""),
      cwd: String(session.cwd || cwd || root),
      installedCommands: [...new Set([
        ...(this.state.installedCommands || []),
        ...(Array.isArray(hydratedCommands.installedCommands)
          ? hydratedCommands.installedCommands.map((command) => String(command))
          : []),
      ])],
      packageRepositoryMounted: false,
      workspaceFingerprint: await this.fingerprintWorkspace(root),
      lastError: null,
    });
    this.packageRepositoryPaths = new Set(
      filesystem.files
        .map((entry) => String(entry.path || ""))
        .filter((path) => path.startsWith("apt-repository/"))
        .map((path) => path.slice("apt-repository/".length)),
    );
    this.runtimePackageArchivePaths = [];
    this.aptMetadataReady = false;
    this.onStatus(this.status());
  }

  async warmup(cwd, workspaceRoot, { omitInstalledPayload = false } = {}) {
    const root = String(workspaceRoot || "/home/user");
    if (this.state.interactive || this.state.interactiveDormant) return this.status();
    if (this.warming) return await this.warming;
    this.warming = (async () => {
      await this.prepare();
      if (!this.state.interactive && !this.state.interactiveDormant) {
        this.state.phase = "warming";
        this.onStatus(this.status());
        await this.ensureDormantSession(root, String(cwd || root), { omitInstalledPayload });
      }
      return this.status();
    })();
    try {
      return await this.warming;
    } finally {
      this.warming = null;
    }
  }

  async runFlexM4Command(command, root) {
    const words = parseSimpleShellWords(command);
    const program = String(words?.[0] || "").replace(/^.*\//, "");
    if (!words?.length || !["flex", "flex++"].includes(program)) return null;

    const request = async (type, source) => await this.client.request(type, {
      configUrl: this.runtimeConfigUrl(),
      sessionId: this.state.sessionId,
      source,
      syncFiles: true,
    });
    const argumentsList = words.slice(1);
    if (argumentsList.some((argument) => ["--help", "-h", "--version", "-V"].includes(argument))) {
      const result = await request(
        "interactive-command-run",
        ["flex-real", ...argumentsList].map(shellQuote).join(" "),
      );
      return {
        exitCode: Number(result.exitCode || 0),
        cwd: String(this.state.cwd || root),
        runtime: "busybox-wasix",
        changedFiles: Number(result.changedFiles || 0),
        warmRuntime: true,
      };
    }

    let outputPath = program === "flex++" ? "lex.yy.cc" : "lex.yy.c";
    let writesStdout = false;
    const scannerArguments = [];
    for (let index = 0; index < argumentsList.length; index += 1) {
      const argument = argumentsList[index];
      if (argument === "-o" || argument === "--outfile") {
        if (index + 1 >= argumentsList.length) {
          this.output("stderr", `${program}: option requires an argument: ${argument}\n`);
          return { exitCode: 2, cwd: String(this.state.cwd || root), runtime: "busybox-wasix", changedFiles: 0, warmRuntime: true };
        }
        outputPath = argumentsList[index + 1];
        index += 1;
        continue;
      }
      if (argument.startsWith("--outfile=")) {
        outputPath = argument.slice("--outfile=".length);
        continue;
      }
      if (argument.startsWith("-o") && argument.length > 2) {
        outputPath = argument.slice(2);
        continue;
      }
      if (argument === "-t" || argument === "--stdout") {
        writesStdout = true;
        continue;
      }
      scannerArguments.push(argument);
    }
    if (program === "flex++" && !scannerArguments.includes("-+")) scannerArguments.unshift("-+");

    const intermediatePath = `.edgeterm-flex-${crypto.randomUUID()}.m4`;
    const scanner = await request(
      "interactive-command-run",
      ["flex-real", "--preproc=0", "-o", intermediatePath, ...scannerArguments].map(shellQuote).join(" "),
    );
    if (Number(scanner.exitCode || 0) !== 0) {
      return { exitCode: Number(scanner.exitCode || 1), cwd: String(this.state.cwd || root), runtime: "busybox-wasix", changedFiles: 0, warmRuntime: true };
    }

    const m4Source = writesStdout
      ? ["m4", "-P", intermediatePath].map(shellQuote).join(" ")
      : `${["m4", "-P", intermediatePath].map(shellQuote).join(" ")} > ${shellQuote(outputPath)}`;
    const processed = await request("interactive-run-buffered", m4Source);
    await request("interactive-run-buffered", `rm -f ${shellQuote(intermediatePath)}`);
    await this.syncing.catch(() => {});
    await this.persisting.catch(() => {});
    if (!processed.streamedOutput && processed.stdout) this.output("stdout", processed.stdout);
    if (!processed.streamedOutput && processed.stderr) this.output("stderr", processed.stderr);
    return {
      exitCode: Number(processed.exitCode || 0),
      cwd: String(this.state.cwd || root),
      runtime: "busybox-wasix",
      changedFiles: Number(processed.changedFiles || 0),
      warmRuntime: true,
    };
  }

  async runDormantCommand(command, root, { repositoryStaged = false, commandCwd = "" } = {}) {
    if (needsWorkspacePackageRepository(command)) {
      await this.mountInteractivePackageRepository(root, command, { repositoryStaged });
    }
    let executionCommand = rewriteAptCommandWithArchives(
      command,
      this.stagedAptArchivePaths,
    );
    const transactionArchivePaths = [...this.stagedAptArchivePaths];
    this.state.running = true;
    this.state.foreground = true;
    this.state.phase = "executing";
    this.onStatus(this.status());
    try {
      if (isInteractiveAptTransaction(command)) {
        const simulationCommand = addAptExecutionOption(executionCommand, "--simulate");
        const simulation = await this.client.request("interactive-command-run", {
          configUrl: this.runtimeConfigUrl(),
          sessionId: this.state.sessionId,
          source: simulationCommand,
          cwd: String(commandCwd || this.state.cwd || root),
          syncFiles: false,
          captureChanges: false,
        });
        if (!simulation.streamedOutput && simulation.stdout) this.output("stdout", simulation.stdout);
        if (!simulation.streamedOutput && simulation.stderr) this.output("stderr", simulation.stderr);
        if (Number(simulation.exitCode || 0) !== 0) {
          return {
            exitCode: Number(simulation.exitCode || 1),
            cwd: String(simulation.cwd || commandCwd || this.state.cwd || root),
            runtime: "busybox-wasix",
            changedFiles: 0,
            warmRuntime: true,
            simulated: true,
          };
        }
        const approved = await this.confirm({
          prompt: "Continue? [Y/n] ",
          command,
          executionCommand,
        });
        if (!approved) {
          this.output("stdout", "Abort.\n", { streaming: true });
          return {
            exitCode: 1,
            cwd: String(simulation.cwd || commandCwd || this.state.cwd || root),
            runtime: "busybox-wasix",
            changedFiles: 0,
            warmRuntime: true,
            aborted: true,
          };
        }
        executionCommand = addAptExecutionOption(executionCommand, "--assume-yes");
      }
      if (isFlexAdapterCommand(executionCommand)) {
        return await this.runFlexM4Command(executionCommand, root);
      }
      const recipePlanKind = isJustRecipeCommand(executionCommand)
        ? "just"
        : isMakeRecipeCommand(executionCommand)
          ? "make"
          : "";
      const recipePlanCommand = recipePlanKind === "just"
        ? justDryRunCommand(executionCommand)
        : recipePlanKind === "make"
          ? makeDryRunCommand(executionCommand)
          : "";
      if (recipePlanCommand) {
        const planned = await this.client.request("interactive-run-buffered", {
          configUrl: this.runtimeConfigUrl(),
          sessionId: this.state.sessionId,
          source: recipePlanCommand,
        });
        if (Number(planned.exitCode || 0) !== 0) {
          if (!planned.streamedOutput && planned.stderr) this.output("stderr", planned.stderr);
          return {
            exitCode: Number(planned.exitCode || 1),
            cwd: String(planned.cwd || this.state.cwd || root),
            runtime: "busybox-wasix",
            changedFiles: Number(planned.changedFiles || 0),
            warmRuntime: true,
          };
        }
        const recipeCommands = parseJustDryRunCommands(
          recipePlanKind === "just"
            ? planned.stderr || planned.stdout
            : planned.stdout,
        );
        let changedFiles = Number(planned.changedFiles || 0);
        for (const recipeCommand of recipeCommands) {
          const result = await this.client.request("interactive-run-buffered", {
            configUrl: this.runtimeConfigUrl(),
            sessionId: this.state.sessionId,
            source: recipeCommand,
          });
          if (!result.streamedOutput && result.stdout) {
            this.output("stdout", result.stdout);
          }
          if (!result.streamedOutput && result.stderr) {
            this.output("stderr", result.stderr);
          }
          changedFiles += Number(result.changedFiles || 0);
          if (Number(result.exitCode || 0) !== 0) {
            await this.syncing.catch(() => {});
            await this.persisting.catch(() => {});
            this.state.workspaceFingerprint = await this.fingerprintWorkspace(root);
            return {
              exitCode: Number(result.exitCode || 1),
              cwd: String(result.cwd || this.state.cwd || root),
              runtime: "busybox-wasix",
              changedFiles,
              warmRuntime: true,
            };
          }
        }
        await this.syncing.catch(() => {});
        await this.persisting.catch(() => {});
        if (syncFiles) this.state.workspaceFingerprint = await this.fingerprintWorkspace(root);
        return {
          exitCode: 0,
          cwd: String(planned.cwd || this.state.cwd || root),
          runtime: "busybox-wasix",
          changedFiles,
          warmRuntime: true,
        };
      }
      const directRuntimeCommand = this.installedRuntimeCommands(executionCommand).length > 0
        || isDirectRuntimeCommand(executionCommand)
        || isBundledStandaloneRuntimeCommand(executionCommand);
      const persistentShellExpansion = requiresPersistentShellExpansion(executionCommand);
      const syncFiles = mayChangeInteractiveFiles(executionCommand);
      if (
        isBufferedInteractiveShellCommand(executionCommand)
        || (
          !requiresInteractiveTerminal(executionCommand)
          && isBundledStandaloneRuntimeCommand(executionCommand)
        )
      ) {
        const result = await this.client.request("interactive-run-buffered", {
          configUrl: this.runtimeConfigUrl(),
          sessionId: this.state.sessionId,
          source: executionCommand,
          cwd: commandCwd,
          syncFiles,
        });
        if (Array.isArray(result.changes) && result.changes.length) {
          await this.applyChanges(root, result.changes, { persist: false });
          await this.fs.flush?.();
        }
        await this.syncing.catch(() => {});
        await this.persisting.catch(() => {});
        if (!result.streamedOutput && result.stdout) this.output("stdout", result.stdout);
        if (!result.streamedOutput && result.stderr) this.output("stderr", result.stderr);
        if (syncFiles) this.state.workspaceFingerprint = await this.fingerprintWorkspace(root);
        const nextCwd = String(result.cwd || commandCwd || this.state.cwd || root);
        this.state.cwd = nextCwd;
        return {
          exitCode: Number(result.exitCode || 0),
          cwd: nextCwd,
          runtime: "busybox-wasix",
          changedFiles: Number(result.changedFiles || 0),
          warmRuntime: true,
          bufferedCommand: true,
        };
      }
      if (!requiresInteractiveTerminal(executionCommand) && (!directRuntimeCommand || persistentShellExpansion)) {
        const result = await this.client.request("interactive-shell-command-run", {
          configUrl: this.runtimeConfigUrl(),
          sessionId: this.state.sessionId,
          source: executionCommand,
          cwd: commandCwd,
          syncFiles,
        });
        await this.syncing.catch(() => {});
        await this.persisting.catch(() => {});
        this.state.cwd = String(result.cwd || this.state.cwd || root);
        if (syncFiles) this.state.workspaceFingerprint = await this.fingerprintWorkspace(root);
        return {
          exitCode: Number(result.exitCode || 0),
          cwd: this.state.cwd,
          runtime: "busybox-wasix",
          changedFiles: Number(result.changedFiles || 0),
          warmRuntime: true,
          persistentShell: true,
        };
      }
      let result;
      try {
        result = await this.client.request("interactive-command-run", {
          configUrl: this.runtimeConfigUrl(),
          sessionId: this.state.sessionId,
          source: executionCommand,
          cwd: String(commandCwd || this.state.cwd || root),
          syncFiles,
          captureChanges: needsWorkspacePackageRepository(command)
           ,
        });
      } catch (error) {
        if (!isReadOnlyRuntimeSnapshotExit(error, executionCommand)) throw error;
        result = {
          exitCode: 1,
          cwd: String(commandCwd || this.state.cwd || root),
          changedFiles: 0,
          changes: [],
          systemChanges: [],
        };
      }
      if (Array.isArray(result.changes) && result.changes.length) {
        await this.applyChanges(root, result.changes, { persist: false });
      }
      if (Array.isArray(result.systemChanges) && result.systemChanges.length) {
        await this.applySystemChanges(result.systemChanges);
      }
      if (Array.isArray(result.installedCommands)) {
        this.state.installedCommands = result.installedCommands.map((command) => String(command));
      }
      if (Number(result.exitCode || 0) === 0 && transactionArchivePaths.length) {
        await this.persistStagedPackagePayloads(root, commandCwd, transactionArchivePaths);
      }
      await this.syncing.catch(() => {});
      await this.persisting.catch(() => {});
      if (!result.streamedOutput && result.stdout) this.output("stdout", result.stdout);
      if (!result.streamedOutput && result.stderr) this.output("stderr", result.stderr);
      if (syncFiles) this.state.workspaceFingerprint = await this.fingerprintWorkspace(root);
      return {
        exitCode: Number(result.exitCode || 0),
        cwd: String(result.cwd || commandCwd || this.state.cwd || root),
        runtime: "busybox-wasix",
        changedFiles: Number(result.changedFiles || 0),
        warmRuntime: true,
      };
    } finally {
      this.state.running = false;
      this.state.foreground = false;
      this.state.phase = "ready";
      this.onStatus(this.status());
    }
  }

  async loadPackageIndex(repositoryRoot, { refresh = false } = {}) {
    if (!refresh) {
      try {
        const indexText = await this.fs.readText(`${repositoryRoot}/Packages`);
        const inRelease = await this.fs.readText(`${repositoryRoot}/InRelease`);
        const packages = await verifyRepositoryIndex(indexText, inRelease);
        return { indexText, inRelease, packages };
      } catch {
        // Missing, expired, or altered cached metadata must be refreshed.
      }
    }
    this.progress({ phase: "packages", message: "Verifying package repository" });
    const result = await fetchRepositoryIndex(this.packageRepositoryUrl, this.fetch, { refresh });
    await this.fs.writeText(`${repositoryRoot}/Packages`, result.indexText);
    await this.fs.writeText(`${repositoryRoot}/InRelease`, result.inRelease);
    return result;
  }

  async stageAptRepository(root, command, { includeInstalledPayload = false } = {}) {
    this.stagedAptArchivePaths = [];
    this.runtimePackageArchivePaths = [];
    await this.fs.ensureReady?.();
    if (typeof this.fetch !== "function") {
      throw runtimeError(
        "external_shell_package_fetch_unavailable",
        "The package repository cannot be downloaded in this browser.",
        { recoverable: true },
      );
    }
    const repositoryRoot = `${String(root || "/home/user").replace(/\/+$/, "")}/apt-repository`;
    await this.fs.mkdir(repositoryRoot);
    const refreshMetadata = isAptMetadataRefresh(command);
    const { indexText, packages } = await this.loadPackageIndex(repositoryRoot, { refresh: refreshMetadata });
    if (refreshMetadata) {
      this.packageRepositoryPaths.clear();
      this.systemMountCache.clear();
      this.output("stdout", `Repository verified: ${packages.size} packages available.\n`);
    }
    let installedVersions = new Map();
    try {
      installedVersions = parseInstalledPackageVersions(await this.fs.readText("/var/lib/dpkg/status"));
    } catch {
      installedVersions = new Map();
    }
    const commandSelection = aptArchiveSelection(command, packages, installedVersions);
    if (commandSelection.length) {
      try {
        await this.fs.removeTree("/var/lib/apt/lists");
      } catch {
      }
      await this.fs.mkdir("/var/lib/apt/lists");
      await this.fs.mkdir("/var/lib/apt/lists/partial");
      for (const cachePath of [
        "/var/cache/apt/pkgcache.bin",
        "/var/cache/apt/srcpkgcache.bin",
      ]) {
        try {
          await this.fs.removeTree(cachePath);
        } catch {
        }
      }
    }
    const existingEntries = await this.fs.readTree(repositoryRoot, {
      includeNodeModules: true,
      includeDirectories: false,
      metadataOnly: true,
      maxFiles: 10_000,
      maxBytes: 256 * 1024 * 1024,
    });
    const existingPaths = new Set(existingEntries.map((entry) => String(entry.path || "")));
    const existingFiles = new Map(
      existingEntries
        .filter((entry) => !entry.dir)
        .map((entry) => [String(entry.path || ""), entry]),
    );
    const exactInstalledArchives = new Map();
    if (includeInstalledPayload) {
      for (const [name, version] of installedVersions) {
        const prefix = `${name}_${version}_`;
        const exactPath = [...existingPaths].find((path) => {
          const basename = path.split("/").pop() || "";
          return basename.startsWith(prefix) && basename.endsWith(".deb");
        });
        if (exactPath) exactInstalledArchives.set(name, exactPath);
      }
    }
    const payloadDownloads = includeInstalledPayload
      ? [...installedVersions.entries()]
        .filter(([name, version]) => (
          !exactInstalledArchives.has(name)
          && packages.has(name)
          && String(packages.get(name).Version || "") === version
        ))
        .map(([name]) => name)
      : [];
    const selected = [...new Set([...commandSelection, ...payloadDownloads])];
    for (let index = 0; index < selected.length; index += 1) {
      const name = selected[index];
      const fields = packages.get(name);
      const filename = String(fields.Filename || "").replace(/^\/+/, "");
      if (!filename || filename.includes("..")) {
        throw runtimeError(
          "external_shell_package_path_invalid",
          `The repository path for ${name} is invalid.`,
          { recoverable: false },
        );
      }
      const target = `${repositoryRoot}/${filename}`;
      const archivePrefix = `${name}_`;
      for (const path of [...existingPaths]) {
        const basename = path.split("/").pop() || "";
        if (path === filename || !basename.startsWith(archivePrefix) || !basename.endsWith(".deb")) continue;
        await this.fs.removeTree(`${repositoryRoot}/${path}`);
        existingPaths.delete(path);
      }
      if (existingPaths.has(filename)) {
        const existing = existingFiles.get(filename);
        const expectedSize = Number(fields.Size || 0);
        const expectedSha256 = String(fields.SHA256 || "").toLowerCase();
        let existingMatches = Number(existing?.size || 0) === expectedSize;
        if (existingMatches && expectedSha256 && existing?.encoding === "base64") {
          existingMatches = await sha256Hex(base64ToBytes(existing.data)) === expectedSha256;
        }
        if (existingMatches) continue;
        await this.fs.removeTree(target);
        existingPaths.delete(filename);
        existingFiles.delete(filename);
      }
      this.progress({
        phase: "packages",
        message: `Downloading ${name} (${index + 1}/${selected.length})`,
      });
      const archiveUrl = new URL(`${this.packageRepositoryUrl}/${filename}`, globalThis.location?.href || "http://localhost/");
      const response = await this.fetch(archiveUrl, { cache: "force-cache" });
      if (!response.ok) {
        throw runtimeError(
          "external_shell_package_download_failed",
          `Unable to download ${name}: HTTP ${response.status}`,
          { recoverable: true },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const expectedSize = Number(fields.Size || 0);
      if (expectedSize && bytes.byteLength !== expectedSize) {
        throw runtimeError(
          "external_shell_package_size_mismatch",
          `The downloaded size for ${name} does not match the repository metadata.`,
          { recoverable: true },
        );
      }
      const actualSha256 = await sha256Hex(bytes);
      if (actualSha256 !== String(fields.SHA256 || "").toLowerCase()) {
        throw runtimeError(
          "external_shell_package_checksum_mismatch",
          `The checksum for ${name} does not match the repository metadata.`,
          { recoverable: false },
        );
      }
      await this.fs.writeFiles([{ path: target, encoding: "base64", data: bytesToBase64(bytes) }]);
      existingPaths.add(filename);
    }
    this.stagedAptArchivePaths = commandSelection
      .map((name) => packages.get(name))
      .map((fields) => String(fields?.Filename || "").replace(/^\/+/, ""))
      .filter(Boolean)
      .map((filename) => `${repositoryRoot}/${filename}`);
    if (includeInstalledPayload) {
      const candidatePayloadPaths = payloadDownloads
        .map((name) => packages.get(name))
        .map((fields) => String(fields?.Filename || "").replace(/^\/+/, ""))
        .filter(Boolean);
      this.runtimePackageArchivePaths = [
        ...exactInstalledArchives.values(),
        ...candidatePayloadPaths,
      ].map((filename) => `${repositoryRoot}/${filename}`);
      if (this.runtimePackageArchivePaths.length !== installedVersions.size) {
        const missing = [...installedVersions.keys()].filter((name) => (
          !exactInstalledArchives.has(name) && !payloadDownloads.includes(name)
        ));
        throw runtimeError(
          "external_shell_installed_archive_missing",
          `Installed package archives are unavailable for: ${missing.join(", ")}`,
          { recoverable: true },
        );
      }
    }
    await this.fs.flush?.();
    return repositoryRoot;
  }

  async mountInteractivePackageRepository(root, command, { repositoryStaged = false } = {}) {
    const repositoryRoot = repositoryStaged
      ? `${String(root || "/home/user").replace(/\/+$/, "")}/apt-repository`
      : await this.stageAptRepository(root, command);
    const entries = await this.fs.readTree(repositoryRoot, {
      includeNodeModules: true,
      includeDirectories: true,
      maxFiles: 10_000,
      maxBytes: 256 * 1024 * 1024,
    });
    const archivePrefix = `${repositoryRoot.replace(/\/+$/, "")}/`;
    const requiredFiles = new Set([
      "Packages",
      ...this.stagedAptArchivePaths
        .filter((path) => String(path || "").startsWith(archivePrefix))
        .map((path) => String(path).slice(archivePrefix.length)),
    ]);
    const requiredDirectories = new Set();
    for (const path of requiredFiles) {
      const parts = String(path || "").split("/").filter(Boolean);
      parts.pop();
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        requiredDirectories.add(current);
      }
    }
    const pendingEntries = entries.filter((entry) => {
      const path = String(entry.path || "");
      if (entry.dir ? !requiredDirectories.has(path) : !requiredFiles.has(path)) return false;
      if (this.packageRepositoryPaths.has(path)) return false;
      this.packageRepositoryPaths.add(path);
      return true;
    });
    if (!pendingEntries.length) return;
    await this.client.request(
      "interactive-add-files",
      {
        sessionId: this.state.sessionId,
        files: pendingEntries.map((entry) => ({
          ...entry,
          path: ["apt-repository", String(entry.path || "")].filter(Boolean).join("/"),
        })),
      },
      { timeoutMs: 60_000 },
    );
    this.state.packageRepositoryMounted = true;
  }

  async resumeInteractiveSession(root, cwd) {
    if (!this.state.interactiveDormant) return;
    const filesystem = await this.readRuntimeFilesystemWithArchiveFallback(root, {
      includePackageRepository: false,
      omitInstalledPayload: true,
    });
    const session = await this.client.request(
      "interactive-start",
      {
        configUrl: this.runtimeConfigUrl(),
        cwd: String(cwd || root),
        workspaceRoot: root,
        packageArchivePaths: this.runtimePackageArchivePaths,
        ...filesystem,
      },
      { timeoutMs: 60_000 },
    );
    Object.assign(this.state, {
      phase: "interactive",
      running: true,
      interactive: true,
      interactiveDormant: false,
      foreground: false,
      sessionId: String(session.sessionId || ""),
      cwd: String(session.cwd || cwd || root),
      installedCommands: [...new Set([
        ...(this.state.installedCommands || []),
        ...(Array.isArray(session.installedCommands)
          ? session.installedCommands.map((command) => String(command))
          : []),
      ])],
      packageRepositoryMounted: false,
    });
    this.packageRepositoryPaths = new Set(
      filesystem.files
        .map((entry) => String(entry.path || ""))
        .filter((path) => path.startsWith("apt-repository/"))
        .map((path) => path.slice("apt-repository/".length)),
    );
    this.runtimePackageArchivePaths = [];
    this.aptMetadataReady = false;
    this.onStatus(this.status());
  }

  async run(source, cwd, workspaceRoot) {
    const sequence = splitTopLevelCommandSequence(source);
    const explicitlyInteractive = this.state.interactive && !this.state.interactiveDormant;
    const containsPackageManagerCommand = sequence?.some(({ source: entrySource }) => (
      /^(?:apt|apt-get|apt-cache|dpkg)(?:\s|$)/.test(String(entrySource || "").trim())
    ));
    if (
      sequence?.length > 1
      && !explicitlyInteractive
      && (containsPackageManagerCommand || !isBufferedInteractiveShellCommand(source))
    ) {
      let currentCwd = String(cwd || this.state.cwd || workspaceRoot || "/home/user");
      let previousExitCode = 0;
      let lastResult = {
        exitCode: 0,
        cwd: currentCwd,
        runtime: "busybox-wasix",
        changedFiles: 0,
      };
      for (const entry of sequence) {
        if (entry.operator === "&&" && previousExitCode !== 0) continue;
        if (entry.operator === "||" && previousExitCode === 0) continue;
        lastResult = await this.run(
          expandShellLastStatus(entry.source, previousExitCode),
          currentCwd,
          workspaceRoot,
        );
        previousExitCode = Number(lastResult.exitCode || 0);
        currentCwd = String(lastResult.cwd || currentCwd);
      }
      return { ...lastResult, cwd: currentCwd, exitCode: previousExitCode };
    }
    try {
      return await this.runOnce(source, cwd, workspaceRoot);
    } catch (error) {
      if (!this.state.interactiveDormant || !isMissingDormantSessionError(error)) throw error;
      this.resetDormantSessionState();
      await this.warmup(String(cwd || workspaceRoot || "/home/user"), String(workspaceRoot || "/home/user"), {
        omitInstalledPayload: true,
      });
      return await this.runOnce(source, cwd, workspaceRoot);
    }
  }

  async runOnce(source, cwd, workspaceRoot) {
    await this.prepare();
    const root = String(workspaceRoot || "/home/user");
    const command = String(source || "").trim();
    const commandCwd = String(cwd || this.state.cwd || root);
    this.state.cwd = commandCwd;
    if (!this.state.interactive) {
      let missingCommand = "";
      for (const name of firstCommands(command)) {
        if (!INSTALL_REQUIRED_OVERRIDE_COMMANDS.has(name)) continue;
        if (!(await this.installedPackagesForCommand(name)).length) {
          missingCommand = name;
          break;
        }
      }
      if (missingCommand) {
        this.output("stderr", `ash: ${missingCommand}: not found\n`, { streaming: true });
        return {
          exitCode: 127,
          cwd: commandCwd,
          runtime: "busybox-wasix",
          changedFiles: 0,
        };
      }
    }
    const interactiveApt = isInteractiveAptTransaction(command);
    if (this.state.interactiveDormant && referencesInstalledPackageFilesystem(command)) {
      await this.stopDormantSession();
    }
    if (this.state.interactiveDormant) {
      const noopPackages = await this.aptNoopInstall(command, root);
      if (noopPackages) {
        for (const item of noopPackages) {
          this.output(
            "stdout",
            `${item.name} is already the newest version (${item.version}).\n`,
            { streaming: true },
          );
        }
        this.output("stdout", "Summary:\n", { streaming: true });
        this.output(
          "stdout",
          "  Upgrading: 0, Installing: 0, Removing: 0, Not Upgrading: 0\n",
          { streaming: true },
        );
        return {
          exitCode: 0,
          cwd: commandCwd,
          runtime: "busybox-wasix",
          changedFiles: 0,
          noop: true,
        };
      }
    }
    if (this.state.interactive) {
      if (this.state.foreground) {
        await this.client.request("interactive-write", {
          sessionId: this.state.sessionId,
          data: `${String(source || "")}\r`,
        });
        return {
          exitCode: 0,
          cwd: String(this.state.cwd || cwd || root),
          runtime: "busybox-wasix",
          changedFiles: 0,
          interactive: true,
          foregroundInput: true,
        };
      }
      if (command === "exit") {
        if (this.state.interactiveDormant) {
          Object.assign(this.state, {
            phase: "ready",
            running: false,
            interactive: false,
            interactiveDormant: false,
            foreground: false,
            sessionId: "",
            packageRepositoryMounted: false,
            workspaceFingerprint: "",
          });
          this.packageRepositoryPaths.clear();
          this.onStatus(this.status());
          return {
            exitCode: 0,
            cwd: String(this.state.cwd || cwd || root),
            runtime: "busybox-wasix",
            changedFiles: 0,
            interactive: false,
          };
        }
        await this.client.request(
          "interactive-stop",
          { sessionId: this.state.sessionId },
          { timeoutMs: 12_000 },
        );
        await this.syncing.catch(() => {});
        await this.persisting.catch(() => {});
        Object.assign(this.state, {
          phase: "ready",
          running: false,
          interactive: false,
          interactiveDormant: false,
          foreground: false,
          sessionId: "",
          packageRepositoryMounted: false,
          workspaceFingerprint: "",
        });
        this.packageRepositoryPaths.clear();
        this.onStatus(this.status());
        return {
          exitCode: 0,
          cwd: String(this.state.cwd || cwd || root),
          runtime: "busybox-wasix",
          changedFiles: 0,
          interactive: false,
        };
      }
      await this.resumeInteractiveSession(root, String(this.state.cwd || cwd || root));
      await this.ensureInstalledRuntimeAvailable(command, root, commandCwd);
      if (needsWorkspacePackageRepository(command)) {
        await this.mountInteractivePackageRepository(root, command);
      }
      if (isFlexAdapterCommand(command)) {
        this.state.foreground = true;
        this.state.phase = "interactive-command";
        this.onStatus(this.status());
        try {
          return await this.runFlexM4Command(command, root);
        } finally {
          this.state.foreground = false;
          this.state.phase = "interactive";
          this.onStatus(this.status());
        }
      }
      if (isInteractiveForegroundCommand(command)) {
        const executionCommand = rewriteAptCommandWithArchives(
          command,
          this.stagedAptArchivePaths,
        );
        this.state.foreground = true;
        this.state.phase = "interactive-command";
        this.onStatus(this.status());
        try {
          let result;
          try {
            result = await this.client.request("interactive-command-run", {
              configUrl: this.runtimeConfigUrl(),
              sessionId: this.state.sessionId,
              source: executionCommand,
              cwd: commandCwd,
              syncFiles: mayChangeInteractiveFiles(command),
              captureChanges: needsWorkspacePackageRepository(command)
               ,
            });
          } catch (error) {
            if (!isReadOnlyRuntimeSnapshotExit(error, executionCommand)) throw error;
            result = {
              exitCode: 1,
              cwd: String(commandCwd || this.state.cwd || root),
              changedFiles: 0,
              changes: [],
              systemChanges: [],
            };
          }
          if (Array.isArray(result.changes) && result.changes.length) {
            await this.applyChanges(root, result.changes, { persist: false });
          }
          if (Array.isArray(result.systemChanges) && result.systemChanges.length) {
            await this.applySystemChanges(result.systemChanges);
          }
          if (Array.isArray(result.installedCommands)) {
            this.state.installedCommands = result.installedCommands.map((installedCommand) => String(installedCommand));
          }
          if (Number(result.exitCode || 0) === 0 && this.stagedAptArchivePaths.length) {
            await this.persistStagedPackagePayloads(root, commandCwd);
          }
          await this.syncing.catch(() => {});
          await this.persisting.catch(() => {});
          this.state.cwd = String(result.cwd || commandCwd || this.state.cwd || root);
          return {
            exitCode: Number(result.exitCode || 0),
            cwd: this.state.cwd,
            runtime: "busybox-wasix",
            changedFiles: Number(result.changedFiles || 0),
            warmRuntime: true,
          };
        } catch (error) {
          throw error;
        } finally {
          this.state.foreground = false;
          this.state.phase = this.state.interactiveDormant ? "ready" : "interactive";
          this.onStatus(this.status());
        }
      }
      if (isBufferedInteractiveShellCommand(command)) {
        const result = await this.client.request("interactive-run-buffered", {
          configUrl: this.runtimeConfigUrl(),
          sessionId: this.state.sessionId,
          source: command,
          cwd: commandCwd,
        });
        if (Array.isArray(result.changes) && result.changes.length) {
          await this.applyChanges(root, result.changes, { persist: false });
          await this.fs.flush?.();
        }
        await this.syncing.catch(() => {});
        if (!result.streamedOutput && result.stdout) this.output("stdout", result.stdout);
        if (!result.streamedOutput && result.stderr) this.output("stderr", result.stderr);
        const persistedCwd = await this.resolvePersistedCwd(
          root,
          String(result.cwd || commandCwd || this.state.cwd || root),
        );
        return {
          exitCode: Number(result.exitCode || 0),
          cwd: persistedCwd,
          runtime: "busybox-wasix",
          changedFiles: Number(result.changedFiles || 0),
          interactive: true,
          bufferedCommand: true,
        };
      }
      await this.client.request("interactive-write", {
        sessionId: this.state.sessionId,
        data: `${String(source || "")}\r\n`,
        syncCwd: mayChangeInteractiveCwd(command),
        syncFiles: mayChangeInteractiveFiles(command),
      });
      return {
        exitCode: 0,
        cwd: String(this.state.cwd || cwd || root),
        runtime: "busybox-wasix",
        changedFiles: 0,
        interactive: true,
        interactiveDormant: false,
      };
    }
    if (this.state.interactiveDormant && isExternalShellSessionEntry(command)) {
      Object.assign(this.state, {
        phase: "interactive",
        running: true,
        interactive: true,
        interactiveDormant: false,
      });
      this.output("stdout", "BusyBox ash is running. Type exit to return to EdgeTerm.");
      this.onStatus(this.status());
      return {
        exitCode: 0,
        cwd: String(this.state.cwd || cwd || root),
        runtime: "busybox-wasix",
        changedFiles: 0,
        interactive: true,
      };
    }
    if (
      needsWorkspacePackageRepository(command)
      && interactiveApt
    ) {
      await this.stageAptRepository(root, command);
      if (!this.stagedAptArchivePaths.length) {
        return await this.runDormantCommand(command, root, { commandCwd });
      }
      await this.stopDormantSession();
      const transactionArchivePaths = [...this.stagedAptArchivePaths];
      await this.warmup(String(cwd || root), root, { omitInstalledPayload: true });
      this.stagedAptArchivePaths = transactionArchivePaths;
      return await this.runDormantCommand(command, root, { repositoryStaged: true, commandCwd });
    }
    if (
      this.state.interactiveDormant
      && needsWorkspacePackageRepository(command)
      && !interactiveApt
      && !isNonInteractiveAptTransaction(command)
    ) {
      await this.mountInteractivePackageRepository(root, command);
      return await this.runDormantCommand(command, root, { commandCwd });
    }
    let transactionArchivePaths = [];
    if (needsWorkspacePackageRepository(command)) {
      await this.stopDormantSession();
      await this.stageAptRepository(root, command);
      transactionArchivePaths = [...this.stagedAptArchivePaths];
    }
    const executionCommand = rewriteAptCommandWithArchives(
      command,
      this.stagedAptArchivePaths,
    );
    if (this.state.interactiveDormant) {
      await this.ensureInstalledRuntimeAvailable(executionCommand, root, cwd);
      return await this.runDormantCommand(command, root, { commandCwd });
    }
    if (requiresInteractiveTerminal(command)) {
      await this.warmup(String(cwd || root), root, { omitInstalledPayload: true });
      return await this.runDormantCommand(command, root, { commandCwd });
    }
    const runtimeFilesystem = await this.readRuntimeFilesystemWithArchiveFallback(root, {
      includePackageRepository: !isExternalShellSessionEntry(command)
        && needsWorkspacePackageRepository(command),
      omitInstalledPayload: !referencesInstalledPackageFilesystem(command),
      command: executionCommand,
    });
    const { files, systemMounts } = runtimeFilesystem;
    if (isExternalShellSessionEntry(command)) {
      const result = await this.client.request(
        "interactive-start",
        {
          configUrl: this.runtimeConfigUrl(),
          cwd: String(cwd || root),
          workspaceRoot: root,
          files,
          systemMounts,
          packageArchivePaths: this.runtimePackageArchivePaths,
        },
        { timeoutMs: 180_000 },
      );
      Object.assign(this.state, {
        phase: "interactive",
        running: true,
        interactive: true,
        foreground: false,
        sessionId: String(result.sessionId || ""),
        cwd: String(result.cwd || cwd || root),
        installedCommands: Array.isArray(result.installedCommands)
          ? result.installedCommands.map((command) => String(command))
          : [],
        packageRepositoryMounted: false,
        lastError: null,
      });
      this.packageRepositoryPaths.clear();
      this.stagedAptArchivePaths = [];
      this.output("stdout", "BusyBox ash is running. Type exit to return to EdgeTerm.");
      this.onStatus(this.status());
      return {
        exitCode: 0,
        cwd: String(cwd || root),
        runtime: "busybox-wasix",
        changedFiles: 0,
        interactive: true,
      };
    }
    if (shouldHydrateRuntimeFilesystemInBatches(runtimeFilesystem)) {
      await this.warmup(String(cwd || root), root, {
        omitInstalledPayload: !referencesInstalledPackageFilesystem(command),
      });
      await this.ensureInstalledRuntimeAvailable(executionCommand, root, cwd);
      return await this.runDormantCommand(command, root, { commandCwd });
    }
    this.state.running = true;
    this.state.phase = "executing";
    this.onStatus(this.status());
    try {
      const result = await this.client.request("run", {
        configUrl: this.runtimeConfigUrl(),
        source: executionCommand,
        cwd: String(cwd || root),
        workspaceRoot: root,
        files,
        systemMounts,
        packageArchivePaths: this.runtimePackageArchivePaths,
        systemMountCacheKey: this.systemMountCacheKey,
        captureChanges: mayChangeInteractiveFiles(executionCommand),
      });
      const workspaceChanged = Array.isArray(result.changes) && result.changes.length > 0;
      const systemChanged = Array.isArray(result.systemChanges)
        && result.systemChanges.some((group) => Array.isArray(group?.changes) && group.changes.length > 0);
      if ((workspaceChanged || systemChanged) && this.state.interactiveDormant) {
        await this.stopDormantSession();
      }
      this.progress({ phase: "apply-workspace", message: "Applying workspace changes..." });
      await this.applyChanges(root, result.changes);
      this.progress({ phase: "apply-system", message: "Applying package changes..." });
      await this.applySystemChanges(result.systemChanges);
      if (Number(result.exitCode || 0) === 0 && transactionArchivePaths.length) {
        await this.persistStagedPackagePayloads(
          root,
          String(cwd || root),
          transactionArchivePaths,
        );
      }
      if (
        Array.isArray(result.installedCommands)
        && Number(result.changedSystemFiles || 0) > 0
      ) {
        this.state.installedCommands = result.installedCommands.map((installedCommand) => String(installedCommand));
      }
      this.progress({ phase: "persisted", message: "Package changes are saved." });
      if (!result.streamedOutput && result.stdout) this.output("stdout", result.stdout);
      if (!result.streamedOutput && result.stderr) this.output("stderr", result.stderr);
      this.state.phase = "ready";
      const persistedCwd = await this.resolvePersistedCwd(
        root,
        String(result.cwd || cwd || root),
      );
      return {
        exitCode: Number(result.exitCode || 0),
        cwd: persistedCwd,
        runtime: "busybox-wasix",
        changedFiles: Number(result.changedFiles || 0),
      };
    } catch (error) {
      if (["external_shell_request_timeout", "external_shell_worker_crashed"].includes(String(error?.code || ""))) {
        this.state.ready = false;
        this.state.available = false;
        this.state.phase = "fallback";
      } else {
        this.state.phase = "ready";
      }
      throw error;
    } finally {
      this.state.running = false;
      this.runtimePackageArchivePaths = [];
      this.onStatus(this.status());
    }
  }

  cancel() {
    this.client.cancel();
    this.preparing = null;
    this.warming = null;
    this.state.running = false;
    this.state.ready = false;
    this.state.interactive = false;
    this.state.interactiveDormant = false;
    this.state.foreground = false;
    this.state.sessionId = "";
    this.state.packageRepositoryMounted = false;
    this.state.workspaceFingerprint = "";
    this.state.phase = "cancelled";
    this.onStatus(this.status());
  }

  reset() {
    this.cancel();
    Object.assign(this.state, {
      phase: "idle",
      ready: false,
      available: null,
      running: false,
      interactive: false,
      sessionId: "",
      packageRepositoryMounted: false,
      workspaceFingerprint: "",
      version: "",
      license: "",
      sourceRepository: "",
      lastError: null,
    });
    this.onStatus(this.status());
    return this.status();
  }
}

export function createEdgeTermExternalShellRuntime(options) {
  return new EdgeTermExternalShellRuntime(options);
}
