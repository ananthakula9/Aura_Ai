// Aura AI — providers.js
// Thin HTTP clients for each backend AI provider. No routing or fallback
// logic lives here — that's server.js's job. Each function either
// resolves with { text, latencyMs } or throws a ProviderError carrying
// enough information (httpStatus, providerErrorCode) for the caller to
// decide whether a fallback is warranted.

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';

class ProviderError extends Error {
  constructor(message, { httpStatus, providerErrorCode, provider } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.httpStatus = httpStatus ?? null;
    this.providerErrorCode = providerErrorCode ?? null;
    this.provider = provider ?? null;
  }
}

// Retryable = a genuine provider-availability problem (rate limit, quota,
// transient server error) as opposed to a permanent client-side mistake
// (bad key, malformed request, bad model). Only errors where this is true
// should ever trigger a Gemini → Mistral fallback.
function isRetryableFailure(httpStatus, providerErrorCode) {
  if ([429, 500, 502, 503, 504].includes(httpStatus)) return true;
  if (typeof providerErrorCode === 'string') {
    const code = providerErrorCode.toUpperCase();
    if (code.includes('RESOURCE_EXHAUSTED') || code.includes('UNAVAILABLE') || code.includes('QUOTA')) return true;
  }
  return false;
}

// Convert the {role: 'user'|'assistant', content} history shape used
// throughout this app into Gemini's {role: 'user'|'model', parts:[{text}]}.
function toGeminiContents(messages) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

async function callGemini({ apiKey, geminiModel, systemPrompt, messages, maxTokens }) {
  const startedAt = Date.now();

  let res, data;
  try {
    res = await fetch(`${GEMINI_BASE_URL}/${encodeURIComponent(geminiModel)}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: toGeminiContents(messages),
        // temperature/top_p/top_k are deprecated on Gemini 3.x models and
        // intentionally omitted — only maxOutputTokens is set here.
        generationConfig: { maxOutputTokens: Math.min(maxTokens || 700, 1200) },
      }),
    });
    data = await res.json();
  } catch (networkErr) {
    // A network-level failure (DNS, connection refused, timeout) is itself
    // a genuine availability problem — treat it as retryable.
    throw new ProviderError(`Gemini network error: ${networkErr.message}`, {
      httpStatus: 503, provider: 'gemini',
    });
  }

  if (!res.ok) {
    const providerErrorCode = data?.error?.status || null; // e.g. "RESOURCE_EXHAUSTED"
    throw new ProviderError(data?.error?.message || 'Gemini request failed.', {
      httpStatus: res.status, providerErrorCode, provider: 'gemini',
    });
  }

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
  return { text, latencyMs: Date.now() - startedAt };
}

// Convert to Mistral's OpenAI-compatible {role, content} messages array,
// with the system prompt prepended as a 'system' role message — preserving
// both the conversation history and the Aura system instructions exactly
// as they were built for Gemini.
function toMistralMessages(systemPrompt, messages) {
  return [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
  ];
}

async function callMistral({ apiKey, mistralModel, systemPrompt, messages, maxTokens }) {
  const startedAt = Date.now();

  if (!apiKey) {
    throw new ProviderError('Mistral is not configured on this server.', {
      httpStatus: 503, provider: 'mistral', providerErrorCode: 'NOT_CONFIGURED',
    });
  }

  let res, data;
  try {
    res = await fetch(MISTRAL_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: mistralModel,
        messages: toMistralMessages(systemPrompt, messages),
        max_tokens: Math.min(maxTokens || 700, 1200),
      }),
    });
    data = await res.json();
  } catch (networkErr) {
    throw new ProviderError(`Mistral network error: ${networkErr.message}`, {
      httpStatus: 503, provider: 'mistral',
    });
  }

  if (!res.ok) {
    const providerErrorCode = data?.error?.code || data?.code || null;
    throw new ProviderError(data?.error?.message || data?.message || 'Mistral request failed.', {
      httpStatus: res.status, providerErrorCode, provider: 'mistral',
    });
  }

  const text = data?.choices?.[0]?.message?.content?.trim() || '';
  return { text, latencyMs: Date.now() - startedAt };
}

module.exports = {
  ProviderError,
  isRetryableFailure,
  callGemini,
  callMistral,
};
