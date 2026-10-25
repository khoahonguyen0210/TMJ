export const NTFY = "https://ntfy.sh";
const PRIORITY = { low: 2, default: 3, high: 4, urgent: 5 };

export const ackTopicOf = (topic) => `${topic}-ack`;

export function validTopic(topic) {
  return typeof topic === "string" && /^[A-Za-z0-9_-]{12,64}$/.test(topic);
}

export function randomTopic(random = Math.random) {
  const chars = "abcdefghijkmnopqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 12; i++) id += chars[Math.floor(random() * chars.length)];
  return `rollwatch-${id}`;
}

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function span(s) {
  const t = Math.round(s);
  return t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, "0")} s`;
}

export function pushFor(kind, info) {
  const tag = info.simulated ? "[Simulator] " : "";
  switch (kind) {
    case "FLIPPED":
      return { title: `${tag}Baby rolled onto stomach`, message: `Face down since ${time(info.at)}.`, priority: PRIORITY.high, tags: ["rotating_light"], ack: true };
    case "ESCALATED": {
      const what = info.offline ? "Monitor offline" : "Still on stomach";
      return info.level >= 3
        ? { title: `${tag}NO RESPONSE – 60 s`, message: `${what}, nobody has acknowledged.`, priority: PRIORITY.urgent, tags: ["rotating_light", "sos"], ack: true }
        : { title: `${tag}${what} – no response 30 s`, message: "Nobody has acknowledged yet.", priority: PRIORITY.urgent, tags: ["rotating_light"], ack: true };
    }
    case "DISCONNECTED":
      return { title: `${tag}Monitor offline`, message: `No data from the sensor since ${time(info.at)}.`, priority: PRIORITY.high, tags: ["warning"], ack: true };
    case "ACK":
      return { title: `${tag}Acknowledged from ${info.source} after ${span(info.after_s)}`, message: "Alarm silenced.", priority: PRIORITY.low, tags: ["white_check_mark"], ack: false };
    case "BACK_OK":
      return { title: `${tag}Back on back after ${span(info.after_s)}`, message: `Not face down since ${time(info.at)}.`, priority: PRIORITY.low, tags: ["white_check_mark"], ack: false };
    case "RECONNECTED":
      return { title: `${tag}Monitor reconnected`, message: `Sensor data again since ${time(info.at)}.`, priority: PRIORITY.low, tags: ["electric_plug"], ack: false };
    default:
      return null;
  }
}

export function ntfyBody(topic, push) {
  const body = { topic, title: push.title, message: push.message, priority: push.priority, tags: push.tags };
  if (push.click) body.click = push.click;
  if (push.ack) {
    body.actions = [{ action: "http", label: "Acknowledge", url: `${NTFY}/${ackTopicOf(topic)}`, method: "POST", body: "ack", clear: true }];
  }
  return body;
}

export async function sendPush(topic, push) {
  let res;
  try {
    res = await fetch(NTFY, { method: "POST", body: JSON.stringify(ntfyBody(topic, push)) });
  } catch {
    throw new Error("no internet connection");
  }
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}

export function isAck(data) {
  try {
    const m = JSON.parse(data);
    return m.event === "message" && String(m.message).trim().toLowerCase() === "ack";
  } catch {
    return false;
  }
}

export function listenForAck(topic, onAck) {
  const source = new EventSource(`${NTFY}/${ackTopicOf(topic)}/sse`);
  source.onmessage = (e) => { if (isAck(e.data)) onAck(); };
  return () => source.close();
}
