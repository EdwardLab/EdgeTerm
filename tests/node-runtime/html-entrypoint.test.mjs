import assert from "node:assert/strict";
import test from "node:test";

import {
  htmlModuleEntrypoint,
  replaceHtmlModuleEntrypoint,
} from "../../frontend/src/node/html-entrypoint.js";

test("reads quoted and unquoted module entrypoints in either attribute order", () => {
  assert.equal(
    htmlModuleEntrypoint('<script type="module" src="/src/main.ts"></script>'),
    "src/main.ts",
  );
  assert.equal(
    htmlModuleEntrypoint("<script src=/src.js type=module></script>"),
    "src.js",
  );
});

test("replaces only the first external module script", () => {
  const html = '<script src="legacy.js"></script><script src=/src.js type=module></script>';
  assert.equal(
    replaceHtmlModuleEntrypoint(html, '<script type="module" src="./assets/app.js"></script>'),
    '<script src="legacy.js"></script><script type="module" src="./assets/app.js"></script>',
  );
});

test("ignores inline module scripts and non-module scripts", () => {
  const html = '<script type="module">console.log("inline")</script><script src="app.js"></script>';
  assert.equal(htmlModuleEntrypoint(html), "");
  assert.equal(replaceHtmlModuleEntrypoint(html, "replacement"), html);
});
