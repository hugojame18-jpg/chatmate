/**
 * HAR import.
 *
 * A HAR file is a recording her own browser already made while she looked at her
 * Fansly insights. Reading one sends ZERO requests to Fansly: there is no robot,
 * no scraper and no session being replayed. That is the whole point of this route
 * over anything that talks to the platform on her behalf.
 *
 * A HAR does however contain her live session token, so nothing leaves this module
 * until it has been through `redact()`. Only response bodies survive; headers,
 * cookies and query values are dropped before the text is ever shown to a model.
 */

const MAX_BLOCKS = 25;
const MAX_PER_BLOCK = 6000;   // characters of JSON kept per endpoint
const MAX_TOTAL = 60000;      // ~15k tokens, so one import stays cheap

/** Endpoint fragments worth reading, most useful first. Everything else is dropped. */
const WANTED = [
  'statistic', 'stats', 'insight', 'analytic',
  'earning', 'revenue', 'payout', 'transaction',
  'topsupporter', 'topfan', 'tipper',
  'trackinglink', 'referral',
  'subscriber', 'follower', 'subscription',
  'post', 'media', 'timeline', 'account'
];

const isFanslyApi = (url) => {
  let u;
  try { u = new URL(url); } catch { return false; }
  return /(^|\.)fansly\.com$/i.test(u.hostname) && /\/api\//i.test(u.pathname);
};

/** How early the path matches WANTED. Lower is better; -1 means "not wanted". */
const rank = (path) => {
  const p = path.toLowerCase();
  for (let i = 0; i < WANTED.length; i++) if (p.includes(WANTED[i])) return i;
  return -1;
};

/**
 * Strips anything that could be a credential. Two passes, because either alone
 * has a blind spot: the first catches known key names, the second catches any
 * long opaque blob regardless of what it is called.
 */
export function redact(text) {
  return String(text)
    .replace(
      /"(\w*(?:token|auth|session|password|secret|apikey|checkkey|signature)\w*)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"'
    )
    // Opaque blobs: 40+ chars of base64/hex alphabet mixing letters and digits.
    // Real statistics are numbers and short labels, so nothing legitimate is lost.
    .replace(/[A-Za-z0-9_-]{40,}/g, (m) =>
      (/[A-Za-z]/.test(m) && /[0-9]/.test(m)) ? '[redacted]' : m);
}

/** Path only, so a token smuggled in a query string cannot ride along. */
const safeLabel = (url) => {
  try { return new URL(url).pathname.slice(0, 120); } catch { return '/'; }
};

/**
 * Pulls the JSON responses out of a parsed HAR. Kept separate from `prepare` so
 * the browser can run this half locally and upload only the small result.
 */
export function collectFromHar(har) {
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries
    : Array.isArray(har?.entries) ? har.entries
      : Array.isArray(har) ? har : [];

  const out = [];
  for (const e of entries) {
    const url = e?.request?.url;
    if (!url || !isFanslyApi(url)) continue;

    const body = e?.response?.content?.text;
    if (typeof body !== 'string' || body.length < 2) continue;
    if (!/^[\s]*[{[]/.test(body)) continue;      // JSON payloads only

    out.push({ url, body });
  }
  return out;
}

/**
 * Ranks, trims, de-duplicates and redacts. This is the security boundary: it runs
 * server-side on every import, whether the browser pre-filtered the file or not.
 */
export function prepare(rawBlocks) {
  const seen = new Map();

  for (const b of Array.isArray(rawBlocks) ? rawBlocks : []) {
    const url = String(b?.url || '');
    const body = String(b?.body || '');
    if (!url || !body || !isFanslyApi(url)) continue;

    const path = safeLabel(url);
    const score = rank(path);
    if (score < 0) continue;

    // Same endpoint hit repeatedly while she scrolled: keep the richest response.
    const prev = seen.get(path);
    if (prev && prev.body.length >= body.length) continue;
    seen.set(path, { path, score, body });
  }

  const ranked = [...seen.values()].sort((a, b) => a.score - b.score || b.body.length - a.body.length);

  const blocks = [];
  let total = 0;
  for (const item of ranked) {
    if (blocks.length >= MAX_BLOCKS || total >= MAX_TOTAL) break;

    let body = redact(item.body).slice(0, MAX_PER_BLOCK);
    if (total + body.length > MAX_TOTAL) body = body.slice(0, MAX_TOTAL - total);

    blocks.push({ path: item.path, body });
    total += body.length;
  }

  return { blocks, chars: total };
}
