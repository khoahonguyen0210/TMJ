import { CONFIG } from "./config.js";
import {
  parseLine, nextAlarm, isDisconnected, updateLog, ackLog, stats, toCSV,
  tiltDeg, facing, START,
} from "./logic.js";
import * as serial from "./serial.js";

const el = (id) => document.getElementById(id);

let alarm = START;
let log = [];
let boardState = null;
let lastLineTime = null;
let lastZ = null;
let monitoring = false;
let realConnected = false;

function handleLine(text) {
  if (!monitoring) return;
  const line = parseLine(text);
  if (line === null) return;
  if (line.type === "ERR") { showMessage("Sensor error: " + line.text); return; }
  if (line.type === "STATUS") { showMessage(""); return; }

  const now = Date.now();
  lastLineTime = now;
  lastZ = line.z;
  log = updateLog(log, boardState, line.state, now);
  boardState = line.state;
  step(line, now);
}

function handleDisconnect() {
  realConnected = false;
  if (!monitoring) return;
  step({ type: "DISCONNECT" }, Date.now());
}

function startMonitoring() {
  monitoring = true;
  lastLineTime = Date.now();
}

async function stopMonitoring() {
  const now = Date.now();
  monitoring = false;
  stopSim();
  log = updateLog(log, boardState, "OK", now);
  boardState = null;
  alarm = { ...START, screen: "STOPPED" };
  setSound(false);
  render(now);
  if (realConnected) await serial.disconnect();
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
  WAITING:      { cls: "waiting",      text: "Not connected", sub: "Plug in the sensor and press Connect." },
  GREEN:        { cls: "green",        text: "All good",      sub: "The board is not face down." },
  RED:          { cls: "red",          text: "Flipped",       sub: "The board is face down. Check now." },
  DISCONNECTED: { cls: "disconnected", text: "No signal",     sub: "No data from the sensor. Check the USB cable." },
  STOPPED:      { cls: "waiting",      text: "Paused",        sub: "Monitoring is off, so no alarms. Press Connect to start again." },
};

function render(now) {
  const s = SCREENS[alarm.screen];
  el("status").className = "status " + s.cls;
  document.body.classList.toggle("sounding", alarm.sound);
  el("status-text").textContent = s.text;
  el("status-sub").textContent = s.sub;
  document.title = s.text + " · RollWatch";

  const live = alarm.screen === "GREEN" || alarm.screen === "RED";
  renderPosition(live ? lastZ : null);

  el("stop").disabled = !monitoring;
  el("ack").disabled = !alarm.sound;
  if (alarm.ackAt !== null) {
    const left = Math.ceil(CONFIG.RE_ALARM_S - (now - alarm.ackAt) / 1000);
    el("ack").textContent = `Silenced · beeps again in ${left} s`;
  } else {
    el("ack").textContent = "Silence alarm";
  }

  renderLog(now);
  renderStats(now);
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
  const min = Math.floor(s.totalS / 60);
  const sec = String(s.totalS % 60).padStart(2, "0");
  el("stat-count").textContent = s.count;
  el("stat-time").textContent = `${min}:${sec}`;
}

function renderLog(now) {
  const time = (ms) => new Date(ms).toLocaleTimeString();
  const rows = [...log].reverse().map((e) => {
    const end = e.end === null ? `<span class="open">still face down</span>` : time(e.end);
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

const gauge = el("marker").parentElement.style;
gauge.setProperty("--up-w", `${(tiltDeg(CONFIG.OK_Z) / 180) * 100}%`);
gauge.setProperty("--down-w", `${((180 - tiltDeg(CONFIG.FLIP_Z)) / 180) * 100}%`);

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
    startMonitoring();
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

const SIM_Z = { up: 1.0, down: -1.0, side: 0.0 };
const sim = { timer: null, pos: "up", z: 1.0, state: "OK", belowSince: null };

function simConfirmMs() {
  return el("demo").checked ? 1000 : 3000;
}

function simTick() {
  const now = Date.now();
  sim.z += 0.9 * (SIM_Z[sim.pos] - sim.z);
  if (sim.state === "OK" && sim.z < CONFIG.FLIP_Z) {
    if (sim.belowSince === null) sim.belowSince = now;
    if (now - sim.belowSince >= simConfirmMs()) sim.state = "FLIPPED";
  } else {
    sim.belowSince = null;
  }
  if (sim.state === "FLIPPED" && sim.z > CONFIG.OK_Z) sim.state = "OK";
  handleLine(`S,${Math.round(performance.now())},${sim.state},${sim.z.toFixed(2)}`);
}

function stopSim() {
  clearInterval(sim.timer);
  sim.timer = null;
}

el("sim-start").addEventListener("click", () => {
  unlockSound();
  if (sim.timer !== null) return;
  handleLine("# ROLLWATCH fw=1 imu=ok");
  sim.timer = setInterval(simTick, 200);
  startMonitoring();
});

el("sim-unplug").addEventListener("click", () => {
  stopSim();
  handleDisconnect();
});

for (const btn of document.querySelectorAll("[data-pos]")) {
  btn.addEventListener("click", () => { sim.pos = btn.dataset.pos; });
}

render(Date.now());
