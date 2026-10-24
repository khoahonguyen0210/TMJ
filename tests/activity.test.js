import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../web/config.js";
import {
  featuresOf, addToWindow, fitScaler, scale, trainKnn, predict, baselinePredict,
  confusion, crossSessionEval, evalMarkdown, WINDOW_MS,
} from "../web/activity.js";

const line = (z, x, motion) => ({ type: "S", t: 0, state: "OK", z, x, motion });

test("featuresOf: mean z, mean x, mean motion, max motion, z range", () => {
  const f = featuresOf([line(1, 0, 0.01), line(0.8, 0.2, 0.03), line(0.9, 0.1, 0.02)]);
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  [0.9, 0.1, 0.02, 0.03, 0.2].forEach((v, i) => assert.ok(close(f[i], v), `feature ${i}: ${f[i]}`));
});

test("addToWindow closes a window after 2 s", () => {
  let win = null, out;
  for (let t = 0; t < WINDOW_MS; t += 200) ({ win, features: out } = addToWindow(win, line(1, 0, 0.01), t));
  assert.equal(out, null);
  ({ win, features: out } = addToWindow(win, line(1, 0, 0.01), WINDOW_MS));
  assert.equal(out.length, 5);
  assert.equal(win.lines.length, 1);
});

test("addToWindow drops a window with too few lines, and fw=1 lines", () => {
  let { win } = addToWindow(null, line(1, 0, 0), 0);
  ({ win } = addToWindow(win, line(1, 0, 0), 500));
  assert.equal(addToWindow(win, line(1, 0, 0), 2500).features, null);
  assert.deepEqual(addToWindow(win, line(1, null, null), 600), { win: null, features: null });
});

test("scaler uses mean and spread; a constant feature is left at 0", () => {
  const sc = fitScaler([[0, 5, 1, 1, 1], [2, 5, 3, 3, 3]]);
  assert.deepEqual(sc.mean, [1, 5, 2, 2, 2]);
  assert.deepEqual(scale([2, 5, 3, 3, 3], sc), [1, 0, 1, 1, 1]);
});

const STILL = (s) => ({ session: s, label: "STILL", f: [0.98, 0.0, 0.01, 0.02, 0.01] });
const RESTLESS = (s) => ({ session: s, label: "RESTLESS", f: [0.9, 0.1, 0.12, 0.3, 0.2] });
const CARRIED = (s) => ({ session: s, label: "CARRIED", f: [0.3, 0.4, 0.3, 0.8, 0.9] });
const wiggle = (w, k) => ({ ...w, f: w.f.map((v, i) => v + ((k * 7 + i * 3) % 5 - 2) * 0.004) });
const DATA = {
  windows: [1, 2].flatMap((s) => [STILL, RESTLESS, CARRIED].flatMap((mk) =>
    Array.from({ length: 6 }, (_, k) => wiggle(mk(s), k + s)))),
};

test("k-NN finds the right cluster", () => {
  const model = trainKnn(DATA.windows.filter((w) => w.session === 1));
  assert.equal(predict(model, [0.97, 0.01, 0.012, 0.025, 0.01]), "STILL");
  assert.equal(predict(model, [0.88, 0.12, 0.13, 0.31, 0.22]), "RESTLESS");
  assert.equal(predict(model, [0.32, 0.38, 0.29, 0.75, 0.85]), "CARRIED");
});

test("k-NN tie goes to the nearest point's label", () => {
  const model = trainKnn([
    { label: "STILL", f: [0, 0, 0, 0, 0] }, { label: "RESTLESS", f: [1, 1, 1, 1, 1] },
  ]);
  assert.equal(predict(model, [0.1, 0.1, 0.1, 0.1, 0.1], 2), "STILL");
});

test("baseline only knows still vs restless", () => {
  assert.equal(baselinePredict(STILL(1).f, CONFIG), "STILL");
  assert.equal(baselinePredict(RESTLESS(1).f, CONFIG), "RESTLESS");
  assert.equal(baselinePredict(CARRIED(1).f, CONFIG), "RESTLESS");
});

test("confusion matrix and accuracy", () => {
  const c = confusion(["STILL", "STILL", "CARRIED"], ["STILL", "RESTLESS", "CARRIED"]);
  assert.deepEqual(c.matrix, [[1, 1, 0], [0, 0, 0], [0, 0, 1]]);
  assert.equal(c.accuracy, 2 / 3);
  assert.equal(c.n, 3);
});

test("cross-session evaluation trains and tests on different sessions", () => {
  const runs = crossSessionEval(DATA, CONFIG);
  assert.deepEqual(runs.map((r) => [r.train, r.test]), [[1, 2], [2, 1]]);
  for (const r of runs) {
    assert.equal(r.model.n, 18);
    assert.equal(r.model.accuracy, 1);
    assert.equal(r.baseline.accuracy, 2 / 3);
  }
  assert.match(evalMarkdown(runs), /Train on session 1, test on session 2 \(18 windows\)/);
});

test("evaluation skips a run when a session is missing", () => {
  assert.deepEqual(crossSessionEval({ windows: DATA.windows.filter((w) => w.session === 1) }, CONFIG), []);
});
