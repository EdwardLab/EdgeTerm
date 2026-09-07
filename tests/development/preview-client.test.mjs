import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { buildAppModeClientScript } from "../../frontend/src/preview/client-script.js";
import { serializeSiteDataMap, deserializeSiteDataMap } from "../../frontend/src/preview/site-data.js";

test("preview site data roundtrips deterministically", () => {
  const entries = serializeSiteDataMap(new Map([["b", "two"], ["a", "one"]]));
  assert.deepEqual(entries, [["a", "one"], ["b", "two"]]);
  assert.deepEqual(serializeSiteDataMap(deserializeSiteDataMap(entries)), entries);
});
test("generated preview client remains valid JavaScript with quoted site data", () => {
  const script = buildAppModeClientScript({ currentPath: "/test/", siteData: { cookies: new Map([["session", "quotes'\"\\\n"]]) } });
  assert.doesNotThrow(() => new vm.Script(script));
});
