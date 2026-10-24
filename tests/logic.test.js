import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../web/config.js";
import {
  parseLine, nextAlarm, isDisconnected, updateLog, ackLog, stats,
  tiltDeg, facing, nextPosture, POSTURE_START, escalationLevel, START,
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
    { type: "S", t: 48210, state: "FLIPPED", z: -0.97, x: null, motion: null });
  assert.deepEqual(parseLine("S,0,OK,1.00\r\n"),
    { type: "S", t: 0, state: "OK", z: 1, x: null, motion: null });
});

test("fw=2 line with x and motion parses", () => {
  assert.deepEqual(parseLine("S,48210,OK,0.02,-0.98,0.07"),
    { type: "S", t: 48210, state: "OK", z: 0.02, x: -0.98, motion: 0.07 });
});

test("status and error lines parse", () => {
  assert.deepEqual(parseLine("# ROLLWATCH fw=1 imu=ok"),
    { type: "STATUS", text: "ROLLWATCH fw=1 imu=ok", fw: 1 });
  assert.equal(parseLine("# ROLLWATCH fw=2 imu=ok").fw, 2);
  assert.deepEqual(parseLine("# ERR imu not found"),
    { type: "ERR", text: "imu not found" });
});

test("junk returns null", () => {
  for (const junk of [
    "", "hello", "S", "S,1,OK", "S,1,OK,0.5,extra", "X,1,OK,0.5",
    "S,abc,OK,0.5", "S,-5,OK,0.5", "S,1.5,OK,0.5", "S,1,SIDE,0.5",
    "S,1,ok,0.5", "S,1,OK,", "S,1,OK,nan", "S,,OK,0.5", null, undefined, 42,
    "S,1,OK,0.5,0.1", "S,1,OK,0.5,,0.1", "S,1,OK,0.5,0.1,", "S,1,OK,0.5,abc,0.1",
    "S,1,OK,0.5,0.1,-0.2", "S,1,OK,0.5,0.1,0.2,9",
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

const side = (x, motion, state = "OK") => ({ type: "S", t: 0, state, z: 0, x, motion });

function posture(steps, from = POSTURE_START) {
  let p = from;
  for (const [line, now] of steps) p = nextPosture(p, line, now, CONFIG);
  return p;
}

const EARLY_STEPS = [[side(0.9, 0), 0], [side(0.9, 0), 3000], [side(0.9, 0.2), 3200], [side(0.9, 0.2), 5200]];

test("on its side for less than 3 s stays OK", () => {
  assert.equal(posture([[side(0.95, 0), 0], [side(0.95, 0), 2999]]).posture, "OK");
});

test("on its side for 3 s → SIDE (either side)", () => {
  const p = posture([[side(0.95, 0), 0], [side(-0.9, 0), 3000]]);
  assert.equal(p.posture, "SIDE");
  assert.equal(p.event, "SIDE");
});

test("leaving the side restarts the 3 s", () => {
  const p = posture([[side(0.95, 0), 0], [side(0.2, 0), 2000], [side(0.95, 0), 2500], [side(0.95, 0), 5000]]);
  assert.equal(p.posture, "OK");
});

test("SIDE + moving for 2 s → EARLY, once", () => {
  const p = posture(EARLY_STEPS);
  assert.equal(p.posture, "EARLY");
  assert.equal(p.event, "EARLY");
  const later = posture([[side(0.9, 0.01), 6000]], p);
  assert.equal(later.posture, "EARLY");
  assert.equal(later.event, null);
  assert.equal(posture([[side(0.1, 0), 7000]], later).posture, "OK");
});

test("moving before SIDE is confirmed does not count toward EARLY", () => {
  const p = posture([[side(0.9, 0.3), 0], [side(0.9, 0.3), 3000], [side(0.9, 0.3), 4999]]);
  assert.equal(p.posture, "SIDE");
});

test("still on its side never gives EARLY", () => {
  const p = posture([[side(0.9, 0.01), 0], [side(0.9, 0.01), 3000], [side(0.9, 0.04), 60000]]);
  assert.equal(p.posture, "SIDE");
});

test("short wiggle on its side resets the 2 s", () => {
  const p = posture([[side(0.9, 0), 0], [side(0.9, 0), 3000], [side(0.9, 0.2), 3200],
    [side(0.9, 0), 4000], [side(0.9, 0.2), 4500], [side(0.9, 0.2), 6000]]);
  assert.equal(p.posture, "SIDE");
});

test("FLIPPED always wins over SIDE and EARLY", () => {
  const p = nextPosture(posture(EARLY_STEPS), side(0.9, 0.2, "FLIPPED"), 6000, CONFIG);
  assert.equal(p.posture, "FLIPPED");
  assert.equal(p.event, "FLIPPED");
});

test("fw=1 lines (no x) never give SIDE", () => {
  assert.equal(posture([[side(null, null), 0], [side(null, null), 10000]]).posture, "OK");
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

test("unanswered alarm escalates at 30 s and 60 s", () => {
  assert.equal(escalationLevel(null, null, 5000, CONFIG), 0);
  assert.equal(escalationLevel(1000, null, 1000, CONFIG), 1);
  assert.equal(escalationLevel(1000, null, 30999, CONFIG), 1);
  assert.equal(escalationLevel(1000, null, 31000, CONFIG), 2);
  assert.equal(escalationLevel(1000, null, 61000, CONFIG), 3);
});

test("Silence resets escalation; a re-alarm starts again at level 1", () => {
  assert.equal(escalationLevel(1000, 40000, 50000, CONFIG), 0);
  const a = [[FLIPPED, 0], [{ type: "ACK" }, 1000], [FLIPPED, 31000]]
    .reduce((p, [input, now]) => nextAlarm(p, input, now, CONFIG), START);
  assert.equal(a.since, 31000);
  assert.equal(escalationLevel(a.since, a.ackAt, 32000, CONFIG), 1);
  assert.equal(escalationLevel(a.since, a.ackAt, 61000, CONFIG), 2);
});

test("since marks when the sound started and clears on OK", () => {
  const red = nextAlarm(START, FLIPPED, 5000, CONFIG);
  assert.equal(red.since, 5000);
  assert.equal(nextAlarm(red, { type: "TICK" }, 9000, CONFIG).since, 5000);
  assert.equal(nextAlarm(red, OK, 9000, CONFIG).since, null);
  assert.equal(nextAlarm(START, { type: "DISCONNECT" }, 7000, CONFIG).since, 7000);
});
