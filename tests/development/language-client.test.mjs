import assert from "node:assert/strict";
import test from "node:test";
import { EdgeTermLanguageClient } from "../../frontend/src/development/language-client.js";

class FakeLanguageWorker extends EventTarget {
  terminated = false;

  postMessage(message) {
    if (!Object.hasOwn(message, "id")) return;
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent("message", {
        data: { jsonrpc: "2.0", id: message.id, result: { capabilities: {} } },
      }));
    });
  }

  terminate() {
    this.terminated = true;
  }
}

test("shares one worker startup across concurrent document opens", async () => {
  let workerCount = 0;
  const client = new EdgeTermLanguageClient({
    workerUrl: "language-service-worker.js",
    workerFactory: () => {
      workerCount += 1;
      return new FakeLanguageWorker();
    },
  });

  await Promise.all([
    client.open({ uri: "file:///home/user/one.js", languageId: "javascript", text: "const one = 1;" }),
    client.open({ uri: "file:///home/user/two.js", languageId: "javascript", text: "const two = 2;" }),
  ]);

  assert.equal(workerCount, 1);
  assert.equal(client.status().ready, true);
});
