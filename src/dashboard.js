// Everything the dashboard reasons about beyond raw totals: the daily briefing,
// the health score, trend detection, root-cause analysis and the CEO focus list.
//
// All of it is computed here — SQL and arithmetic, never a model call — for the
// same reason the reply engine keeps strategy deterministic and only turns to AI
// for wording (see strategy.js): a health score or a "what to do today" list has
// to be the same if you ask twice, has to load instantly, and has to cost nothing
// to open. A model is free to riff; a dashboard is not.

import * as db from './db.js';

const DAY = 86400000;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Same shape as the frontend's money() — duplicated on purpose: this is server
 *  text baked into a CEO-focus task, not a UI component worth sharing across the
 *  network boundary. */
function fmtMoney(n, cur = 'USD') {
  const sym = { USD: '$', EUR: '€', GBP: '£' }[cur] || '';
  const amount = Math.round(Number(n) || 0).toLocaleString('en-US');
  return cur === 'USD' || cur === 'GBP' ? `${sym}${amount}` : `${amount}${sym}`;
}

/* --------------------------------- Briefing -------------------------------- */

/**
 * What happened yesterday, in the four numbers she asked for. The PPV conversion
 * and traffic source are not literally "yesterday" — a PPV converts over days, and
 * traffic is only as fresh as her last screenshot import — so each carries its own
 * real date rather than borrowing yesterday's label for data that is not from then.
 */
export function buildBriefing(userId) {
  const [from, to] = db.dayBounds(1);
  const revenue = db.periodPurchaseStats(userId, from, to);
  const newSubs = db.subscribersBetween(userId, from, to);
  const lastPpv = db.lastPpvConversion(userId);

  const snaps = db.listPlatformStats(userId, 1);
  const latest = snaps[0];
  const sources = latest?.breakdowns?.traffic_sources;
  const topSource = Array.isArray(sources) && sources.length
    ? [...sources].sort((a, b) => b.value - a.value)[0]
    : null;

  return {
    date: new Date(from).toISOString().slice(0, 10),
    revenue: revenue.revenue,
    sales: revenue.count,
    newSubscribers: newSubs,
    lastPpv,
    topSource: topSource ? { ...topSource, asOf: latest.captured_at } : null
  };
}

/* ------------------------------- Health score ------------------------------- */

const RELIABLE_SAMPLE = 5;

/** Maps a fractional change (0.25 = +25%) onto a 0-20 score centred on 10. */
function scoreFromChange(pct, steep = 40) {
  if (pct === null) return null;
  return Math.round(Math.min(20, Math.max(0, 10 + pct * steep)));
}

function pctChange(current, previous) {
  if (!previous) return current > 0 ? null : 0; // no base to compare against
  return (current - previous) / previous;
}

/**
 * Five dimensions, 20 points each. Every one that cannot be computed reliably —
 * too little history, no comparison period — falls back to a neutral 10 rather
 * than a fabricated high or low score, and says so in its note so the number is
 * never mistaken for more certain than it is.
 */
export function buildHealthScore(userId, dash) {
  const now = Date.now();
  const [last30From] = [new Date(now - 30 * DAY).toISOString()];
  const [prev30From, prev30To] = [new Date(now - 60 * DAY).toISOString(), last30From];

  const dims = [];

  // Growth — new fans, last 30 days vs the 30 before.
  const fansLast30 = db.newFansBetween(userId, last30From, new Date(now).toISOString());
  const fansPrev30 = db.newFansBetween(userId, prev30From, prev30To);
  const growthPct = pctChange(fansLast30, fansPrev30);
  dims.push({
    key: 'growth', label: 'Growth',
    score: growthPct === null ? 10 : scoreFromChange(growthPct),
    note: fansPrev30
      ? `${fansLast30} new fans vs ${fansPrev30} the 30 days before`
      : fansLast30 ? `${fansLast30} new fans, nothing to compare yet` : 'No new fans in 60 days',
    reliable: fansPrev30 >= 3 || fansLast30 >= 3
  });

  // Revenue — reuses the same last-30-vs-previous-30 the headline card shows.
  dims.push({
    key: 'revenue', label: 'Revenue',
    score: dash.prev30 > 0 ? scoreFromChange(dash.delta30 / 100) : 10,
    note: dash.prev30 > 0
      ? `${dash.delta30 > 0 ? '+' : ''}${dash.delta30}% vs the 30 days before`
      : 'Not enough history to compare yet',
    reliable: dash.prev30 > 0
  });

  // Retention — of fans who have ever paid, how many have paid more than once.
  const paying = dash.totals.paying;
  const repeat = db.repeatBuyerCount(userId);
  const retentionRate = paying ? repeat / paying : null;
  dims.push({
    key: 'retention', label: 'Retention',
    score: retentionRate === null ? 10 : Math.round(Math.min(20, retentionRate * 30)),
    note: paying ? `${repeat} of ${paying} paying fans have bought more than once` : 'No paying fans yet',
    reliable: paying >= RELIABLE_SAMPLE
  });

  // Consistency — how many of the last 30 days had at least one sale.
  const activeDays = dash.revenueByDay.filter((d) => d.total > 0).length;
  dims.push({
    key: 'consistency', label: 'Consistency',
    score: Math.round((activeDays / 30) * 20),
    note: `Sales landed on ${activeDays} of the last 30 days`,
    reliable: true
  });

  // Marketing — momentum on whatever metrics two imports have in common. Freeform
  // vision-extracted labels mean there is no fixed key to trust across creators,
  // so this only trusts a label that showed up in her own last two imports.
  const snaps = db.listPlatformStats(userId, 2);
  let marketing = { score: 10, note: 'Import Fansly stats to score marketing', reliable: false };
  if (snaps.length === 2) {
    const [older, newer] = snaps;
    const shared = Object.keys(newer.metrics).filter((k) => k in older.metrics && older.metrics[k] > 0);
    if (shared.length) {
      const avgPct = shared.reduce((s, k) => s + (newer.metrics[k] - older.metrics[k]) / older.metrics[k], 0) / shared.length;
      marketing = {
        score: scoreFromChange(avgPct, 30),
        note: `${shared.slice(0, 2).map((k) => k.replace(/_/g, ' ')).join(', ')} up ${Math.round(avgPct * 100)}% since your last import`,
        reliable: true
      };
    }
  }
  dims.push({ key: 'marketing', label: 'Marketing', ...marketing });

  const total = dims.reduce((s, d) => s + d.score, 0);
  return { total, dimensions: dims };
}

/* ---------------------------------- Trends ---------------------------------- */

const MIN_WEEKDAY_SAMPLE = 6;   // purchases or signups
const MIN_WEEKDAY_DATES = 3;    // distinct calendar dates, so 2 lucky Fridays cannot speak for "Fridays"

/** The one weekday that stands out, if any real signal exists — never forced. */
function bestWeekday(rows, valueKey) {
  const eligible = rows.filter((r) => r.n >= MIN_WEEKDAY_SAMPLE && r.days >= MIN_WEEKDAY_DATES);
  if (eligible.length < 2) return null; // need at least two real days to call one "best"

  const totalValue = eligible.reduce((s, r) => s + Number(r[valueKey]), 0);
  const mean = totalValue / eligible.length;
  const best = eligible.reduce((a, b) => (Number(b[valueKey]) > Number(a[valueKey]) ? b : a));

  // The leader has to clear the pack by a real margin, not just edge out a tie.
  if (mean <= 0 || Number(best[valueKey]) < mean * 1.4) return null;
  return { dow: best.dow, value: Number(best[valueKey]), overMean: Math.round((Number(best[valueKey]) / mean - 1) * 100) };
}

export function buildTrends(userId) {
  const trends = [];

  const revenueDow = bestWeekday(db.revenueByWeekday(userId), 'total');
  if (revenueDow) {
    trends.push({
      type: 'revenue_weekday',
      label: `${DOW[revenueDow.dow]}s bring in the most`,
      detail: `About ${revenueDow.overMean}% more revenue than an average day.`
    });
  }

  const fansDow = bestWeekday(db.newFansByWeekday(userId), 'n');
  if (fansDow) {
    trends.push({
      type: 'fans_weekday',
      label: `Most new fans show up on ${DOW[fansDow.dow]}s`,
      detail: `About ${fansDow.overMean}% more than an average day.`
    });
  }

  return trends;
}

/* ------------------------------- Root cause -------------------------------- */

const DROP_THRESHOLD = -10; // percent; smaller dips are normal noise, not a "cause"

/**
 * Only fires on a real drop. Decomposes revenue into buyers × sales-per-buyer ×
 * average order, and reports whichever moved the most — with the actual before
 * and after numbers, not a guess at why.
 */
export function buildRootCause(userId, dash) {
  if (dash.delta30 === null || dash.delta30 > DROP_THRESHOLD) {
    return { hasDrop: false };
  }

  const now = Date.now();
  const last = db.periodPurchaseStats(userId, new Date(now - 30 * DAY).toISOString(), new Date(now).toISOString());
  const prev = db.periodPurchaseStats(userId, new Date(now - 60 * DAY).toISOString(), new Date(now - 30 * DAY).toISOString());

  const freqLast = last.buyers ? last.count / last.buyers : 0;
  const freqPrev = prev.buyers ? prev.count / prev.buyers : 0;

  const factors = [
    { key: 'buyers', label: 'fewer people bought', before: prev.buyers, after: last.buyers, pct: pctChange(last.buyers, prev.buyers) },
    { key: 'frequency', label: 'buyers purchased less often', before: freqPrev, after: freqLast, pct: pctChange(freqLast, freqPrev) },
    { key: 'avgOrder', label: 'the average order size dropped', before: prev.avgOrder, after: last.avgOrder, pct: pctChange(last.avgOrder, prev.avgOrder) }
  ]
    .filter((f) => f.pct !== null && f.pct < -0.05)
    .sort((a, b) => a.pct - b.pct);

  const newFansLast = db.newFansBetween(userId, new Date(now - 30 * DAY).toISOString(), new Date(now).toISOString());
  const newFansPrev = db.newFansBetween(userId, new Date(now - 60 * DAY).toISOString(), new Date(now - 30 * DAY).toISOString());

  return {
    hasDrop: true,
    deltaPct: dash.delta30,
    last30: dash.last30,
    prev30: dash.prev30,
    drivers: factors.slice(0, 2),
    newFansTrend: pctChange(newFansLast, newFansPrev),
    goingQuiet: dash.goingQuiet
  };
}

/* -------------------------------- CEO focus --------------------------------- */

/**
 * Up to four tasks, ranked by what is actually costing revenue right now. Every
 * entry names a real number from her account — the same discipline the manager
 * chat follows — so none of it reads as generic platform advice.
 */
export function buildCeoFocus(userId, { dash, health, rootCause, cur }) {
  const tasks = [];

  if (dash.goingQuiet > 0) {
    tasks.push({
      priority: 60 + Math.min(dash.goingQuiet, 20),
      title: `Reach out to your ${dash.goingQuiet} going-quiet fan${dash.goingQuiet > 1 ? 's' : ''}`,
      why: 'Biggest spenders first — a check-in brings more of them back than a pitch does.'
    });
  }

  const pending = db.pendingOffersCount(userId);
  if (pending > 0) {
    tasks.push({
      priority: 40,
      title: `Log the outcome on ${pending} pending pitch${pending > 1 ? 'es' : ''}`,
      why: 'Marking who bought is what teaches the app what actually sells.'
    });
  }

  if (rootCause.hasDrop && rootCause.drivers.length) {
    const d = rootCause.drivers[0];
    tasks.push({
      priority: 90,
      title: d.key === 'buyers'
        ? `Buyers dropped from ${d.before} to ${d.after} — focus on re-engaging past buyers`
        : d.key === 'avgOrder'
          ? `Average order fell from ${fmtMoney(d.before, cur)} to ${fmtMoney(d.after, cur)} — revisit pricing or offer a bundle`
          : 'Repeat buyers are purchasing less often — a loyalty perk usually brings this back',
      why: `That is the main driver behind the ${Math.abs(rootCause.deltaPct)}% revenue dip.`
    });
  }

  const weakest = [...health.dimensions].filter((d) => d.reliable).sort((a, b) => a.score - b.score)[0];
  if (weakest && weakest.score <= 11) {
    const copy = {
      growth: 'Fan growth has slowed — post something today that invites new followers in.',
      retention: 'Few fans are buying twice — a loyalty perk or a bundle usually fixes this.',
      consistency: "You've missed sales on several days this month — a small daily touchpoint keeps momentum.",
      marketing: 'Import fresh Fansly stats so the manager can see what is actually working.'
    }[weakest.key];
    if (copy) tasks.push({ priority: 30, title: copy, why: `${weakest.label} is the weakest part of your health score (${weakest.score}/20).` });
  }

  if (dash.goal?.target > 0 && dash.goal.onPace === false && dash.goal.neededPerDay) {
    tasks.push({
      priority: 70,
      title: `You're behind pace on your ${fmtMoney(dash.goal.target, cur)} goal`,
      why: `You need about ${fmtMoney(dash.goal.neededPerDay, cur)}/day for the rest of the month to hit it.`
    });
  }

  return tasks.sort((a, b) => b.priority - a.priority).slice(0, 4).map(({ title, why }) => ({ title, why }));
}
