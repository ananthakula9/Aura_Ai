// Aura AI — models.js
// Maps user-facing "Aura" branded model names to the actual Gemini API
// model IDs. The browser only ever sends/receives displayName strings —
// it never sees or chooses a raw Gemini model ID. This file is the single
// place that association lives, so if Gemini's lineup changes again, only
// this file (and AURA_DEFAULT_MODEL if the default itself changes) needs
// to be touched.
//
// Every apiModel value below has been checked against Gemini's current
// generally-available model list (see the AURA_DEFAULT_MODEL note in
// README.md for how to re-verify this if Google renames/retires a model).

const MODEL_REGISTRY = [
  {
    displayName: 'Aura 1 Flash',
    apiModel: 'gemini-3.6-flash',
    description: 'Fast and balanced — the default for everyday conversation, questions, and coding help.',
    isDefault: true,
  },
  {
    displayName: 'Aura 1 Flash Lite',
    apiModel: 'gemini-3.5-flash-lite',
    description: 'Lighter and quicker, for simple questions and casual chat.',
    isDefault: false,
  },
  {
    displayName: 'Aura 1 Pro',
    apiModel: 'gemini-3.1-pro-preview',
    description: 'Stronger reasoning for harder problems — slower and more expensive per response.',
    isDefault: false,
  },
];

const DEFAULT_DISPLAY_NAME = MODEL_REGISTRY.find(m => m.isDefault)?.displayName || MODEL_REGISTRY[0].displayName;

function getPublicModelList() {
  // What the frontend is allowed to see: display name + description only.
  // Never includes apiModel.
  return MODEL_REGISTRY.map(({ displayName, description, isDefault }) => ({ displayName, description, isDefault }));
}

// Resolves a user-facing display name (as sent by the browser) to the
// real Gemini model ID to call. Anything not in the registry — a typo, a
// stale cached name, or a deliberately forged value — silently falls back
// to the default. This is the enforcement point for "do not allow
// arbitrary model IDs from the browser": the browser's input is only ever
// used as a lookup key into this fixed table, never passed through.
function resolveApiModel(displayName) {
  const entry = MODEL_REGISTRY.find(m => m.displayName === displayName);
  if (entry) return entry.apiModel;
  const fallback = MODEL_REGISTRY.find(m => m.isDefault) || MODEL_REGISTRY[0];
  return fallback.apiModel;
}

function isKnownDisplayName(displayName) {
  return MODEL_REGISTRY.some(m => m.displayName === displayName);
}

module.exports = {
  MODEL_REGISTRY,
  DEFAULT_DISPLAY_NAME,
  getPublicModelList,
  resolveApiModel,
  isKnownDisplayName,
};
