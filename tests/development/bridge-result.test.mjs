import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeResult } from "../../frontend/src/bridge/result.js";

const context = { requestId: "test", idempotencyKey: "test", workspaceGeneration: "workspace:1", startedAt: "2026-09-07T00:00:00Z" };
test("preview responses preserve the HTTP status alongside the Bridge status", () => {
  const response = createBridgeResult("preview.request", { status: 404, body: "missing" }, context);
  assert.equal(response.status, "completed");
  assert.equal(response.http_status, 404);
  assert.equal(response.body, "missing");
});
test("a failed terminal command is not reported as a completed operation", () => {
  const response = createBridgeResult("terminal.run", { exit_code: 100, stderr: "Repository unavailable" }, context);
  assert.equal(response.status, "failed");
  assert.equal(response.exit_code, 100);
  assert.equal(response.error_code, "command_failed");
});
test("cancelled terminal commands keep their cancellation state", () => {
  assert.equal(createBridgeResult("terminal.run", { exit_code: 130, cancelled: true }, context).status, "cancelled");
});
