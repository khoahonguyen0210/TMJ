export const EVENT_TYPES = ["FLIPPED", "SIDE", "EARLY", "DISCONNECTED"];

export function newSession(now, simulated = false) {
  return { id: String(now), start: now, end: null, fw: null, simulated, samples: [], events: [], activity: [] };
}

export function addActivity(session, label, now) {
  return { ...session, activity: [...(session.activity ?? []), [now, label]] };
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

export function addEscalation(session, level, now) {
  const event = { type: "ESCALATED", level, start: now, end: now, acked_at: null };
  return { ...session, events: [...session.events, event] };
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
    escalations: ofType(session, "ESCALATED").length,
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
    activity: activityStats(session),
  };
}

export function activityByMinute(session) {
  const buckets = new Map();
  for (const [t, label] of session.activity ?? []) {
    const minute = Math.floor((t - session.start) / 60_000);
    if (!buckets.has(minute)) buckets.set(minute, new Map());
    const votes = buckets.get(minute);
    votes.set(label, (votes.get(label) ?? 0) + 1);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([minute, votes]) => {
    const top = Math.max(...votes.values());
    const label = [...votes.keys()].find((l) => votes.get(l) === top);
    return { minute, from: session.start + minute * 60_000, label };
  });
}

export function activityStats(session) {
  const minutes = activityByMinute(session);
  if (minutes.length === 0) return null;
  const count = (label, list) => list.filter((m) => m.label === label).length;
  return {
    still_min: count("STILL", minutes),
    restless_min: count("RESTLESS", minutes),
    carried_min: count("CARRIED", minutes),
    restless_before_flips: ofType(session, "FLIPPED").map((f) => ({
      flip_start: f.start,
      restless_min: count("RESTLESS", minutes.filter((m) => m.from >= f.start - 10 * 60_000 && m.from < f.start)),
    })),
  };
}

export function compareNights(sessions, cfg) {
  const rows = [...sessions].sort((a, b) => a.start - b.start).map((n) => {
    const d = nightSummaryData(n, cfg);
    return {
      id: n.id,
      start: n.start,
      simulated: n.simulated,
      flips: d.flips.count,
      longest_flip_s: d.flips.longest_s,
      avg_response_s: d.response.avg_s,
      restless_min: d.activity ? d.activity.restless_min : null,
    };
  });
  const keys = ["flips", "longest_flip_s", "avg_response_s", "restless_min"];
  return rows.map((row, i) => {
    if (i === 0) return { ...row, change: null };
    const prev = rows[i - 1];
    const change = Object.fromEntries(keys.map((k) =>
      [k, row[k] === null || prev[k] === null ? null : row[k] - prev[k]]));
    return { ...row, change };
  });
}

export function eventsToCSV(session) {
  const iso = (ms) => (ms === null ? "" : new Date(ms).toISOString());
  const rows = ["type,start,end,duration_s,silenced_at,level"];
  for (const e of session.events) {
    const duration = e.end === null ? "" : secs(e.end - e.start);
    rows.push([e.type, iso(e.start), iso(e.end), duration, iso(e.acked_at), e.level ?? ""].join(","));
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
    activity: demoActivity(start, at),
  };
}

function demoActivity(start, at) {
  const restless = [[0, 35, 0, 55], [1, 50, 2, 6], [3, 25, 3, 42], [4, 55, 5, 9], [5, 32, 5, 41], [6, 15, 6, 33]];
  const carried = [[4, 5, 4, 14]];
  const inside = (t, spans) => spans.some(([h1, m1, h2, m2]) => t >= at(h1, m1) && t < at(h2, m2));
  const out = [];
  for (let t = start; t < at(7, 0); t += 30_000) {
    out.push([t, inside(t, carried) ? "CARRIED" : inside(t, restless) ? "RESTLESS" : "STILL"]);
  }
  return out;
}
