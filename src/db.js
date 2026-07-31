// Base de donnees locale (SQLite integre a Node, aucune dependance a installer).
// Tout reste dans data/chatmate.db, sur la machine. Rien n'est envoye ailleurs.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Hosts mount their persistent disk somewhere else, so the location is overridable.
const DATA_DIR = process.env.CHATMATE_DATA_DIR || join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'chatmate.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  -- Settings are per account, hence the composite key rather than a single row.
  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS fans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    handle        TEXT NOT NULL,
    display_name  TEXT DEFAULT '',
    notes         TEXT DEFAULT '',
    kinks         TEXT DEFAULT '',
    timezone      TEXT DEFAULT '',
    total_spent   REAL DEFAULT 0,
    blocked       INTEGER DEFAULT 0,
    block_reason  TEXT DEFAULT '',
    created_at    TEXT NOT NULL,
    last_activity TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    fan_id     INTEGER NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,           -- 'fan' | 'creator'
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_fan ON messages(fan_id, id);

  CREATE TABLE IF NOT EXISTS purchases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    fan_id     INTEGER NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
    amount     REAL NOT NULL,
    label      TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_purchases_fan ON purchases(fan_id);

  CREATE TABLE IF NOT EXISTS media (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    tags       TEXT DEFAULT '',
    price      REAL DEFAULT 0,
    notes      TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  -- Every pitch she actually sends, and whether it converted. This is the only
  -- place the app learns what works instead of just what was tried.
  CREATE TABLE IF NOT EXISTS offers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fan_id      INTEGER NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
    media_id    INTEGER,
    media_title TEXT DEFAULT '',
    price       REAL DEFAULT 0,
    push        TEXT DEFAULT '',      -- soft | medium | hard
    personality TEXT DEFAULT '',
    cta_level   INTEGER DEFAULT 0,
    stage       TEXT DEFAULT '',
    message     TEXT DEFAULT '',
    outcome     TEXT DEFAULT 'pending', -- pending | bought | declined
    created_at  TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_offers_fan ON offers(fan_id);
  CREATE INDEX IF NOT EXISTS idx_offers_outcome ON offers(outcome);

  -- Platform numbers she screenshots from Fansly. Kept as a time series so the
  -- manager can talk about direction, not just today's figure.
  CREATE TABLE IF NOT EXISTS platform_stats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT DEFAULT '',
    metrics     TEXT NOT NULL,        -- JSON: { "followers": 1200, ... }
    captured_at TEXT NOT NULL
  );

  -- Competitors she found herself in Fansly search and screenshotted. The model is
  -- forbidden from naming any creator outside this table, which is what stops it
  -- from inventing accounts that do not exist.
  CREATE TABLE IF NOT EXISTS competitors (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    handle       TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    followers    INTEGER,
    subscribers  INTEGER,
    price        REAL,
    bio          TEXT DEFAULT '',
    themes       TEXT DEFAULT '',
    notes        TEXT DEFAULT '',
    captured_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS strategies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT DEFAULT '',
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS manager_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    role       TEXT NOT NULL,           -- 'user' | 'assistant'
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS media_sent (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    fan_id   INTEGER NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    price    REAL DEFAULT 0,
    sent_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_sent_fan ON media_sent(fan_id);
`);

// Migrations: adding a column to an existing database. Idempotent, the throw on
// an already-existing column is the expected path after the first run.
for (const sql of [
  "ALTER TABLE fans ADD COLUMN personality TEXT DEFAULT ''",
  // Multi-account: every top-level table is scoped to its owner. Rows created
  // before accounts existed keep user_id NULL and are adopted at first signup.
  'ALTER TABLE fans ADD COLUMN user_id INTEGER',
  'ALTER TABLE media ADD COLUMN user_id INTEGER',
  'ALTER TABLE offers ADD COLUMN user_id INTEGER',
  'ALTER TABLE manager_messages ADD COLUMN user_id INTEGER',
  'ALTER TABLE platform_stats ADD COLUMN user_id INTEGER',
  'ALTER TABLE competitors ADD COLUMN user_id INTEGER',
  'ALTER TABLE strategies ADD COLUMN user_id INTEGER',
  // Categorical insights: traffic sources, hashtags, best posts. Kept apart from
  // `metrics` because these are lists and shares, not single numbers.
  'ALTER TABLE platform_stats ADD COLUMN breakdowns TEXT'
]) {
  try { db.exec(sql); } catch { /* column already there */ }
}

for (const sql of [
  'CREATE INDEX IF NOT EXISTS idx_fans_user ON fans(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_media_user ON media(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_offers_user ON offers(user_id)'
]) {
  try { db.exec(sql); } catch { /* index already there */ }
}

// The old single-tenant settings table had `key` as the sole primary key.
try {
  const cols = db.prepare('PRAGMA table_info(settings)').all();
  if (cols.length && !cols.some((c) => c.name === 'user_id')) {
    db.exec(`
      ALTER TABLE settings RENAME TO settings_legacy;
      CREATE TABLE settings (
        user_id INTEGER NOT NULL,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      INSERT INTO settings(user_id, key, value) SELECT 0, key, value FROM settings_legacy;
      DROP TABLE settings_legacy;
    `);
  }
} catch { /* already migrated */ }

export const nowISO = () => new Date().toISOString();

/* --------------------------------- Users ---------------------------------- */

/** scrypt with a per-user salt. Slow on purpose: a stolen database stays useless. */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const countUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

export const findUserByEmail = (email) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());

export const getUser = (id) =>
  db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(id);

export function createUser(email, password) {
  const clean = String(email || '').trim().toLowerCase();
  const info = db.prepare(
    'INSERT INTO users(email, password_hash, created_at) VALUES(?, ?, ?)'
  ).run(clean, hashPassword(password), nowISO());

  const id = Number(info.lastInsertRowid);
  adoptOrphanRows(id);
  return getUser(id);
}

/**
 * Everything created before accounts existed has no owner. The first account to
 * be created takes it over, so she does not lose her fans on upgrade.
 */
function adoptOrphanRows(userId) {
  if (countUsers() !== 1) return;
  for (const table of [
    'fans', 'media', 'offers', 'manager_messages', 'platform_stats', 'competitors', 'strategies'
  ]) {
    try { db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(userId); } catch { /* table may be empty */ }
  }
  try { db.prepare('UPDATE settings SET user_id = ? WHERE user_id = 0').run(userId); } catch { /* nothing to move */ }
}

/* ------------------------------- Reglages -------------------------------- */

export const DEFAULT_CONFIG = {
  personaName: '',
  tone: 'warm, teasing, playful. Short messages, loose punctuation, lowercase.',
  styleSamples: '',
  exampleConversations: '',
  hardLimits: '',
  forbiddenWords: [],
  priceList: '',
  currency: 'USD',
  whaleThreshold: 200,
  silentDays: 5,
  explicitness: 'direct',
  defaultPersonality: 'sweet',
  language: 'en',
  llmProvider: 'mock',
  llmBaseUrl: 'https://openrouter.ai/api/v1',
  llmModel: '',
  // Reading screenshots needs a model that accepts images. Kept separate because
  // the writing model is usually not the best or cheapest one for that.
  llmVisionModel: 'qwen/qwen3.7-flash',
  // OpenRouter runs a web search plugin when ":online" is appended to a model id.
  // Off by default because it costs noticeably more per question.
  managerWebSearch: false,
  // Her own Fansly handle, so the stats can be refreshed in one tap.
  fanslyHandle: '',
  llmApiKey: ''
};

export function getConfig(userId) {
  const row = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, 'config');
  if (!row) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(userId, patch) {
  const merged = { ...getConfig(userId), ...patch };
  db.prepare(`
    INSERT INTO settings(user_id, key, value) VALUES(?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(userId, 'config', JSON.stringify(merged));
  return merged;
}

/* --------------------------------- Fans ---------------------------------- */

export function listFans(userId) {
  return db.prepare(`
    SELECT f.*,
           (SELECT COUNT(*) FROM messages m WHERE m.fan_id = f.id)  AS message_count,
           (SELECT COUNT(*) FROM purchases p WHERE p.fan_id = f.id) AS purchase_count,
           (SELECT m.role FROM messages m WHERE m.fan_id = f.id ORDER BY m.id DESC LIMIT 1) AS last_role,
           (SELECT m.content FROM messages m WHERE m.fan_id = f.id ORDER BY m.id DESC LIMIT 1) AS last_message
    FROM fans f
    WHERE f.user_id = ?
    ORDER BY f.last_activity DESC
  `).all(userId);
}

// Scoped by owner on purpose: an id from another account must come back empty,
// which is what makes every route that calls this tenant-safe.
export function getFan(userId, id) {
  return db.prepare(`
    SELECT f.*,
           (SELECT COUNT(*) FROM messages m WHERE m.fan_id = f.id)  AS message_count,
           (SELECT COUNT(*) FROM purchases p WHERE p.fan_id = f.id) AS purchase_count
    FROM fans f WHERE f.id = ? AND f.user_id = ?
  `).get(id, userId);
}

export function createFan(userId, {
  handle, display_name = '', notes = '', kinks = '', timezone = '', personality = ''
}) {
  const ts = nowISO();
  const info = db.prepare(`
    INSERT INTO fans(user_id, handle, display_name, notes, kinks, timezone, personality, created_at, last_activity)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, handle, display_name, notes, kinks, timezone, personality, ts, ts);
  return getFan(userId, Number(info.lastInsertRowid));
}

const FAN_FIELDS = [
  'handle', 'display_name', 'notes', 'kinks', 'timezone', 'personality', 'blocked', 'block_reason'
];

export function updateFan(userId, id, patch) {
  const keys = Object.keys(patch).filter((k) => FAN_FIELDS.includes(k));
  if (keys.length) {
    const sql = `UPDATE fans SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`;
    db.prepare(sql).run(...keys.map((k) => patch[k]), id, userId);
  }
  return getFan(userId, id);
}

export function deleteFan(userId, id) {
  if (!getFan(userId, id)) return false;
  db.prepare('DELETE FROM media_sent WHERE fan_id = ?').run(id);
  db.prepare('DELETE FROM purchases WHERE fan_id = ?').run(id);
  db.prepare('DELETE FROM messages WHERE fan_id = ?').run(id);
  db.prepare('DELETE FROM offers WHERE fan_id = ?').run(id);
  db.prepare('DELETE FROM fans WHERE id = ? AND user_id = ?').run(id, userId);
  return true;
}

function touchFan(fanId) {
  db.prepare('UPDATE fans SET last_activity = ? WHERE id = ?').run(nowISO(), fanId);
}

/* ------------------------------- Messages -------------------------------- */

export function listMessages(fanId, limit = 400) {
  return db.prepare(
    'SELECT * FROM messages WHERE fan_id = ? ORDER BY id DESC LIMIT ?'
  ).all(fanId, limit).reverse();
}

export function addMessage(fanId, role, content) {
  const info = db.prepare(
    'INSERT INTO messages(fan_id, role, content, created_at) VALUES(?, ?, ?, ?)'
  ).run(fanId, role, content, nowISO());
  touchFan(fanId);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function deleteMessage(userId, id) {
  // A message has no owner of its own, so ownership is checked through its fan.
  const owned = db.prepare(`
    SELECT m.id FROM messages m JOIN fans f ON f.id = m.fan_id
    WHERE m.id = ? AND f.user_id = ?
  `).get(id, userId);
  if (!owned) return false;
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  return true;
}

/* ------------------------------- Achats ---------------------------------- */

export function listPurchases(fanId) {
  return db.prepare('SELECT * FROM purchases WHERE fan_id = ? ORDER BY id DESC').all(fanId);
}

export function addPurchase(userId, fanId, amount, label = '') {
  db.prepare(
    'INSERT INTO purchases(fan_id, amount, label, created_at) VALUES(?, ?, ?, ?)'
  ).run(fanId, amount, label, nowISO());
  db.prepare('UPDATE fans SET total_spent = total_spent + ? WHERE id = ?').run(amount, fanId);
  touchFan(fanId);
  return getFan(userId, fanId);
}

/* -------------------------------- Medias --------------------------------- */

export function listMedia(userId) {
  return db.prepare('SELECT * FROM media WHERE user_id = ? ORDER BY id DESC').all(userId);
}

export function createMedia(userId, { title, tags = '', price = 0, notes = '' }) {
  const info = db.prepare(
    'INSERT INTO media(user_id, title, tags, price, notes, created_at) VALUES(?, ?, ?, ?, ?, ?)'
  ).run(userId, title, tags, price, notes, nowISO());
  return db.prepare('SELECT * FROM media WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function deleteMedia(userId, id) {
  const owned = db.prepare('SELECT id FROM media WHERE id = ? AND user_id = ?').get(id, userId);
  if (!owned) return false;
  db.prepare('DELETE FROM media_sent WHERE media_id = ?').run(id);
  db.prepare('DELETE FROM media WHERE id = ? AND user_id = ?').run(id, userId);
  return true;
}

export function listMediaSent(fanId) {
  return db.prepare(`
    SELECT ms.*, m.title, m.tags
    FROM media_sent ms JOIN media m ON m.id = ms.media_id
    WHERE ms.fan_id = ? ORDER BY ms.id DESC
  `).all(fanId);
}

/* --------------------------------- Offers --------------------------------- */

export function createOffer(userId, fanId, data) {
  const info = db.prepare(`
    INSERT INTO offers(user_id, fan_id, media_id, media_title, price, push, personality,
                       cta_level, stage, message, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    fanId,
    data.media_id ?? null,
    data.media_title || '',
    Number(data.price) || 0,
    data.push || '',
    data.personality || '',
    Number(data.cta_level) || 0,
    data.stage || '',
    data.message || '',
    nowISO()
  );
  return db.prepare('SELECT * FROM offers WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function getOffer(userId, id) {
  return db.prepare('SELECT * FROM offers WHERE id = ? AND user_id = ?').get(id, userId);
}

export function resolveOffer(userId, id, outcome) {
  db.prepare('UPDATE offers SET outcome = ?, resolved_at = ? WHERE id = ? AND user_id = ?')
    .run(outcome, nowISO(), id, userId);
  return getOffer(userId, id);
}

export function listPendingOffers(userId, fanId = null) {
  const base = "SELECT o.*, f.handle, f.display_name FROM offers o JOIN fans f ON f.id = o.fan_id WHERE o.outcome = 'pending' AND o.user_id = ?";
  return fanId
    ? db.prepare(`${base} AND o.fan_id = ? ORDER BY o.id DESC`).all(userId, fanId)
    : db.prepare(`${base} ORDER BY o.id DESC LIMIT 40`).all(userId);
}

/** Conversion broken down by whatever column we group on. */
function conversionBy(userId, column) {
  return db.prepare(`
    SELECT ${column} AS key,
           COUNT(*) AS sent,
           SUM(CASE WHEN outcome = 'bought' THEN 1 ELSE 0 END) AS bought,
           SUM(CASE WHEN outcome = 'bought' THEN price ELSE 0 END) AS revenue
    FROM offers
    WHERE user_id = ? AND outcome IN ('bought', 'declined') AND ${column} <> ''
    GROUP BY ${column}
    ORDER BY sent DESC
  `).all(userId).map((r) => ({
    ...r,
    rate: r.sent ? Math.round((r.bought / r.sent) * 100) : 0
  }));
}

export function offerStats(userId) {
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN outcome = 'bought'   THEN 1 ELSE 0 END) AS bought,
           SUM(CASE WHEN outcome = 'declined' THEN 1 ELSE 0 END) AS declined,
           SUM(CASE WHEN outcome = 'pending'  THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN outcome = 'bought'   THEN price ELSE 0 END) AS revenue
    FROM offers WHERE user_id = ?
  `).get(userId);

  const resolved = (totals.bought || 0) + (totals.declined || 0);

  return {
    total: totals.total || 0,
    bought: totals.bought || 0,
    declined: totals.declined || 0,
    pending: totals.pending || 0,
    resolved,
    rate: resolved ? Math.round((totals.bought / resolved) * 100) : null,
    revenue: totals.revenue || 0,
    byPush: conversionBy(userId, 'push'),
    byPersonality: conversionBy(userId, 'personality'),
    byMedia: conversionBy(userId, 'media_title'),
    byStage: conversionBy(userId, 'stage')
  };
}

/* --------------------------- Platform snapshots ---------------------------- */

export function addPlatformStats(userId, label, metrics, breakdowns = null) {
  const info = db.prepare(
    'INSERT INTO platform_stats(user_id, label, metrics, breakdowns, captured_at) VALUES(?, ?, ?, ?, ?)'
  ).run(
    userId,
    label || '',
    JSON.stringify(metrics || {}),
    breakdowns ? JSON.stringify(breakdowns) : null,
    nowISO()
  );
  return db.prepare('SELECT * FROM platform_stats WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function listPlatformStats(userId, limit = 12) {
  return db.prepare('SELECT * FROM platform_stats WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
    .map((r) => {
      let metrics = {};
      let breakdowns = {};
      try { metrics = JSON.parse(r.metrics); } catch { /* keep empty */ }
      try { if (r.breakdowns) breakdowns = JSON.parse(r.breakdowns); } catch { /* keep empty */ }
      return { ...r, metrics, breakdowns };
    })
    .reverse();
}

export function deletePlatformStats(userId, id) {
  db.prepare('DELETE FROM platform_stats WHERE id = ? AND user_id = ?').run(id, userId);
}

/* ------------------------------- Competitors ------------------------------- */

export function listCompetitors(userId) {
  return db.prepare('SELECT * FROM competitors WHERE user_id = ? ORDER BY followers DESC NULLS LAST, id DESC').all(userId);
}

export function addCompetitor(userId, data) {
  const info = db.prepare(`
    INSERT INTO competitors(user_id, handle, display_name, followers, subscribers, price, bio, themes, notes, captured_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    String(data.handle || '').slice(0, 60),
    String(data.display_name || '').slice(0, 80),
    Number.isFinite(Number(data.followers)) ? Number(data.followers) : null,
    Number.isFinite(Number(data.subscribers)) ? Number(data.subscribers) : null,
    Number.isFinite(Number(data.price)) ? Number(data.price) : null,
    String(data.bio || '').slice(0, 600),
    String(data.themes || '').slice(0, 300),
    String(data.notes || '').slice(0, 600),
    nowISO()
  );
  return db.prepare('SELECT * FROM competitors WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function deleteCompetitor(userId, id) {
  db.prepare('DELETE FROM competitors WHERE id = ? AND user_id = ?').run(id, userId);
}

/* -------------------------------- Strategies ------------------------------- */

export function saveStrategy(userId, title, content) {
  const info = db.prepare(
    'INSERT INTO strategies(user_id, title, content, created_at) VALUES(?, ?, ?, ?)'
  ).run(userId, title || '', content, nowISO());
  return db.prepare('SELECT * FROM strategies WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function listStrategies(userId, limit = 10) {
  return db.prepare('SELECT * FROM strategies WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
}

export function getStrategy(userId, id) {
  return db.prepare('SELECT * FROM strategies WHERE id = ? AND user_id = ?').get(id, userId);
}

export function deleteStrategy(userId, id) {
  db.prepare('DELETE FROM strategies WHERE id = ? AND user_id = ?').run(id, userId);
}

/* ----------------------------- Manager chat ------------------------------- */

export function listManagerMessages(userId, limit = 40) {
  return db.prepare(
    'SELECT * FROM manager_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  ).all(userId, limit).reverse();
}

export function addManagerMessage(userId, role, content) {
  const info = db.prepare(
    'INSERT INTO manager_messages(user_id, role, content, created_at) VALUES(?, ?, ?, ?)'
  ).run(userId, role, content, nowISO());
  return db.prepare('SELECT * FROM manager_messages WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function clearManagerMessages(userId) {
  db.prepare('DELETE FROM manager_messages WHERE user_id = ?').run(userId);
}

/* -------------------------------------------------------------------------- */

export function markMediaSent(fanId, mediaId, price = 0) {
  db.prepare(
    'INSERT INTO media_sent(fan_id, media_id, price, sent_at) VALUES(?, ?, ?, ?)'
  ).run(fanId, mediaId, price, nowISO());
  touchFan(fanId);
  return listMediaSent(fanId);
}
