import { splitLines } from './serial.js';

export const POD_NAME = 'RollWatch-Pod';
export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

export function isSupported() {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

let device = null;
let rx = null;
let tx = null;
let buffer = '';
let onLineNow = null;
let onDisconnectNow = null;
const decoder = new TextDecoder();

function onChunk(event) {
  const result = splitLines(buffer, decoder.decode(event.target.value, { stream: true }));
  buffer = result.rest;
  for (const line of result.lines) onLineNow?.(line);
}

function onGattDisconnected() {
  rx = null;
  if (tx) tx.removeEventListener('characteristicvaluechanged', onChunk);
  tx = null;
  onDisconnectNow?.('pod lost');
}

async function openGatt() {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(NUS_SERVICE);
  rx = await service.getCharacteristic(NUS_RX);
  tx = await service.getCharacteristic(NUS_TX);
  buffer = '';
  tx.addEventListener('characteristicvaluechanged', onChunk);
  await tx.startNotifications();
}

export function isConnected() {
  return Boolean(device?.gatt?.connected && tx);
}

export async function connect(onLine, onDisconnect) {
  if (!isSupported()) throw new Error('Web Bluetooth not available. Use Chrome or Edge on a computer, with Bluetooth on.');
  await disconnect();
  const picked = await navigator.bluetooth.requestDevice({
    filters: [{ name: POD_NAME }],
    optionalServices: [NUS_SERVICE],
  });
  if (device !== picked) {
    device?.removeEventListener('gattserverdisconnected', onGattDisconnected);
    picked.addEventListener('gattserverdisconnected', onGattDisconnected);
    device = picked;
  }
  onLineNow = onLine;
  onDisconnectNow = onDisconnect;
  await openGatt();
}

export async function reconnect(onLine, onDisconnect) {
  if (!device || isConnected()) return false;
  onLineNow = onLine;
  onDisconnectNow = onDisconnect;
  try {
    await openGatt();
    return true;
  } catch {
    return false;
  }
}

let writing = Promise.resolve();

export function send(text) {
  if (!rx) return Promise.resolve(false);
  const target = rx;
  const done = writing.then(() => target.writeValueWithResponse(new TextEncoder().encode(text + '\n')));
  writing = done.catch(() => {});
  return done.then(() => true);
}

export async function disconnect() {
  if (device?.gatt?.connected) device.gatt.disconnect();
}
