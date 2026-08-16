// Aura AI — research/store.js
// Session store for Deep Research. Two tiers, mirroring the rest of Aura:
//   - Postgres when DATABASE_URL is configured → sessions survive restarts
//     ("continue my research" works days later, for logged-in owners).
//   - In-memory Map otherwise (guests / no-DB deploys) → sessions live as
//     long as the server process does, exactly like guest chat philosophy.
// The full session (plan, sources, evidence, conflicts, findings, charts,
// report, QC, events, stats) is one versioned JSONB document per row —
// simple to persist, migrate, and resume.

const crypto = require('crypto');
const db = require('../db');

const memoryStore = new Map(); // id -> session
const MEMORY_MAX = 60;         // bound guest memory; oldest non-running first

function ownerKey(req) {
  // Logged-in users own sessions by user id. Guests get a stable per-IP key
  // — no persistent guest identity is created (hashed, never stored
  // client-side, and only meaningful for the lifetime of the store).
  if (req.user?.id) return `user:${req.user.id}`;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  return `guest:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24)}`;
}

function owns(session, owner) { return session.owner === owner; }

async function save(session) {
  session.updatedAt = Date.now();
  if (db.isConfigured()) {
    try {
      await db.query(
        `INSERT INTO research_sessions (id, owner, query, mode, effective_mode, state, parent_id, document, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),to_timestamp($10/1000.0))
         ON CONFLICT (id) DO UPDATE SET
           query = EXCLUDED.query, mode = EXCLUDED.mode, effective_mode = EXCLUDED.effective_mode,
           state = EXCLUDED.state, document = EXCLUDED.document, updated_at = EXCLUDED.updated_at`,
        [
          session.id, session.owner, session.query, session.mode, session.effectiveMode,
          session.state, session.parentId,
          JSON.stringify(session), session.createdAt, session.updatedAt,
        ]
      );
      return;
    } catch (err) {
      console.error('research session persist failed (falling back to memory):', err.message);
      // fall through to memory so research still works if the DB hiccups
    }
  }
  memoryStore.set(session.id, session);
  if (memoryStore.size > MEMORY_MAX) {
    const oldest = [...memoryStore.values()]
      .filter(s => !require('./engine').isRunning(s.id))
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldest) memoryStore.delete(oldest.id);
  }
}

// Load from memory first (always the freshest copy while running), then DB.
async function load(id) {
  const live = memoryStore.get(id);
  if (live) return live;
  if (db.isConfigured()) {
    try {
      const res = await db.query(`SELECT document FROM research_sessions WHERE id = $1`, [id]);
      if (res.rows.length > 0) {
        const session = JSON.parse(res.rows[0].document);
        memoryStore.set(id, session);
        return session;
      }
    } catch (err) {
      console.error('research session load failed:', err.message);
    }
  }
  return null;
}

async function list(owner, limit = 40) {
  const results = [];
  if (db.isConfigured()) {
    try {
      const res = await db.query(
        `SELECT id, query, mode, effective_mode, state, created_at, updated_at
         FROM research_sessions WHERE owner = $1 ORDER BY updated_at DESC LIMIT $2`,
        [owner, limit]
      );
      for (const row of res.rows) {
        results.push({
          id: row.id, query: row.query, mode: row.mode, effectiveMode: row.effective_mode,
          state: row.state, createdAt: new Date(row.created_at).getTime(), updatedAt: new Date(row.updated_at).getTime(),
        });
      }
      return results;
    } catch (err) {
      console.error('research list failed (memory only):', err.message);
    }
  }
  for (const s of [...memoryStore.values()].filter(s => owns(s, owner)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)) {
    results.push({ id: s.id, query: s.query, mode: s.mode, effectiveMode: s.effectiveMode, state: s.state, createdAt: s.createdAt, updatedAt: s.updatedAt });
  }
  return results;
}

async function remove(id, owner) {
  const session = await load(id);
  if (!session || !owns(session, owner)) return false;
  memoryStore.delete(id);
  if (db.isConfigured()) {
    try { await db.query(`DELETE FROM research_sessions WHERE id = $1 AND owner = $2`, [id, owner]); } catch { /* memory delete already done */ }
  }
  return true;
}

module.exports = { ownerKey, owns, save, load, list, remove };
