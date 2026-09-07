import assert from "node:assert/strict";
import test from "node:test";

import {
  EdgeTermExternalShellRuntime,
  expandShellLastStatus,
  isBufferedExternalPipeline,
  isBufferedInteractiveShellCommand,
  isExternalShellCommand,
  isExternalShellSessionEntry,
  mayChangeInteractiveCwd,
  mayChangeInteractiveFiles,
  needsWorkspacePackageRepository,
  parseInstalledPackageVersions,
  requiresPersistentShellExpansion,
  shouldHydrateRuntimeFilesystemInBatches,
  splitTopLevelCommandSequence,
} from "../../frontend/src/external-shell/runtime-controller.js";

test("resolves the runtime configuration URL before sending it to the worker", () => {
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {},
    assetUrl: (value) => `assets/${value}`,
  });
  assert.equal(
    runtime.runtimeConfigUrl(),
    "http://localhost/assets/external-runtime/runtime-config.json",
  );
});

test("batches large runtime filesystem payloads", () => {
  assert.equal(shouldHydrateRuntimeFilesystemInBatches({ files: [] }), false);
  assert.equal(
    shouldHydrateRuntimeFilesystemInBatches({
      files: Array.from({ length: 257 }, (_, index) => ({ path: `file-${index}` })),
    }),
    true,
  );
  assert.equal(
    shouldHydrateRuntimeFilesystemInBatches({
      files: [{ path: "large.bin", data: "x".repeat(8 * 1024 * 1024 + 1) }],
    }),
    true,
  );
});

test("detects pipelines that need the buffered WASIX adapter", () => {
  assert.equal(isBufferedExternalPipeline("busybox --list | wc -l"), true);
  assert.equal(isBufferedExternalPipeline("printf 'b\\na\\n' | sort | head -1"), true);
  assert.equal(isBufferedExternalPipeline("echo 'a|b'"), false);
  assert.equal(isBufferedExternalPipeline("echo a || echo b"), false);
  assert.equal(isBufferedExternalPipeline("echo a | sort; pwd"), false);
  assert.equal(isBufferedExternalPipeline("echo $(printf x | sort)"), false);
});

test("buffers shell control syntax that does not need persistent shell state", () => {
  assert.equal(isBufferedInteractiveShellCommand("printf x > result.txt"), true);
  assert.equal(isBufferedInteractiveShellCommand("cat input.txt | sort > output.txt"), true);
  assert.equal(isBufferedInteractiveShellCommand("echo one && touch result.txt"), true);
  assert.equal(isBufferedInteractiveShellCommand("echo $(pwd)"), true);
  assert.equal(isBufferedInteractiveShellCommand('echo "cwd=$(pwd)"'), true);
  assert.equal(isBufferedInteractiveShellCommand('echo "cwd=`pwd`"'), true);
  assert.equal(isBufferedInteractiveShellCommand("cd /tmp; pwd"), true);
  assert.equal(isBufferedInteractiveShellCommand("export NAME=value; echo $NAME"), false);
  assert.equal(isBufferedInteractiveShellCommand("alias ll='ls -l'; ll"), false);
  assert.equal(isBufferedInteractiveShellCommand("echo 'x > y'"), false);
});

test("splits top-level command lists without splitting quoted text or pipelines", () => {
  assert.deepEqual(
    splitTopLevelCommandSequence(
      'grep -q "Digi AI Bridge QA" page.html && php --version | head -1 && git --version',
    ),
    [
      { source: 'grep -q "Digi AI Bridge QA" page.html', operator: "" },
      { source: "php --version | head -1", operator: "&&" },
      { source: "git --version", operator: "&&" },
    ],
  );
  assert.equal(splitTopLevelCommandSequence("echo 'a && b'"), null);
  assert.equal(splitTopLevelCommandSequence("if test -e file; then echo yes; else echo no; fi"), null);
  assert.deepEqual(
    splitTopLevelCommandSequence("cd /home/user && if test -e file; then echo yes; else echo no; fi"),
    [
      { source: "cd /home/user", operator: "" },
      { source: "if test -e file; then echo yes; else echo no; fi", operator: "&&" },
    ],
  );
  assert.deepEqual(
    splitTopLevelCommandSequence("cd /home/user && for item in a b; do echo $item; done"),
    [
      { source: "cd /home/user", operator: "" },
      { source: "for item in a b; do echo $item; done", operator: "&&" },
    ],
  );
  assert.deepEqual(splitTopLevelCommandSequence("mkdir -p demo; cd demo; for n in 1 2; do echo $n; done"), [
    { source: "mkdir -p demo", operator: "" },
    { source: "cd demo", operator: ";" },
    { source: "for n in 1 2; do echo $n; done", operator: ";" },
  ]);
  assert.equal(splitTopLevelCommandSequence("for item in a b; do echo $item; done"), null);
  assert.equal(splitTopLevelCommandSequence("while false; do echo no; done"), null);
  assert.deepEqual(splitTopLevelCommandSequence("echo start; i=0; while test $i -lt 2; do i=$((i+1)); done; echo end"), [
    { source: "echo start", operator: "" },
    { source: "i=0; while test $i -lt 2; do i=$((i+1)); done", operator: ";" },
    { source: "echo end", operator: ";" },
  ]);
  assert.equal(splitTopLevelCommandSequence("case x in x) echo yes;; esac"), null);
  assert.equal(splitTopLevelCommandSequence("export NAME=value; echo $NAME"), null);
  assert.deepEqual(splitTopLevelCommandSequence("test -e missing; echo status=$?"), [
    { source: "test -e missing", operator: "" },
    { source: "echo status=$?", operator: ";" },
  ]);
  assert.notEqual(splitTopLevelCommandSequence("printf '$?'; echo done"), null);
  assert.deepEqual(
    splitTopLevelCommandSequence("cd /; pwd; cd /home/user; python3 -V; apt --version"),
    [
      { source: "cd /", operator: "" },
      { source: "pwd", operator: ";" },
      { source: "cd /home/user", operator: ";" },
      { source: "python3 -V", operator: ";" },
      { source: "apt --version", operator: ";" },
    ],
  );
  assert.equal(expandShellLastStatus('printf "status=$?"', 17), 'printf "status=17"');
});

test("keeps buffered POSIX command lists in one runtime operation", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  const calls = [];
  runtime.runOnce = async (source, cwd) => {
    calls.push({ source, cwd });
    return { exitCode: 0, cwd, runtime: "test", changedFiles: 0 };
  };
  const result = await runtime.run(
    'grep -q "Digi AI Bridge QA" page.html && php --version | head -1 && git --version',
    "/home/user",
    "/home/user",
  );
  assert.deepEqual(calls.map((entry) => entry.source), [
    'grep -q "Digi AI Bridge QA" page.html && php --version | head -1 && git --version',
  ]);
  assert.equal(result.exitCode, 0);
});

test("routes APT command lists one command at a time", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  const calls = [];
  runtime.runOnce = async (source, cwd) => {
    calls.push({ source, cwd });
    return { exitCode: 0, cwd, runtime: "test", changedFiles: 0 };
  };

  await runtime.run(
    "apt update; apt install -y git; git --version; pwd; echo lifecycle-ok",
    "/home/user",
    "/home/user",
  );

  assert.deepEqual(calls.map((entry) => entry.source), [
    "apt update",
    "apt install -y git",
    "git --version",
    "pwd",
    "echo lifecycle-ok",
  ]);
});

test("falls back to the workspace root when a command deletes its cwd", async () => {
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {
      readTree: async (path) => {
        if (path === "/home/user/deleted/sub") throw new Error("missing");
        return [];
      },
    },
    assetUrl: (value) => value,
  });

  assert.equal(
    await runtime.resolvePersistedCwd("/home/user", "/home/user/deleted/sub"),
    "/home/user",
  );
  assert.equal(
    await runtime.resolvePersistedCwd("/home/user", "/home/user/present"),
    "/home/user/present",
  );
});

test("keeps shell status expansion inside the buffered POSIX operation", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  const calls = [];
  runtime.runOnce = async (source, cwd) => {
    calls.push(source);
    return { exitCode: calls.length === 1 ? 1 : 0, cwd, runtime: "test", changedFiles: 0 };
  };

  await runtime.run("test -e missing; echo status=$?", "/home/user", "/home/user");

  assert.deepEqual(calls, ["test -e missing; echo status=$?"]);
});

test("ignores shell-looking text inside quoted multiline values", () => {
  assert.equal(isExternalShellCommand("printf 'python3\\nnode\\n'"), true);
  assert.equal(isExternalShellCommand("printf value; python3 -V"), false);
  assert.equal(isExternalShellCommand("echo $(python3 -V)"), false);
});

test("routes compound command substitutions through the buffered adapter", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  runtime.state.cwd = "/home/user";
  runtime.state.workspaceFingerprint = "stable";
  runtime.fingerprintWorkspace = async () => "stable";
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    return { exitCode: 0, cwd: "/home/user", stdout: "SUB=/home/user\na\n", changedFiles: 0 };
  };

  const result = await runtime.runDormantCommand(
    "echo SUB=$(pwd); printf 'b\\na\\n' | sort | head -1",
    "/home/user",
  );

  assert.equal(requests[0].type, "interactive-run-buffered");
  assert.equal(result.exitCode, 0);
  assert.equal(result.bufferedCommand, true);
});

test("routes compound commands that begin with a shell builtin", () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  assert.equal(runtime.shouldHandle("cd /tmp && echo ready"), true);
  assert.equal(runtime.shouldHandle('grep -q "ready" page.html && php --version'), true);
  assert.equal(runtime.shouldHandle("export NAME=value"), false);
});

test("buffers batch package commands that require complete output and file synchronization", () => {
  assert.equal(isBufferedInteractiveShellCommand("bison -o parser.c grammar.y"), true);
  assert.equal(isBufferedInteractiveShellCommand("dash -c 'printf ready'"), true);
  assert.equal(isBufferedInteractiveShellCommand("fd input /home/user"), true);
  assert.equal(isBufferedInteractiveShellCommand("ninja -f build.ninja"), true);
  assert.equal(isBufferedInteractiveShellCommand("wget -O output.txt file:///input.txt"), true);
  assert.equal(isBufferedInteractiveShellCommand("cp input.txt output.txt"), true);
  assert.equal(isBufferedInteractiveShellCommand("mv input.txt output.txt"), true);
  assert.equal(isBufferedInteractiveShellCommand("pwd"), true);
  assert.equal(isBufferedInteractiveShellCommand("less -F -X input.txt"), true);
  assert.equal(isBufferedInteractiveShellCommand("less input.txt"), false);
  assert.equal(isBufferedInteractiveShellCommand("dash"), false);
});

test("detects commands that can change the persistent shell directory", () => {
  assert.equal(mayChangeInteractiveCwd("cd /tmp"), true);
  assert.equal(mayChangeInteractiveCwd("mkdir demo; cd demo"), true);
  assert.equal(mayChangeInteractiveCwd("builtin cd .."), true);
  assert.equal(mayChangeInteractiveCwd(". ./environment.sh"), true);
  assert.equal(mayChangeInteractiveCwd("echo cd /tmp"), false);
  assert.equal(mayChangeInteractiveCwd("printf '%s' ."), false);
});

test("keeps shell expansion inside the persistent session", () => {
  assert.equal(requiresPersistentShellExpansion('printf "%s\\n" "$NAME"'), true);
  assert.equal(requiresPersistentShellExpansion("printf '%s\\n' '$NAME'"), false);
  assert.equal(requiresPersistentShellExpansion("ls *.txt"), true);
  assert.equal(requiresPersistentShellExpansion("cat ~/notes.txt"), true);
  assert.equal(requiresPersistentShellExpansion("printf plain"), false);
});

test("detects interactive commands that can change workspace files", () => {
  assert.equal(mayChangeInteractiveFiles("mkdir -p demo"), true);
  assert.equal(mayChangeInteractiveFiles("printf x > result.txt"), true);
  assert.equal(mayChangeInteractiveFiles("sed -i 's/a/b/' file.txt"), true);
  assert.equal(mayChangeInteractiveFiles("busybox rm old.txt"), true);
  assert.equal(mayChangeInteractiveFiles("apt install edgeterm-smoke"), true);
  assert.equal(mayChangeInteractiveFiles("dpkg --remove edgeterm-smoke"), true);
  assert.equal(mayChangeInteractiveFiles("bison -o parser.c grammar.y"), true);
  assert.equal(mayChangeInteractiveFiles("ninja -f build.ninja"), true);
  assert.equal(mayChangeInteractiveFiles("rsync -a source/ destination/"), true);
  assert.equal(mayChangeInteractiveFiles("wget -O output.txt file:///input.txt"), true);
  assert.equal(mayChangeInteractiveFiles("curl -o output.txt https://example.test/file"), true);
  assert.equal(mayChangeInteractiveFiles("cat file.txt"), false);
  assert.equal(mayChangeInteractiveFiles("cd /tmp"), false);
  assert.equal(mayChangeInteractiveFiles("printf '%s' '> not a redirect'"), true);
});

test("routes redirection syntax through the buffered shell", () => {
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {},
    assetUrl: (value) => value,
  });
  runtime.state.interactive = true;
  runtime.state.sessionId = "test-session";
  assert.equal(runtime.shouldHandle("printf x > result.txt"), true);
  assert.equal(isBufferedExternalPipeline("printf x > result.txt"), false);
  assert.equal(isBufferedInteractiveShellCommand("printf x > result.txt"), true);
});

test("runs redirected shell commands as buffered operations", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.prepare = async () => runtime.status();
  runtime.state.interactive = true;
  runtime.state.sessionId = "test-session";
  let request = null;
  runtime.client.request = async (type, payload) => {
    request = { type, payload };
    return { accepted: true };
  };
  await runtime.run("printf x > result.txt", "/home/user", "/home/user");
  assert.equal(request.type, "interactive-run-buffered");
  assert.equal(request.payload.source, "printf x > result.txt");
});

test("keeps the worker cache while isolating consecutive WASIX processes", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.prepare = async () => runtime.status();
  let filesystemReads = 0;
  runtime.readRuntimeFilesystem = async () => {
    filesystemReads += 1;
    return { files: [], systemMounts: [] };
  };
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    if (type === "run") {
      return {
        exitCode: 0,
        cwd: "/home/user",
        changedFiles: 0,
        changes: [],
        systemChanges: [],
        installedCommands: ["ls", "fastfetch"],
      };
    }
    throw new Error(`Unexpected request: ${type}`);
  };
  let workerResets = 0;
  runtime.client.resetWorker = () => {
    workerResets += 1;
  };

  const first = await runtime.run("ls", "/home/user", "/home/user");
  const second = await runtime.run("fastfetch", "/home/user", "/home/user");

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(filesystemReads, 2);
  assert.equal(requests.filter((entry) => entry.type === "run").length, 2);
  assert.equal(requests[0].payload.captureChanges, false);
  assert.equal(requests[1].payload.captureChanges, false);
  assert.equal(workerResets, 0);
});

test("reuses package mount snapshots until a system change is applied", async () => {
  let treeReads = 0;
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {
      ensureReady: async () => {},
      mkdir: async () => {},
      readText: async () => "edgeterm-package-state-v2\n",
      writeText: async () => {},
      flush: async () => {},
      readTree: async (path) => {
        treeReads += 1;
        return path === "/home/user" ? [] : [{ path: "state", data: "ready" }];
      },
      writeFiles: async () => {},
      removeTree: async () => {},
    },
    assetUrl: (value) => value,
  });

  await runtime.readRuntimeFilesystem("/home/user");
  const readsAfterFirstSnapshot = treeReads;
  await runtime.readRuntimeFilesystem("/home/user");
  assert.equal(treeReads, readsAfterFirstSnapshot + 1);

  await runtime.applySystemChanges([{ path: "/var", changes: [{ path: "lib/dpkg/status", data: "changed" }] }]);
  await runtime.readRuntimeFilesystem("/home/user");
  assert.ok(treeReads > readsAfterFirstSnapshot + 2);
});

test("recovers missing dpkg status before hydrating a dormant session", async () => {
  const files = new Map([
    ["/var/lib/dpkg/status", ""],
    ["/usr/local/share/edgeterm/commands/git.json", JSON.stringify({
      schema: "edgeterm.package-commands.v1",
      package: "git",
      version: "2.55.0-1edgeterm3",
      commands: ["git"],
    })],
  ]);
  let flushes = 0;
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {
      ensureReady: async () => {},
      mkdir: async () => {},
      readText: async (path) => {
        if (!files.has(path)) throw new Error("missing");
        return files.get(path);
      },
      writeText: async (path, value) => files.set(path, value),
      readTree: async (path) => path === "/usr/local/share/edgeterm/commands"
        ? [{ path: "git.json", data: files.get("/usr/local/share/edgeterm/commands/git.json") }]
        : [],
      removeTree: async () => {},
      flush: async () => { flushes += 1; },
    },
    assetUrl: (value) => value,
    fetchImpl: async () => ({
      ok: true,
      text: async () => `Package: git
Version: 2.55.0-1edgeterm4
Architecture: wasm32-wasix
Filename: current/git.deb
SHA256: abc
`,
    }),
  });

  runtime.loadPackageIndex = async () => {
    const indexText = await (await runtime.fetch()).text();
    const { parseDebianPackageIndex } = await import("../../frontend/src/external-shell/repository.js");
    return { indexText, packages: parseDebianPackageIndex(indexText) };
  };

  const recovered = await runtime.ensureInstalledPackageState("/home/user");

  assert.equal(recovered, true);
  assert.deepEqual(
    parseInstalledPackageVersions(files.get("/var/lib/dpkg/status")),
    new Map([["git", "2.55.0-1edgeterm3"]]),
  );
  assert.equal(runtime.packageStateChecked, true);
  assert.match(files.get("/var/lib/dpkg/info/git.list"), /\/usr\/local\/bin\/git/);
  assert.ok(flushes > 0);
  assert.equal(await runtime.ensureInstalledPackageState("/home/user"), false);
});

test("repairs missing dpkg file lists even when an older recovery marker exists", async () => {
  const files = new Map([
    ["/var/lib/dpkg/status", `Package: git\nStatus: install ok installed\nVersion: 2.55.0-1edgeterm4\nArchitecture: wasm32-wasix\n\nPackage: libgit-support\nStatus: install ok installed\nVersion: 1.0\nArchitecture: wasm32-wasix\n\n`],
    ["/var/lib/dpkg/.edgeterm-manifest-recovery-v1", "1\n"],
    ["/usr/local/share/edgeterm/commands/git.json", JSON.stringify({
      schema: "edgeterm.package-commands.v1",
      package: "git",
      version: "2.55.0-1edgeterm4",
      commands: ["git"],
    })],
  ]);
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {
      ensureReady: async () => {},
      mkdir: async () => {},
      readText: async (path) => {
        if (!files.has(path)) throw new Error("missing");
        return files.get(path);
      },
      writeText: async (path, value) => files.set(path, value),
      readTree: async (path) => {
        if (path === "/usr/local/share/edgeterm/commands") {
          return [{ path: "git.json", data: files.get("/usr/local/share/edgeterm/commands/git.json") }];
        }
        if (path === "/var/lib/dpkg/info") return [];
        return [];
      },
      flush: async () => {},
    },
    assetUrl: (value) => value,
  });

  assert.equal(await runtime.ensureInstalledPackageState("/home/user"), true);
  assert.match(files.get("/var/lib/dpkg/info/git.list"), /\/usr\/local\/bin\/git/);
  assert.equal(files.get("/var/lib/dpkg/info/libgit-support.list"), "");
});

test("restores large installed package state from verified package archives", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  const calls = [];
  runtime.readRuntimeFilesystem = async (_root, options) => {
    calls.push({ ...options });
    if (calls.length === 1) {
      const error = new Error(
        "Unable to load package state from /usr/local: The project exceeds the Node runtime file or size limit.",
      );
      error.code = "external_shell_package_state_read_failed";
      throw error;
    }
    return { files: [], systemMounts: [] };
  };
  runtime.stageAptRepository = async (_root, command, options) => {
    assert.equal(command, "apt update");
    assert.equal(options.includeInstalledPayload, true);
    runtime.runtimePackageArchivePaths = [
      "/home/user/apt-repository/coreutils_9.7-1edgeterm1_wasm32-wasix.deb",
    ];
  };

  const result = await runtime.readRuntimeFilesystemWithArchiveFallback("/home/user", {
    includePackageRepository: false,
    omitInstalledPayload: false,
  });

  assert.deepEqual(result, { files: [], systemMounts: [] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    includePackageRepository: true,
    omitInstalledPayload: true,
  });
});

test("reuses installed package archives without reading the expanded payload", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.runtimePackageArchivePaths = [
    "/home/user/apt-repository/coreutils_9.7-1edgeterm1_wasm32-wasix.deb",
  ];
  let options = null;
  runtime.readRuntimeFilesystem = async (_root, value) => {
    options = value;
    return { files: [], systemMounts: [] };
  };

  await runtime.readRuntimeFilesystemWithArchiveFallback("/home/user", {
    includePackageRepository: false,
    omitInstalledPayload: false,
  });

  assert.deepEqual(options, {
    includePackageRepository: true,
    omitInstalledPayload: true,
  });
});

test("hydrates only the installed package that provides the requested command", async () => {
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {
      readTree: async (path) => {
        assert.equal(path, "/usr/local/share/edgeterm/commands");
        return [{
          path: "pkgconf.json",
          text: JSON.stringify({
            package: "pkgconf",
            commands: ["pkgconf", "pkg-config"],
          }),
        }];
      },
    },
    assetUrl: (value) => value,
  });

  assert.deepEqual(await runtime.installedPackagesForCommand("pkgconf --version"), ["pkgconf"]);
  assert.deepEqual(await runtime.installedPackagesForCommand("unrelated --version"), []);
});

test("restores installed command overrides from persisted base64 metadata", async () => {
  const metadata = JSON.stringify({
    schema: "edgeterm.package-commands.v1",
    package: "curl",
    commands: ["curl"],
  });
  let ready = false;
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {
      ensureReady: async () => {
        ready = true;
      },
      readTree: async () => {
        assert.equal(ready, true);
        return [{
        path: "curl.json",
        encoding: "base64",
        data: Buffer.from(metadata).toString("base64"),
        }];
      },
    },
    assetUrl: (value) => value,
  });

  assert.equal(runtime.shouldHandle("curl --version"), false);
  await runtime.refreshInstalledCommands();
  assert.equal(runtime.shouldHandle("curl --version"), true);
});

test("uses targeted package archives before reading expanded package state", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  const calls = [];
  runtime.readRuntimeFilesystem = async (_root, options) => {
    calls.push({ ...options });
    return { files: [], systemMounts: [] };
  };
  runtime.stageInstalledCommandArchives = async (_root, command) => {
    assert.equal(command, "pkgconf --version");
    runtime.runtimePackageArchivePaths = [
      "/home/user/apt-repository/pkgconf_3.0.5-1edgeterm1_wasm32-wasix.deb",
    ];
    return true;
  };
  runtime.stageAptRepository = async () => {
    throw new Error("The full installed package set must not be staged");
  };

  const result = await runtime.readRuntimeFilesystemWithArchiveFallback("/home/user", {
    includePackageRepository: false,
    omitInstalledPayload: false,
    command: "pkgconf --version",
  });

  assert.deepEqual(result, { files: [], systemMounts: [] });
  assert.deepEqual(calls[0], {
    includePackageRepository: true,
    omitInstalledPayload: true,
    command: "pkgconf --version",
  });
});

test("stages a verified reinstall archive for a targeted package command", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.installedPackagesForCommand = async () => ["pkgconf"];
  let stagedCommand = "";
  runtime.stageAptRepository = async (_root, command) => {
    stagedCommand = command;
    runtime.stagedAptArchivePaths = [
      "/home/user/apt-repository/pkgconf_3.0.5-1edgeterm1_wasm32-wasix.deb",
    ];
  };

  assert.equal(await runtime.stageInstalledCommandArchives("/home/user", "pkgconf --version"), true);
  assert.equal(stagedCommand, "apt reinstall pkgconf");
  assert.deepEqual(runtime.runtimePackageArchivePaths, [
    "/home/user/apt-repository/pkgconf_3.0.5-1edgeterm1_wasm32-wasix.deb",
  ]);
  assert.deepEqual(runtime.stagedAptArchivePaths, []);
});

test("keeps explicit interactive warmup separate from one-shot commands", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.prepare = async () => runtime.status();
  let filesystemReads = 0;
  runtime.readRuntimeFilesystem = async () => {
    filesystemReads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { files: [], systemMounts: [] };
  };
  runtime.stageAptRepository = async () => {
    runtime.runtimePackageArchivePaths = [];
  };
  let sessionStarts = 0;
  runtime.client.request = async (type) => {
    if (type === "interactive-start") {
      sessionStarts += 1;
      return {
        sessionId: "shared-warm-session",
        cwd: "/home/user",
        installedCommands: ["fastfetch"],
      };
    }
    if (type === "run") {
      return {
        exitCode: 0,
        cwd: "/home/user",
        changedFiles: 0,
        changes: [],
        systemChanges: [],
        installedCommands: ["fastfetch"],
      };
    }
    if (type === "interactive-add-package-payload") {
      return { installedCommands: ["fastfetch"] };
    }
    throw new Error(`Unexpected request: ${type}`);
  };

  const background = runtime.warmup("/home/user", "/home/user");
  const command = runtime.run("fastfetch", "/home/user", "/home/user");
  const [, result] = await Promise.all([background, command]);

  assert.equal(result.exitCode, 0);
  assert.equal(filesystemReads, 2);
  assert.equal(sessionStarts, 1);
});

test("starts APT transaction sessions without hydrating every installed package", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.prepare = async () => runtime.status();
  let filesystemOptions = null;
  runtime.readRuntimeFilesystemWithArchiveFallback = async (_root, options) => {
    filesystemOptions = options;
    return { files: [], systemMounts: [] };
  };
  const requestTypes = [];
  runtime.client.request = async (type) => {
    requestTypes.push(type);
    if (type === "interactive-start") {
      return {
        sessionId: "apt-transaction-session",
        cwd: "/home/user",
        installedCommands: [],
      };
    }
    if (type === "interactive-add-package-payload") {
      return { installedCommands: [] };
    }
    throw new Error(`Unexpected request: ${type}`);
  };

  await runtime.warmup("/home/user", "/home/user", { omitInstalledPayload: true });

  assert.deepEqual(filesystemOptions, {
    includePackageRepository: false,
    omitInstalledPayload: true,
  });
  assert.deepEqual(requestTypes, [
    "interactive-start",
    "interactive-add-package-payload",
  ]);
});

test("runs non-interactive APT commands from package metadata mounts", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.prepare = async () => runtime.status();
  runtime.stopDormantSession = async () => {};
  runtime.stageAptRepository = async () => {
    runtime.stagedAptArchivePaths = [];
  };
  let filesystemOptions = null;
  runtime.readRuntimeFilesystemWithArchiveFallback = async (_root, options) => {
    filesystemOptions = options;
    return { files: [], systemMounts: [] };
  };
  runtime.applyChanges = async () => {};
  runtime.applySystemChanges = async () => {};
  runtime.client.request = async (type) => {
    assert.equal(type, "run");
    return {
      exitCode: 0,
      cwd: "/home/user",
      changedFiles: 0,
      changes: [],
      systemChanges: [],
      installedCommands: [],
    };
  };

  const result = await runtime.run("apt update", "/home/user", "/home/user");

  assert.equal(result.exitCode, 0);
  assert.deepEqual(filesystemOptions, {
    includePackageRepository: true,
    omitInstalledPayload: true,
    command: "apt update",
  });
});

test("forwards input to a foreground command in the dormant session", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.foreground = true;
  runtime.state.sessionId = "foreground-session";
  let request = null;
  runtime.client.request = async (type, payload) => {
    request = { type, payload };
    return { accepted: true };
  };

  assert.equal(await runtime.writeInput("y\n"), true);
  assert.deepEqual(request, {
    type: "interactive-write",
    payload: {
      sessionId: "foreground-session",
      data: "y\n",
    },
  });
});

test("routes common Unix commands to the external shell", () => {
  assert.equal(isExternalShellCommand("ls -la"), true);
  assert.equal(isExternalShellCommand("printf 'b\\na\\n' | sort | head -1"), true);
  assert.equal(isExternalShellCommand("mkdir -p demo && touch demo/file.txt"), true);
  assert.equal(isExternalShellCommand("FOO=bar sh -c 'echo $FOO'"), true);
  assert.equal(isExternalShellCommand("alias ll='ls -la'"), true);
  assert.equal(isExternalShellCommand("history"), true);
  assert.equal(isExternalShellCommand("clear"), true);
  assert.equal(isExternalShellCommand("base64 /etc/os-release"), true);
  assert.equal(isExternalShellCommand("ps"), true);
  assert.equal(isExternalShellCommand("timeout 1 sleep 0.1"), true);
  assert.equal(isExternalShellCommand("nproc"), true);
  assert.equal(isExternalShellCommand("chgrp users file.txt"), true);
  assert.equal(isExternalShellCommand("free"), true);
  assert.equal(isExternalShellCommand("df -P"), true);
  assert.equal(isExternalShellCommand("hostname"), true);
  assert.equal(isExternalShellCommand("stty size"), true);
  assert.equal(isExternalShellCommand("uptime"), true);
  assert.equal(isExternalShellCommand("apt update"), true);
  assert.equal(isExternalShellCommand("dpkg-query -W edgeterm-smoke"), true);
});

test("keeps host-integrated runtimes on the Python shell", () => {
  assert.equal(isExternalShellCommand("python -c 'print(42)'"), false);
  assert.equal(isExternalShellCommand("npm run build"), false);
  assert.equal(isExternalShellCommand("php -S 127.0.0.1:8000"), false);
  assert.equal(isExternalShellCommand("edgeserve static ."), false);
  assert.equal(isExternalShellCommand("curl https://example.com"), false);
  assert.equal(isExternalShellCommand("wget https://example.com/file"), false);
  assert.equal(isExternalShellCommand("zip archive.zip file.txt"), false);
});

test("detects host-integrated commands inside shell expressions", () => {
  assert.equal(isExternalShellCommand("echo $(python -c 'print(42)')"), false);
  assert.equal(isExternalShellCommand("printf x | python -c 'import sys; print(sys.stdin.read())'"), false);
  assert.equal(isExternalShellCommand("echo `node --version`"), false);
});

test("leaves empty input and the shell exit command to the fallback shell", () => {
  assert.equal(isExternalShellCommand(""), false);
  assert.equal(isExternalShellCommand("exit"), false);
});

test("recognizes interactive BusyBox shell entry commands", () => {
  assert.equal(isExternalShellSessionEntry("busybox ash"), true);
  assert.equal(isExternalShellSessionEntry("busybox sh -i"), true);
  assert.equal(isExternalShellSessionEntry("ash"), true);
  assert.equal(isExternalShellSessionEntry("sh -i"), true);
  assert.equal(isExternalShellSessionEntry("busybox ash -c 'pwd'"), false);
  assert.equal(isExternalShellSessionEntry("sh script.sh"), false);
});

test("loads the workspace package repository only when a command needs package payloads", () => {
  assert.equal(needsWorkspacePackageRepository("apt --version"), false);
  assert.equal(needsWorkspacePackageRepository("apt list"), false);
  assert.equal(needsWorkspacePackageRepository("apt search shell"), false);
  assert.equal(needsWorkspacePackageRepository("apt update"), true);
  assert.equal(needsWorkspacePackageRepository("apt install bash"), true);
  assert.equal(needsWorkspacePackageRepository("apt-get upgrade"), true);
  assert.equal(needsWorkspacePackageRepository("busybox ash"), false);
  assert.equal(needsWorkspacePackageRepository("bash --version"), false);
});

test("keeps host runtimes available during an interactive ash session", () => {
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {},
    assetUrl: (value) => value,
  });
  runtime.state.interactive = true;
  runtime.state.sessionId = "test-session";

  assert.equal(runtime.shouldHandle("ls -la"), true);
  assert.equal(runtime.shouldHandle("busybox --version"), true);
  assert.equal(runtime.shouldHandle("python3 -c 'print(42)'"), false);
  assert.equal(runtime.shouldHandle("node --version"), false);
  assert.equal(runtime.shouldHandle("npm run build"), false);
  assert.equal(runtime.shouldHandle("php -v"), false);
  assert.equal(runtime.shouldHandle("exit"), true);

  runtime.state.installedCommands = ["sqlite3", "curl"];
  assert.equal(runtime.shouldHandle("sqlite3 --version"), true);
  assert.equal(runtime.shouldHandle("curl --version"), true);
  assert.equal(runtime.shouldHandle("python3 -c 'print(42)'"), false);
});

test("routes installed commands before host fallbacks in a dormant session", () => {
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {},
    assetUrl: (value) => value,
  });
  runtime.state.interactiveDormant = true;
  runtime.state.installedCommands = ["file", "curl", "sqlite3", "wget", "zip"];

  assert.equal(runtime.shouldHandle("file --version"), true);
  assert.equal(runtime.shouldHandle("curl --version"), true);
  assert.equal(runtime.shouldHandle("sqlite3 --version"), true);
  assert.equal(runtime.shouldHandle("wget --version"), true);
  assert.equal(runtime.shouldHandle("zip -v"), true);
  assert.equal(runtime.shouldHandle("python3 -c 'print(42)'"), false);
  assert.equal(runtime.mayRouteInstalledCommand("file --version"), true);
  assert.equal(runtime.mayRouteInstalledCommand("curl --version"), true);
  assert.equal(runtime.mayRouteInstalledCommand("python3 --version"), false);
  assert.equal(runtime.mayRouteInstalledCommand("printf '6*7\\n' | bc; file result.txt"), true);
});

test("runs installed non-BusyBox commands through the package runtime", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  runtime.state.installedCommands = ["git"];
  runtime.sessionHydratedCommands.add("git");
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    return { exitCode: 0, cwd: "/home/user", changedFiles: 0 };
  };

  const result = await runtime.runDormantCommand("git --version", "/home/user");

  assert.equal(result.exitCode, 0);
  assert.equal(requests[0].type, "interactive-command-run");
  assert.equal(requests[0].payload.source, "git --version");
});

test("runs APT queries outside the persistent ash process", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    return { exitCode: 0, cwd: "/home/user", changedFiles: 0 };
  };

  const result = await runtime.runDormantCommand("apt list", "/home/user");

  assert.equal(result.exitCode, 0);
  assert.equal(requests[0].type, "interactive-command-run");
  assert.equal(requests[0].payload.source, "apt list");
});

test("simulates and confirms an interactive APT transaction before execution", async () => {
  const confirmations = [];
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {},
    assetUrl: (value) => value,
    confirm: async (request) => {
      confirmations.push(request);
      return true;
    },
  });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  runtime.stagedAptArchivePaths = ["/home/user/apt-repository/git.deb"];
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    return { exitCode: 0, cwd: "/home/user", changedFiles: 0 };
  };
  runtime.mountInteractivePackageRepository = async () => {};
  runtime.persistStagedPackagePayloads = async () => {};

  const result = await runtime.runDormantCommand("apt upgrade", "/home/user", {
    repositoryStaged: true,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(confirmations.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].payload.source,
    "apt --simulate install /home/user/apt-repository/git.deb",
  );
  assert.equal(
    requests[1].payload.source,
    "apt --assume-yes install /home/user/apt-repository/git.deb",
  );
});

test("does not run an interactive APT transaction when confirmation is rejected", async () => {
  const output = [];
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {},
    assetUrl: (value) => value,
    output: (_stream, value) => output.push(value),
    confirm: async () => false,
  });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    return { exitCode: 0, cwd: "/home/user", changedFiles: 0 };
  };
  runtime.mountInteractivePackageRepository = async () => {};

  const result = await runtime.runDormantCommand("apt remove git", "/home/user", {
    repositoryStaged: true,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.aborted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.source, "apt --simulate remove git");
  assert.deepEqual(output, ["Abort.\n"]);
});

test("rebuilds a stale dormant session and retries once", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "stale-session";
  let attempts = 0;
  let warmups = 0;
  runtime.runOnce = async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("The BusyBox ash session is no longer running.");
      error.code = "external_shell_session_missing";
      throw error;
    }
    return { exitCode: 0, cwd: "/home/user" };
  };
  runtime.warmup = async () => {
    warmups += 1;
    runtime.state.interactiveDormant = true;
    runtime.state.sessionId = "replacement-session";
  };

  const result = await runtime.run("git --version", "/home/user", "/home/user");

  assert.equal(result.exitCode, 0);
  assert.equal(attempts, 2);
  assert.equal(warmups, 1);
  assert.equal(runtime.state.sessionId, "replacement-session");
});

test("rebuilds a dormant session after its WASM filesystem handle expires", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "stale-session";
  let attempts = 0;
  runtime.runOnce = async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("missing runtime entry"), {
      name: "ErrnoError",
      errno: 10,
    });
    return { exitCode: 0, cwd: "/home/user" };
  };
  runtime.warmup = async () => {
    runtime.state.interactiveDormant = true;
    runtime.state.sessionId = "replacement-session";
  };

  const result = await runtime.run("cd /home/user", "/home/user", "/home/user");

  assert.equal(result.exitCode, 0);
  assert.equal(attempts, 2);
  assert.equal(runtime.state.sessionId, "replacement-session");
});

test("runs standalone BusyBox applets through the buffered runtime", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  runtime.state.installedCommands = ["ls"];
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    return { exitCode: 0, cwd: "/home/user", changedFiles: 0 };
  };

  await runtime.runDormantCommand("ls /", "/home/user");

  assert.equal(requests[0].type, "interactive-run-buffered");
});

test("keeps stateful shell builtins in the persistent ash process", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    return { exitCode: 0, cwd: "/", changedFiles: 0 };
  };

  await runtime.runDormantCommand("cd /", "/home/user");

  assert.equal(requests[0].type, "interactive-shell-command-run");
});

test("routes compound stateful commands through a dormant ash session", () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";

  assert.equal(
    runtime.shouldHandle("cd /home/user; printf 'alpha\\nbeta\\n' > 'space name.txt'; wc -l 'space name.txt'"),
    true,
  );
});

test("lets the persistent shell resolve aliases and unavailable commands", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    return { exitCode: 127, cwd: "/", changedFiles: 0 };
  };

  const result = await runtime.runDormantCommand("mount", "/home/user");

  assert.equal(result.exitCode, 127);
  assert.equal(requests[0].type, "interactive-shell-command-run");
});

test("interrupt terminates a foreground worker that does not stop after Ctrl-C", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.foreground = true;
  runtime.state.sessionId = "test-session";
  runtime.writeInput = async () => true;
  let cancellations = 0;
  runtime.client.cancel = () => {
    cancellations += 1;
  };

  assert.equal(await runtime.interrupt(), true);
  assert.equal(cancellations, 1);
  assert.equal(runtime.state.foreground, false);
  assert.equal(runtime.state.phase, "cancelled");
});

test("hydrates an installed command payload once per dormant session", async () => {
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {
      readBinary: async () => ({ encoding: "base64", data: "AA==" }),
    },
    assetUrl: (value) => value,
  });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  runtime.state.installedCommands = ["git"];
  let stages = 0;
  runtime.stageInstalledCommandArchives = async () => {
    stages += 1;
    runtime.runtimePackageArchivePaths = [
      "/home/user/apt-repository/current/git_2.55.0_wasm32-wasix.deb",
    ];
    return true;
  };
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    return { installedCommands: ["git"] };
  };

  await runtime.ensureInstalledRuntimeAvailable("git --version", "/home/user", "/home/user");
  await runtime.ensureInstalledRuntimeAvailable("git status", "/home/user", "/home/user");

  assert.equal(stages, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "interactive-add-package-archives");
  assert.deepEqual(requests[0].payload.archivePaths, [
    "/home/user/apt-repository/current/git_2.55.0_wasm32-wasix.deb",
  ]);
});

test("hydrates every installed command referenced by a compound command", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.installedCommands = ["git", "sd"];

  assert.deepEqual(
    runtime.installedRuntimeCommands("git --version; sd --version; echo ready"),
    ["git", "sd"],
  );
});

test("hydrates expanded installed files before falling back to package extraction", async () => {
  const runtime = new EdgeTermExternalShellRuntime({ fs: {}, assetUrl: (value) => value });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  runtime.state.installedCommands = ["git"];
  runtime.installedPackagesForCommand = async () => ["git"];
  runtime.readInstalledPackagePayloads = async () => [{
    path: "/usr",
    files: [{ path: "local/lib/edgeterm/runtime/git.webc", encoding: "base64", data: "AA==" }],
  }];
  runtime.stageInstalledCommandArchives = async () => {
    throw new Error("archive fallback should not run");
  };
  const requests = [];
  runtime.client.request = async (type, payload) => {
    requests.push({ type, payload });
    return { installedCommands: ["git"] };
  };

  await runtime.ensureInstalledRuntimeAvailable("git --version", "/home/user", "/home/user");

  assert.equal(requests[0].type, "interactive-add-package-payload");
  assert.equal(runtime.sessionHydratedCommands.has("git"), true);
});

test("short-circuits an APT install that is already at the candidate version", async () => {
  const status = `Package: git
Status: install ok installed
Version: 2.55.0-1edgeterm4
`;
  const packages = `Package: git
Version: 2.55.0-1edgeterm4
Filename: current/git.deb
SHA256: abc
`;
  const output = [];
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {
      readText: async (path) => path.endsWith("/Packages") ? packages : status,
    },
    assetUrl: (value) => value,
    output: (stream, value, options) => output.push({ stream, value, options }),
  });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  runtime.state.cwd = "/home/user";
  runtime.prepare = async () => {};

  const result = await runtime.run("apt install git", "/home/user", "/home/user");

  assert.equal(result.exitCode, 0);
  assert.equal(result.noop, true);
  assert.match(output.map((entry) => entry.value).join(""), /git is already the newest version/);
  assert.ok(output.every((entry) => entry.options.streaming));
});

test("keeps the caller working directory for an APT no-op", async () => {
  const status = `Package: git
Status: install ok installed
Version: 2.55.0-1edgeterm4
`;
  const packages = `Package: git
Version: 2.55.0-1edgeterm4
Filename: current/git.deb
SHA256: abc
`;
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {
      readText: async (path) => path.endsWith("/Packages") ? packages : status,
    },
    assetUrl: (value) => value,
  });
  runtime.state.interactiveDormant = true;
  runtime.state.sessionId = "test-session";
  runtime.state.cwd = "/home/user";
  runtime.prepare = async () => {};

  const result = await runtime.run("apt install git", "/", "/home/user");

  assert.equal(result.exitCode, 0);
  assert.equal(result.cwd, "/");
});

test("routes compound commands through a dormant POSIX session", () => {
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {},
    assetUrl: (value) => value,
  });
  runtime.state.interactiveDormant = true;
  runtime.state.installedCommands = ["bc", "file"];

  assert.equal(runtime.shouldHandle("printf '6*7\\n' | bc; file result.txt"), true);
});

test("routes installed overrides with shell builtins before session warmup", () => {
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {},
    assetUrl: (value) => value,
  });
  runtime.state.installedCommands = ["bc", "file"];

  assert.equal(runtime.shouldHandle("printf '6*7\\n' | bc; file result.txt"), true);
  assert.equal(runtime.shouldHandle("python3 script.py | file -"), false);
});

test("routes package override names inside a compound POSIX command", () => {
  const runtime = new EdgeTermExternalShellRuntime({
    fs: {},
    assetUrl: (value) => value,
  });

  assert.equal(runtime.shouldHandle("printf ready > result.txt; file result.txt"), true);
  assert.equal(runtime.shouldHandle("file result.txt"), false);
});
