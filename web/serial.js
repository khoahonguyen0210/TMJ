import { CONFIG } from './config.js';

let session = null;

let lastPort = null;

export function isSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function isConnected() {
  return session !== null;
}

export function splitLines(buffer, chunk) {
  const parts = (buffer + chunk).split('\n');
  const rest = parts.pop();
  const lines = parts
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
  return { lines, rest };
}

export async function connect(onLine, onDisconnect) {
  if (!isSupported()) {
    throw new Error('Web Serial not available. Use Chrome or Edge on a desktop.');
  }
  await disconnect();

  const port = await navigator.serial.requestPort();
  await openPort(port, onLine, onDisconnect);
}

export async function reconnect(onLine, onDisconnect) {
  if (!isSupported() || session !== null) return false;
  const ports = await navigator.serial.getPorts();
  const port = ports.includes(lastPort) ? lastPort : ports[0];
  if (!port) return false;
  try {
    await openPort(port, onLine, onDisconnect);
    return true;
  } catch {
    return false;
  }
}

async function openPort(port, onLine, onDisconnect) {
  await port.open({ baudRate: CONFIG.BAUD });
  lastPort = port;

  const s = { port, reader: null, keepReading: true, done: null };
  session = s;

  s.done = readLoop(s, onLine).then(async (reason) => {
    if (session === s) session = null;
    try {
      await port.close();
    } catch {
    }
    if (onDisconnect) onDisconnect(reason);
  });
}

async function readLoop(s, onLine) {
  const decoder = new TextDecoder();
  let buffer = '';

  while (s.keepReading && s.port.readable) {
    s.reader = s.port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await s.reader.read();
        if (done) break;
        const result = splitLines(buffer, decoder.decode(value, { stream: true }));
        buffer = result.rest;
        for (const line of result.lines) onLine(line);
      }
    } catch (err) {
      console.warn('serial read error:', err.message);
    } finally {
      s.reader.releaseLock();
      s.reader = null;
    }
  }
  return s.keepReading ? 'pod lost' : 'closed by user';
}

export async function disconnect() {
  const s = session;
  if (!s) return;
  s.keepReading = false;
  if (s.reader) {
    try {
      await s.reader.cancel();
    } catch {
    }
  }
  await s.done;
}

export async function send(text) {
  if (!session || !session.port.writable) return false;
  const writer = session.port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(text + '\n'));
    return true;
  } finally {
    writer.releaseLock();
  }
}
