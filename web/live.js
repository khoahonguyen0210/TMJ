const PEER_PREFIX = "rollwatch-live-";

export function randomPeerId(random = Math.random) {
  const chars = "abcdefghijkmnopqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 14; i++) id += chars[Math.floor(random() * chars.length)];
  return PEER_PREFIX + id;
}

export function parentLink(pageUrl, peerId) {
  const url = new URL(pageUrl);
  url.searchParams.set("peer", peerId);
  return url.toString();
}

export function liveErrorText(err) {
  const type = err?.type ?? err?.name;
  if (type === "peer-unavailable") return "The base is not live. Start live view on the laptop and scan the new QR code.";
  if (type === "NotAllowedError") return "Camera or microphone blocked. Allow it in the browser and try again.";
  if (type === "NotFoundError") return "No camera or microphone found.";
  if (type === "network" || type === "server-error" || type === "socket-error") return "Cannot reach the live view server. Check the internet connection.";
  return `Live view problem: ${err?.message ?? type ?? "unknown"}`;
}

function needPeer() {
  if (typeof window.Peer !== "function") throw new Error("Live view library did not load (no internet?).");
}

export async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

export async function startBase({ cameraId, peerId, talkAudio, onReady, onParents, onTalk, onError }) {
  needPeer();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: cameraId ? { deviceId: { exact: cameraId } } : true,
    audio: { echoCancellation: true, noiseSuppression: true },
  });

  const peer = new window.Peer(peerId);
  const calls = new Set();
  const voices = new Map();

  const playVoices = () => {
    const latest = [...voices.values()].at(-1) ?? null;
    talkAudio.srcObject = latest;
    if (latest) talkAudio.play().catch(() => {});
  };

  peer.on("open", (id) => onReady(id));
  peer.on("error", (err) => onError(err));
  peer.on("connection", (conn) => {
    conn.on("data", (msg) => onTalk(Boolean(msg?.talk)));
    conn.on("close", () => onTalk(false));
  });
  peer.on("call", (call) => {
    call.answer(stream);
    calls.add(call);
    onParents(calls.size);
    call.on("stream", (voice) => {
      voices.set(call, voice);
      playVoices();
    });
    call.on("close", () => {
      calls.delete(call);
      voices.delete(call);
      playVoices();
      onParents(calls.size);
    });
  });

  return {
    stream,
    stop() {
      for (const call of calls) call.close();
      peer.destroy();
      stream.getTracks().forEach((t) => t.stop());
      talkAudio.srcObject = null;
    },
  };
}

export async function startParent({ baseId, video, onStatus, onClosed, onError }) {
  needPeer();
  let mic = null;
  let hasMic = true;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
  } catch {
    mic = silentStream();
    hasMic = false;
  }
  const micTrack = mic.getAudioTracks()[0];
  if (micTrack) micTrack.enabled = false;

  const peer = new window.Peer();
  let call = null;
  let conn = null;

  peer.on("error", (err) => onError(err));
  peer.on("open", () => {
    onStatus("Connecting to the base…");
    conn = peer.connect(baseId);
    call = peer.call(baseId, mic, { constraints: { offerToReceiveAudio: true, offerToReceiveVideo: true } });
    call.on("stream", (remote) => {
      video.srcObject = remote;
      video.play().catch(() => {});
      onStatus("Live");
    });
    call.on("close", () => onClosed());
  });

  return {
    canTalk: hasMic,
    setTalking(on) {
      if (!hasMic) return;
      micTrack.enabled = on;
      if (conn?.open) conn.send({ talk: on });
    },
    stop() {
      conn?.close();
      call?.close();
      peer.destroy();
      mic.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

function silentStream() {
  const ctx = new AudioContext();
  return ctx.createMediaStreamDestination().stream;
}
