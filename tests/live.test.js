import { test } from "node:test";
import assert from "node:assert/strict";
import { randomPeerId, parentLink, liveErrorText } from "../web/live.js";

test("peer ids are random and hard to guess", () => {
  assert.match(randomPeerId(() => 0.5), /^rollwatch-live-[a-z0-9]{14}$/);
  assert.notEqual(randomPeerId(), randomPeerId());
});

test("parent link carries the peer id", () => {
  assert.equal(parentLink("https://u.github.io/rollwatch/web/parent.html", "rollwatch-live-abc"),
    "https://u.github.io/rollwatch/web/parent.html?peer=rollwatch-live-abc");
});

test("live view errors are readable", () => {
  assert.match(liveErrorText({ type: "peer-unavailable" }), /not live/);
  assert.match(liveErrorText({ name: "NotAllowedError" }), /blocked/);
  assert.match(liveErrorText({ type: "network" }), /internet/);
});
