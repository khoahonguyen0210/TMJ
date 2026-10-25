import { test } from "node:test";
import assert from "node:assert/strict";
import { pushFor, ntfyBody, validTopic, randomTopic, ackTopicOf, isAck } from "../web/notify.js";

test("topics must be hard to guess", () => {
  assert.equal(validTopic("rollwatch-k8x2m9q4tz"), true);
  assert.equal(validTopic("short"), false);
  assert.equal(validTopic("has spaces in it ok"), false);
  assert.equal(validTopic("ümlaut-topic-name"), false);
  assert.equal(validTopic(undefined), false);
  const t = randomTopic(() => 0.5);
  assert.equal(validTopic(t), true);
  assert.match(t, /^rollwatch-[a-z0-9]{12}$/);
  assert.equal(ackTopicOf("rollwatch-abc"), "rollwatch-abc-ack");
});

test("alarm pushes are high or urgent and carry the Acknowledge button", () => {
  const flip = pushFor("FLIPPED", { at: 0 });
  assert.equal(flip.priority, 4);
  assert.equal(flip.ack, true);
  assert.equal(flip.title, "Baby rolled onto stomach");

  assert.equal(pushFor("ESCALATED", { level: 2 }).title, "Still on stomach – no response 30 s");
  assert.equal(pushFor("ESCALATED", { level: 2, offline: true }).title, "Monitor offline – no response 30 s");
  assert.equal(pushFor("ESCALATED", { level: 3 }).title, "NO RESPONSE – 60 s");
  assert.equal(pushFor("ESCALATED", { level: 3 }).priority, 5);

  const off = pushFor("DISCONNECTED", { at: 0 });
  assert.equal(off.title, "Monitor offline");
  assert.equal(off.priority, 4);
  assert.equal(off.ack, true);
});

test("info pushes are low, summary is default and labeled AI-written", () => {
  assert.equal(pushFor("ACK", { source: "phone", after_s: 12.4 }).title, "Acknowledged from phone after 12 s");
  assert.equal(pushFor("ACK", { source: "laptop", after_s: 75 }).title, "Acknowledged from laptop after 1 min 15 s");
  assert.equal(pushFor("BACK_OK", { at: 0, after_s: 80 }).priority, 2);
  assert.equal(pushFor("RECONNECTED", { at: 0 }).title, "Monitor reconnected");
  const sum = pushFor("SUMMARY", { text: "Quiet night." });
  assert.equal(sum.priority, 3);
  assert.match(sum.title, /AI-written/);
  assert.match(sum.message, /^Quiet night\./);
});

test("side and early warning never push", () => {
  assert.equal(pushFor("SIDE", {}), null);
  assert.equal(pushFor("EARLY", {}), null);
});

test("simulated nights are marked in the title", () => {
  assert.equal(pushFor("FLIPPED", { at: 0, simulated: true }).title, "[Simulator] Baby rolled onto stomach");
});

test("ntfy body: JSON publish with an http Acknowledge action to the ack topic", () => {
  const body = ntfyBody("rollwatch-k8x2m9q4tz", pushFor("FLIPPED", { at: 0 }));
  assert.equal(body.topic, "rollwatch-k8x2m9q4tz");
  assert.equal(body.priority, 4);
  assert.deepEqual(body.actions, [{
    action: "http", label: "Acknowledge", url: "https://ntfy.sh/rollwatch-k8x2m9q4tz-ack",
    method: "POST", body: "ack", clear: true,
  }]);
  assert.equal("actions" in ntfyBody("rollwatch-k8x2m9q4tz", pushFor("RECONNECTED", { at: 0 })), false);
});

test("isAck reads ntfy SSE messages", () => {
  assert.equal(isAck(JSON.stringify({ event: "message", message: "ack" })), true);
  assert.equal(isAck(JSON.stringify({ event: "message", message: " ACK\n" })), true);
  assert.equal(isAck(JSON.stringify({ event: "keepalive" })), false);
  assert.equal(isAck(JSON.stringify({ event: "message", message: "hello" })), false);
  assert.equal(isAck("not json"), false);
});

test("an alarm push can carry a link that opens the live view", () => {
  const push = { ...pushFor("FLIPPED", { at: 0 }), click: "https://example.org/web/parent.html?peer=x" };
  assert.equal(ntfyBody("rollwatch-k8x2m9q4tz", push).click, "https://example.org/web/parent.html?peer=x");
  assert.equal("click" in ntfyBody("rollwatch-k8x2m9q4tz", pushFor("FLIPPED", { at: 0 })), false);
});
