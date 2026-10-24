export const EVENT_TYPES = ["FLIPPED", "SIDE", "EARLY", "DISCONNECTED"];

export function newSession(now, simulated = false) {
  return { id: String(now), start: now, end: null, fw: null, simulated, samples: [], events: [] };
}

export function addSample(session, line, now) {
  const last = session.samples[session.samples.length - 1];
  if (last && now - last[0] < 1000) return session;
  const sample = [now, line.state, line.z, line.x, line.motion];
  return { ...session, samples: [...session.samples, sample] };
}

export function syncEvents(session, active, now) {
  let events = session.events;
  for (const type of EVENT_TYPES) {
    const open = events.some((e) => e.type === type && e.end === null);
    if (active[type] && !open) {
      events = [...events, { type, start: now, end: null, acked_at: null }];
    } else if (!active[type] && open) {
      events = events.map((e) => (e.type === type && e.end === null ? { ...e, end: now } : e));
    }
  }
  return events === session.events ? session : { ...session, events };
}

export function ackFlip(session, now) {
  const events = session.events.map((e) =>
    e.type === "FLIPPED" && e.end === null && e.acked_at === null ? { ...e, acked_at: now } : e
  );
  return { ...session, events };
}

export function endSession(session, now) {
  const closed = syncEvents(session, {}, now);
  return { ...closed, end: now };
}

const endOf = (session) => session.end ?? session.start;
const eventEnd = (e, session) => e.end ?? endOf(session);
const secs = (ms) => ms / 1000;
const ofType = (session, type) => session.events.filter((e) => e.type === type);

export function timeline(session) {
  const start = session.start;
  const end = endOf(session);
  if (end <= start) return [];

  const kinds = ["DISCONNECTED", "FLIPPED", "SIDE"];
  const spans = session.events
    .filter((e) => kinds.includes(e.type))
    .map((e) => ({ kind: e.type, from: Math.max(start, e.start), to: Math.min(end, eventEnd(e, session)) }))
    .filter((s) => s.to > s.from);

  const cuts = [...new Set([start, end, ...spans.flatMap((s) => [s.from, s.to])])].sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const mid = (cuts[i] + cuts[i + 1]) / 2;
    const kind = kinds.find((k) => spans.some((s) => s.kind === k && s.from <= mid && mid < s.to)) ?? "OK";
    const last = bands[bands.length - 1];
    if (last && last.kind === kind) last.to = cuts[i + 1];
    else bands.push({ from: cuts[i], to: cuts[i + 1], kind });
  }
  return bands;
}

export function flipsPerHour(session) {
  const hours = Math.max(1, Math.ceil(secs(endOf(session) - session.start) / 3600));
  const rows = Array.from({ length: hours }, (_, hour) => ({
    hour, from: session.start + hour * 3600_000, count: 0,
  }));
  for (const e of ofType(session, "FLIPPED")) {
    const hour = Math.floor(secs(e.start - session.start) / 3600);
    if (rows[hour]) rows[hour].count++;
  }
  return rows;
}

export function flipStats(session) {
  const durations = ofType(session, "FLIPPED").map((e) => secs(eventEnd(e, session) - e.start));
  return {
    count: durations.length,
    longest_s: durations.length ? Math.max(...durations) : 0,
    total_s: durations.reduce((a, b) => a + b, 0),
  };
}

export function responseStats(session) {
  const times = ofType(session, "FLIPPED")
    .filter((e) => e.acked_at !== null)
    .map((e) => secs(e.acked_at - e.start));
  return {
    count: times.length,
    avg_s: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
    max_s: times.length ? Math.max(...times) : null,
  };
}

export function sideStats(session, cfg) {
  const sides = ofType(session, "SIDE");
  const earlies = ofType(session, "EARLY");
  const flips = ofType(session, "FLIPPED");
  const windowMs = cfg.EARLY_WINDOW_S * 1000;
  return {
    count: sides.length,
    total_s: sides.reduce((sum, e) => sum + secs(eventEnd(e, session) - e.start), 0),
    early_warnings: earlies.length,
    early_then_flipped: earlies.filter((w) =>
      flips.some((f) => f.start >= w.start && f.start - w.start <= windowMs)
    ).length,
  };
}

export function nightSummaryData(session, cfg) {
  return {
    start: session.start,
    end: endOf(session),
    duration_s: secs(endOf(session) - session.start),
    simulated: session.simulated,
    flips: flipStats(session),
    response: responseStats(session),
    side: sideStats(session, cfg),
    disconnects: ofType(session, "DISCONNECTED").length,
    flips_per_hour: flipsPerHour(session),
  };
}

export function eventsToCSV(session) {
  const iso = (ms) => (ms === null ? "" : new Date(ms).toISOString());
  const rows = ["type,start,end,duration_s,silenced_at"];
  for (const e of session.events) {
    const duration = e.end === null ? "" : secs(e.end - e.start);
    rows.push([e.type, iso(e.start), iso(e.end), duration, iso(e.acked_at)].join(","));
  }
  return rows.join("\n") + "\n";
}

export function demoNight(end) {
  const start = end - 7 * 3600_000;
  const at = (h, m, s = 0) => start + ((h * 60 + m) * 60 + s) * 1000;
  const ev = (type, from, to, acked = null) => ({ type, start: from, end: to, acked_at: acked });
  return {
    id: "demo", start, end, fw: 2, simulated: true, samples: [],
    events: [
      ev("SIDE", at(0, 40), at(0, 52)),
      ev("SIDE", at(1, 55), at(2, 4)),
      ev("EARLY", at(2, 3, 30), at(2, 4)),
      ev("FLIPPED", at(2, 4, 10), at(2, 5, 30), at(2, 4, 21)),
      ev("SIDE", at(3, 30), at(3, 41)),
      ev("DISCONNECTED", at(4, 10), at(4, 11)),
      ev("SIDE", at(5, 0), at(5, 6)),
      ev("EARLY", at(5, 5, 30), at(5, 6)),
      ev("FLIPPED", at(5, 6, 5), at(5, 8, 0), at(5, 6, 13)),
      ev("FLIPPED", at(5, 40), at(5, 40, 50), at(5, 40, 34)),
      ev("SIDE", at(6, 20), at(6, 31)),
    ],
  };
}
