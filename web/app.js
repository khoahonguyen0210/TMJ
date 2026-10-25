import { CONFIG } from "./config.js";
import {
  parseLine, nextAlarm, isDisconnected, updateLog, ackLog, stats,
  tiltDeg, facing, nextPosture, POSTURE_START, escalationLevel, alarmLevelToCommand, speakerMissing, START,
} from "./logic.js";
import {
  newSession, addSample, syncEvents, ackFlip, endSession, addEscalation, addActivity,
  timeline, nightSummaryData, eventsToCSV, demoNight, activityByMinute, compareNights,
} from "./analytics.js";
import {
  addToWindow, trainKnn, predict, crossSessionEval, evalMarkdown, LABELS, FEATURES, WINDOW_MS,
} from "./activity.js";
import { pushFor, sendPush, listenForAck, validTopic, randomTopic, ackTopicOf } from "./notify.js";
import { startBase, listCameras, randomPeerId, parentLink, liveErrorText } from "./live.js";
import * as ble from "./ble.js";
import { createLink, isSupported as serialSupported } from "./serial.js";

const el = (id) => document.getElementById(id);

let alarm = START;
let posture = POSTURE_START;
let level = 0;
let log = [];
let boardState = null;
let lastLineTime = null;
let lastZ = null;
let monitoring = false;
let podConnected = false;
let usingRealBoard = false;
const usbPod = createLink("USB pod");
let podLink = null;
let session = null;

function handleLine(text) {
  if (!monitoring) return;
  const line = parseLine(text);
  if (line === null) return;
  if (line.type === "ERR") { showMessage("Sensor error: " + line.text); return; }
  if (line.type === "STATUS") {
    if (session && line.fw !== null) session = { ...session, fw: line.fw };
    return;
  }

  const now = Date.now();
  lastLineTime = now;
  lastZ = line.z;
  log = updateLog(log, boardState, line.state, now);
  boardState = line.state;
  posture = nextPosture(posture, line, now, CONFIG);
  if ((posture.event === "SIDE" || posture.event === "EARLY") && alarm.screen === "GREEN") sideWarning();
  if (session) session = addSample(session, line, now);
  recordLabel(line, now);
  classifyActivity(line, now);
  step(line, now);
}

function handleDisconnect() {
  podConnected = false;
  if (!monitoring) return;
  posture = POSTURE_START;
  step({ type: "DISCONNECT" }, Date.now());
  if (usingRealBoard) startReconnect();
}

function startMonitoring(realBoard) {
  const now = Date.now();
  monitoring = true;
  usingRealBoard = realBoard;
  lastLineTime = now;
  if (session === null) session = newSession(now, !realBoard);
  else if (!realBoard) session = { ...session, simulated: true };
  selected = "live";
  renderPicker();
}

async function stopMonitoring() {
  const now = Date.now();
  monitoring = false;
  stopSim();
  stopReconnect();
  log = updateLog(log, boardState, "OK", now);
  boardState = null;
  posture = POSTURE_START;
  alarm = { ...START, screen: "STOPPED" };
  if (session) session = syncEvents(session, {}, now);
  setSound(false, 0);
  render(now, true);
  if (podConnected) await podLink.disconnect();
}

let reconnectTimer = null;
let reconnectBusy = false;

function startReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setInterval(async () => {
    if (!monitoring) { stopReconnect(); return; }
    if (reconnectBusy) return;
    reconnectBusy = true;
    const ok = await podLink.reconnect(handleLine, handleDisconnect);
    reconnectBusy = false;
    if (!ok || !monitoring) return;
    stopReconnect();
    podConnected = true;
    showMessage(`Pod reconnected at ${timeSecOf(Date.now())}.`);
    notify("RECONNECTED", { at: Date.now() });
    await sendFastAlert();
  }, CONFIG.RECONNECT_S * 1000);
}

function stopReconnect() {
  clearInterval(reconnectTimer);
  reconnectTimer = null;
}

function step(input, now) {
  const before = alarm.screen;
  alarm = nextAlarm(alarm, input, now, CONFIG);
  const newLevel = escalationLevel(alarm.since, alarm.ackAt, now, CONFIG);
  if (newLevel >= 2 && newLevel > level) {
    if (session) session = addEscalation(session, newLevel, now);
    notify("ESCALATED", { level: newLevel, offline: alarm.screen === "DISCONNECTED" });
  }
  level = newLevel;
  setSound(alarm.sound && laptopPlays(), level);
  driveSpeaker();
  recordEvents(now);
  render(now);

  if (alarm.event === "FLIPPED") notify("FLIPPED", { at: now });
  if (alarm.event === "DISCONNECTED") notify("DISCONNECTED", { at: now });
  if (alarm.event === "OK" && before === "RED" && log.length) {
    notify("BACK_OK", { at: now, after_s: log[log.length - 1].durationS ?? 0 });
  }
}

function acknowledge(source) {
  if (!alarm.sound) return;
  const now = Date.now();
  const after = (now - (alarm.since ?? now)) / 1000;
  if (alarm.screen === "RED") {
    log = ackLog(log);
    if (session) session = ackFlip(session, now, source);
  }
  step({ type: "ACK" }, now);
  notify("ACK", { source, after_s: after });
  if (source === "phone") showMessage(`Acknowledged from the phone after ${duration(after)}.`);
}

function recordEvents(now) {
  if (session === null) return;
  const calm = alarm.screen === "GREEN";
  const onSide = calm && (posture.posture === "SIDE" || posture.posture === "EARLY");
  session = syncEvents(session, {
    FLIPPED: alarm.screen === "RED",
    DISCONNECTED: alarm.screen === "DISCONNECTED",
    SIDE: onSide,
    EARLY: calm && posture.posture === "EARLY",
  }, now);
}

setInterval(() => {
  if (!monitoring) return;
  const now = Date.now();
  const off = isDisconnected(lastLineTime, now, CONFIG);
  if (off) posture = POSTURE_START;
  step({ type: off ? "DISCONNECT" : "TICK" }, now);
}, 250);

let audio = null;
let beepTimer = null;
let beepLevel = 0;

function unlockSound() {
  if (audio === null) audio = new AudioContext();
  audio.resume();
}

function tone(type, freqs, volume, length) {
  if (audio === null) return;
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  freqs.forEach((f, i) => osc.frequency.setValueAtTime(f, t + (i * length) / freqs.length));
  gain.gain.value = volume;
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + length);
}

const BEEPS = {
  1: { every: 1000, volume: 0.2, length: 0.5 },
  2: { every: 600, volume: 0.4, length: 0.4 },
  3: { every: 400, volume: 0.7, length: 0.3 },
};
const BASE_VOLUME = { LOUD: 1, SOFT: 0.25 };
const baseVolume = () => BASE_VOLUME[el("base-sound").value] ?? 1;

const softBeep = () => tone("sine", [520], 0.08 * baseVolume(), 0.18);

function setSound(on, lvl) {
  const want = on ? Math.max(1, lvl) : 0;
  if (want === beepLevel) return;
  clearInterval(beepTimer);
  beepTimer = null;
  beepLevel = want;
  if (want === 0) return;
  const b = BEEPS[want];
  const beep = () => tone("square", [880, 660], b.volume * baseVolume(), b.length);
  beep();
  beepTimer = setInterval(beep, b.every);
}

const SCREENS = {
  WAITING:      { cls: "waiting",      text: "Not connected",    sub: "Switch on the pod and press Connect pod." },
  GREEN:        { cls: "green",        text: "All good",         sub: "The pod is not face down." },
  SIDE:         { cls: "side",         text: "On side",          sub: "Lying on its side. Not an alarm." },
  EARLY:        { cls: "side",         text: "Likely to roll",   sub: "On its side and moving (a simple rule). Keep an eye on it." },
  RED:          { cls: "red",          text: "Flipped",          sub: "The pod is face down. Check now." },
  DISCONNECTED: { cls: "disconnected", text: "Pod disconnected", sub: "No data from the pod. Check its power bank, or its cable on USB backup." },
  STOPPED:      { cls: "waiting",      text: "Paused",           sub: "Monitoring is off, so no alarms. Press Connect pod to go on, or End night to save it." },
};

function screenKey() {
  if (alarm.screen === "GREEN" && (posture.posture === "SIDE" || posture.posture === "EARLY")) return posture.posture;
  return alarm.screen;
}

function render(now, forceReport = false) {
  const s = SCREENS[screenKey()];
  el("status").className = "status " + s.cls;
  document.body.classList.toggle("sounding", alarm.sound);
  document.body.classList.toggle("flashing", alarm.sound && el("flash-on").checked);
  el("no-response").hidden = level < 3;
  el("status-text").textContent = s.text;
  el("status-sub").textContent = alarm.screen === "DISCONNECTED" && reconnectTimer !== null
    ? "No data from the pod. Trying to reconnect every 2 s…"
    : s.sub;
  renderDevices();
  document.title = s.text + " · RollWatch";

  const live = alarm.screen === "GREEN" || alarm.screen === "RED";
  renderPosition(live ? lastZ : null);
  el("activity-now").hidden = !(live && liveActivity);
  if (liveActivity) el("activity-now").textContent = `Activity: ${ACTIVITY_NAMES[liveActivity]} (small model)`;

  el("stop").disabled = !monitoring;
  el("end-night").disabled = session === null;
  el("ack").disabled = !alarm.sound;
  if (alarm.ackAt !== null) {
    const left = Math.ceil(CONFIG.RE_ALARM_S - (now - alarm.ackAt) / 1000);
    el("ack").textContent = `Silenced · beeps again in ${left} s`;
  } else {
    el("ack").textContent = "Silence alarm";
  }

  renderStats(now);
  if (forceReport || now - lastReportRender >= 1000) renderReport(now);
}

function renderPosition(z) {
  if (z === null) {
    el("board").style.transform = "";
    el("marker").hidden = true;
    el("facing-label").textContent = "—";
    return;
  }
  const deg = tiltDeg(z);
  el("board").style.transform = `rotate(${deg}deg)`;
  el("marker").hidden = false;
  el("marker").style.left = `${(deg / 180) * 100}%`;
  el("facing-label").textContent = `${facing(z, CONFIG)} · ${deg}°`;
}

function renderStats(now) {
  const s = stats(log, now);
  el("stat-count").textContent = s.count;
  el("stat-time").textContent = clock(s.totalS);
}

function showMessage(text) {
  el("message").textContent = text;
}

const gauge = el("marker").parentElement.style;
gauge.setProperty("--up-w", `${(tiltDeg(CONFIG.OK_Z) / 180) * 100}%`);
gauge.setProperty("--down-w", `${((180 - tiltDeg(CONFIG.FLIP_Z)) / 180) * 100}%`);

function clock(totalS) {
  const t = Math.round(totalS);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const timeSecOf = (ms) => new Date(ms).toLocaleTimeString();
const dayOf = (ms) => new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

function duration(s) {
  if (s === null) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return clock(s);
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function load(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    showMessage("Could not save: browser storage is full or blocked.");
    return false;
  }
}

const NIGHTS_KEY = "rollwatch-nights";
let nights = load(NIGHTS_KEY, []);
let selected = "live";
let demo = null;

async function endNight() {
  if (monitoring) await stopMonitoring();
  if (session === null) return;
  const night = endSession(session, Date.now());
  session = null;
  nights = [...nights, night];
  store(NIGHTS_KEY, nights);
  selected = night.id;
  renderPicker();
  render(Date.now(), true);
}

window.addEventListener("pagehide", () => {
  if (session === null || session.samples.length === 0) return;
  nights = [...nights, endSession(session, Date.now())];
  session = null;
  store(NIGHTS_KEY, nights);
});

function nightLabel(n) {
  return `${dayOf(n.start)}, ${timeOf(n.start)}–${timeOf(n.end)}${n.simulated ? " · simulated" : ""}`;
}

function renderPicker() {
  const options = [];
  if (session !== null) options.push(["live", "Tonight (recording)"]);
  for (const n of [...nights].reverse()) options.push([n.id, nightLabel(n)]);
  options.push(["demo", "Sample night (made-up data)"]);
  if (!options.some(([id]) => id === selected)) selected = options[0][0];

  const pick = el("night");
  pick.replaceChildren(...options.map(([id, label]) => new Option(label, id, false, id === selected)));
}

function shownNight(now) {
  if (selected === "live") return session ? { ...session, end: now } : null;
  if (selected === "demo") return (demo ??= demoNight(Date.now()));
  return nights.find((n) => n.id === selected) ?? null;
}

function previousNight(night) {
  const before = nights.filter((n) => n.start < night.start && !n.simulated === !night.simulated);
  return before.length ? before.reduce((a, b) => (b.start > a.start ? b : a)) : null;
}

let lastReportRender = 0;
let chart = null;

const EVENT_NAMES = {
  FLIPPED: "Flipped", SIDE: "On side", EARLY: "Likely to roll", DISCONNECTED: "No signal", ESCALATED: "Got louder",
};
const ACTIVITY_NAMES = { STILL: "Still", RESTLESS: "Restless", CARRIED: "Carried" };

function renderReport(now) {
  lastReportRender = now;
  const night = shownNight(now);
  el("report-empty").hidden = night !== null;
  el("report-body").hidden = night === null;
  el("simulated").hidden = !(night && night.simulated);
  for (const id of ["export", "print"]) el(id).disabled = night === null;
  renderTrends();
  if (night === null) return;

  const d = nightSummaryData(night, CONFIG);
  const span = d.end - d.start || 1;
  el("print-night").textContent = nightLabel({ ...night, end: d.end });

  el("timeline").replaceChildren(...timeline(night).map((b) => {
    const seg = document.createElement("span");
    seg.className = "k-" + b.kind.toLowerCase();
    seg.style.width = `${((b.to - b.from) / span) * 100}%`;
    seg.title = `${EVENT_NAMES[b.kind] ?? "Not flipped"}: ${timeSecOf(b.from)} – ${timeSecOf(b.to)}`;
    return seg;
  }));
  el("tl-start").textContent = timeOf(d.start);
  el("tl-end").textContent = timeOf(d.end);

  const minutes = activityByMinute(night);
  el("activity-row").hidden = minutes.length === 0;
  el("activity-legend").hidden = minutes.length === 0;
  el("activity-row").replaceChildren(...minutes.map((m) => {
    const seg = document.createElement("span");
    seg.className = "a-" + m.label.toLowerCase();
    seg.style.left = `${((m.from - d.start) / span) * 100}%`;
    seg.style.width = `${(60_000 / span) * 100}%`;
    seg.title = `${ACTIVITY_NAMES[m.label]}: ${timeOf(m.from)}`;
    return seg;
  }));

  el("r-flips").textContent = d.flips.count;
  el("r-longest").textContent = d.flips.count ? duration(d.flips.longest_s) : "—";
  el("r-total").textContent = d.flips.count ? duration(d.flips.total_s) : "—";
  el("r-response").textContent = duration(d.response.avg_s);
  el("r-response-label").textContent = d.response.escalations
    ? `average time to silence, ${d.response.escalations} got louder unanswered`
    : "average time to silence";
  el("r-early").textContent = d.side.early_warnings;
  el("r-early-label").textContent = d.side.early_warnings
    ? `early warnings, ${d.side.early_then_flipped} followed by a flip`
    : "early warnings";
  el("r-restless-box").hidden = d.activity === null;
  if (d.activity) {
    el("r-restless").textContent = d.activity.restless_min;
    el("r-restless-label").textContent = `restless minutes (${d.activity.still_min} still, ${d.activity.carried_min} carried)`;
  }

  renderChart(d.flips_per_hour);

  const rows = [...night.events].reverse().map((e) => {
    const tr = document.createElement("tr");
    const lasted = e.end === null ? null : (e.end - e.start) / 1000;
    const silenced = e.acked_at === null
      ? (e.type === "FLIPPED" ? "not silenced" : "")
      : `${duration((e.acked_at - e.start) / 1000)}${e.acked_by ? ` (${e.acked_by})` : ""}`;
    const cells = e.type === "ESCALATED"
      ? [`${EVENT_NAMES.ESCALATED} (level ${e.level})`, timeSecOf(e.start), "", "", ""]
      : [EVENT_NAMES[e.type], timeSecOf(e.start), e.end === null ? "still going" : timeSecOf(e.end),
        lasted === null ? "—" : duration(lasted), silenced];
    for (const text of cells) tr.insertCell().textContent = text;
    tr.className = "row-" + e.type.toLowerCase();
    return tr;
  });
  el("events").replaceChildren(...rows);
  el("events-empty").hidden = rows.length > 0;
}

function renderChart(perHour) {
  if (typeof window.Chart === "undefined") {
    el("chart").hidden = true;
    el("chart-missing").hidden = false;
    return;
  }
  const labels = perHour.map((h) => timeOf(h.from));
  const counts = perHour.map((h) => h.count);
  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = counts;
    chart.update("none");
    return;
  }
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  chart = new window.Chart(el("chart"), {
    type: "bar",
    data: { labels, datasets: [{ label: "Flips", data: counts, backgroundColor: color("--down"), borderRadius: 8, maxBarThickness: 48 }] },
    options: {
      animation: false,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: color("--muted") } },
        y: { beginAtZero: true, ticks: { precision: 0, color: color("--muted") }, grid: { color: color("--line") } },
      },
    },
  });
}

el("print").addEventListener("click", () => {
  render(Date.now(), true);
  window.print();
});
window.addEventListener("beforeprint", () => chart?.resize());
window.addEventListener("afterprint", () => chart?.resize());

function trendNights() {
  return el("trend-sim").checked ? nights : nights.filter((n) => !n.simulated);
}

function renderTrends() {
  const list = trendNights();
  el("trend-empty").hidden = list.length >= 2;
  el("trend-body").hidden = list.length < 2;
  if (list.length < 2) return;

  const delta = (v, fmt, lowerIsBetter = true) => {
    if (v === null || v === 0) return "";
    const better = lowerIsBetter ? v < 0 : v > 0;
    return ` <span class="${better ? "better" : "worse"}">${v > 0 ? "▲" : "▼"} ${fmt(Math.abs(v))}</span>`;
  };
  const rows = compareNights(list, CONFIG).map((r) => {
    const tr = document.createElement("tr");
    const c = r.change ?? {};
    tr.innerHTML = [
      `${dayOf(r.start)}, ${timeOf(r.start)}${r.simulated ? " · simulated" : ""}`,
      `${r.flips}${delta(c.flips ?? null, (v) => v)}`,
      `${r.flips ? duration(r.longest_flip_s) : "—"}${delta(c.longest_flip_s ?? null, duration)}`,
      `${duration(r.avg_response_s)}${delta(c.avg_response_s ?? null, duration)}`,
      `${r.restless_min ?? "—"}${delta(c.restless_min ?? null, (v) => v)}`,
    ].map((html) => `<td>${html}</td>`).join("");
    return tr;
  });
  el("trend-rows").replaceChildren(...rows.reverse());
}

el("trend-sim").addEventListener("change", () => render(Date.now(), true));

const LABEL_KEY = "rollwatch-activity-windows";
let recorded = load(LABEL_KEY, []);
let fileWindows = [];
let model = null;
let liveWin = null;
let liveActivity = null;
let labelHeld = null;
let labelWin = null;

const trainingWindows = () => (recorded.length ? recorded : fileWindows);

function retrain() {
  const windows = trainingWindows();
  const labels = new Set(windows.map((w) => w.label));
  model = windows.length >= 15 && labels.size >= 2 ? trainKnn(windows) : null;
  if (!model) liveActivity = null;
  const source = recorded.length ? "your recordings in this browser" : "web/model/activity-data.json";
  el("model-status").textContent = model
    ? `· trained on ${windows.length} windows from ${source}`
    : "· no training data yet";
  renderLabelCounts();
}

function renderLabelCounts() {
  const rows = [1, 2].map((s) => {
    const tr = document.createElement("tr");
    tr.insertCell().textContent = `Session ${s}`;
    for (const label of LABELS) {
      const n = recorded.filter((w) => w.session === s && w.label === label).length;
      tr.insertCell().textContent = `${n} (${Math.round((n * WINDOW_MS) / 1000)} s)`;
    }
    return tr;
  });
  el("label-counts").replaceChildren(...rows);
}

function recordLabel(line, now) {
  if (labelHeld === null) return;
  const out = addToWindow(labelWin, line, now);
  labelWin = out.win;
  if (out.features) {
    recorded = [...recorded, { session: Number(el("label-session").value), label: labelHeld, f: out.features }];
    store(LABEL_KEY, recorded);
    retrain();
  }
}

function classifyActivity(line, now) {
  if (model === null) return;
  const out = addToWindow(liveWin, line, now);
  liveWin = out.win;
  if (!out.features) return;
  liveActivity = predict(model, out.features);
  if (session) session = addActivity(session, liveActivity, now);
}

for (const btn of document.querySelectorAll("[data-label]")) {
  const start = (e) => {
    e.preventDefault();
    if (!monitoring || !usingRealBoard) {
      showMessage("Label mode needs the real pod: press Connect pod first.");
      return;
    }
    labelHeld = btn.dataset.label;
    labelWin = null;
    btn.classList.add("held");
  };
  const stop = () => {
    labelHeld = null;
    labelWin = null;
    btn.classList.remove("held");
  };
  btn.addEventListener("pointerdown", start);
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, stop);
}

el("label-export").addEventListener("click", () => {
  const data = { version: 1, window_s: WINDOW_MS / 1000, features: FEATURES, windows: recorded };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "activity-data.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

el("label-eval").addEventListener("click", () => {
  const runs = crossSessionEval({ windows: trainingWindows() }, CONFIG);
  el("eval-out").hidden = false;
  el("eval-out").textContent = runs.length
    ? evalMarkdown(runs)
    : "Need windows from both session 1 and session 2 to evaluate.";
});

el("label-clear").addEventListener("click", () => {
  if (!recorded.length || !confirm(`Delete ${recorded.length} recorded windows from this browser?`)) return;
  recorded = [];
  store(LABEL_KEY, recorded);
  retrain();
});

fetch("model/activity-data.json")
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (data && Array.isArray(data.windows)) fileWindows = data.windows;
    retrain();
  })
  .catch(() => retrain());

async function connectPod(link, supported, noSupportText) {
  unlockSound();
  if (!supported) {
    showMessage(noSupportText);
    return;
  }
  try {
    stopReconnect();
    if (podConnected && podLink !== link) await podLink.disconnect();
    await link.connect(handleLine, handleDisconnect);
    podLink = link;
    stopSim();
    podConnected = true;
    showMessage("");
    startMonitoring(true);
    await sendFastAlert();
  } catch (err) {
    if (err.name !== "NotFoundError") showMessage("Could not connect the pod: " + err.message);
  }
}

el("connect").addEventListener("click", () => connectPod(ble, ble.isSupported(),
  "This browser has no Bluetooth access. Use Chrome or Edge on a computer, with Bluetooth on."));
el("connect-usb").addEventListener("click", () => connectPod(usbPod, serialSupported(),
  "This browser can't talk to USB devices. Use Chrome or Edge on a computer."));

async function sendFastAlert() {
  if (!podConnected) return;
  try {
    await podLink.send(el("demo").checked ? "D,1" : "D,0");
  } catch (err) {
    showMessage("Could not send Fast alert to the pod: " + err.message);
  }
}

const speaker = createLink("speaker");
let speakerWanted = false;
let speakerSeen = null;
let speakerCmd = null;
let speakerRetry = null;

const alarmOutput = () => el("alarm-output").value;
const speakerOk = () => speaker.isConnected() && !speakerMissing(speakerSeen, Date.now(), CONFIG);
const useSpeaker = () => alarmOutput() !== "LAPTOP" && speakerOk();
const laptopPlays = () => alarmOutput() !== "SPEAKER" || !speakerOk();

function handleSpeakerLine(text) {
  if (text.startsWith("# SPEAKER") || text.startsWith("# OK")) speakerSeen = Date.now();
}

function handleSpeakerDisconnect() {
  speakerSeen = null;
  speakerCmd = null;
  renderDevices();
  if (speakerWanted && speakerRetry === null) {
    speakerRetry = setInterval(async () => {
      if (await speaker.reconnect(handleSpeakerLine, handleSpeakerDisconnect)) {
        clearInterval(speakerRetry);
        speakerRetry = null;
        speakerSeen = Date.now();
        driveSpeaker();
      }
    }, CONFIG.RECONNECT_S * 1000);
  }
}

function sendSpeaker(cmd) {
  speaker.send(cmd).catch(() => {});
}

function driveSpeaker() {
  if (!speaker.isConnected()) return;
  const want = useSpeaker() ? alarmLevelToCommand(alarm.sound ? Math.max(1, level) : 0) : "A,0";
  if (want === speakerCmd) return;
  speakerCmd = want;
  sendSpeaker(want);
}

function sideWarning() {
  if (useSpeaker()) sendSpeaker("W,1");
  else if (laptopPlays()) softBeep();
}

function renderDevices() {
  const podText = podConnected
    ? `Connected over ${podLink === ble ? "Bluetooth" : "USB (backup)"}`
    : reconnectTimer !== null ? "Lost · reconnecting…" : sim.timer !== null ? "Simulator running" : "Not connected";
  el("pod-state").textContent = podText;
  el("pod-dot").className = "dot " + (podConnected || sim.timer !== null ? "on" : reconnectTimer !== null ? "bad" : "");

  const ok = speakerOk();
  const lost = speakerWanted && !ok;
  el("speaker-state").textContent = ok
    ? (alarmOutput() === "LAPTOP" ? "Connected · not used (output: Laptop)" : "Connected · plays alarms")
    : lost ? "Disconnected · laptop plays alarms" : "Not connected · laptop plays alarms";
  el("speaker-dot").className = "dot " + (ok ? "on" : lost ? "bad" : "");
  el("test-speaker").disabled = !speaker.isConnected();
  el("speaker-warning").hidden = !(lost && alarmOutput() !== "LAPTOP");
}

el("connect-speaker").addEventListener("click", async () => {
  unlockSound();
  if (!serialSupported()) {
    showMessage("This browser can't talk to USB devices. Use Chrome or Edge on a computer.");
    return;
  }
  try {
    await speaker.connect(handleSpeakerLine, handleSpeakerDisconnect);
    speakerWanted = true;
    speakerSeen = Date.now();
    speakerCmd = null;
    driveSpeaker();
    renderDevices();
  } catch (err) {
    if (err.name !== "NotFoundError") showMessage("Could not connect the speaker: " + err.message);
  }
});

el("test-speaker").addEventListener("click", () => sendSpeaker("T,1"));

const OUTPUT_KEY = "rollwatch-alarm-output";
el("alarm-output").value = load(OUTPUT_KEY, "SPEAKER");
el("alarm-output").addEventListener("change", () => {
  store(OUTPUT_KEY, el("alarm-output").value);
  setSound(alarm.sound && laptopPlays(), level);
  driveSpeaker();
  render(Date.now());
});

setInterval(() => {
  setSound(alarm.sound && laptopPlays(), level);
  driveSpeaker();
  renderDevices();
}, 1000);

el("demo").addEventListener("change", sendFastAlert);

const FLASH_KEY = "rollwatch-flash";
el("flash-on").checked = load(FLASH_KEY, true);
el("flash-on").addEventListener("change", () => {
  store(FLASH_KEY, el("flash-on").checked);
  render(Date.now());
});

el("stop").addEventListener("click", stopMonitoring);
el("end-night").addEventListener("click", endNight);

el("ack").addEventListener("click", () => acknowledge("laptop"));

const SOUND_KEY = "rollwatch-base-sound";
el("base-sound").value = load(SOUND_KEY, "LOUD");
el("base-sound").addEventListener("change", () => {
  store(SOUND_KEY, el("base-sound").value);
  beepLevel = -1;
  setSound(alarm.sound && laptopPlays(), level);
  render(Date.now());
});

const NTFY_KEY = "rollwatch-ntfy";
const ntfy = load(NTFY_KEY, { topic: "", on: false });
let stopAckListener = null;

el("ntfy-topic").value = ntfy.topic;
el("ntfy-on").checked = ntfy.on;

function notify(kind, info) {
  if (!ntfy.on || !validTopic(ntfy.topic)) return;
  const push = pushFor(kind, { simulated: session?.simulated ?? false, ...info });
  if (push === null) return;
  if (push.ack && liveLink) push.click = liveLink;
  sendPush(ntfy.topic, push).catch((err) => showMessage(`Phone notification failed: ${err.message}.`));
}

let liveBase = null;
let liveLink = null;

async function fillCameras() {
  try {
    const cams = await listCameras();
    const pick = el("camera");
    const current = pick.value;
    pick.replaceChildren(new Option("Default camera", ""),
      ...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
    pick.value = cams.some((c) => c.deviceId === current) ? current : "";
  } catch {
  }
}

function stopLive() {
  liveBase?.stop();
  liveBase = null;
  liveLink = null;
  el("live-body").hidden = true;
  el("live-start").hidden = false;
  el("live-stop").hidden = true;
  el("live-preview").srcObject = null;
}

el("live-start").addEventListener("click", async () => {
  unlockSound();
  el("live-error").textContent = "";
  el("live-start").disabled = true;
  try {
    liveBase = await startBase({
      cameraId: el("camera").value,
      peerId: randomPeerId(),
      talkAudio: el("talk-audio"),
      onReady: (id) => {
        liveLink = parentLink(CONFIG.PARENT_PAGE, id);
        el("live-link").href = liveLink;
        el("live-link").textContent = liveLink;
        el("live-local").href = parentLink(new URL("parent.html", location.href).href, id);
        el("live-qr").innerHTML = qrSvg(liveLink);
        el("live-state").textContent = "Waiting for a phone…";
      },
      onParents: (n) => {
        el("live-state").textContent = n ? `${n} phone${n > 1 ? "s" : ""} watching` : "Waiting for a phone…";
      },
      onTalk: (on) => {
        el("live-state").classList.toggle("talking", on);
        if (on) el("live-state").textContent = "Parent is talking…";
        else el("live-state").textContent = "Phone watching";
      },
      onError: (err) => { el("live-error").textContent = liveErrorText(err); },
    });
    el("live-preview").srcObject = liveBase.stream;
    el("live-body").hidden = false;
    el("live-start").hidden = true;
    el("live-stop").hidden = false;
    fillCameras();
  } catch (err) {
    stopLive();
    el("live-error").textContent = liveErrorText(err);
  } finally {
    el("live-start").disabled = false;
  }
});

el("live-stop").addEventListener("click", stopLive);

function qrSvg(text) {
  if (typeof window.qrcode !== "function") return "";
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

fillCameras();

function applyNtfy() {
  ntfy.topic = el("ntfy-topic").value.trim();
  ntfy.on = el("ntfy-on").checked && validTopic(ntfy.topic);
  el("ntfy-on").checked = ntfy.on;
  store(NTFY_KEY, ntfy);

  stopAckListener?.();
  stopAckListener = null;
  if (ntfy.on) stopAckListener = listenForAck(ntfy.topic, () => acknowledge("phone"));

  el("ntfy-state").textContent = ntfy.on
    ? `On · listening for Acknowledge on ${ackTopicOf(ntfy.topic)}`
    : validTopic(ntfy.topic) ? "Off" : "Off · set a topic of at least 12 letters, digits, - or _";
}

el("ntfy-new").addEventListener("click", () => {
  el("ntfy-topic").value = randomTopic();
  applyNtfy();
});
el("ntfy-topic").addEventListener("change", applyNtfy);
el("ntfy-on").addEventListener("change", applyNtfy);
el("ntfy-test").addEventListener("click", () => {
  const topic = el("ntfy-topic").value.trim();
  if (!validTopic(topic)) {
    showMessage("Set a topic first (at least 12 letters, digits, - or _).");
    return;
  }
  sendPush(topic, { title: "RollWatch test", message: "Phone notifications work.", priority: 3, tags: ["bell"], ack: false })
    .then(() => showMessage("Test notification sent. Check your phone."))
    .catch((err) => showMessage(`Phone notification failed: ${err.message}.`));
});
applyNtfy();

el("night").addEventListener("change", () => {
  selected = el("night").value;
  render(Date.now(), true);
});

el("export").addEventListener("click", () => {
  const night = shownNight(Date.now());
  if (night === null) return;
  const blob = new Blob([eventsToCSV(night)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rollwatch-night-${new Date(night.start).toISOString().slice(0, 16).replace(":", "")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

const SIM_POS = { up: { z: 1, x: 0 }, side: { z: 0, x: 1 }, down: { z: -1, x: 0 } };
const sim = { timer: null, pos: "up", z: 1, x: 0, wiggle: false, state: "OK", belowSince: null };

function simConfirmMs() {
  return el("demo").checked ? 1000 : 3000;
}

function simTick() {
  const now = Date.now();
  const target = SIM_POS[sim.pos];
  sim.z += 0.9 * (target.z - sim.z);
  sim.x += 0.9 * (target.x - sim.x);
  const motion = sim.wiggle ? 0.12 + Math.random() * 0.08 : Math.random() * 0.02;
  if (sim.state === "OK" && sim.z < CONFIG.FLIP_Z) {
    if (sim.belowSince === null) sim.belowSince = now;
    if (now - sim.belowSince >= simConfirmMs()) sim.state = "FLIPPED";
  } else {
    sim.belowSince = null;
  }
  if (sim.state === "FLIPPED" && sim.z > CONFIG.OK_Z) sim.state = "OK";
  handleLine(`S,${Math.round(performance.now())},${sim.state},${sim.z.toFixed(2)},${sim.x.toFixed(2)},${motion.toFixed(2)}`);
}

function stopSim() {
  clearInterval(sim.timer);
  sim.timer = null;
}

el("sim-start").addEventListener("click", () => {
  unlockSound();
  if (sim.timer !== null) return;
  stopReconnect();
  startMonitoring(false);
  handleLine("# ROLLWATCH fw=2 imu=ok");
  sim.timer = setInterval(simTick, 200);
});

el("sim-unplug").addEventListener("click", () => {
  stopSim();
  handleDisconnect();
});

el("sim-wiggle").addEventListener("click", () => {
  sim.wiggle = !sim.wiggle;
  el("sim-wiggle").setAttribute("aria-pressed", String(sim.wiggle));
});

for (const btn of document.querySelectorAll("[data-pos]")) {
  btn.addEventListener("click", () => { sim.pos = btn.dataset.pos; });
}

renderPicker();
render(Date.now(), true);
