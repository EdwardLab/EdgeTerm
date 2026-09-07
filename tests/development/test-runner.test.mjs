import assert from "node:assert/strict";
import test from "node:test";
import { discoverTestSuites, EdgeTermTestController, parseTestOutput } from "../../frontend/src/development/test-runner.js";
import { EdgeTermComponentHost } from "../../frontend/src/development/component-host.js";

test("discovers Python, Django, npm, and PHP suites", () => {
  const suites = discoverTestSuites({
    "manage.py": "",
    "tests/test_api.py": "",
    "tests/UnitTest.php": "",
    "phpunit.xml": "",
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
  });
  assert.deepEqual(new Set(suites.map((entry) => entry.framework)), new Set(["pytest", "unittest", "django", "npm", "php"]));
});

test("parses test cases and failure locations", () => {
  const npm = parseTestOutput("npm", "✓ renders page\n× rejects bad input", 1);
  assert.equal(npm.passed, 1);
  assert.equal(npm.failed, 1);
  const python = parseTestOutput("pytest", "tests/test_api.py:12: AssertionError", 1);
  assert.equal(python.failures[0].location.line, 12);
});

test("uses the unittest summary when terminal capture omits individual cases", () => {
  const result = parseTestOutput("unittest", "Ran 3 tests in 0.001s\n\nOK", 0);
  assert.equal(result.total, 3);
  assert.equal(result.passed, 3);
  assert.equal(result.failed, 0);
});

test("records command output and duration for a completed run", async () => {
  const controller = new EdgeTermTestController({
    processHost: {
      start: async () => ({ id: "process-1" }),
      wait: async () => ({ exit_code: 0 }),
      output: async () => ({ stdout: "demo ... ok\n", stderr: "" }),
    },
  });
  const run = await controller.run({ id: "python.unittest", framework: "unittest", command: "python -m unittest" });
  assert.equal(run.result.status, "passed");
  assert.match(run.result.output, /demo \.\.\. ok/);
  assert.equal(Number.isInteger(run.result.duration_ms), true);
});

test("component host requires explicit HTTP approval", async () => {
  const host = new EdgeTermComponentHost();
  host.register("wasi:http/outgoing-handler", async (_operation, payload) => payload);
  await assert.rejects(host.invoke("wasi:http/outgoing-handler", "send", { url: "https://example.com" }), /separate approval/);
  assert.deepEqual(await host.invoke("wasi:http/outgoing-handler", "send", { url: "https://example.com" }, { approved: true }), { url: "https://example.com" });
});
