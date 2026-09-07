import assert from "node:assert/strict";
import test from "node:test";

import { TerminalLineStream } from "../../frontend/src/terminal/line-stream.js";

test("emits complete terminal lines and keeps partial text", () => {
  const stream = new TerminalLineStream();
  assert.deepEqual(stream.push("stdout", "one\ntw"), [
    { stream: "stdout", text: "one", carriageReturn: false },
  ]);
  assert.equal(stream.peek("stdout"), "tw");
  assert.deepEqual(stream.push("stdout", "o\n"), [
    { stream: "stdout", text: "two", carriageReturn: false },
  ]);
  assert.equal(stream.peek("stdout"), "");
});

test("keeps split CRLF as one line ending", () => {
  const stream = new TerminalLineStream();
  assert.deepEqual(stream.push("stdout", "ready\r"), []);
  assert.deepEqual(stream.push("stdout", "\nnext\n"), [
    { stream: "stdout", text: "ready", carriageReturn: false },
    { stream: "stdout", text: "next", carriageReturn: false },
  ]);
});

test("preserves carriage-return progress updates", () => {
  const stream = new TerminalLineStream();
  assert.deepEqual(stream.push("stderr", "10%\r20%\r"), [
    { stream: "stderr", text: "10%", carriageReturn: true },
  ]);
  assert.deepEqual(stream.flush("stderr"), [
    { stream: "stderr", text: "20%", carriageReturn: true },
  ]);
});

test("flushes a prompt without inventing a newline in its text", () => {
  const stream = new TerminalLineStream();
  assert.deepEqual(stream.push("stdout", "Continue? [Y/n]"), []);
  assert.deepEqual(stream.flush("stdout"), [
    { stream: "stdout", text: "Continue? [Y/n]", carriageReturn: false },
  ]);
});
