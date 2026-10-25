import { CONFIG } from './config.js';

const portsInUse = new Set();

export function isSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function splitLines(buffer, chunk) {
  const parts = (buffer + chunk).split('\n');
  const rest = parts.pop();
  const lines = parts
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
  return { lines, rest };
}

const sameDevice = (a, b) => {
  const x = a.getInfo(), y = b.getInfo();
  return x.usbVendorId === y.usbVendorId && x.usbProductId === y.usbProductId;
};

export function createLink(name) {
  let session = null;
  let lastPort = null;

  async function openPort(port, onLine, onDisconnect) {
    await port.open({ baudRate: CONFIG.BAUD });
    lastPort = port;
    portsInUse.add(port);

    const s = { port, reader: null, keepReading: true, done: null };
    session = s;

    s.done = readLoop(s, onLine).then(async (reason) => {
      if (session === s) session = null;
      portsInUse.delete(port);
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
        console.warn(`${name} serial read error:`, err.message);
      } finally {
        s.reader.releaseLock();
        s.reader = null;
      }
    }
    return s.keepReading ? `${name} lost` : 'closed by user';
  }

  async function disconnect() {
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

  return {
    isConnected: () => session !== null,

    async connect(onLine, onDisconnect) {
      if (!isSupported()) throw new Error('Web Serial not available. Use Chrome or Edge on a computer.');
      await disconnect();
      const port = await navigator.serial.requestPort();
      if (portsInUse.has(port)) throw new Error('That port is already in use by the other device. Pick the other one.');
      await openPort(port, onLine, onDisconnect);
    },

    async reconnect(onLine, onDisconnect) {
      if (!isSupported() || session !== null || lastPort === null) return false;
      const ports = (await navigator.serial.getPorts()).filter((p) => !portsInUse.has(p));
      const port = ports.find((p) => p === lastPort) ?? ports.find((p) => sameDevice(p, lastPort));
      if (!port) return false;
      try {
        await openPort(port, onLine, onDisconnect);
        return true;
      } catch {
        return false;
      }
    },

    async send(text) {
      if (!session || !session.port.writable) return false;
      const writer = session.port.writable.getWriter();
      try {
        await writer.write(new TextEncoder().encode(text + '\n'));
        return true;
      } finally {
        writer.releaseLock();
      }
    },

    disconnect,
  };
}
