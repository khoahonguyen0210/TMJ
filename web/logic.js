export function parseLine(text) {
  if (typeof text !== "string") return null;
  const line = text.trim();

  if (line.startsWith("# ERR")) {
    return { type: "ERR", text: line.slice(5).trim() };
  }
  if (line.startsWith("# ROLLWATCH")) {
    const fw = /fw=(\d+)/.exec(line);
    return { type: "STATUS", text: line.slice(1).trim(), fw: fw ? Number(fw[1]) : null };
  }

  const parts = line.split(",");
  if ((parts.length !== 4 && parts.length !== 6) || parts[0] !== "S") return null;

  const num = (s) => (s === "" ? NaN : Number(s));
  const t = num(parts[1]);
  const state = parts[2];
  const z = num(parts[3]);
  if (!Number.isInteger(t) || t < 0) return null;
  if (state !== "OK" && state !== "FLIPPED") return null;
  if (!Number.isFinite(z)) return null;
  if (parts.length === 4) return { type: "S", t, state, z, x: null, motion: null };

  const x = num(parts[4]);
  const motion = num(parts[5]);
  if (!Number.isFinite(x) || !Number.isFinite(motion) || motion < 0) return null;
  return { type: "S", t, state, z, x, motion };
}

export function tiltDeg(z) {
  const clamped = Math.max(-1, Math.min(1, z));
  return Math.round((Math.acos(clamped) * 180) / Math.PI);
}

export function facing(z, cfg) {
  if (z < cfg.FLIP_Z) return "Face down";
  if (z > cfg.OK_Z) return "Face up";
  return "On its side";
}

export const POSTURE_START = { posture: null, sideSince: null, movingSince: null, event: null };

export function nextPosture(prev, line, now, cfg) {
  const changed = (posture) => (prev.posture === posture ? null : posture);

  if (line.state === "FLIPPED") {
    return { posture: "FLIPPED", sideSince: null, movingSince: null, event: changed("FLIPPED") };
  }
  const onSide = line.x !== null && Math.abs(line.x) > cfg.SIDE_X;
  if (!onSide) {
    return { posture: "OK", sideSince: null, movingSince: null, event: changed("OK") };
  }

  const sideSince = prev.sideSince ?? now;
  if (now - sideSince < cfg.SIDE_CONFIRM_S * 1000) {
    return { posture: "OK", sideSince, movingSince: null, event: changed("OK") };
  }
  if (prev.posture === "EARLY") return { ...prev, event: null };

  const moving = line.motion !== null && line.motion > cfg.MOTION_T;
  const movingSince = moving ? (prev.movingSince ?? now) : null;
  if (moving && now - movingSince >= cfg.EARLY_S * 1000) {
    return { posture: "EARLY", sideSince, movingSince, event: "EARLY" };
  }
  return { posture: "SIDE", sideSince, movingSince, event: changed("SIDE") };
}

export const START = { screen: "WAITING", sound: false, event: null, ackAt: null, since: null };

export function nextAlarm(prev, input, now, cfg) {
  if (input.type === "ACK" && prev.sound) {
    return { ...prev, sound: false, event: "ACK", ackAt: now };
  }
  if (input.type === "DISCONNECT" && prev.screen !== "DISCONNECTED") {
    return { screen: "DISCONNECTED", sound: true, event: "DISCONNECTED", ackAt: null, since: now };
  }
  if (input.type === "S" && input.state === "FLIPPED" && prev.screen !== "RED") {
    return { screen: "RED", sound: true, event: "FLIPPED", ackAt: null, since: now };
  }
  if (input.type === "S" && input.state === "OK" && prev.screen !== "GREEN") {
    return { screen: "GREEN", sound: false, event: "OK", ackAt: null, since: null };
  }

  if (!prev.sound && prev.ackAt !== null && now - prev.ackAt >= cfg.RE_ALARM_S * 1000) {
    return { ...prev, sound: true, event: "REALARM", ackAt: null, since: now };
  }
  return { ...prev, event: null };
}

export function escalationLevel(alarmStart, ackTime, now, cfg) {
  if (alarmStart === null) return 0;
  if (ackTime !== null && ackTime >= alarmStart) return 0;
  const waited = now - alarmStart;
  if (waited >= cfg.ESC3_S * 1000) return 3;
  if (waited >= cfg.ESC2_S * 1000) return 2;
  return 1;
}

export function alarmLevelToCommand(level) {
  const clamped = Math.max(0, Math.min(3, Math.round(level)));
  return `A,${clamped}`;
}

export function speakerMissing(lastStatusTime, now, cfg) {
  if (lastStatusTime === null) return true;
  return now - lastStatusTime >= cfg.SPEAKER_TIMEOUT_S * 1000;
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

export function stats(log, now) {
  let totalMs = 0;
  for (const e of log) totalMs += (e.end === null ? now : e.end) - e.start;
  return { count: log.length, totalS: Math.round(totalMs / 1000) };
}
