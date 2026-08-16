// Aura AI — db.js
// Postgres access layer. Uses Railway's managed Postgres (DATABASE_URL is
// injected automatically when a Postgres plugin is attached to the
// service). Falls back cleanly with a clear error if DATABASE_URL is
// missing, so auth/save-history features degrade instead of crashing the
// whole server — guest chat still works with no database at all.

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Railway's internal Postgres doesn't need SSL; external connections
    // during local dev against a Railway-hosted DB do. This satisfies both.
    ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  });
}

function isConfigured() {
  return Boolean(pool);
}

async function query(text, params) {
  if (!pool) throw new Error('DATABASE_NOT_CONFIGURED');
  return pool.query(text, params);
}

// ============================================================
// SCHEMA
// ============================================================
async function ensureSchema() {
  if (!pool) return;

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      google_id TEXT UNIQUE,
      display_name TEXT,
      avatar_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Migration-safe additions for databases created by earlier versions of
  // this app (before Google OAuth existed) — IF NOT EXISTS makes this a
  // no-op on a fresh install and a safe upgrade on an existing production
  // database. password_hash is relaxed to nullable here too, since a
  // Google-only account has no password.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;`).catch(() => {});
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;`).catch(() => {});
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`).catch(() => {});
  await query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;`).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New chat',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, created_at ASC);`);

  // Deep Research sessions — one versioned JSONB document per session
  // (plan, sources, evidence, conflicts, findings, charts, report, QC,
  // events, stats). Created here so an upgraded deploy picks it up
  // migration-safely, same as the OAuth columns above.
  await query(`
    CREATE TABLE IF NOT EXISTS research_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner TEXT NOT NULL,
      query TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'auto',
      effective_mode TEXT NOT NULL DEFAULT 'standard',
      state TEXT NOT NULL DEFAULT 'created',
      parent_id UUID REFERENCES research_sessions(id) ON DELETE SET NULL,
      document JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_research_owner ON research_sessions(owner, updated_at DESC);`);

  // gen_random_uuid() needs pgcrypto on some Postgres images; harmless if already present.
  await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`).catch(() => { /* may lack permission on managed DBs; UUIDs still work if extension already enabled */ });
}

// ============================================================
// USERS
// ============================================================
async function createUser(email, passwordHash) {
  const res = await query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at`,
    [email, passwordHash]
  );
  return res.rows[0];
}

async function findUserByEmail(email) {
  const res = await query(`SELECT * FROM users WHERE email = $1`, [email]);
  return res.rows[0] || null;
}

async function findUserById(id) {
  const res = await query(`SELECT id, email, display_name, avatar_url, created_at FROM users WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function findUserByGoogleId(googleId) {
  const res = await query(`SELECT * FROM users WHERE google_id = $1`, [googleId]);
  return res.rows[0] || null;
}

// Finds or creates a user for a Google-authenticated sign-in. If an
// account with this email already exists (created via email/password
// signup), the Google identity is linked to it rather than creating a
// duplicate account — same person, same conversations either way they
// log in. A brand-new Google-only account has no password_hash at all.
async function findOrCreateGoogleUser({ googleId, email, displayName, avatarUrl }) {
  const byGoogleId = await findUserByGoogleId(googleId);
  if (byGoogleId) return byGoogleId;

  const byEmail = await findUserByEmail(email);
  if (byEmail) {
    await query(
      `UPDATE users SET google_id = $1, display_name = COALESCE(display_name, $2), avatar_url = COALESCE(avatar_url, $3) WHERE id = $4`,
      [googleId, displayName, avatarUrl, byEmail.id]
    );
    return { ...byEmail, google_id: googleId };
  }

  const res = await query(
    `INSERT INTO users (email, google_id, display_name, avatar_url) VALUES ($1, $2, $3, $4) RETURNING *`,
    [email, googleId, displayName, avatarUrl]
  );
  return res.rows[0];
}

async function updateUserPassword(id, passwordHash) {
  await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, id]);
}

async function deleteUser(id) {
  // ON DELETE CASCADE on sessions/conversations handles cleanup.
  await query(`DELETE FROM users WHERE id = $1`, [id]);
}

// ============================================================
// SESSIONS
// ============================================================
async function createSession(token, userId, expiresAt) {
  await query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`, [token, userId, expiresAt]);
}

async function findSession(token) {
  const res = await query(
    `SELECT s.*, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return res.rows[0] || null;
}

async function deleteSession(token) {
  await query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

async function deleteAllSessionsForUser(userId) {
  await query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}

// ============================================================
// CONVERSATIONS + MESSAGES (scoped to user_id everywhere — this is what
// prevents one user from ever reading another user's chats)
// ============================================================
async function listConversations(userId) {
  const res = await query(
    `SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200`,
    [userId]
  );
  return res.rows;
}

async function createConversation(userId, title = 'New chat') {
  const res = await query(
    `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at, updated_at`,
    [userId, title]
  );
  return res.rows[0];
}

async function getConversationWithMessages(userId, convoId) {
  const convoRes = await query(
    `SELECT id, title, created_at, updated_at FROM conversations WHERE id = $1 AND user_id = $2`,
    [convoId, userId]
  );
  const convo = convoRes.rows[0];
  if (!convo) return null;

  const msgRes = await query(
    `SELECT id, role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [convoId]
  );
  convo.messages = msgRes.rows;
  return convo;
}

async function renameConversation(userId, convoId, title) {
  const res = await query(
    `UPDATE conversations SET title = $1, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING id, title`,
    [title, convoId, userId]
  );
  return res.rows[0] || null;
}

async function deleteConversation(userId, convoId) {
  const res = await query(`DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id`, [convoId, userId]);
  return res.rows.length > 0;
}

async function deleteAllConversations(userId) {
  await query(`DELETE FROM conversations WHERE user_id = $1`, [userId]);
}

async function addMessage(userId, convoId, role, content) {
  // Verify ownership first — this is the check that stops user A from
  // writing into user B's conversation by guessing/forging an id.
  const owns = await query(`SELECT id FROM conversations WHERE id = $1 AND user_id = $2`, [convoId, userId]);
  if (owns.rows.length === 0) throw new Error('NOT_FOUND_OR_FORBIDDEN');

  const res = await query(
    `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id, role, content, created_at`,
    [convoId, role, content]
  );
  await query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [convoId]);
  return res.rows[0];
}

module.exports = {
  isConfigured,
  ensureSchema,
  query, // raw parameterized query — used by research/store.js for the
         // research_sessions table. Was missing from this export list,
         // which made every research persist fail with "db.query is not a
         // function" whenever DATABASE_URL was configured (found during
         // real-API validation; unit tests run DB-less so never saw it).
  createUser, findUserByEmail, findUserById, findUserByGoogleId, findOrCreateGoogleUser, updateUserPassword, deleteUser,
  createSession, findSession, deleteSession, deleteAllSessionsForUser,
  listConversations, createConversation, getConversationWithMessages,
  renameConversation, deleteConversation, deleteAllConversations, addMessage,
};
