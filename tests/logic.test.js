import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../web/config.js";
import {
  parseLine, nextAlarm, isDisconnected, updateLog, ackLog, stats, toCSV,
  tiltDeg, facing, START,
} from "../web/logic.js";

const FLIPPED = { type: "S", t: 1000, state: "FLIPPED", z: -0.97 };
const OK = { type: "S", t: 1000, state: "OK", z: 0.98 };

function run(steps, from = START) {
  let a = from;
  for (const [input, now] of steps) a = nextAlarm(a, input, now, CONFIG);
  return a;
}

test("valid S line parses", () => {
  assert.deepEqual(parseLine("S,48210,FLIPPED,-0.97"),
    { type: "S", t: 48210, state: "FLIPPED", z: -0.97 });
  assert.deepEqual(parseLine("S,0,OK,1.00\r\n"),
    { type: "S", t: 0, state: "OK", z: 1 });
});

test("status and error lines parse", () => {
  assert.deepEqual(parseLine("# ROLLWATCH fw=1 imu=ok"),
    { type: "STATUS", text: "ROLLWATCH fw=1 imu=ok" });
  assert.deepEqual(parseLine("# ERR imu not found"),
    { type: "ERR", text: "imu not found" });
});

test("junk returns null", () => {
  for (const junk of [
    "", "hello", "S", "S,1,OK", "S,1,OK,0.5,extra", "X,1,OK,0.5",
    "S,abc,OK,0.5", "S,-5,OK,0.5", "S,1.5,OK,0.5", "S,1,SIDE,0.5",
    "S,1,ok,0.5", "S,1,OK,", "S,1,OK,nan", "S,,OK,0.5", null, undefined, 42,
  ]) {
    assert.equal(parseLine(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});

test("starts WAITING, never OK before data", () => {
  assert.equal(START.screen, "WAITING");
  assert.equal(START.sound, false);
});

test("FLIPPED → red + sound", () => {
  const a = run([[OK, 0], [FLIPPED, 1000]]);
  assert.equal(a.screen, "RED");
  assert.equal(a.sound, true);
  assert.equal(a.event, "FLIPPED");
});

test("ACK → sound off, still red", () => {
  const a = run([[FLIPPED, 0], [{ type: "ACK" }, 500]]);
  assert.equal(a.screen, "RED");
  assert.equal(a.sound, false);
  assert.equal(a.event, "ACK");
});

test("still FLIPPED before 30 s after ACK → stays quiet", () => {
  const a = run([[FLIPPED, 0], [{ type: "ACK" }, 1000], [FLIPPED, 30999]]);
  assert.equal(a.screen, "RED");
  assert.equal(a.sound, false);
});

test("30 s after ACK, still FLIPPED → sound again", () => {
  const a = run([[FLIPPED, 0], [{ type: "ACK" }, 1000], [FLIPPED, 31000]]);
  assert.equal(a.screen, "RED");
  assert.equal(a.sound, true);
  assert.equal(a.event, "REALARM");
});

test("re-alarm can be ACKed again and re-alarms again", () => {
  const a = run([
    [FLIPPED, 0], [{ type: "ACK" }, 1000], [FLIPPED, 31000],
    [{ type: "ACK" }, 32000], [FLIPPED, 61000],
  ]);
  assert.equal(a.sound, false);
  assert.equal(run([[FLIPPED, 62000]], a).sound, true);
});

test("OK → green, sound off", () => {
  const a = run([[FLIPPED, 0], [OK, 5000]]);
  assert.equal(a.screen, "GREEN");
  assert.equal(a.sound, false);
  assert.equal(a.event, "OK");
});

test("OK after ACK clears the ACK (next flip alarms at once)", () => {
  const a = run([[FLIPPED, 0], [{ type: "ACK" }, 1000], [OK, 2000], [FLIPPED, 3000]]);
  assert.equal(a.screen, "RED");
  assert.equal(a.sound, true);
});

test("ACK while green does nothing", () => {
  const a = run([[OK, 0], [{ type: "ACK" }, 100]]);
  assert.equal(a.screen, "GREEN");
  assert.equal(a.sound, false);
  assert.equal(a.ackAt, null);
});

test("disconnect → POD DISCONNECTED + sound, never OK", () => {
  const a = run([[OK, 0], [{ type: "DISCONNECT" }, 2000]]);
  assert.equal(a.screen, "DISCONNECTED");
  assert.equal(a.sound, true);
  assert.equal(a.event, "DISCONNECTED");
  assert.equal(run([[{ type: "TICK" }, 3000], [{ type: "DISCONNECT" }, 4000]], a).screen,
    "DISCONNECTED");
});

test("disconnect can be ACKed and re-alarms after 30 s", () => {
  const a = run([[OK, 0], [{ type: "DISCONNECT" }, 2000], [{ type: "ACK" }, 3000]]);
  assert.equal(a.screen, "DISCONNECTED");
  assert.equal(a.sound, false);
  assert.equal(run([[{ type: "DISCONNECT" }, 32999]], a).sound, false);
  assert.equal(run([[{ type: "DISCONNECT" }, 33000]], a).sound, true);
});

test("data after disconnect recovers", () => {
  const off = run([[OK, 0], [{ type: "DISCONNECT" }, 2000]]);
  assert.equal(run([[OK, 5000]], off).screen, "GREEN");
  assert.equal(run([[OK, 5000]], off).sound, false);
  assert.equal(run([[FLIPPED, 5000]], off).screen, "RED");
  assert.equal(run([[FLIPPED, 5000]], off).sound, true);
});

test("no line for 2 s → disconnected", () => {
  assert.equal(isDisconnected(1000, 2999, CONFIG), false);
  assert.equal(isDisconnected(1000, 3000, CONFIG), true);
  assert.equal(isDisconnected(null, 0, CONFIG), true);
});

test("flip opens a log entry, OK closes it with duration", () => {
  let log = updateLog([], "OK", "FLIPPED", 10000);
  assert.deepEqual(log, [{ start: 10000, end: null, durationS: null, acked: false }]);

  log = updateLog(log, "FLIPPED", "FLIPPED", 11000);
  assert.equal(log.length, 1);

  log = updateLog(log, "FLIPPED", "OK", 22500);
  assert.deepEqual(log, [{ start: 10000, end: 22500, durationS: 12.5, acked: false }]);
});

test("first line FLIPPED opens an entry", () => {
  assert.equal(updateLog([], null, "FLIPPED", 0).length, 1);
});

test("OK with no flip does not touch the log", () => {
  const log = [];
  assert.equal(updateLog(log, "OK", "OK", 0), log);
  assert.equal(updateLog(log, null, "OK", 0), log);
});

test("updateLog does not change the old log", () => {
  const log = updateLog([], "OK", "FLIPPED", 0);
  updateLog(log, "FLIPPED", "OK", 5000);
  assert.equal(log[0].end, null);
});

test("ackLog marks only the open entry", () => {
  let log = updateLog([], "OK", "FLIPPED", 0);
  log = updateLog(log, "FLIPPED", "OK", 1000);
  log = updateLog(log, "OK", "FLIPPED", 2000);
  log = ackLog(log);
  assert.equal(log[0].acked, false);
  assert.equal(log[1].acked, true);
});

test("stats counts flips and total time flipped", () => {
  assert.deepEqual(stats([], 0), { count: 0, totalS: 0 });
  const log = [
    { start: 0, end: 10000, durationS: 10, acked: true },
    { start: 20000, end: null, durationS: null, acked: false },
  ];
  assert.deepEqual(stats(log, 25400), { count: 2, totalS: 15 });
});

test("toCSV writes header and rows", () => {
  const log = [
    { start: 0, end: 12500, durationS: 12.5, acked: true },
    { start: 60000, end: null, durationS: null, acked: false },
  ];
  assert.equal(toCSV(log),
    "start,end,duration_s,acknowledged\n" +
    "1970-01-01T00:00:00.000Z,1970-01-01T00:00:12.500Z,12.5,yes\n" +
    "1970-01-01T00:01:00.000Z,,,no\n");
  assert.equal(toCSV([]), "start,end,duration_s,acknowledged\n");
});

test("tiltDeg turns z into 0–180°", () => {
  assert.equal(tiltDeg(1), 0);
  assert.equal(tiltDeg(0), 90);
  assert.equal(tiltDeg(-1), 180);
  assert.equal(tiltDeg(1.08), 0);
  assert.equal(tiltDeg(-1.2), 180);
});

test("facing uses the firmware thresholds", () => {
  assert.equal(facing(0.98, CONFIG), "Face up");
  assert.equal(facing(0.7, CONFIG), "On its side");
  assert.equal(facing(0.1, CONFIG), "On its side");
  assert.equal(facing(-0.7, CONFIG), "On its side");
  assert.equal(facing(-0.95, CONFIG), "Face down");
});
