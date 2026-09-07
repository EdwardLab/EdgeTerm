import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = path.join(
  repositoryRoot,
  "runtime-packages/external-shell/edgeterm-posix-apt.webc",
);
const fixtureRepository = path.join(repositoryRoot, "tests/fixtures/apt-repository");
const dpkgData = path.join(repositoryRoot, "ports/apt-wasix/.cache/runtime-package/dpkg-data");
const sandbox = await mkdtemp(path.join(os.tmpdir(), "edgeterm-apt-interactive-"));

async function createRuntimeFilesystem() {
  const directories = [
    "home/user/apt-repository",
    "etc/apt/apt.conf.d",
    "etc/apt/preferences.d",
    "etc/apt/sources.list.d",
    "etc/dpkg/dpkg.cfg.d",
    "usr/share",
    "var/cache/apt/archives/partial",
    "var/lib/apt/lists/partial",
    "var/lib/dpkg/info",
    "var/lib/dpkg/parts",
    "var/lib/dpkg/triggers",
    "var/lib/dpkg/updates",
    "var/log/apt",
    "tmp",
  ];
  await Promise.all(directories.map((directory) => mkdir(path.join(sandbox, directory), {
    recursive: true,
  })));
  await cp(dpkgData, path.join(sandbox, "usr/share"), { recursive: true });
  for (const file of [
    "Packages",
    "edgeterm-apt-test_1.0.0_all.deb",
    "fastfetch_2.66.0-1edgeterm1_wasm32-wasix.deb",
  ]) {
    await copyFile(
      path.join(fixtureRepository, file),
      path.join(sandbox, "home/user/apt-repository", file),
    );
  }
  const emptyFiles = [
    "var/lib/dpkg/available",
    "var/lib/dpkg/diversions",
    "var/lib/dpkg/diversions-old",
    "var/lib/dpkg/status",
    "var/lib/dpkg/statoverride",
    "var/lib/dpkg/statoverride-old",
    "var/lib/dpkg/triggers/File",
    "var/lib/dpkg/triggers/Unincorp",
  ];
  await Promise.all(emptyFiles.map((file) => writeFile(path.join(sandbox, file), "")));
  await writeFile(path.join(sandbox, "var/lib/dpkg/info/format"), "1\n");
  await writeFile(
    path.join(sandbox, "etc/apt/apt.conf"),
    [
      'Dpkg::Use-Pty "false";',
      'Dpkg::Progress-Fancy "false";',
      'APT::Architecture "wasm32-wasix";',
      'APT::Architectures { "wasm32-wasix"; "all"; };',
      'APT::Sandbox::User "root";',
      'Acquire::Languages "none";',
      'Acquire::AllowInsecureRepositories "true";',
      'APT::Get::AllowUnauthenticated "true";',
      'Dir::Bin::Methods "/bin";',
      'Dir::Bin::dpkg "/bin/dpkg";',
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(sandbox, "etc/apt/sources.list"),
    "deb [trusted=yes] file:/home/user/apt-repository ./\n",
  );
}

function waitForOutput(predicate, description, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate(output)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${description}.\n${output.slice(-4000)}`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

await createRuntimeFilesystem();
const volumes = ["home", "etc", "usr", "var", "tmp"].flatMap((directory) => [
  "--volume",
  `${path.join(sandbox, directory)}:/${directory}`,
]);
const child = spawn(
  "wasmer",
  [
    "run",
    runtime,
    "-e",
    "ash",
    ...volumes,
    "--env",
    "PATH=/bin:/usr/bin:/usr/local/bin",
    "--",
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
let output = "";
let chunks = 0;
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output += chunk.toString("utf8");
    chunks += 1;
  });
}

try {
  child.stdin.write("apt update\n");
  await waitForOutput(
    (value) => value.includes("All packages are up to date."),
    "APT repository update",
  );
  child.stdin.write("apt install -y edgeterm-apt-test\n");
  await waitForOutput(
    (value) => value.includes("Setting up edgeterm-apt-test (1.0.0)"),
    "test package installation",
  );
  const beforeUpgrade = output.length;
  child.stdin.write("apt upgrade\n");
  await waitForOutput(
    (value) => value.slice(beforeUpgrade).includes("Continue? [Y/n]"),
    "interactive confirmation prompt",
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  const waitingOutput = output.slice(beforeUpgrade);
  assert.equal(waitingOutput.includes("Abort."), false);
  assert.equal(child.exitCode, null);
  child.stdin.write("y\n");
  await waitForOutput(
    (value) => value.slice(beforeUpgrade).includes("Setting up edgeterm-apt-test (1.0.0)"),
    "confirmed package upgrade",
  );
  child.stdin.write("exit\n");
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0);
  assert.ok(chunks > 10, `Expected streamed output, received ${chunks} chunks.`);
  process.stdout.write(`Interactive APT upgrade passed with ${chunks} output chunks.\n`);
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(sandbox, { recursive: true, force: true });
}
