import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../web/config.js";
import {
  newSession, addSample, syncEvents, ackFlip, endSession, addEscalation,
  timeline, flipsPerHour, flipStats, responseStats, sideStats, nightSummaryData,
  eventsToCSV, demoNight, addActivity, activityByMinute, activityStats, compareNights,
} from "../web/analytics.js";

const S = 1000;
const ev = (type, start, end, acked = null) =>
  ({ type, start: start * S, end: end === null ? null : end * S, acked_at: acked === null ? null : acked * S });

const NIGHT = {
  id: "t", start: 0, end: 3 * 3600 * S, fw: 2, simulated: false, samples: [],
  events: [
    ev("SIDE", 600, 900),
    ev("EARLY", 840, 900),
    ev("FLIPPED", 900, 960, 910),
    ev("DISCONNECTED", 3700, 3710),
    ev("SIDE", 5000, 5100),
    ev("FLIPPED", 7300, 7420, 7330),
    ev("FLIPPED", 7500, 7530),
    { type: "ESCALATED", level: 2, start: 7530 * S, end: 7530 * S, acked_at: null },
    ev("EARLY", 9000, 9050),
  ],
};

test("addSample keeps one sample per second", () => {
  const line = { state: "OK", z: 0.98, x: 0.01, motion: 0.02 };
  let s = newSession(0);
  for (const t of [0, 200, 400, 999, 1000, 1500, 2100]) s = addSample(s, line, t);
  assert.deepEqual(s.samples.map((x) => x[0]), [0, 1000, 2100]);
  assert.deepEqual(s.samples[0], [0, "OK", 0.98, 0.01, 0.02]);
});

test("syncEvents opens and closes events by type", () => {
  let s = newSession(0);
  s = syncEvents(s, { SIDE: true }, 1000);
  s = syncEvents(s, { SIDE: true, EARLY: true }, 2000);
  s = syncEvents(s, { SIDE: true, EARLY: true }, 2500);
  s = syncEvents(s, { FLIPPED: true }, 3000);
  assert.deepEqual(s.events, [
    { type: "SIDE", start: 1000, end: 3000, acked_at: null },
    { type: "EARLY", start: 2000, end: 3000, acked_at: null },
    { type: "FLIPPED", start: 3000, end: null, acked_at: null },
  ]);
});

test("syncEvents with no change returns the same session", () => {
  const s = syncEvents(newSession(0), { SIDE: true }, 1000);
  assert.equal(syncEvents(s, { SIDE: true }, 2000), s);
});

test("ackFlip stamps only the first Silence on the open flip", () => {
  let s = syncEvents(newSession(0), { FLIPPED: true }, 1000);
  s = ackFlip(s, 4000, "phone");
  s = ackFlip(s, 9000);
  assert.equal(s.events[0].acked_at, 4000);
  assert.equal(s.events[0].acked_by, "phone");
});

test("addEscalation logs a moment with its level", () => {
  const s = addEscalation(newSession(0), 3, 61000);
  assert.deepEqual(s.events, [{ type: "ESCALATED", level: 3, start: 61000, end: 61000, acked_at: null }]);
});

test("endSession closes open events and the night", () => {
  let s = syncEvents(newSession(0), { FLIPPED: true }, 1000);
  s = endSession(s, 5000);
  assert.equal(s.end, 5000);
  assert.equal(s.events[0].end, 5000);
});

test("flipStats", () => {
  assert.deepEqual(flipStats(NIGHT), { count: 3, longest_s: 120, total_s: 210 });
  assert.deepEqual(flipStats({ ...NIGHT, events: [] }), { count: 0, longest_s: 0, total_s: 0 });
});

test("responseStats uses only silenced flips", () => {
  assert.deepEqual(responseStats(NIGHT), { count: 2, avg_s: 20, max_s: 30, escalations: 1 });
  assert.deepEqual(responseStats({ ...NIGHT, events: [] }), { count: 0, avg_s: null, max_s: null, escalations: 0 });
});

test("sideStats counts early warnings followed by a flip within 60 s", () => {
  assert.deepEqual(sideStats(NIGHT, CONFIG),
    { count: 2, total_s: 400, early_warnings: 2, early_then_flipped: 1 });
});

test("flipsPerHour buckets by hour since start", () => {
  assert.deepEqual(flipsPerHour(NIGHT).map((h) => [h.hour, h.count]), [[0, 1], [1, 0], [2, 2]]);
  assert.equal(flipsPerHour(NIGHT)[2].from, 7200 * S);
});

test("timeline bands cover the night with the right priority", () => {
  const bands = timeline(NIGHT).map((b) => [b.from / S, b.to / S, b.kind]);
  assert.deepEqual(bands, [
    [0, 600, "OK"], [600, 900, "SIDE"], [900, 960, "FLIPPED"], [960, 3700, "OK"],
    [3700, 3710, "DISCONNECTED"], [3710, 5000, "OK"], [5000, 5100, "SIDE"], [5100, 7300, "OK"],
    [7300, 7420, "FLIPPED"], [7420, 7500, "OK"], [7500, 7530, "FLIPPED"], [7530, 10800, "OK"],
  ]);
});

test("timeline: flip beats an overlapping side band", () => {
  const night = { ...NIGHT, events: [ev("SIDE", 0, 100), ev("FLIPPED", 50, 80)] };
  assert.deepEqual(timeline(night).slice(0, 3).map((b) => [b.from / S, b.to / S, b.kind]),
    [[0, 50, "SIDE"], [50, 80, "FLIPPED"], [80, 100, "SIDE"]]);
});

test("open events count up to the night's end", () => {
  const night = { ...NIGHT, end: 100 * S, events: [ev("FLIPPED", 40, null)] };
  assert.equal(flipStats(night).total_s, 60);
  assert.deepEqual(timeline(night).map((b) => b.kind), ["OK", "FLIPPED"]);
});

test("nightSummaryData collects everything", () => {
  const d = nightSummaryData(NIGHT, CONFIG);
  assert.equal(d.duration_s, 10800);
  assert.equal(d.disconnects, 1);
  assert.equal(d.simulated, false);
  assert.deepEqual(d.flips, flipStats(NIGHT));
  assert.deepEqual(d.side, sideStats(NIGHT, CONFIG));
});

test("eventsToCSV", () => {
  const night = { ...NIGHT, events: [{ ...ev("FLIPPED", 0, 12.5, 3), acked_by: "phone" }, ev("SIDE", 60, null)] };
  assert.equal(eventsToCSV(night),
    "type,start,end,duration_s,silenced_at,silenced_from,level\n" +
    "FLIPPED,1970-01-01T00:00:00.000Z,1970-01-01T00:00:12.500Z,12.5,1970-01-01T00:00:03.000Z,phone,\n" +
    "SIDE,1970-01-01T00:01:00.000Z,,,,,\n");
});

test("demo night is always marked simulated", () => {
  const d = demoNight(Date.now());
  assert.equal(d.simulated, true);
  assert.equal(flipStats(d).count, 3);
  assert.equal(sideStats(d, CONFIG).early_then_flipped, 2);
});

test("activityByMinute takes the most common label each minute", () => {
  let s = newSession(0);
  for (const [t, l] of [[0, "STILL"], [2000, "STILL"], [4000, "RESTLESS"], [61000, "CARRIED"]]) s = addActivity(s, l, t);
  assert.deepEqual(activityByMinute(s).map((m) => [m.minute, m.label]), [[0, "STILL"], [1, "CARRIED"]]);
});

test("activityStats counts minutes and restless minutes before each flip", () => {
  let s = { ...newSession(0), events: [ev("FLIPPED", 15 * 60, 16 * 60)] };
  for (let m = 0; m < 15; m++) s = addActivity(s, m >= 3 && m < 8 ? "RESTLESS" : "STILL", m * 60 * S);
  const a = activityStats(s);
  assert.equal(a.still_min, 10);
  assert.equal(a.restless_min, 5);
  assert.equal(a.carried_min, 0);
  assert.deepEqual(a.restless_before_flips, [{ flip_start: 15 * 60 * S, restless_min: 3 }]);
  assert.equal(activityStats(newSession(0)), null);
});

test("compareNights orders nights and shows changes", () => {
  const n1 = { ...NIGHT, id: "a", start: 0 };
  const n2 = { ...NIGHT, id: "b", start: 86400 * S, end: 86400 * S + 3600 * S,
    events: [ev("FLIPPED", 86400 + 10, 86400 + 70, 86400 + 15)] };
  const rows = compareNights([n2, n1], CONFIG);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
  assert.equal(rows[0].change, null);
  assert.equal(rows[1].flips, 1);
  assert.deepEqual(rows[1].change, { flips: -2, longest_flip_s: -60, avg_response_s: -15, restless_min: null });
});
