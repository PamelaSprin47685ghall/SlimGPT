// The only `delta_encoding: "v1"` decoder. Each delta event carries a
// (possibly compact) JSON-patch-like operation `{ c, p, o, v }`; omitted
// fields inherit from the previous delta. Values are kept per channel `c`.
// Updates are copy-on-write: a value returned earlier is never mutated later,
// so emitted snapshots stay valid. Invalid deltas return `{ ok: false }`.

import { isObject } from './util.js';

const OPS = new Set(['add', 'remove', 'replace', 'append', 'truncate', 'patch']);
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);

class DeltaError extends Error {}

function fail(reason) {
  throw new DeltaError(reason);
}

function expand(raw, previous) {
  if (!isObject(raw)) fail('delta is not an object');
  const delta = {
    channel: 'c' in raw ? raw.c : previous.channel,
    path: 'p' in raw ? raw.p : previous.path,
    op: 'o' in raw ? raw.o : previous.op,
    value: raw.v,
  };
  if (!Number.isSafeInteger(delta.channel) || delta.channel < 0) fail('bad channel');
  return validate(delta);
}

function validate(delta) {
  if (typeof delta.path !== 'string') fail('bad path');
  if (!OPS.has(delta.op)) fail('bad op');
  if (delta.op === 'patch') {
    if (!Array.isArray(delta.value)) fail('bad patch');
    delta.value = delta.value.map((item) => {
      if (!isObject(item)) fail('bad patch item');
      return validate({ path: item.p, op: item.o, value: item.v });
    });
  }
  return delta;
}

function parsePath(path) {
  if (!path) return [];
  const source = path[0] === '/' ? path.slice(1) : path;
  return source.split('/').map((part) => {
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (UNSAFE.has(decoded)) fail('unsafe path');
    return /^(?:0|[1-9]\d*)$/.test(decoded) ? Number(decoded) : decoded;
  });
}

function cloneContainer(value, nextKey) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === 'object') return { ...value };
  return typeof nextKey === 'number' ? [] : {};
}

function apply(previousValue, delta) {
  const keys = parsePath(delta.path);
  if (!keys.length) return applyAtRoot(previousValue, delta);
  const root = cloneContainer(previousValue, keys[0]);
  let source = previousValue;
  let target = root;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    const sourceChild = source && typeof source === 'object' ? source[key] : undefined;
    const targetChild = cloneContainer(sourceChild, keys[index + 1]);
    assignChild(target, key, targetChild);
    source = sourceChild;
    target = targetChild;
  }
  applyOperation(target, keys[keys.length - 1], delta);
  return root;
}

function assignChild(target, key, child) {
  if (Array.isArray(target) && (!Number.isSafeInteger(key) || key < 0 || key > target.length)) fail('bad index');
  target[key] = child;
}

function applyAtRoot(previousValue, delta) {
  const box = { root: previousValue };
  applyOperation(box, 'root', delta);
  return box.root;
}

function applyOperation(target, key, delta) {
  if (Array.isArray(target)) {
    if (key === '-' && delta.op === 'add') key = target.length;
    if (!Number.isSafeInteger(key) || key < 0 || key > target.length || (key === target.length && delta.op !== 'add')) {
      fail('bad index');
    }
  }
  switch (delta.op) {
    case 'patch': {
      let value = target[key];
      for (const item of delta.value) value = apply(value, item);
      target[key] = value;
      return;
    }
    case 'add':
      if (Array.isArray(target)) target.splice(key, 0, delta.value);
      else target[key] = delta.value;
      return;
    case 'remove':
      if (Array.isArray(target)) target.splice(key, 1);
      else delete target[key];
      return;
    case 'replace':
      target[key] = delta.value;
      return;
    case 'append': {
      const previous = target[key];
      if (typeof previous === 'string' && typeof delta.value === 'string') target[key] = previous + delta.value;
      else if (Array.isArray(previous)) target[key] = previous.concat(Array.isArray(delta.value) ? delta.value : [delta.value]);
      else if (isObject(previous) && isObject(delta.value)) target[key] = { ...previous, ...delta.value };
      else if (previous === undefined || previous === null) target[key] = delta.value;
      else fail('append type mismatch');
      return;
    }
    case 'truncate': {
      const length = delta.value;
      if (!Number.isSafeInteger(length) || length < 0) fail('bad truncate');
      if (typeof target[key] === 'string') target[key] = target[key].slice(0, length);
      else if (Array.isArray(target[key])) target[key] = target[key].slice(0, length);
      else fail('truncate type mismatch');
      return;
    }
    default:
      fail('bad op');
  }
}

/**
 * Stateful v1 delta decoder.
 * @returns {{ decode(raw: unknown): { ok: true, channel: number, value: unknown } | { ok: false } }}
 */
export function createDeltaDecoder() {
  let previous = { channel: 0, path: '', op: 'add' };
  const values = new Map();
  return {
    decode(raw) {
      try {
        const delta = expand(raw, previous);
        const value = apply(values.get(delta.channel), delta);
        previous = { channel: delta.channel, path: delta.path, op: delta.op };
        values.set(delta.channel, value);
        return { ok: true, channel: delta.channel, value };
      } catch {
        return { ok: false };
      }
    },
  };
}
