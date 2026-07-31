// Account sessions. Each request carries a signed cookie holding the user id, and
// every database call is scoped by that id — that is what keeps two accounts from
// ever seeing each other's fans.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { countUsers, createUser, findUserByEmail, getUser, verifyPassword } from './db.js';

const SECRET = (process.env.CHATMATE_SECRET || '').trim() || randomBytes(32).toString('hex');
const MAX_AGE_DAYS = 30;
const COOKIE = 'chatmate_session';

// Set this to allow only these emails to register, once the app is public.
const ALLOWED = (process.env.CHATMATE_ALLOWED_EMAILS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

if (!process.env.CHATMATE_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('\n  WARNING: CHATMATE_SECRET is not set.');
  console.warn('  Sessions will be invalidated on every restart.\n');
}

/* --------------------------------- Tokens ---------------------------------- */

const sign = (payload) => createHmac('sha256', SECRET).update(payload).digest('hex');

function makeToken(userId) {
  const body = `${userId}.${Date.now() + MAX_AGE_DAYS * 86400000}`;
  return `${body}.${sign(body)}`;
}

function readToken(token) {
  const [userId, expires, mac] = String(token || '').split('.');
  if (!userId || !expires || !mac) return null;
  if (Number(expires) < Date.now()) return null;

  const expected = sign(`${userId}.${expires}`);
  if (expected.length !== mac.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  } catch {
    return null;
  }
  return Number(userId);
}

/* ------------------------------ Login attempts ----------------------------- */

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function tooMany(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return false; }
  return rec.count >= MAX_ATTEMPTS;
}

function noteFailure(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else rec.count += 1;
}

/* --------------------------------- Cookies --------------------------------- */

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function sessionCookie(userId) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  return `${COOKIE}=${makeToken(userId)}; HttpOnly; SameSite=Lax;${secure} Path=/; Max-Age=${MAX_AGE_DAYS * 86400}`;
}

export const logoutCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

export const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

/** Returns the signed-in user, or null. */
export function currentUser(req) {
  const id = readToken(readCookie(req, COOKIE));
  return id ? getUser(id) || null : null;
}

/* --------------------------------- Actions --------------------------------- */

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
}

export function signup(req, email, password) {
  const clean = String(email || '').trim().toLowerCase();

  if (!validEmail(clean)) return { ok: false, error: 'That email does not look right.' };
  if (String(password || '').length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }
  if (ALLOWED.length && !ALLOWED.includes(clean)) {
    return { ok: false, error: 'Sign-ups are closed on this instance.' };
  }
  if (findUserByEmail(clean)) {
    return { ok: false, error: 'An account already exists for that email.' };
  }

  const user = createUser(clean, password);
  return { ok: true, user, cookie: sessionCookie(user.id) };
}

export function login(req, email, password) {
  const key = clientIp(req);
  if (tooMany(key)) return { ok: false, error: 'Too many attempts. Wait 15 minutes.' };

  const user = findUserByEmail(email);
  // Hash even when the user is unknown, so timing does not reveal which emails exist.
  const ok = verifyPassword(String(password || ''), user?.password_hash || 'scrypt$00$00');

  if (!user || !ok) {
    noteFailure(key);
    return { ok: false, error: 'Wrong email or password.' };
  }

  attempts.delete(key);
  return { ok: true, user: getUser(user.id), cookie: sessionCookie(user.id) };
}

export const hasAccounts = () => countUsers() > 0;
