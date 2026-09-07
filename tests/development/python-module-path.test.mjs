import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("python module execution starts imports from the current project", async () => {
  const source = await readFile(new URL("../../rootfs/bin/bigbox/python.py", import.meta.url), "utf8");
  const moduleRunner = source.slice(source.indexOf("async def _run_module"), source.indexOf("\ndef _consume_value"));
  assert.match(moduleRunner, /_pythonpath_for_script\(os\.getcwd\(\), old_path\)/);
  assert.doesNotMatch(moduleRunner, /sys\.path\[:\]\s*=\s*clean_path/);
});
