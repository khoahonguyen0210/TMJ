import { startParent, liveErrorText } from "./live.js";

const el = (id) => document.getElementById(id);
const baseId = new URL(location.href).searchParams.get("peer");
let live = null;

function setStatus(text) {
  el("status").textContent = text;
}

function showLive(on) {
  el("live-badge").hidden = !on;
  el("video-empty").hidden = on;
  el("watch").hidden = on;
  el("leave").hidden = !on;
}

function stop() {
  live?.stop();
  live = null;
  showLive(false);
  el("talk").disabled = true;
}

if (!baseId) {
  setStatus("Scan the QR code on the base laptop to open this page.");
  el("watch").disabled = true;
}

el("watch").addEventListener("click", async () => {
  setStatus("Starting…");
  try {
    live = await startParent({
      baseId,
      video: el("video"),
      onStatus: (text) => {
        setStatus(text);
        if (text === "Live") {
          showLive(true);
          el("talk").disabled = !live?.canTalk;
          if (!live?.canTalk) setStatus("Live · microphone blocked, so Talk is off");
        }
      },
      onClosed: () => { stop(); setStatus("The base stopped live view."); },
      onError: (err) => { stop(); setStatus(liveErrorText(err)); },
    });
  } catch (err) {
    stop();
    setStatus(liveErrorText(err));
  }
});

el("leave").addEventListener("click", () => { stop(); setStatus("Not connected"); });

const talk = el("talk");
const talkOn = (e) => {
  e.preventDefault();
  if (talk.disabled || !live) return;
  live.setTalking(true);
  talk.classList.add("talking");
  talk.textContent = "Talking… release to stop";
};
const talkOff = () => {
  if (!live) return;
  live.setTalking(false);
  talk.classList.remove("talking");
  talk.textContent = "Hold to talk";
};
talk.addEventListener("pointerdown", talkOn);
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) talk.addEventListener(ev, talkOff);
talk.addEventListener("contextmenu", (e) => e.preventDefault());
