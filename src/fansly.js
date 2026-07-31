// Reads PUBLIC profile data from Fansly. Read-only, unauthenticated, no account
// of hers is ever touched: this is the same data any visitor sees on the page.
//
// The endpoint is undocumented, so it can change without notice. Every failure
// falls back to the screenshot import, which never breaks.

const API = 'https://apiv3.fansly.com/api/v1/account';
const TIMEOUT_MS = 15000;

export class FanslyError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'FanslyError';
    this.hint = hint;
  }
}

/** Accepts a full profile URL, an @handle, or a bare username. */
export function parseHandle(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  // https://fansly.com/username/posts -> username
  const fromUrl = raw.match(/fansly\.com\/([^/?#\s]+)/i);
  const candidate = (fromUrl ? fromUrl[1] : raw).replace(/^@/, '').trim();

  // Reject the platform's own routes, which are not profiles.
  if (/^(home|explore|messages|settings|notifications|search|live)$/i.test(candidate)) return '';
  return /^[A-Za-z0-9_.-]{2,40}$/.test(candidate) ? candidate : '';
}

function tierPrices(tiers) {
  if (!Array.isArray(tiers)) return [];
  return tiers
    .map((t) => Number(t?.price))
    .filter((n) => Number.isFinite(n) && n > 0)
    // Fansly returns prices in cents.
    .map((n) => Math.round(n) / 100)
    .sort((a, b) => a - b);
}

/**
 * Fetches one public profile.
 * @returns normalised account data, or throws FanslyError.
 */
export async function fetchAccount(input) {
  const handle = parseHandle(input);
  if (!handle) {
    throw new FanslyError('That does not look like a Fansly profile.', 'Paste the profile link, or just the username.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${API}?usernames=${encodeURIComponent(handle)}`, {
      headers: {
        // Without a browser-like agent the endpoint tends to answer with nothing.
        'User-Agent': 'Mozilla/5.0 (compatible; chatmate/1.0)',
        Accept: 'application/json'
      },
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw new FanslyError(
      err.name === 'AbortError' ? 'Fansly took too long to answer.' : `Could not reach Fansly: ${err.message}`,
      'You can still import the numbers from a screenshot.'
    );
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new FanslyError(`Fansly answered ${res.status}.`, 'The endpoint may have changed. Use the screenshot import instead.');
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new FanslyError('Unreadable answer from Fansly.');
  }

  const account = payload?.response?.[0];
  if (!account) {
    throw new FanslyError(`No public profile found for "${handle}".`, 'Check the spelling, and that the profile is public.');
  }

  const stats = account.timelineStats || {};
  const prices = tierPrices(account.subscriptionTiers);

  return {
    handle: account.username || handle,
    display_name: account.displayName || '',
    bio: String(account.about || '').slice(0, 600),
    location: account.location || '',
    price_low: prices[0] ?? null,
    price_high: prices[prices.length - 1] ?? null,
    metrics: {
      followers: Number(account.followCount) || 0,
      subscribers: Number(account.subscriberCount) || 0,
      post_likes: Number(account.postLikes) || 0,
      media_likes: Number(account.accountMediaLikes) || 0,
      images: Number(stats.imageCount) || 0,
      videos: Number(stats.videoCount) || 0,
      bundles: Number(stats.bundleCount) || 0
    }
  };
}
