import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  createEdgeTermBridgeServer,
  EDGETERM_BRIDGE_PROTOCOL,
} from "../frontend/src/bridge/server.js";
import { normalizeAppTarget } from "../frontend/src/bridge/runtime-target.js";
import { EdgeTermBridgeClient } from "../packages/bridge/index.js";

assert.equal(normalizeAppTarget("flask", "app.py"), "app:app");
assert.equal(
  normalizeAppTarget(
    "flask",
    "/home/user/project/src/server.py",
    "/home/user/project",
  ),
  "src.server:app",
);
assert.equal(normalizeAppTarget("fastapi", "main.py"), "main:app");
assert.equal(normalizeAppTarget("flask", "web:create_app"), "web:create_app");
assert.equal(normalizeAppTarget("django", "manage.py"), "siteapp.wsgi:application");
assert.equal(
  normalizeAppTarget("django", "config/wsgi.py"),
  "config.wsgi:application",
);

const hostOrigin = "http://127.0.0.1:3100";
const embedOrigin = "http://127.0.0.1:3200";
const parentWindow = {};
const listeners = new Set();
const targetWindow = {
  parent: parentWindow,
  addEventListener(type, listener) {
    if (type === "message") listeners.add(listener);
  },
  removeEventListener(type, listener) {
    if (type === "message") listeners.delete(listener);
  },
};

const dispatchToEmbed = (data, origin, ports = []) => {
  for (const listener of listeners) {
    listener({
      data,
      origin,
      ports,
      source: parentWindow,
    });
  }
};

const server = createEdgeTermBridgeServer({
  enabled: true,
  allowedOrigins: [hostOrigin],
  runtimeVersion: "test-runtime",
  targetWindow,
  getCapabilities: () => ({ methods: ["test.echo", "test.recoverable"] }),
  invoke: async (method, params, context) => {
    assert.equal(context.origin, hostOrigin);
    assert.equal(typeof params.request_id, "string");
    assert.equal(typeof params.idempotency_key, "string");
    if (method === "test.recoverable") {
      const error = new Error("Read the current file and retry.");
      error.code = "bridge_file_changed";
      throw error;
    }
    if (method !== "test.echo") {
      const error = new Error("Unknown method");
      error.code = "method_not_found";
      throw error;
    }
    return { echoed: params.value };
  },
});
assert.equal(server.start(), true);

const iframe = {
  contentWindow: {
    postMessage(data, _targetOrigin, ports) {
      dispatchToEmbed(data, hostOrigin, ports);
    },
  },
};
const client = new EdgeTermBridgeClient({ iframe, targetOrigin: embedOrigin, timeoutMs: 2_000 });
const connected = await client.connect();
assert.equal(connected.runtime_version, "test-runtime");
assert.equal(connected.capabilities.methods[0], "test.echo");
assert.match(client.sessionId, /^[a-z0-9]+-/);

client.setHostRequestHandler(async (method, params) => {
  if (method === "backup.oauth.token") {
    return { access_token: `token-for-${params.connection_id}` };
  }
  const error = new Error("Host capability unavailable");
  error.code = "bridge_host_method_unavailable";
  throw error;
});
const hostResponse = await server.requestHost("backup.oauth.token", {
  connection_id: "42",
});
assert.deepEqual(hostResponse, { access_token: "token-for-42" });
await assert.rejects(
  server.requestHost("backup.oauth.missing", {}),
  (error) => error.code === "bridge_host_method_unavailable",
);

const response = await client.request("test.echo", { value: "EdgeTerm Bridge" });
assert.deepEqual(response, { echoed: "EdgeTerm Bridge" });

await assert.rejects(
  client.request("test.recoverable", {}),
  (error) =>
    error.code === "bridge_file_changed" &&
    error.recoverable === true &&
    error.requestId.length > 0 &&
    error.idempotencyKey.length > 0 &&
    error.details?.status === "failed",
);

await assert.rejects(
  client.request("test.missing", {}),
  (error) => error.code === "method_not_found",
);

assert.throws(
  () => new EdgeTermBridgeClient({ iframe, targetOrigin: "file:///tmp/edgeterm.html" }),
  (error) => error.code === "bridge_target_origin_invalid",
);

const unavailableClient = new EdgeTermBridgeClient({
  iframe: { contentWindow: { postMessage() {} } },
  targetOrigin: embedOrigin,
  timeoutMs: 1_000,
});
await assert.rejects(
  unavailableClient.connect(),
  (error) => error.code === "bridge_connect_timeout",
);
assert.equal(unavailableClient.pending.size, 0);
unavailableClient.close();

const rejectedChannel = new MessageChannel();
let rejectedMessage = null;
rejectedChannel.port1.onmessage = (event) => {
  rejectedMessage = event.data;
};
dispatchToEmbed(
  {
    type: "edgeterm.bridge.connect",
    protocol: EDGETERM_BRIDGE_PROTOCOL,
    nonce: "thisnonceislongenough",
  },
  "https://untrusted.example",
  [rejectedChannel.port2],
);
await delay(50);
assert.equal(rejectedMessage, null);

rejectedChannel.port1.close();
rejectedChannel.port2.close();
client.close();
server.dispose();

console.log("EdgeTerm Bridge protocol tests passed.");
