# Aura AI — Railway Deployment

A general-purpose AI assistant with an internal aura-farming personality
pipeline (mood detection, query classification, aura engine, cringe
detection, memory, scoring), a Gemini backend, a professional chat
interface, and optional accounts with saved conversation history.

## What's new in this version

**1. Fixed the Gemini model error.** `gemini-2.5-flash` was retired for new
API keys ("no longer available to new users"). The server now defaults to
**`gemini-3.6-flash`** and validates every model request against an
allowlist (`ALLOWED_MODELS` in `server.js`) — an unrecognized or deprecated
model string silently falls back to the default instead of breaking the
app. Change it anytime via the `AURA_DEFAULT_MODEL` environment variable
or per-session in Settings → General → Model.

**2. Professional UI rebuild.** The interface no longer looks like a game
dashboard — it's an original design (not a copy of ChatGPT/Claude/Grok)
built around a deep charcoal palette with a violet→cyan "aura" gradient
used as a single signature accent: a glow ring around the AI avatar that
scales with that response's aura intensity. Includes markdown rendering,
syntax-highlighted code blocks with copy buttons, message timestamps,
copy/regenerate/stop-generation controls, polished error cards with retry,
a collapsible sidebar with conversation search/rename/delete, a full
Settings panel (General / Personality / Conversation / Developer tabs),
light/dark/system theme, and mobile-safe layout (keyboard-aware input,
horizontally scrollable code blocks, slide-out drawer sidebar).

**3. Accounts + guest mode.** See below.

## Architecture

```
Browser
  ↓  POST /api/chat  { systemPrompt, messages, model }
  ↓  POST/GET /api/auth/*, /api/conversations/*  (cookie-based session)
Railway server (server.js)
  ↓  GEMINI_API_KEY from process.env → Gemini API
  ↓  DATABASE_URL from process.env → Postgres (accounts + saved chats)
Response
  ↓
Browser
```

The Gemini key and database credentials are read once, server-side, from
environment variables. Neither ever reaches the browser, ever appears in
`index.html`/`app.js`/`pipeline.js`, and ever gets written to
`localStorage`. Authentication uses an opaque, randomly generated session
token stored in Postgres and delivered to the browser only as an
**HTTP-only cookie** — JavaScript in the browser cannot read it, and no
JWT or other self-describing token is used.

## Guest mode vs. accounts

Both use the exact same Aura AI — same Gemini backend, same Aura Engine,
Query Classifier, Mood Detector, Cringe Detector, memory, and scoring.
The only difference is persistence:

| | Guest | Logged in |
|---|---|---|
| Chat works fully | ✅ | ✅ |
| Aura personality engine | ✅ full | ✅ full |
| Conversation history | Browser `localStorage` only | Saved server-side in Postgres |
| Survives closing the tab | Only within that browser's storage — never sent to or restored from a database | Yes, across devices |
| Requires login to chat | **No** | — |

A guest can start chatting immediately with no popup or forced signup —
there's a "Continue as guest" option right on the login/signup modal, and
the modal itself is optional; closing it or ignoring the account button
works the same way. A dismissible banner reminds guests their chat is
temporary and offers a one-click path to log in or sign up if they want
to keep it.

If no database is configured at all (`DATABASE_URL` unset), the entire
account system quietly disables itself — the account button still shows,
but signup/login return a clear "accounts aren't configured" message
instead of erroring, and guest chat is completely unaffected.

## Security notes

- **Passwords:** hashed with bcrypt (12 rounds) via `bcryptjs`. Never
  stored or logged in plain text.
- **Sessions:** a random 32-byte token (`crypto.randomBytes`), stored in a
  `sessions` table with an expiry, set as an `httpOnly`, `sameSite=lax`
  cookie, and `secure` (HTTPS-only) whenever `NODE_ENV=production`.
- **Conversation isolation:** every conversation and message query in
  `db.js` is scoped by `user_id` at the SQL level — there is no code path
  that returns or modifies another user's data. `addMessage` additionally
  verifies conversation ownership before inserting.
- **Rate limiting:** two independent in-memory limiters — 30 req/min per
  IP for `/api/chat`, and a stricter 10 req/min per IP specifically for
  `/api/auth/*` to slow down credential-stuffing attempts.
- **No secrets in the frontend:** `GEMINI_API_KEY` and `DATABASE_URL` are
  read only in `server.js`/`db.js`, which run server-side. Grep the
  `public/` folder yourself — neither value appears there.

## Project structure

```
aura-ai/
├── server.js              # Express app: static frontend, /api/chat (Gemini), auth + conversation routes
├── db.js                   # Postgres access layer — schema + all queries, scoped by user_id
├── auth.js                  # Password hashing, session tokens, auth middleware
├── package.json               # dependencies: express, cookie-parser, bcryptjs, pg
├── railway.json                 # Railway build/deploy config
├── .env.example                   # environment variable reference
├── .gitignore
└── public/
    ├── index.html          # UI shell + all styles (design tokens, layout, components)
    ├── app.js               # Frontend logic: chat, markdown rendering, settings, auth UI, conversation sync
    └── pipeline.js            # Aura pipeline — mood detector, engine, cringe detector, memory, scoring (unchanged)
```

## Deploy to Railway

1. **Push this project to a GitHub repo** (or deploy directly from this
   folder with the Railway CLI: `railway init` then `railway up`).

2. **Create a new Railway project** → "Deploy from GitHub repo".

3. **Add a Postgres database** (optional, but required for accounts/saved
   history): in your Railway project, click **+ New → Database →
   PostgreSQL**. Railway automatically injects `DATABASE_URL` into your
   app service — you don't need to copy/paste anything for this. Skip
   this step entirely to run guest-only with no accounts.

4. **Set environment variables.** In your app service → Variables:
   ```
   GEMINI_API_KEY = your-real-gemini-key
   ```
   Get a free key at https://aistudio.google.com/apikey.

   Optional:
   ```
   AURA_DEFAULT_MODEL = gemini-3.6-flash
   NODE_ENV = production
   ```
   `PORT` and `DATABASE_URL` (if you added Postgres) are set automatically
   by Railway — don't set `PORT` manually, and don't set `DATABASE_URL`
   yourself unless you're intentionally pointing at a different database.

5. **Deploy.** Railway auto-detects Node via Nixpacks, runs `npm install`,
   then `npm start`. On first boot with a database attached, the server
   automatically creates all required tables (`users`, `sessions`,
   `conversations`, `messages`) — no manual migration step needed.

6. **Open the generated Railway URL.** Settings → General should show
   "Connected — server key configured". If you added Postgres, the
   account button (top right) will offer Log in / Sign up; without it,
   the app runs in guest-only mode automatically.

## Local development

```bash
npm install
cp .env.example .env
# edit .env: add your real GEMINI_API_KEY, and DATABASE_URL if you want
# to test accounts locally (point it at a local or Railway-hosted Postgres)
export GEMINI_API_KEY=your-real-gemini-key
export DATABASE_URL=postgresql://...   # optional — omit to run guest-only
npm start
```

Then open http://localhost:3000. Leave `NODE_ENV` unset locally so
session cookies work over plain `http://` — set it to `production` only
when actually deployed behind HTTPS.

## Notes

- If `gemini-3.6-flash` is ever itself retired, update `ALLOWED_MODELS`
  and `DEFAULT_MODEL` in `server.js` (and the matching list in the
  Settings model dropdown, populated automatically from `/api/health`) —
  everything else keeps working unchanged.
- Password reset via email is out of scope for a minimal deploy (no email
  provider is wired up). A logged-in user can change their password
  directly from a signed-in session; this rotates all existing sessions
  for that account.
- The in-memory rate limiters reset on redeploy/restart — fine for a
  small personal deployment, not meant as production-grade abuse
  protection at scale.
