import assert from "node:assert/strict";
import test from "node:test";

import { createPosixProfile } from "../../frontend/static/posix-profile.js";

test("creates a truthful POSIX compatibility profile", () => {
  const profile = createPosixProfile({
    workspaceRoot: "/home/alice",
    username: "alice",
    command: "ash -c pwd",
    uptimeSeconds: 12.5,
    hardwareConcurrency: 4,
  });

  assert.equal(profile.profile, "edgeterm-posix-v2");
  assert.equal(profile.env.HOME, "/home/alice");
  assert.equal(profile.env.USER, "alice");
  assert.equal(profile.env.XDG_CONFIG_HOME, "/home/alice/.config");
  assert.equal(profile.env.XDG_DATA_HOME, "/home/alice/.local/share");
  assert.equal(profile.env._ZO_DATA_DIR, "/home/alice/.local/share/zoxide");
  assert.equal(profile.env.SHELL, "/bin/ash");
  assert.equal(profile.env.TERM, "xterm-256color");
  assert.equal(profile.env.EDGETERM_TTY, "line");
  assert.equal(profile.env.COLUMNS, "120");
  assert.equal(profile.env.PATH, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  assert.match(profile.files["/etc/passwd"], /alice:x:1000:1000:EdgeTerm User:\/home\/alice:\/bin\/ash/);
  assert.match(profile.files["/etc/os-release"], /EdgeTerm POSIX Environment/);
  assert.match(profile.files["/proc/version"], /POSIX compatibility layer 2/);
  assert.match(profile.files["/etc/profile"], /getconf\(\)/);
  assert.match(profile.files["/etc/profile"], /stty\(\)/);
  assert.match(profile.files["/etc/profile"], /getent\(\)/);
  assert.match(profile.files["/etc/profile"], /locale\(\)/);
  assert.match(profile.files["/etc/profile"], /mount\(\)/);
  assert.equal(profile.files["/proc/sys/kernel/random/boot_id"], "00000000-0000-4000-8000-000000000001\n");
  assert.equal(profile.files["/sys/fs/cgroup/memory.max"], "268435456\n");
  assert.equal(profile.files["/proc/cpuinfo"].match(/^processor/gm)?.length, 4);
  assert.equal(profile.files["/proc/uptime"], "12.50 12.50\n");
  assert.ok(profile.directories.includes("/tmp"));
  assert.ok(profile.directories.includes("/var/tmp"));
  assert.ok(profile.directories.includes("/usr/local/bin"));
  assert.ok(profile.directories.includes("/sys/class/tty/tty"));
  assert.equal(profile.files["/proc/sys/net/ipv4/ip_forward"], "0\n");
  assert.equal(profile.files["/sys/class/tty/tty/active"], "tty\n");
});

test("maps runtime and browser storage limits into compatibility files", () => {
  const profile = createPosixProfile({
    memoryBytes: 512 * 1024 * 1024,
    storageQuotaBytes: 1024 * 1024 * 1024,
    storageUsageBytes: 256 * 1024 * 1024,
    ttyColumns: 132,
    ttyRows: 48,
  });

  assert.equal(profile.env.COLUMNS, "132");
  assert.equal(profile.env.LINES, "48");
  assert.equal(profile.files["/sys/fs/cgroup/memory.max"], "536870912\n");
  assert.match(profile.files["/etc/profile"], /rows 48; columns 132/);
  assert.match(profile.files["/etc/profile"], /1048576 262144 786432 25 \/home\/user/);
});

test("sanitizes the compatibility account name", () => {
  const profile = createPosixProfile({ username: "bad name/$", workspaceRoot: "/home/user" });
  assert.equal(profile.env.USER, "badname");
  assert.match(profile.files["/etc/passwd"], /^badname:x:1000:1000:/m);
});
