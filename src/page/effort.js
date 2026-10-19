// Reasoning effort (思考强度), learned passively from what the official app
// itself fetches and sends. Pure: no DOM, no network.
//
// Sources (HAR 2026-10-19, logged-in free account):
//   GET /backend-api/settings/user → available_options.backend_reasoning_effort: ["instant"]
//   GET /backend-api/models        → models[].configurable_thinking_effort (false on every
//                                    model) and models[].thinking_efforts ([])
//   POST /backend-api/f/conversation body → `model` ("auto", "gpt-6"); no effort field on
//                                    this account. A `thinking_effort` / `reasoning_effort`
//                                    field, if the app sends one, is read as the current effort.
// A model whose effort is configurable offers its own list; otherwise the
// account-level list applies. One value (or none) is no choice: the UI hides
// the selector.

import { isEffortValue } from '../shared/bridge-protocol.js';

const MAX_EFFORTS = 12;

/** Normalise one official effort entry (a string or an object naming it). */
export function effortName(entry) {
  let value = entry;
  if (entry && typeof entry === 'object') {
    value = ['thinking_effort', 'reasoning_effort', 'effort', 'value', 'id', 'slug'].map((key) => entry[key]).find((item) => typeof item === 'string');
  }
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  return isEffortValue(name) ? name : null;
}

function names(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const name = effortName(entry);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= MAX_EFFORTS) break;
  }
  return out;
}

function parse(body) {
  if (typeof body !== 'string') return body && typeof body === 'object' ? body : null;
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const slugOf = (value) => (typeof value === 'string' && value && value.length <= 100 ? value : null);

export function createEffortTracker() {
  let account = [];
  /** @type {Map<string, string[]>} slug → efforts (configurable models only) */
  let models = new Map();
  let defaultModel = null;
  let model = null;
  let current = null;

  return {
    /** Body of GET /backend-api/models. @returns {boolean} changed */
    noteModels(body) {
      const value = parse(body);
      if (!value || !Array.isArray(value.models)) return false;
      const before = this.signature();
      const next = new Map();
      for (const entry of value.models) {
        const slug = slugOf(entry?.slug);
        if (!slug || entry.configurable_thinking_effort !== true) continue;
        const list = names(entry.thinking_efforts);
        if (list.length) next.set(slug, list);
      }
      models = next;
      defaultModel = slugOf(value.default_model_slug) ?? defaultModel;
      return this.signature() !== before;
    },
    /** Body of GET /backend-api/settings/user. @returns {boolean} changed */
    noteSettings(body) {
      const value = parse(body);
      const list = value?.available_options?.backend_reasoning_effort;
      if (!Array.isArray(list)) return false;
      const before = this.signature();
      account = names(list);
      return this.signature() !== before;
    },
    /** What the official app just submitted. @returns {boolean} changed */
    noteSubmit({ model: submitted = null, effort = null } = {}) {
      const before = this.signature();
      if (slugOf(submitted)) model = submitted;
      if (effort && isEffortValue(effort)) current = effort;
      return this.signature() !== before;
    },
    /** The official control confirmed a choice. */
    noteChosen(effort) {
      if (isEffortValue(effort)) current = effort;
    },
    /** Values available now (for the model the official app uses). */
    efforts() {
      const slug = model || defaultModel;
      return [...((slug && models.get(slug)) || account)];
    },
    current: () => current,
    signature() {
      return JSON.stringify([this.efforts(), current]);
    },
  };
}
