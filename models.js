// Aura AI — models.js
// Maps user-facing "Aura" branded model names to actual provider API model
// IDs, AND declares each model's provider strategy. The browser only ever
// sends/receives displayName strings — it never sees or chooses a raw
// Gemini or Mistral model ID, and it never sees which provider is behind
// a given Aura model. This file is the single place both associations
// live, so provider or model-lineup changes only touch this file (plus
// AURA_DEFAULT_MODEL if the default itself changes).
//
// PROVIDER STRATEGY:
//   'gemini-with-fallback' — call Gemini first; on a retryable
//        provider-availability failure (429/500/502/503/504/quota-exhausted),
//        retry the same request against Mistral. Non-retryable failures
//        (bad key, malformed request, bad model config) are NOT retried
//        against Mistral — they're real problems, not availability blips.
//   'mistral-only' — call Mistral directly. Gemini is never invoked for
//        this model, not even as a fallback.
//
// Every apiModel value below has been checked against each provider's
// current generally-available model list.

const MODEL_REGISTRY = [
  {
    displayName: 'Aura 1 Flash',
    strategy: 'gemini-with-fallback',
    geminiModel: 'gemini-3.6-flash',
    mistralModel: 'mistral-large-latest',
    description: 'Fast and balanced — the default for everyday conversation, questions, and coding help.',
    isDefault: true,
  },
  {
    displayName: 'Aura 1 Flash Lite',
    strategy: 'gemini-with-fallback',
    geminiModel: 'gemini-3.5-flash-lite',
    mistralModel: 'mistral-large-latest',
    description: 'Lighter and quicker, for simple questions and casual chat.',
    isDefault: false,
  },
  {
    displayName: 'Aura 1 Pro',
    strategy: 'mistral-only',
    geminiModel: null,
    mistralModel: 'mistral-large-latest',
    description: 'Stronger reasoning for harder problems — slower and more expensive per response.',
    isDefault: false,
  },
];

const DEFAULT_DISPLAY_NAME = MODEL_REGISTRY.find(m => m.isDefault)?.displayName || MODEL_REGISTRY[0].displayName;

function getPublicModelList() {
  // What the frontend is allowed to see: display name + description only.
  // Never includes provider names, strategy, or any raw model ID.
  return MODEL_REGISTRY.map(({ displayName, description, isDefault }) => ({ displayName, description, isDefault }));
}

// Resolves a user-facing display name (as sent by the browser) to its full
// registry entry — the routing logic in server.js reads .strategy,
// .geminiModel, .mistralModel from this. Anything not in the registry — a
// typo, a stale cached name, or a deliberately forged value — silently
// falls back to the default entry. This is the enforcement point for "do
// not allow arbitrary model IDs from the browser": the browser's input is
// only ever used as a lookup key into this fixed table, never passed
// through to either provider.
function resolveModelEntry(displayName) {
  const entry = MODEL_REGISTRY.find(m => m.displayName === displayName);
  if (entry) return entry;
  return MODEL_REGISTRY.find(m => m.isDefault) || MODEL_REGISTRY[0];
}

function isKnownDisplayName(displayName) {
  return MODEL_REGISTRY.some(m => m.displayName === displayName);
}

module.exports = {
  MODEL_REGISTRY,
  DEFAULT_DISPLAY_NAME,
  getPublicModelList,
  resolveModelEntry,
  isKnownDisplayName,
};
