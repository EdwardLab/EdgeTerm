import assert from "node:assert/strict";
import test from "node:test";
import { EdgeTermProcessHost } from "../../frontend/src/development/process-host.js";

test("tracks output, completion, resize, input, and signals", async () => {
  let state = "running";
  const calls = [];
  const host = new EdgeTermProcessHost({
    workspaceGeneration: () => "g1",
    driver: {
      async start(spec) { calls.push(["start", spec]); return { execution_id: "driver-1", status: "running" }; },
      async status() { return { execution: { status: state, exit_code: state === "completed" ? 0 : null } }; },
      async output() { return { stdout: "hello\n", stderr: "", status: state }; },
      async input(spec) { calls.push(["input", spec.data]); return { accepted: true }; },
      async resize(spec) { calls.push(["resize", spec.columns, spec.rows]); },
      async signal(spec) { calls.push(["signal", spec.signal]); state = "cancelled"; return { cancelled: true }; },
    },
  });
  const process = await host.start({ command: "echo hello", cwd: "/home/user" });
  assert.equal(process.workspace_generation, "g1");
  assert.equal((await host.output(process.id)).stdout, "hello\n");
  await host.input(process.id, "yes\n");
  assert.equal((await host.resize(process.id, { columns: 120, rows: 40 })).dimensions.columns, 120);
  assert.equal((await host.signal(process.id, "SIGINT")).process.state, "cancelled");
  assert.deepEqual(calls.slice(1).map((entry) => entry[0]), ["input", "resize", "signal"]);
});

test("wait returns the real exit code", async () => {
  let polls = 0;
  const host = new EdgeTermProcessHost({ driver: {
    async start() { return { execution_id: "job", status: "running" }; },
    async status() { polls += 1; return { execution: { status: polls > 1 ? "completed" : "running", exit_code: 7 } }; },
    async output() { return {}; },
  } });
  const process = await host.start({ command: "false" });
  const result = await host.wait(process.id, { interval_ms: 25 });
  assert.equal(result.exit_code, 7);
});

test("reports unavailable terminal resize instead of pretending it succeeded", async () => {
  const host = new EdgeTermProcessHost({ driver: {
    async start() { return { execution_id: "job", status: "running" }; },
    async status() { return { execution: { status: "running" } }; },
    async output() { return {}; },
  } });
  const process = await host.start({ command: "watch task" });
  await assert.rejects(
    host.resize(process.id, { columns: 120, rows: 40 }),
    (error) => error.code === "process_resize_unavailable",
  );
});
