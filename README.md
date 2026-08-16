# Aura AI — Railway Deployment

A general-purpose AI assistant with an internal aura-farming personality
pipeline (mood detection, query classification, aura engine, cringe
detection, memory, scoring), a Gemini + Mistral backend with automatic
fallback, image/document analysis, browser-native text-to-speech, and
accounts (email/password or Google) with saved conversation history —
while guest chat remains fully available with zero persistence.

## What changed in this version

**0. Image/document analysis + text-to-speech.** Users can attach up to 3
images (PNG/JPG/WEBP) or documents (PDF/TXT) per message via the new
attachment button next to the composer, with previews, per-file removal,
and size limits (8MB/image, 15MB/document) enforced both client-side (for
immediate feedback) and — the real enforcement point — server-side in the
new `attachments.js`, which verifies every file's actual type from its
byte signature rather than trusting the client's claimed MIME type or
filename. DOCX is deliberately not supported: direct verification against
Gemini's API showed `generateContent` rejects that MIME type, so it's
rejected up front with an honest message instead of silently failing.
Multimodal requests always route to Gemini (see the provider notes below
for why), regardless of which Aura model tier is selected; a clean
"temporarily unavailable" error is returned if Gemini can't serve the
request, rather than silently dropping the attachment or guessing at
Mistral's vision support. Every AI response also gets a Listen button
using the browser's native Speech Synthesis API — no conversation text is
ever sent to a third-party TTS service, and speech never starts without
an explicit click.

**1. Fixed a real guest-persistence bug.** Guest conversations were being
written to `localStorage` (key `aura_conversations_v1`) and restored on
every page load — meaning a "guest" chat quietly survived refreshes and
reopens. This has been completely removed. Guest state now lives in a
single in-memory JavaScript object (`guestConversation` in `app.js`) that
is discarded on refresh, tab close, "New chat," or logout. Verified by:
statically auditing every remaining `localStorage` call in `app.js` (only
theme, a "welcome seen" flag, a "guest banner dismissed" flag, and the
selected model name remain — no chat content), and by loading the real
`app.js` against a hand-built DOM/localStorage stub, driving an actual
simulated send-message interaction through the real `handleSend()` code
path, and confirming the resulting `localStorage` contents contain no
trace of the message text.

**2. Aura-branded model names, now backed by two providers.** The UI never
shows a raw Gemini or Mistral model ID. `models.js` maintains the only
mapping between user-facing names and real provider model IDs, and also
declares each model's provider strategy:

| Display name (what users see) | Primary provider | Fallback | Notes |
|---|---|---|---|
| **Aura 1 Flash** (default) | Gemini (`gemini-3.6-flash`) | Mistral (`mistral-large-latest`) | Falls back only on a genuine retryable provider failure |
| Aura 1 Flash Lite | Gemini (`gemini-3.5-flash-lite`) | Mistral (`mistral-large-latest`) | Same fallback behavior as Flash |
| Aura 1 Pro | Mistral (`mistral-large-latest`) | — | Gemini is never called for this model |

The browser only ever sends/receives display names — never a provider
name, a raw model ID, or which provider actually served a given response.
`/api/chat` resolves a display name to a registry entry via a fixed lookup
table; anything not in that table (a stale cached value, a forged request,
a typo — including a forged *raw* Gemini or Mistral model ID) silently
falls back to the default entry rather than being passed through to either
provider. Verified with direct forgery tests using both a fake Gemini
model string and a real raw Mistral model string as the `model` field —
both resolve to the default, neither reaches a provider.

**2a. Automatic Gemini → Mistral fallback.** Aura 1 Flash and Aura 1 Flash
Lite call Gemini first. If Gemini fails with a genuine
availability problem — HTTP 429/500/502/503/504, or a
`RESOURCE_EXHAUSTED`/`UNAVAILABLE`/quota-related error code — the exact
same request (same system prompt, same conversation history) is retried
once against Mistral, and the response is returned as if nothing
happened; the client-facing `model` field still just says "Aura 1 Flash."
Permanent failures (bad API key, malformed request, invalid model
configuration) are deliberately **not** retried against Mistral — those
are real problems that a fallback would either mask or fail identically
against, so they're surfaced directly as a clean error instead. Aura 1 Pro
calls Mistral directly and never touches Gemini at all, not even as a
fallback target for itself. If Mistral fails — whether called directly for
Pro or as a fallback for Flash/Flash Lite — the user gets a generic,
clean error message; the raw provider error text is logged server-side
only and never returned in the API response.

**3. "Continue with Google."** Real, server-side OAuth 2.0 (authorization
code flow) — not a fake button. See the Google OAuth section below. If
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` aren't all
set, the button still appears (per the intended UX — guests shouldn't see
a broken-looking landing screen) but clicking it shows a plain "Google
sign-in isn't configured on this server yet" message instead of pretending
to authenticate.

**4. Professional first-visit welcome modal.** A logged-out visitor sees a
centered modal: Aura AI logo, "Your AI. Your vibe.", then Continue with
Google / Sign in with Email / Create an Account / Continue as Guest — no
aura meters, scores, or slang on this screen. Guests who dismiss it or
pick "Continue as Guest" aren't re-prompted on every reload; a single
anonymous flag (`aura_welcome_seen`, no chat data, no token, no personal
information) tracks that this browser has already seen it.

**6. Structured quiz components (with plain-text fallback).** When the
user asks for a quiz — naturally, e.g. "Create a 5-question quiz about
space," "Quiz me on photosynthesis," "Make a math quiz," "Test me on
World War 2" — the response now includes an interactive quiz component
rendered in the chat UI. Server-side, `components.js` appends a short
format spec to the system prompt telling the model to emit the entire
quiz as one JSON object inside a ```quiz fenced block. But models
frequently ignore that and write a perfectly good multiple-choice quiz
as plain text — so `components.js` has TWO ways to produce a component:

  1. **Structured path:** ```quiz fenced blocks (or a bare JSON quiz
     object) are parsed, validated (malformed questions dropped, never
     crashing), and stripped out of the visible text.
  2. **Intent + normalization fallback:** if no structured component was
     found AND the user's last message clearly asks for an interactive
     quiz/test (`isQuizRequest`: quiz/trivia/MCQ/multiple choice/
     "test me on" etc.), `parsePlainTextQuiz` converts an obvious
     plain-text quiz (numbered questions with a/b/c/d options — as
     lines, inline letters, or inline parentheses — plus an Answers/
     Answer Key block, letter or text answers, or per-question
     "Answer:" lines) into the exact same component schema.

The fallback is deliberately double-gated (clear quiz intent +
extractable quiz structure), so normal chat is never touched: a numbered
list like "5 tips to improve sleep" or a prose answer to a quiz request
stays plain text. The `/api/chat` response gains a `components` array —
`[{ type: "quiz", title, questions }]` — empty (`[]`) for every ordinary
response, so plain chat is byte-for-byte unchanged apart from the new
field. The frontend (`public/components.js`) renders each quiz component
as a paginated interactive card: one question at a time with Back/Next,
a progress bar ("Question 2 of 5"), answer selection, Submit (enabled
once all questions are answered), a score, per-question review with
correct/wrong highlighting and explanations, and Retry. Works identically
whether Gemini or Mistral served the request (it's text-in/text-out on
both), and components are never persisted to conversation history — they
live only for the message on screen, like attachment previews.

## Architecture

```
Browser
  ↓  POST /api/chat  { systemPrompt, messages, model: "Aura 1 Flash" }
  ↓  /api/auth/*  (email/password + Google OAuth, cookie-based sessions)
  ↓  /api/conversations/*  (logged-in users only)
Railway server (server.js)
  ↓  models.js resolves "Aura 1 Flash" → { strategy: gemini-with-fallback,
  ↓      geminiModel: gemini-3.6-flash, mistralModel: mistral-large-latest }
  ↓  runChatWithFallback() in server.js decides which provider(s) to call
  ↓  providers.js makes the actual HTTP calls:
  ↓    GEMINI_API_KEY from process.env → Gemini API (primary for Flash/Flash Lite)
  ↓    MISTRAL_API_KEY from process.env → Mistral API (primary for Pro,
  ↓      automatic fallback for Flash/Flash Lite on a retryable Gemini failure)
  ↓  DATABASE_URL from process.env → Postgres (accounts + saved chats)
  ↓  GOOGLE_CLIENT_ID/SECRET from process.env → Google OAuth (oauth.js)
Response  { text, model: "Aura 1 Flash", latencyMs, truncated,
            components: [{ type: "quiz", title, questions }] }
  ↓
Browser
```

No secret (Gemini key, Mistral key, database credentials, Google client
secret, session tokens, password hashes) ever reaches
`public/index.html`, `public/app.js`, or `public/pipeline.js` — grep those
files yourself; none of these strings appear there. `MISTRAL_API_KEY`
specifically does not appear anywhere client-facing at all — not even as
a variable *name* in help text (unlike `GEMINI_API_KEY`, which does appear
as a name in a couple of user-facing "not configured" messages, matching
its pre-existing behavior) — and it is never included in `/api/health` or
any `/api/chat` response.

## Guest mode vs. accounts

Both use the exact same Aura AI — same Gemini backend (via Aura-branded
model names), same Aura Engine, Query Classifier, Mood Detector, Cringe
Detector, memory, and scoring. The only difference is persistence:

| | Guest | Logged in (email or Google) |
|---|---|---|
| Chat works fully, no forced signup | ✅ | ✅ |
| Aura personality engine | ✅ full | ✅ full |
| Conversation history | Exists only in page memory | Saved server-side in Postgres |
| Survives refresh / reopening the site | **No — always starts fresh** | Yes, across devices |
| Sidebar shows saved conversation list | No (nothing to list) | Yes — search, rename, delete |

On logout, the previous account's conversations stay safely in Postgres,
untouched — the UI simply drops to a brand-new, empty guest conversation.
Nothing from the account is copied into guest state, and nothing from a
guest session is ever copied into an account (guest state is discarded
outright, both on login/signup success and on logout).

## Google OAuth setup

1. **Google Cloud Console** → APIs & Services → Credentials → **Create
   Credentials → OAuth 2.0 Client ID** → Application type: **Web
   application**.
2. Under **Authorized redirect URIs**, add:
   ```
   https://YOUR-RAILWAY-DOMAIN/api/auth/google/callback
   ```
   (and `http://localhost:3000/api/auth/google/callback` too, if you want
   to test Google sign-in locally.)
3. Copy the generated **Client ID** and **Client Secret**.
4. On Railway → your service → Variables, set:
   ```
   GOOGLE_CLIENT_ID = your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET = your-client-secret
   GOOGLE_REDIRECT_URI = https://YOUR-RAILWAY-DOMAIN/api/auth/google/callback
   ```
   All three are required together — the app checks `isConfigured()` in
   `oauth.js`, which is only `true` when all three are present.

**How sign-in works:** clicking "Continue with Google" redirects the
browser to `/api/auth/google`, which sets a short-lived, `httpOnly` CSRF
state cookie and redirects to Google's consent screen. Google redirects
back to `/api/auth/google/callback` with a code and the same state value;
the server verifies the state matches (rejecting the request outright if
it doesn't or if the cookie is missing), exchanges the code for tokens
directly with Google's token endpoint (server-to-server, using the client
secret), fetches the user's email/name/picture, and either links to an
existing email/password account with the same email or creates a new
Google-only account (no password). A normal session cookie is then set,
identical in form to an email/password login.

## Security notes

- **Passwords:** bcrypt, 12 rounds. A Google-only account has no password
  at all (`password_hash` is nullable) — email/password login for such an
  account fails cleanly rather than crashing.
- **Sessions:** random 32-byte token stored server-side in Postgres,
  delivered as an `httpOnly`, `sameSite=lax` cookie, `secure` (HTTPS-only)
  whenever `NODE_ENV=production`.
- **OAuth CSRF protection:** a random `state` value round-trips through a
  short-lived cookie; the callback rejects the request if the returned
  state doesn't match or the cookie is missing entirely. Verified with a
  direct test using a forged mismatched state and a request with the
  state cookie stripped — both correctly rejected with no session created.
- **Conversation isolation:** every query in `db.js` is scoped by
  `user_id`. `addMessage` additionally verifies conversation ownership
  before inserting.
- **Model allowlist:** `/api/chat` never forwards a client-supplied model
  string directly to Gemini or Mistral — it's only ever used as a lookup
  key into `models.js`'s fixed registry, which resolves it to a
  provider-strategy entry, not a passthrough value.
- **Quiz parsing is output-side only:** the quiz format spec is appended
to the system prompt server-side (never client-controlled), and the
parser only reads the provider's final text — it never feeds model
output back into a request. Model-provided quiz content is validated
against a strict shape and escaped before rendering, like any other AI
output.
- **Plain-text quiz normalization is double-gated:** conversion only
happens when the user's last message clearly asks for an interactive
quiz/test AND the response contains extractable multiple-choice
structure (numbered questions + ≥2 options + a resolvable answer). A
numbered list, essay, or prose answer is never converted, so normal
chat behavior is preserved.
- **Retryable vs. permanent provider failures:** `providers.js`'s
  `isRetryableFailure()` only treats HTTP 429/500/502/503/504 and
  `RESOURCE_EXHAUSTED`/`UNAVAILABLE`/quota provider error codes as
  fallback-eligible. A bad API key, malformed request, or invalid model
  configuration is surfaced directly — a fallback would either mask a real
  configuration problem or just fail identically against the other
  provider. Verified with a dedicated 15-case unit test covering every
  listed status/code plus several non-retryable cases (401, 400, 403, 404,
  422, `INVALID_ARGUMENT`).
- **Rate limiting:** 30 req/min per IP on `/api/chat`, 10 req/min per IP
  on `/api/auth/*`.

## Project structure

```
aura-ai/
├── server.js         # Express app: static frontend, /api/chat routing (see runChatWithFallback), auth + OAuth + conversation routes
├── models.js          # Aura display name ↔ {provider strategy, Gemini model ID, Mistral model ID} registry (the only place this mapping lives)
├── components.js       # Structured response components — quiz system-prompt appendix, quiz intent detection, ```quiz JSON parsing/validation, and plain-text quiz → component normalization (provider-agnostic)
├── providers.js         # Gemini + Mistral HTTP clients and retryable-failure classification — no routing logic, just the calls
├── attachments.js         # Server-side attachment validation — magic-byte type detection, size/count limits (used by server.js's /api/chat)
├── oauth.js            # Google OAuth 2.0 authorization code flow (server-side only)
├── db.js                # Postgres access layer — schema (incl. Google OAuth columns) + all queries, scoped by user_id
├── auth.js                # Password hashing, session tokens, auth middleware
├── package.json              # dependencies: express, cookie-parser, bcryptjs, pg (no provider SDK, no upload middleware — plain fetch + native FileReader/base64)
├── railway.json                # Railway build/deploy config
├── .env.example                  # environment variable reference, incl. Mistral + Google OAuth
├── .gitignore
└── public/
    ├── index.html          # UI shell + styles — welcome modal, sidebar account card, settings, attachment composer
    ├── app.js               # Frontend logic: chat, markdown rendering, settings, auth UI, attachments (selection/preview/removal), TTS, guest/account conversation handling
    ├── components.js         # Frontend component renderers — paginated interactive quiz card (progress, prev/next, submit, score, review, retry)
    └── pipeline.js            # Aura pipeline — mood detector, engine, cringe detector, memory, scoring (unchanged)
```

## Deploy to Railway

1. Push to GitHub, then **Deploy from GitHub repo** on Railway.
2. **Add Postgres** (optional, for accounts): **+ New → Database →
   PostgreSQL**. `DATABASE_URL` is injected automatically.
3. **Set environment variables** (Variables tab):
   ```
   GEMINI_API_KEY = your-real-gemini-key
   MISTRAL_API_KEY = your-real-mistral-key
   ```
   `GEMINI_API_KEY` powers Aura 1 Flash and Aura 1 Flash Lite as their
   primary provider. `MISTRAL_API_KEY` powers Aura 1 Pro directly, and
   also serves as the automatic fallback for Flash/Flash Lite if Gemini
   has a genuine outage. Either can technically be omitted (the affected
   model(s) return a clean "not configured" error instead of crashing),
   but setting both is what actually enables the fallback behavior.

   Optional: `NODE_ENV=production`, and the three `GOOGLE_*` variables
   above for Google sign-in.
4. **Deploy.** Railway runs `npm install` then `npm start`. On first boot
   with Postgres attached, the server creates all tables automatically —
   including migration-safe `ALTER TABLE` statements so upgrading an
   already-deployed database (adding Google OAuth columns to an existing
   `users` table) is a no-op-safe operation, not a destructive migration.
5. Open the Railway URL — first-time logged-out visitors see the welcome
   modal; Settings → General shows connection status for Gemini, and the
   account area reflects whether Postgres/Google OAuth are configured.
   (Mistral's configuration status is intentionally not exposed in
   Settings or `/api/health` — see Security notes.)

## Local development

```bash
npm install
cp .env.example .env
# edit .env: GEMINI_API_KEY required; DATABASE_URL and GOOGLE_* optional
export GEMINI_API_KEY=your-real-gemini-key
export MISTRAL_API_KEY=your-real-mistral-key
npm start
```

Open http://localhost:3000. Leave `NODE_ENV` unset locally so cookies work
over plain `http://`.

## Testing performed on this version

Everything below was actually executed, not just read for plausibility —
using a hand-built Express/Postgres test harness (this sandbox has no
package registry access, so real `npm install`/live Postgres wasn't
possible; the harness simulates their request/response and query
contracts closely enough to exercise the real, unmodified application
code, and every harness bug hit during development was found, diagnosed,
and fixed before trusting its results).

- **Backend syntax**: `server.js`, `db.js`, `auth.js`, `models.js`,
  `oauth.js` all pass `node --check`.
- **Frontend syntax**: `app.js` passes `node --check`; the module also
  loads and runs to completion (all top-level code, all event listener
  registration, the full async `checkAuthAndInit()`) against a hand-built
  DOM/localStorage stub with zero errors.
- **Google OAuth end-to-end** (9 checks): health reports `googleOAuthEnabled`
  correctly; `/api/auth/google` redirects to Google with a state cookie
  set; callback with a valid code+state creates a session that resolves to
  the correct Google user; mismatched state rejected; missing state cookie
  rejected; Google denial handled without crashing; a second login with
  the same Google ID returns to the same account rather than duplicating
  it; a Google login using an email that already has a password account
  links to that same account (verified by matching user ID) instead of
  creating a duplicate.
- **Model registry & forgery protection**: public model list never
  contains a raw Gemini or Mistral ID, provider name, or strategy field;
  valid display names resolve correctly; a forged raw Gemini model ID
  (`gemini-2.5-flash`) AND a forged raw Mistral model ID
  (`mistral-large-latest`) sent directly as the `model` field both safely
  fall back to the default and the response correctly reports
  `"Aura 1 Flash"` in every case.
- **Multi-provider routing & fallback (12 scenarios from the provider
  architecture spec, all executed against the real, unmodified
  `server.js` with fake Gemini/Mistral `fetch` responses)**:
  1. Aura 1 Flash + Gemini succeeds → Gemini response returned, Mistral
     never called (call counters confirm 1 Gemini call, 0 Mistral calls).
  2. Aura 1 Flash + Gemini 429 → Mistral fallback used; response `model`
     field still reads `"Aura 1 Flash"`, never revealing the fallback.
  3. Aura 1 Flash + Gemini 503 → Mistral fallback used.
  4. Aura 1 Flash Lite + Gemini succeeds → Gemini response, no fallback.
  5. Aura 1 Flash Lite + Gemini quota failure (429/`RESOURCE_EXHAUSTED`)
     → Mistral fallback used.
  6. Aura 1 Pro → Mistral called directly; Gemini call counter stays at 0
     for the entire request.
  7. Gemini fails retryably (500) *and* the Mistral fallback also fails
     (500) → a clean generic error is returned; the response body was
     checked to contain neither the raw Mistral error text nor the word
     "mistral" in any case.
  8. `MISTRAL_API_KEY` unset: (a) Aura 1 Pro returns a clean 5xx
     config error without crashing, and the error body was checked to
     never contain the literal string `MISTRAL_API_KEY`; (b) Aura 1 Flash
     with a retryable Gemini failure and no Mistral key configured
     reports as a Gemini failure rather than crashing or hanging.
  9. Invalid/expired Gemini key simulated as HTTP 401 → Mistral call
     counter stays at 0 (confirming non-retryable failures are never
     silently papered over with a fallback) and a clean error is
     returned.
  10. Forged model IDs (both a stale raw Gemini ID and a raw Mistral ID)
      → existing default-fallback behavior in the model registry,
      unaffected by the new provider logic.
  11. Grepped `public/app.js` and `public/index.html`: zero occurrences
      of `MISTRAL_API_KEY` anywhere (not even as a variable name, unlike
      `GEMINI_API_KEY` which does appear in pre-existing help text);
      reviewed every `res.json()` call site in `server.js` and confirmed
      none references either key variable.
  12. Full existing regression suite (17 checks: health, signup,
      duplicate-email rejection, wrong-password rejection, logout/session
      invalidation, Google OAuth initiate/callback/CSRF-state-rejection,
      conversation creation, unauthenticated-request blocking, cross-user
      read/delete isolation, an end-to-end chat call through the new
      routing path, and both the auth and chat rate limiters under burst)
      re-run after the provider changes — all still pass.

  Additionally, `providers.js`'s `isRetryableFailure()` was unit-tested
  directly against all 15 cases named in the spec (429/500/502/503/504,
  `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, and the non-retryable
  401/400/403/404/422/`INVALID_ARGUMENT`/no-signal cases) — all 15 pass.

- **Guest-mode persistence**: static audit of every `localStorage` call in
  `app.js` (none touch chat content); a real simulated send-message flow
  driven through the actual `handleSend()` code path against a DOM stub,
  confirming zero chat content in resulting storage; a simulated fresh
  module load (representing a refresh) with pre-existing storage state
  present still renders only the empty state, no restored messages.
- **Auth flows**: signup, duplicate-email rejection, wrong-password
  rejection, correct login, logout + session invalidation — all via
  real HTTP-shaped requests against the actual route handlers.
- **Cross-user isolation**: a second user gets 404 attempting to read
  *or* rename the first user's conversation.
- **Rate limiting**: auth endpoint burst test confirms the 429 response
  fires under load.
- **CSS cascade for the new auth modal / sidebar account card**: traced
  actual specificity and media-query nesting (not just selector
  presence); found and fixed a real bug where the auth modal had no
  scroll capability, meaning content could be clipped unreachably on
  short/landscape mobile viewports; found and hardened a fragile
  inline-style-dependent positioning rule for the sidebar popover;
  added a global `:focus-visible` style since no button previously had
  any visible keyboard-focus indicator beyond the browser default.
- **DOM/ID consistency**: every `$('id')` reference in `app.js` (76
  total) cross-checked against `index.html` — zero missing elements;
  zero duplicate `id` attributes anywhere in the page.
- **Scope discipline**: `diff`-checked `public/pipeline.js`, `public/app.js`,
  and `public/index.html` against the pre-Mistral version — all three are
  byte-for-byte identical, confirming the provider architecture change
  touched only `server.js`, `models.js` (rewritten), and the new
  `providers.js`, with zero incidental changes to the Aura Engine, Mood
  Detector, Query Classifier, Cringe Detector, memory, scoring, or any
  frontend code.
- **Quiz components end-to-end** (`test-quiz.js`): a real HTTP POST to the
  real `/api/chat` route (real express app, only the provider `fetch`
  stubbed) with the exact prompt "Create a 5-question quiz about space."
  — asserts the actual response contains `components[0].type === "quiz"`.
  Regression coverage includes: the structured ```quiz fence path (5
  validated questions, JSON stripped from `text`, format spec confirmed
  in the provider's system prompt); the plain-text normalization fallback
  for the exact space prompt, "Quiz me on photosynthesis," and "Make a
  math quiz" (different option layouts — option lines, inline
  parentheses, inline letters with single-digit answers — all converted
  to the same schema with answers resolved); non-quiz requests ("Give me
  5 tips to improve sleep") with numbered-list responses → `components:
  []` and text untouched (no false positives); quiz intent with a prose
  response → never converted; a bare-JSON quiz with no fence still
  parses; malformed quiz JSON degrades to no component without crashing;
  and the response keeps the standard `{ text, model, latencyMs,
  truncated, components }` shape. **Frontend** (`test-frontend.js`,
  jsdom): the real `app.js` + `public/components.js` load and run against
  a real DOM, and the full paginated quiz interactivity is exercised —
  one question at a time, progress label/bar, Back/Next, submit gated
  until all questions are answered, score, review with per-question
  correct/wrong marks and explanations, Retry, `addAI()` placing the card
  directly below the message text bubble, empty components being a no-op,
  and model-provided text escaping (no HTML injection).

### Known limitations

- This sandbox cannot run a live `npm install` (no package registry
  access) or connect to a real Postgres/Railway instance, so final
  confirmation on an actual Railway deployment with real Gemini/Google
  credentials is still worth doing once — the test harness closely
  mirrors Express's and `pg`'s real contracts, but "closely mirrors" is
  not "is."
- No automated test exists for actual pixel rendering (font metrics,
  exact wrapping) — the CSS cascade/specificity/overflow analysis is
  real and mathematically grounded in the actual property values, but a
  quick manual look on a real device after deploying is still worthwhile.
- Password reset via email is out of scope (no email provider wired up).
  A signed-in user can change their password directly, which rotates all
  existing sessions for that account.
