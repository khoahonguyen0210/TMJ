export function parseLine(text) {
  if (typeof text !== "string") return null;
  const line = text.trim();

  if (line.startsWith("# ERR")) {
    return { type: "ERR", text: line.slice(5).trim() };
  }
  if (line.startsWith("# ROLLWATCH")) {
    return { type: "STATUS", text: line.slice(1).trim() };
  }

  const parts = line.split(",");
  if (parts.length !== 4 || parts[0] !== "S") return null;

  const t = Number(parts[1]);
  const state = parts[2];
  const z = Number(parts[3]);
  if (parts[1] === "" || !Number.isInteger(t) || t < 0) return null;
  if (state !== "OK" && state !== "FLIPPED") return null;
  if (parts[3] === "" || !Number.isFinite(z)) return null;

  return { type: "S", t, state, z };
}

export const START = { screen: "WAITING", sound: false, event: null, ackAt: null };

export function nextAlarm(prev, input, now, cfg) {
  if (input.type === "ACK" && prev.sound) {
    return { ...prev, sound: false, event: "ACK", ackAt: now };
  }
  if (input.type === "DISCONNECT" && prev.screen !== "DISCONNECTED") {
    return { screen: "DISCONNECTED", sound: true, event: "DISCONNECTED", ackAt: null };
  }
  if (input.type === "S" && input.state === "FLIPPED" && prev.screen !== "RED") {
    return { screen: "RED", sound: true, event: "FLIPPED", ackAt: null };
  }
  if (input.type === "S" && input.state === "OK" && prev.screen !== "GREEN") {
    return { screen: "GREEN", sound: false, event: "OK", ackAt: null };
  }

  if (!prev.sound && prev.ackAt !== null && now - prev.ackAt >= cfg.RE_ALARM_S * 1000) {
    return { ...prev, sound: true, event: "REALARM", ackAt: null };
  }
  return { ...prev, event: null };
}

export function isDisconnected(lastLineTime, now, cfg) {
  if (lastLineTime === null) return true;
  return now - lastLineTime >= cfg.DISCONNECT_S * 1000;
}

export function updateLog(log, prevState, newState, now) {
  if (newState === "FLIPPED" && prevState !== "FLIPPED") {
    return [...log, { start: now, end: null, durationS: null, acked: false }];
  }
  if (newState === "OK" && prevState === "FLIPPED") {
    return log.map((e) =>
      e.end === null
        ? { ...e, end: now, durationS: Math.round((now - e.start) / 100) / 10 }
        : e
    );
  }
  return log;
}

export function ackLog(log) {
  return log.map((e) => (e.end === null ? { ...e, acked: true } : e));
}

export function toCSV(log) {
  const rows = ["start,end,duration_s,acknowledged"];
  for (const e of log) {
    rows.push([
      new Date(e.start).toISOString(),
      e.end === null ? "" : new Date(e.end).toISOString(),
      e.durationS === null ? "" : e.durationS,
      e.acked ? "yes" : "no",
    ].join(","));
  }
  return rows.join("\n") + "\n";
}
