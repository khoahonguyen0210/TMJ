import { test } from "node:test";
import assert from "node:assert/strict";
import { splitLines } from "../web/serial.js";

test("lines cut into 20-byte Bluetooth chunks are joined again", () => {
  const text = "S,48210,OK,0.03,0.98,0.07\n# ROLLWATCH fw=3 imu=ok link=ble\n";
  const chunks = text.match(/.{1,20}/gs);
  let buffer = "";
  const got = [];
  for (const c of chunks) {
    const r = splitLines(buffer, c);
    buffer = r.rest;
    got.push(...r.lines);
  }
  assert.deepEqual(got, ["S,48210,OK,0.03,0.98,0.07", "# ROLLWATCH fw=3 imu=ok link=ble"]);
  assert.equal(buffer, "");
});

test("splitLines handles \\r\\n and keeps a partial line", () => {
  assert.deepEqual(splitLines("", "a\r\nb\nc"), { lines: ["a", "b"], rest: "c" });
  assert.deepEqual(splitLines("c", "d\n\n"), { lines: ["cd"], rest: "" });
});
