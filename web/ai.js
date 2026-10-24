import { nightSummaryData } from "./analytics.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-5-5";

const SYSTEM = `You explain baby sleep-position logs to a parent.
Use ONLY the numbers and events in the provided JSON. Never invent numbers.
If the data cannot answer the question, say so.
Do not give medical advice or health conclusions. Do not mention SIDS.
For any health question, say to ask their pediatrician.
This is position awareness from a prototype, not a medical device.
Plain, calm, short sentences.`;

export function aiInput(session, cfg) {
  const time = (ms) => (ms === null ? null : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const s = (n) => (n === null ? null : Math.round(n * 10) / 10);
  const d = nightSummaryData(session, cfg);
  return {
    simulated_demo_data: d.simulated,
    night_start: time(d.start),
    night_end: time(d.end),
    hours_monitored: s(d.duration_s / 3600),
    flips: { count: d.flips.count, longest_seconds: s(d.flips.longest_s), total_seconds: s(d.flips.total_s) },
    time_to_silence_alarm: { count: d.response.count, average_seconds: s(d.response.avg_s), max_seconds: s(d.response.max_s) },
    side_lying: {
      count: d.side.count,
      total_seconds: s(d.side.total_s),
      early_warnings: d.side.early_warnings,
      early_warnings_followed_by_flip_within_60s: d.side.early_then_flipped,
    },
    signal_lost_count: d.disconnects,
    flips_per_hour: d.flips_per_hour.map((h) => ({ hour_starting: time(h.from), flips: h.count })),
    events: session.events.map((e) => ({
      type: e.type,
      start: time(e.start),
      end: time(e.end),
      seconds: e.end === null ? null : s((e.end - e.start) / 1000),
      alarm_silenced_at: time(e.acked_at),
    })),
  };
}

export async function summarizeNight(data, apiKey) {
  return ask(apiKey,
    `Here is tonight's log as JSON:\n${JSON.stringify(data, null, 2)}\n\n` +
    "Write a summary of this night for the parent in 3 to 4 sentences.");
}

export async function askAboutNight(data, question, apiKey) {
  return ask(apiKey,
    `Here is the log as JSON:\n${JSON.stringify(data, null, 2)}\n\n` +
    `The parent asks: ${question}\nAnswer in at most 3 short sentences.`);
}

async function ask(apiKey, userText) {
  if (!apiKey) throw new Error("Add your API key under AI settings first.");

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2026-10-21",
        "anthropic-beta": "server-side-fallback-2026-07-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        output_config: { effort: "low" },
        fallbacks: "default",
        messages: [{ role: "user", content: userText }],
      }),
    });
  } catch {
    throw new Error("Could not reach the AI service. Check the internet connection.");
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) throw new Error("The API key was not accepted. Check it under AI settings.");
    if (res.status === 429) throw new Error("Too many AI requests right now. Wait a moment and try again.");
    throw new Error(`AI service error (${res.status}): ${body?.error?.message ?? "unknown error"}`);
  }
  if (body.stop_reason === "refusal") throw new Error("The AI declined to answer this one.");

  const text = body.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error("The AI sent back an empty answer. Try again.");
  return text;
}
