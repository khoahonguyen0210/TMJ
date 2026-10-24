import { CONFIG } from "./config.js";
import {
  parseLine, nextAlarm, isDisconnected, updateLog, ackLog, stats,
  tiltDeg, facing, nextPosture, POSTURE_START, START,
} from "./logic.js";
import {
  newSession, addSample, syncEvents, ackFlip, endSession,
  timeline, nightSummaryData, eventsToCSV, demoNight,
} from "./analytics.js";
import { aiInput, summarizeNight, askAboutNight } from "./ai.js";
import * as serial from "./serial.js";

const el = (id) => document.getElementById(id);

let alarm = START;
let posture = POSTURE_START;
let log = [];
let boardState = null;
let lastLineTime = null;
let lastZ = null;
let monitoring = false;
let realConnected = false;
let session = null;

function handleLine(text) {
  if (!monitoring) return;
  const line = parseLine(text);
  if (line === null) return;
  if (line.type === "ERR") { showMessage("Sensor error: " + line.text); return; }
  if (line.type === "STATUS") {
    showMessage("");
    if (session && line.fw !== null) session = { ...session, fw: line.fw };
    return;
  }

  const now = Date.now();
  lastLineTime = now;
  lastZ = line.z;
  log = updateLog(log, boardState, line.state, now);
  boardState = line.state;
  posture = nextPosture(posture, line, now, CONFIG);
  if (posture.event === "EARLY" && alarm.screen === "GREEN") softBeep();
  if (session) session = addSample(session, line, now);
  step(line, now);
}

function handleDisconnect() {
  realConnected = false;
  if (!monitoring) return;
  posture = POSTURE_START;
  step({ type: "DISCONNECT" }, Date.now());
}

function startMonitoring(simulated) {
  const now = Date.now();
  monitoring = true;
  lastLineTime = now;
  if (session === null) session = newSession(now, simulated);
  else if (simulated) session = { ...session, simulated: true };
  selected = "live";
  renderPicker();
}

async function stopMonitoring() {
  const now = Date.now();
  monitoring = false;
  stopSim();
  log = updateLog(log, boardState, "OK", now);
  boardState = null;
  posture = POSTURE_START;
  alarm = { ...START, screen: "STOPPED" };
  if (session) session = syncEvents(session, {}, now);
  setSound(false);
  render(now, true);
  if (realConnected) await serial.disconnect();
}

function step(input, now) {
  alarm = nextAlarm(alarm, input, now, CONFIG);
  setSound(alarm.sound);
  recordEvents(now);
  render(now);
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

const beep = () => tone("square", [880, 660], 0.2, 0.5);
const softBeep = () => tone("sine", [520], 0.08, 0.18);

function setSound(on) {
  if (on && beepTimer === null) {
    beep();
    beepTimer = setInterval(beep, 1000);
  }
  if (!on && beepTimer !== null) {
    clearInterval(beepTimer);
    beepTimer = null;
  }
}

const SCREENS = {
  WAITING:      { cls: "waiting",      text: "Not connected",  sub: "Plug in the sensor and press Connect." },
  GREEN:        { cls: "green",        text: "All good",       sub: "The board is not face down." },
  SIDE:         { cls: "side",         text: "On side",        sub: "Lying on its side. Not an alarm." },
  EARLY:        { cls: "side",         text: "Likely to roll", sub: "On its side and moving (a simple rule). Keep an eye on it." },
  RED:          { cls: "red",          text: "Flipped",        sub: "The board is face down. Check now." },
  DISCONNECTED: { cls: "disconnected", text: "No signal",      sub: "No data from the sensor. Check the USB cable." },
  STOPPED:      { cls: "waiting",      text: "Paused",         sub: "Monitoring is off, so no alarms. Press Connect to go on, or End night to save it." },
};

function screenKey() {
  if (alarm.screen === "GREEN" && (posture.posture === "SIDE" || posture.posture === "EARLY")) return posture.posture;
  return alarm.screen;
}

function render(now, forceReport = false) {
  const s = SCREENS[screenKey()];
  el("status").className = "status " + s.cls;
  document.body.classList.toggle("sounding", alarm.sound);
  el("status-text").textContent = s.text;
  el("status-sub").textContent = s.sub;
  document.title = s.text + " · RollWatch";

  const live = alarm.screen === "GREEN" || alarm.screen === "RED";
  renderPosition(live ? lastZ : null);

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

function duration(s) {
  if (s === null) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return clock(s);
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

const NIGHTS_KEY = "rollwatch-nights";
let nights = loadNights();
let selected = "live";
let demo = null;

function loadNights() {
  try {
    const saved = JSON.parse(localStorage.getItem(NIGHTS_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveNights() {
  try {
    localStorage.setItem(NIGHTS_KEY, JSON.stringify(nights));
    return true;
  } catch {
    showMessage("Could not save the night: browser storage is full or blocked.");
    return false;
  }
}

async function endNight() {
  if (monitoring) await stopMonitoring();
  if (session === null) return;
  const night = endSession(session, Date.now());
  session = null;
  nights = [...nights, night];
  saveNights();
  selected = night.id;
  renderPicker();
  render(Date.now(), true);
}

window.addEventListener("pagehide", () => {
  if (session === null || session.samples.length === 0) return;
  nights = [...nights, endSession(session, Date.now())];
  session = null;
  saveNights();
});

function nightLabel(n) {
  const day = new Date(n.start).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${day}, ${timeOf(n.start)}–${timeOf(n.end)}${n.simulated ? " · simulated" : ""}`;
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

const EVENT_NAMES = { FLIPPED: "Flipped", SIDE: "On side", EARLY: "Likely to roll", DISCONNECTED: "No signal" };

function renderReport(now) {
  lastReportRender = now;
  const night = shownNight(now);
  el("report-empty").hidden = night !== null;
  el("report-body").hidden = night === null;
  el("simulated").hidden = !(night && night.simulated);
  el("export").disabled = night === null;
  el("ai-summary").disabled = night === null || aiBusy;
  el("ai-ask").disabled = night === null || aiBusy;
  if (night === null) return;

  const d = nightSummaryData(night, CONFIG);

  const span = d.end - d.start || 1;
  el("timeline").replaceChildren(...timeline(night).map((b) => {
    const seg = document.createElement("span");
    seg.className = "k-" + b.kind.toLowerCase();
    seg.style.width = `${((b.to - b.from) / span) * 100}%`;
    seg.title = `${EVENT_NAMES[b.kind] ?? "Not flipped"}: ${timeSecOf(b.from)} – ${timeSecOf(b.to)}`;
    return seg;
  }));
  el("tl-start").textContent = timeOf(d.start);
  el("tl-end").textContent = timeOf(d.end);

  el("r-flips").textContent = d.flips.count;
  el("r-longest").textContent = d.flips.count ? duration(d.flips.longest_s) : "—";
  el("r-total").textContent = d.flips.count ? duration(d.flips.total_s) : "—";
  el("r-response").textContent = duration(d.response.avg_s);
  el("r-early").textContent = d.side.early_warnings;
  el("r-early-label").textContent = d.side.early_warnings
    ? `early warnings, ${d.side.early_then_flipped} followed by a flip`
    : "early warnings";

  renderChart(d.flips_per_hour);

  const rows = [...night.events].reverse().map((e) => {
    const tr = document.createElement("tr");
    const lasted = e.end === null ? null : (e.end - e.start) / 1000;
    const silenced = e.acked_at === null ? (e.type === "FLIPPED" ? "not silenced" : "") : duration((e.acked_at - e.start) / 1000);
    const cells = [EVENT_NAMES[e.type], timeSecOf(e.start), e.end === null ? "still going" : timeSecOf(e.end),
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

const KEY_STORE = "rollwatch-ai-key";
let aiBusy = false;

try { el("ai-key").value = sessionStorage.getItem(KEY_STORE) ?? ""; } catch { }
el("ai-key").addEventListener("input", () => {
  try { sessionStorage.setItem(KEY_STORE, el("ai-key").value.trim()); } catch { }
});

async function runAI(question) {
  const night = shownNight(Date.now());
  if (night === null || aiBusy) return;
  const key = el("ai-key").value.trim();
  if (!key) el("ai-key").closest("details").open = true;

  aiBusy = true;
  render(Date.now(), true);
  el("ai-error").textContent = "";
  el("ai-out").hidden = false;
  el("ai-question-shown").textContent = question ?? "Summary of this night";
  el("ai-text").textContent = "Thinking…";
  try {
    const tonight = aiInput(night, CONFIG);
    let text;
    if (question === null) {
      text = await summarizeNight(tonight, key);
    } else {
      const prev = previousNight(night);
      text = await askAboutNight({ tonight, previous_night: prev ? aiInput(prev, CONFIG) : null }, question, key);
    }
    el("ai-text").textContent = text;
  } catch (err) {
    el("ai-out").hidden = true;
    el("ai-error").textContent = err.message;
  } finally {
    aiBusy = false;
    render(Date.now(), true);
  }
}

el("ai-summary").addEventListener("click", () => runAI(null));
el("ai-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = el("ai-question").value.trim();
  if (q) runAI(q);
});
for (const chip of document.querySelectorAll("[data-q]")) {
  chip.addEventListener("click", () => runAI(chip.dataset.q));
}

el("connect").addEventListener("click", async () => {
  unlockSound();
  if (!serial.isSupported()) {
    showMessage("This browser can't talk to USB devices. Use Chrome or Edge on a computer.");
    return;
  }
  try {
    await serial.connect(handleLine, handleDisconnect);
    stopSim();
    realConnected = true;
    showMessage("");
    startMonitoring(false);
    await sendFastAlert();
  } catch (err) {
    showMessage("Could not connect: " + err.message);
  }
});

async function sendFastAlert() {
  if (!realConnected) return;
  try {
    await serial.send(el("demo").checked ? "D,1" : "D,0");
  } catch (err) {
    showMessage("Could not send Fast alert to the sensor: " + err.message);
  }
}

el("demo").addEventListener("change", sendFastAlert);

el("stop").addEventListener("click", stopMonitoring);
el("end-night").addEventListener("click", endNight);

el("ack").addEventListener("click", () => {
  const now = Date.now();
  if (alarm.screen === "RED") {
    log = ackLog(log);
    if (session) session = ackFlip(session, now);
  }
  step({ type: "ACK" }, now);
});

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
  startMonitoring(true);
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
