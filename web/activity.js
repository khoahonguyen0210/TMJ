export const LABELS = ["STILL", "RESTLESS", "CARRIED"];
export const FEATURES = ["mean_z", "mean_x", "mean_motion", "max_motion", "z_range"];
export const WINDOW_MS = 2000;
export const MIN_LINES = 5;
export const K = 5;

export function featuresOf(lines) {
  const zs = lines.map((l) => l.z);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return [
    mean(zs),
    mean(lines.map((l) => l.x)),
    mean(lines.map((l) => l.motion)),
    Math.max(...lines.map((l) => l.motion)),
    Math.max(...zs) - Math.min(...zs),
  ];
}

export function addToWindow(win, line, now) {
  if (line.x === null || line.motion === null) return { win: null, features: null };
  if (win === null) return { win: { start: now, lines: [line] }, features: null };
  if (now - win.start < WINDOW_MS) return { win: { start: win.start, lines: [...win.lines, line] }, features: null };
  const features = win.lines.length >= MIN_LINES ? featuresOf(win.lines) : null;
  return { win: { start: now, lines: [line] }, features };
}

export function fitScaler(rows) {
  const n = rows.length;
  const mean = FEATURES.map((_, i) => rows.reduce((s, r) => s + r[i], 0) / n);
  const std = FEATURES.map((_, i) => {
    const sd = Math.sqrt(rows.reduce((s, r) => s + (r[i] - mean[i]) ** 2, 0) / n);
    return sd > 1e-9 ? sd : 1;
  });
  return { mean, std };
}

export const scale = (f, scaler) => f.map((v, i) => (v - scaler.mean[i]) / scaler.std[i]);

export function trainKnn(windows) {
  const scaler = fitScaler(windows.map((w) => w.f));
  return { scaler, points: windows.map((w) => ({ f: scale(w.f, scaler), label: w.label })) };
}

export function predict(model, f, k = K) {
  const x = scale(f, model.scaler);
  const dist = (p) => p.f.reduce((s, v, i) => s + (v - x[i]) ** 2, 0);
  const nearest = model.points.map((p) => ({ label: p.label, d: dist(p) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k);
  const votes = new Map();
  for (const n of nearest) votes.set(n.label, (votes.get(n.label) ?? 0) + 1);
  const top = Math.max(...votes.values());
  return nearest.find((n) => votes.get(n.label) === top).label;
}

export function baselinePredict(f, cfg) {
  return f[2] > cfg.MOTION_T ? "RESTLESS" : "STILL";
}

export function confusion(actual, predicted) {
  const matrix = LABELS.map(() => LABELS.map(() => 0));
  actual.forEach((a, i) => matrix[LABELS.indexOf(a)][LABELS.indexOf(predicted[i])]++);
  const correct = LABELS.reduce((s, _, i) => s + matrix[i][i], 0);
  return { matrix, accuracy: actual.length ? correct / actual.length : null, n: actual.length };
}

export function crossSessionEval(data, cfg) {
  const runs = [];
  for (const [train, test] of [[1, 2], [2, 1]]) {
    const trainSet = data.windows.filter((w) => w.session === train);
    const testSet = data.windows.filter((w) => w.session === test);
    if (!trainSet.length || !testSet.length) continue;
    const model = trainKnn(trainSet);
    const actual = testSet.map((w) => w.label);
    runs.push({
      train, test,
      model: confusion(actual, testSet.map((w) => predict(model, w.f))),
      baseline: confusion(actual, testSet.map((w) => baselinePredict(w.f, cfg))),
    });
  }
  return runs;
}

export function evalMarkdown(runs) {
  const pct = (a) => (a === null ? "—" : `${(a * 100).toFixed(1)}%`);
  const table = (m) => [
    `| actual \\ predicted | ${LABELS.join(" | ")} |`,
    `|---|${LABELS.map(() => "---").join("|")}|`,
    ...LABELS.map((l, i) => `| ${l} | ${m.matrix[i].join(" | ")} |`),
  ].join("\n");
  return runs.map((r) => [
    `### Train on session ${r.train}, test on session ${r.test} (${r.model.n} windows)`,
    "",
    `Model (k-NN, k = ${K}): accuracy ${pct(r.model.accuracy)}`,
    "",
    table(r.model),
    "",
    `Baseline (motion > MOTION_T → RESTLESS, else STILL): accuracy ${pct(r.baseline.accuracy)}`,
    "",
    table(r.baseline),
  ].join("\n")).join("\n\n") + "\n";
}
