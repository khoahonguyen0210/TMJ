import { CONFIG } from "./config.js";
import {
  parseLine, nextAlarm, isDisconnected, updateLog, ackLog, stats, toCSV, START,
} from "./logic.js";

const serial = await import("./serial.js").catch(() => null);

const el = (id) => document.getElementById(id);

let alarm = START;
let log = [];
let podState = null;
let lastLineTime = null;
let monitoring = false;
let podConnected = false;

function handleLine(text) {
  const line = parseLine(text);
  if (line === null) return;
  if (line.type === "ERR") { showMessage("Pod error: " + line.text); return; }
  if (line.type === "STATUS") { showMessage(""); return; }

  const now = Date.now();
  lastLineTime = now;
  log = updateLog(log, podState, line.state, now);
  podState = line.state;
  el("z").textContent = line.z.toFixed(2);
  step(line, now);
}

function handleDisconnect() {
  podConnected = false;
  step({ type: "DISCONNECT" }, Date.now());
}

function startMonitoring() {
  monitoring = true;
  lastLineTime = Date.now();
}

function step(input, now) {
  alarm = nextAlarm(alarm, input, now, CONFIG);
  setSound(alarm.sound);
  render(now);
}

setInterval(() => {
  if (!monitoring) return;
  const now = Date.now();
  const off = isDisconnected(lastLineTime, now, CONFIG);
  step({ type: off ? "DISCONNECT" : "TICK" }, now);
}, 250);

let audio = null;
let beepTimer = null;

function unlockSound() {
  if (audio === null) audio = new AudioContext();
  audio.resume();
}

function beep() {
  if (audio === null) return;
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.setValueAtTime(660, t + 0.25);
  gain.gain.value = 0.2;
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + 0.5);
}

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
  WAITING:      { cls: "waiting",      text: "NOT CONNECTED",    sub: 'Press "Connect pod" to start.' },
  GREEN:        { cls: "green",        text: "OK",               sub: "Pod is face up." },
  RED:          { cls: "red",          text: "FLIPPED",          sub: "Pod is face down. Check now." },
  DISCONNECTED: { cls: "disconnected", text: "POD DISCONNECTED", sub: "No data from the pod. Check the cable." },
};

function render(now) {
  const s = SCREENS[alarm.screen];
  el("status").className = "status " + s.cls;
  document.body.classList.toggle("sounding", alarm.sound);
  el("status-text").textContent = s.text;
  el("status-sub").textContent = s.sub;
  document.title = s.text + " — RollWatch";
  if (alarm.screen === "DISCONNECTED" || alarm.screen === "WAITING") el("z").textContent = "—";

  el("ack").disabled = !alarm.sound;
  if (alarm.ackAt !== null) {
    const left = Math.ceil(CONFIG.RE_ALARM_S - (now - alarm.ackAt) / 1000);
    el("ack").textContent = `Silenced — sounds again in ${left} s`;
  } else {
    el("ack").textContent = "ACK — stop sound";
  }

  renderLog(now);
  renderStats(now);
}

function renderStats(now) {
  const s = stats(log, now);
  const min = Math.floor(s.totalS / 60);
  const sec = String(s.totalS % 60).padStart(2, "0");
  el("stat-count").textContent = s.count;
  el("stat-time").textContent = `${min}:${sec}`;
}

function renderLog(now) {
  const time = (ms) => new Date(ms).toLocaleTimeString();
  const rows = [...log].reverse().map((e) => {
    const end = e.end === null ? "still flipped" : time(e.end);
    const secs = e.end === null ? Math.round((now - e.start) / 1000) : e.durationS;
    return `<tr><td>${time(e.start)}</td><td>${end}</td>` +
           `<td>${secs} s</td><td>${e.acked ? "yes" : "no"}</td></tr>`;
  });
  el("log").innerHTML = rows.join("");
  el("log-empty").hidden = log.length > 0;
}

function showMessage(text) {
  el("message").textContent = text;
}

el("connect").addEventListener("click", async () => {
  unlockSound();
  if (!("serial" in navigator)) {
    showMessage("This browser has no Web Serial. Use Chrome or Edge on a desktop.");
    return;
  }
  if (serial === null) {
    showMessage("serial.js is not ready yet. Use the fake pod under Test tools.");
    return;
  }
  try {
    await serial.connect(handleLine, handleDisconnect);
    podConnected = true;
    showMessage("");
    startMonitoring();
    await sendDemoMode();
  } catch (err) {
    showMessage("Could not connect: " + err.message);
  }
});

async function sendDemoMode() {
  if (!podConnected) return;
  if (typeof serial.send !== "function") {
    showMessage("serial.js has no send() yet, so the pod did not get demo mode.");
    return;
  }
  try {
    await serial.send(el("demo").checked ? "D,1" : "D,0");
  } catch (err) {
    showMessage("Could not send demo mode: " + err.message);
  }
}

el("demo").addEventListener("change", sendDemoMode);

el("ack").addEventListener("click", () => {
  if (alarm.screen === "RED") log = ackLog(log);
  step({ type: "ACK" }, Date.now());
});

el("export").addEventListener("click", () => {
  const blob = new Blob([toCSV(log)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rollwatch-log-${new Date().toISOString().slice(0, 16).replace(":", "")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

const FAKE_Z = { back: 1.0, stomach: -1.0, side: 0.0 };
const fake = { timer: null, pos: "back", z: 1.0, state: "OK", belowSince: null };

function fakeConfirmMs() {
  return el("demo").checked ? 1000 : 3000;
}

function fakeTick() {
  const now = Date.now();
  fake.z += 0.9 * (FAKE_Z[fake.pos] - fake.z);
  if (fake.state === "OK" && fake.z < -0.7) {
    if (fake.belowSince === null) fake.belowSince = now;
    if (now - fake.belowSince >= fakeConfirmMs()) fake.state = "FLIPPED";
  } else {
    fake.belowSince = null;
  }
  if (fake.state === "FLIPPED" && fake.z > 0.7) fake.state = "OK";
  handleLine(`S,${Math.round(performance.now())},${fake.state},${fake.z.toFixed(2)}`);
}

el("fake-start").addEventListener("click", () => {
  unlockSound();
  if (fake.timer !== null) return;
  handleLine("# ROLLWATCH fw=1 imu=ok");
  fake.timer = setInterval(fakeTick, 200);
  startMonitoring();
});

el("fake-unplug").addEventListener("click", () => {
  clearInterval(fake.timer);
  fake.timer = null;
  handleDisconnect();
});

for (const btn of document.querySelectorAll("[data-pos]")) {
  btn.addEventListener("click", () => { fake.pos = btn.dataset.pos; });
}

render(Date.now());
