# Aura AI — Railway Deployment (Gemini backend)

A general-purpose AI assistant with an internal aura-farming personality
pipeline (mood detection, aura engine, cringe detection, memory, scoring).
The frontend UI and pipeline logic are unchanged — only the backend model
provider changed, from OpenRouter to Google's Gemini API.

## Architecture

```
Browser
  ↓  POST /api/chat  { systemPrompt, messages, model }
Railway server (server.js)
  ↓  attaches GEMINI_API_KEY from process.env
Google Gemini API  (generateContent)
  ↓
Response text
  ↓
Browser
```

The Gemini key is read once, server-side, from `process.env.GEMINI_API_KEY`.
It is never sent to the browser, never present in `index.html` or
`pipeline.js`, and never written to `localStorage` — the client only ever
talks to this server's own `/api/chat` endpoint.

## What changed vs. the OpenRouter version

- `server.js` now calls `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
  with the key in an `x-goog-api-key` header, instead of OpenRouter's
  `chat/completions` endpoint with a `Bearer` token.
- Conversation history is translated server-side from the `{role: 'user'|'assistant', content}`
  shape the frontend already sends into Gemini's `{role: 'user'|'model', parts: [{text}]}`
  shape — this conversion is the only new logic, and it's entirely internal
  to `server.js`.
- The system prompt is sent via Gemini's `system_instruction` field instead
  of a `system` role message — same content, different transport. The
  Aura Engine's system prompt text itself (`buildSystemPrompt()` in
  `index.html`) is completely unchanged.
- `/api/chat` and `/api/health` keep the exact same request/response shape
  the frontend already expects, so `index.html` needed only cosmetic label
  changes (e.g. "OpenRouter API key" → "Gemini API key" in a settings
  hint) — no structural rewrite.
- `/api/health` now reports `keyConfigured` based on `GEMINI_API_KEY`
  instead of `OPENROUTER_API_KEY`.
- The rate limiter (30 requests/minute per IP, in-memory) is unchanged.
- `pipeline.js` (mood detector, aura engine, cringe detector, memory,
  scoring) is byte-for-byte unchanged — it's pure client-side logic with
  no knowledge of which backend is behind `/api/chat`.
- No new dependency was needed. Gemini's REST API is called with the
  native `fetch()` already available in Node 18+, the same way OpenRouter
  was called — `package.json` is unchanged.

## Project structure

```
aura-ai/
├── server.js              # Express server: serves frontend + /api/chat → Gemini proxy
├── package.json            # start script + dependencies (unchanged)
├── railway.json             # Railway build/deploy config
├── .env.example              # environment variable reference (Gemini)
├── .gitignore
└── public/
    ├── index.html          # UI (unchanged except labels) + calls /api/chat
    └── pipeline.js          # Aura pipeline logic (fully unchanged)
```

## Deploy to Railway

1. **Push this project to a GitHub repo** (or use the Railway CLI to deploy
   directly from this folder).

2. **Create a new Railway project** → "Deploy from GitHub repo" (or
   `railway init` + `railway up` from the CLI in this directory).

3. **Set the environment variable.** In Railway → your project → Variables,
   add exactly this:
   ```
   GEMINI_API_KEY = your-real-gemini-key
   ```
   Get a free key at https://aistudio.google.com/apikey — `gemini-2.5-flash`
   (the default model) has a generous free tier suitable for a personal
   deployment.

   Optional variable:
   ```
   AURA_DEFAULT_MODEL = gemini-2.5-flash
   ```
   Use `gemini-2.5-pro` here (or set it per-message in the frontend's
   Settings → General → Model field) if you want stronger reasoning at
   higher cost/latency. `PORT` is set automatically by Railway — don't
   set it manually.

4. **Deploy.** Railway auto-detects Node via Nixpacks, runs `npm install`,
   then `npm start` (defined in `package.json` and `railway.json`).

5. **Open the generated Railway URL.** Settings → General should show
   "Connected — server key configured" if `GEMINI_API_KEY` is set correctly.

## Local development

```bash
npm install
cp .env.example .env
# edit .env and add your real GEMINI_API_KEY
export GEMINI_API_KEY=your-real-gemini-key
npm start
```

Then open http://localhost:3000

## Notes

- A basic in-memory per-IP rate limit (30 requests/minute) is built into
  `/api/chat` to protect the key's quota from runaway loops. This resets
  on redeploy/restart since it's in-memory, not persistent — fine for a
  small personal deployment, not meant as production-grade abuse protection.
- The health check at `/api/health` reports whether the key is configured,
  without ever exposing the key itself.
- Swapping providers again later only touches `server.js` — the frontend
  contract (`POST /api/chat` with `{systemPrompt, messages, model}`,
  response `{text}`) is provider-agnostic by design.
