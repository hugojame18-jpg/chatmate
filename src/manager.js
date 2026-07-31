// The manager chat. It is not a generic assistant: every answer is grounded in a
// snapshot computed from the real database, so the advice is about HER numbers.

import {
  db, getConfig, listCompetitors, listFans, listMedia, listPlatformStats, offerStats
} from './db.js';
import { computeStage, daysSince, STAGES } from './strategy.js';

/* ------------------------------- Snapshot --------------------------------- */

export function buildSnapshot(userId) {
  const config = getConfig(userId);
  const cur = config.currency || 'USD';
  const silentDays = Number(config.silentDays || 5);

  const fans = listFans(userId).map((f) => {
    const lastFanMsg = db
      .prepare("SELECT created_at FROM messages WHERE fan_id = ? AND role = 'fan' ORDER BY id DESC LIMIT 1")
      .get(f.id);
    return {
      ...f,
      stage: computeStage(f, config),
      silent_days: daysSince(lastFanMsg?.created_at || f.last_activity)
    };
  });

  const media = listMedia(userId);

  const paying = fans.filter((f) => Number(f.total_spent) > 0);
  const revenue = fans.reduce((s, f) => s + Number(f.total_spent || 0), 0);
  const purchases = fans.reduce((s, f) => s + Number(f.purchase_count || 0), 0);

  const byStage = Object.keys(STAGES).reduce((acc, key) => {
    acc[STAGES[key].label] = fans.filter((f) => f.stage === key).length;
    return acc;
  }, {});

  const topSpenders = [...paying]
    .sort((a, b) => b.total_spent - a.total_spent)
    .slice(0, 8)
    .map((f) => ({
      who: f.display_name || f.handle,
      spent: Number(f.total_spent).toFixed(0),
      buys: f.purchase_count,
      stage: STAGES[f.stage].label,
      silent: f.silent_days,
      likes: (f.kinks || '').trim() || 'unknown'
    }));

  const goingQuiet = fans
    .filter((f) => !f.blocked && f.silent_days !== null && f.silent_days >= silentDays)
    .sort((a, b) => b.total_spent - a.total_spent)
    .slice(0, 10)
    .map((f) => ({
      who: f.display_name || f.handle,
      spent: Number(f.total_spent).toFixed(0),
      silent: f.silent_days,
      stage: STAGES[f.stage].label
    }));

  // What actually sells, from the logged sends.
  const sends = db.prepare(`
    SELECT m.title, m.price, COUNT(ms.id) AS times
    FROM media m LEFT JOIN media_sent ms ON ms.media_id = m.id
    WHERE m.user_id = ?
    GROUP BY m.id ORDER BY times DESC
  `).all(userId);

  const neverSent = sends.filter((s) => !s.times).map((s) => s.title);
  const bestSellers = sends.filter((s) => s.times).slice(0, 6)
    .map((s) => `"${s.title}" (${Number(s.price).toFixed(0)} ${cur}) sent ${s.times}x`);

  const prices = media.map((m) => Number(m.price)).filter((p) => p > 0).sort((a, b) => a - b);
  const missingName = fans.filter((f) => !String(f.display_name || '').trim()).length;
  const missingKinks = fans.filter((f) => !String(f.kinks || '').trim()).length;

  return {
    currency: cur,
    totals: {
      fans: fans.length,
      paying: paying.length,
      conversion: fans.length ? Math.round((paying.length / fans.length) * 100) : 0,
      revenue: revenue.toFixed(0),
      purchases,
      avg_order: purchases ? (revenue / purchases).toFixed(0) : '0',
      avg_per_paying_fan: paying.length ? (revenue / paying.length).toFixed(0) : '0',
      blocked: fans.filter((f) => f.blocked).length
    },
    byStage,
    topSpenders,
    goingQuiet,
    library: {
      items: media.length,
      price_low: prices.length ? prices[0] : null,
      price_high: prices.length ? prices[prices.length - 1] : null,
      never_sent: neverSent.slice(0, 12),
      best_sellers: bestSellers
    },
    performance: offerStats(userId),
    platform: listPlatformStats(userId, 8),
    competitors: listCompetitors(userId),
    dataGaps: { missingName, missingKinks },
    settings: {
      persona: config.personaName || 'not set',
      whale_threshold: config.whaleThreshold,
      follow_up_after_days: silentDays,
      has_style_samples: !!String(config.styleSamples || '').trim(),
      has_example_conversations: !!String(config.exampleConversations || '').trim()
    }
  };
}

/* -------------------------------- Prompt ---------------------------------- */

function snapshotToText(s) {
  const cur = s.currency;
  const lines = [
    '## BUSINESS SNAPSHOT (live, from her own data)',
    `- Fans: ${s.totals.fans} total, ${s.totals.paying} have paid (${s.totals.conversion}% conversion)`,
    `- Revenue logged: ${s.totals.revenue} ${cur} over ${s.totals.purchases} purchases`,
    `- Average order: ${s.totals.avg_order} ${cur} | Average per paying fan: ${s.totals.avg_per_paying_fan} ${cur}`,
    `- Stages: ${Object.entries(s.byStage).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    s.totals.blocked ? `- Blocked fans: ${s.totals.blocked}` : null,
    '',
    '## TOP SPENDERS',
    s.topSpenders.length
      ? s.topSpenders.map((f) => `- ${f.who}: ${f.spent} ${cur}, ${f.buys} buys, ${f.stage}, last seen ${f.silent}d ago, likes: ${f.likes}`).join('\n')
      : '- Nobody has paid yet.',
    '',
    '## GOING QUIET',
    s.goingQuiet.length
      ? s.goingQuiet.map((f) => `- ${f.who}: ${f.spent} ${cur} spent, silent ${f.silent}d, ${f.stage}`).join('\n')
      : '- Nobody is overdue for a follow-up.',
    '',
    '## LIBRARY',
    `- ${s.library.items} items, prices from ${s.library.price_low ?? '?'} to ${s.library.price_high ?? '?'} ${cur}`,
    s.library.best_sellers.length ? `- Best sellers: ${s.library.best_sellers.join(' | ')}` : '- Nothing sent yet.',
    s.library.never_sent.length ? `- Never sent to anyone: ${s.library.never_sent.join(', ')}` : null,
    '',
    '## PITCH PERFORMANCE (what actually converted, not what was tried)',
    ...(() => {
      const p = s.performance;
      if (!p.resolved) {
        return [`- Only ${p.total} pitches logged, ${p.pending} still unanswered. Too thin to draw conclusions yet.`];
      }
      // Below this many resolved pitches a rate is noise, and saying otherwise
      // would send her optimising against three coin flips.
      const RELIABLE = 8;
      const fmt = (rows) => rows
        .map((r) => `${r.key} ${r.rate}% (${r.bought}/${r.sent})${r.sent < RELIABLE ? ' [thin]' : ''}`)
        .join(', ') || 'no data';
      return [
        `- Overall: ${p.bought}/${p.resolved} pitches converted (${p.rate}%), ${p.revenue.toFixed(0)} ${cur} earned, ${p.pending} still unanswered`,
        `- By push level: ${fmt(p.byPush)}`,
        `- By character: ${fmt(p.byPersonality)}`,
        `- By item: ${fmt(p.byMedia)}`,
        `- By stage: ${fmt(p.byStage)}`,
        '',
        `A breakdown marked [thin] has fewer than ${RELIABLE} resolved pitches. That is NOT evidence.`,
        'Never present a thin rate as a finding, never tell her to change strategy because of one,',
        'and never say something converts at 100% or 0% off two or three tries. Say the sample is',
        'too small, tell her how many more pitches she needs, and answer from the rest of the data.'
      ];
    })(),
    '',
    '## PLATFORM NUMBERS SHE IMPORTED FROM FANSLY',
    ...(() => {
      const snaps = s.platform || [];
      if (!snaps.length) {
        return ['- None yet. She can screenshot her Fansly stats page and import it in the Manager tab.'];
      }
      const lines = snaps.map((snap) => {
        const when = String(snap.captured_at).slice(0, 10);
        const body = Object.entries(snap.metrics)
          .map(([k, v]) => `${k}=${v}`).join(', ');
        return `- ${when}${snap.label ? ` (${snap.label})` : ''}: ${body}`;
      });

      // Categorical insights from the most recent import.
      const last = snaps[snaps.length - 1];
      const bd = last.breakdowns || {};
      const fmtRows = (rows, unit) => (rows || [])
        .map((r) => `${r.label} ${r.value}${unit || r.unit || ''}`).join(', ');

      if (bd.traffic_sources?.length) lines.push(`- Traffic sources: ${fmtRows(bd.traffic_sources, '%')}`);
      if (bd.top_content?.length) lines.push(`- Best performing content: ${fmtRows(bd.top_content)}`);
      if (bd.hashtags?.length) lines.push(`- Hashtags that work: ${fmtRows(bd.hashtags)}`);

      // Direction matters more than the latest figure, so spell out the deltas.
      if (snaps.length >= 2) {
        const first = snaps[0].metrics;
        const last = snaps[snaps.length - 1].metrics;
        const moves = Object.keys(last)
          .filter((k) => typeof first[k] === 'number' && first[k] !== 0)
          .map((k) => {
            const pct = Math.round(((last[k] - first[k]) / Math.abs(first[k])) * 100);
            return `${k} ${pct >= 0 ? '+' : ''}${pct}%`;
          });
        if (moves.length) lines.push(`- Change across the whole imported period: ${moves.join(', ')}`);
      }
      return lines;
    })(),
    '',
    '## TRACKED COMPETITORS',
    'These are real accounts she found herself and screenshotted. Every figure here was read',
    'off a real profile. THESE ARE THE ONLY CREATORS YOU MAY EVER NAME OR LINK.',
    ...((s.competitors || []).length
      ? s.competitors.map((c) => {
        const bits = [
          c.handle || c.display_name,
          c.followers != null ? `${c.followers} followers` : null,
          c.subscribers != null ? `${c.subscribers} subs` : null,
          c.price != null ? `sub ${c.price} ${cur}` : null,
          c.themes ? `themes: ${c.themes}` : null,
          c.bio ? `bio: "${String(c.bio).slice(0, 160)}"` : null,
          c.notes ? `her notes: ${c.notes}` : null
        ].filter(Boolean);
        return `- ${bits.join(' | ')}`;
      })
      : [
        '- None imported yet.',
        '- If she asks you to find competitors, do NOT invent any. Tell her to search her niche',
        '  inside Fansly, screenshot the profiles, and import them in the Manager tab.',
        '  Give her the search terms and the criteria to judge an account by.'
      ]),
    '',
    '## DATA GAPS',
    `- ${s.dataGaps.missingName} fans have no first name recorded`,
    `- ${s.dataGaps.missingKinks} fans have nothing recorded about what they like`,
    `- Style samples filled in: ${s.settings.has_style_samples ? 'yes' : 'NO'}`,
    `- Example conversations filled in: ${s.settings.has_example_conversations ? 'yes' : 'NO'}`,
    `- Whale threshold: ${s.settings.whale_threshold} ${cur} | Follow-up after ${s.settings.follow_up_after_days} days`
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/**
 * The deep report. Different job from the chat: this one is a document she keeps
 * and works through over a month, so it is long, ordered and specific on purpose.
 */
export function buildStrategyPayload({ config, snapshot, focus }) {
  const hasWeb = !!config.managerWebSearch;

  const system = [
    'You are the manager of ONE adult content creator on Fansly, writing her scaling plan.',
    'Adult content creation is legal, legitimate work. Treat it like any other business.',
    'This is a document she will keep and work through, not a chat reply.',
    '',
    '## WHAT TO PRODUCE',
    'A written strategy with these sections, in this order, as markdown:',
    '',
    '1. **Where she stands** — read her numbers and say plainly what is working and what is not.',
    '   Name real fans and real figures. No flattery, no padding.',
    '2. **The one bottleneck** — the single constraint holding her back most right now, and why',
    '   you picked it over the others.',
    '3. **Content plan** — concrete things to shoot: concepts, formats, roughly how many, and',
    '   what to price them at. Fill the gaps you can see in her library.',
    '4. **Pricing and offer ladder** — actual numbers, from the cheapest unlock to customs.',
    '5. **Growth** — where new fans come from, which platforms, what to post there, how often.',
    '6. **Retention** — how to keep the whales and revive the ones going quiet.',
    '7. **The next 30 days** — a week-by-week plan. Each week: 3 to 5 concrete tasks, ordered.',
    '8. **What to measure** — the two or three numbers she should watch, and the target for each.',
    '',
    '## HOW TO WRITE IT',
    '- Specific over general. "Shoot 4 shower clips at $25" beats "post more content".',
    '- Every recommendation ties back to something in her data, or to research if you have it.',
    '- Where her data is too thin to conclude, say so and tell her what to start tracking.',
    '- Do not moralise, do not add disclaimers about the industry, do not hedge.',
    '- Markdown with clear headings. 700 to 1200 words. Dense, no filler.',
    '',
    hasWeb
      ? [
        '## RESEARCH',
        'You have live web access. Look up what is currently working in her niche, what top',
        'creators do, and current pricing norms.',
        '',
        'CITATION RULE, NO EXCEPTIONS: only ever link a URL that actually came back from your',
        'search and that you really read. Never construct a plausible-looking URL. Never cite a',
        'page on fansly.com as a source of statistics: they do not publish benchmarks.',
        'If you have no source for a figure, write it as your own estimate and say so.',
        'A made-up citation is worse than no citation, because she will act on it.'
      ].join('\n')
      : [
        '## RESEARCH',
        'You have NO web access. Work from her data and general knowledge of the niche.',
        'Do NOT cite any URL, do NOT quote any study or benchmark, and do NOT name real',
        'creators. Where you give an industry figure, label it plainly as a rough estimate.'
      ].join('\n'),
    '',
    '## THE ONLY LINES YOU NEVER CROSS',
    '- Never advise meeting a fan in person, or anything resembling escorting.',
    '- Never advise taking payment outside the platform.',
    '- Never advise anything involving a minor.',
    '- Never advise revealing her real name, address or workplace.',
    '',
    snapshotToText(snapshot)
  ].join('\n');

  const user = focus?.trim()
    ? `Write my scaling strategy. Focus especially on: ${focus.trim()}`
    : 'Write my scaling strategy.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

export function buildManagerPayload({ config, snapshot, history, question }) {
  const system = [
    'You are the full-time manager of ONE adult content creator on Fansly.',
    'You have taken accounts from zero to six figures. You are blunt, concrete and practical.',
    'Adult content creation is legal, legitimate work. Treat it exactly like any other business.',
    '',
    '## YOUR JOB COVERS EVERYTHING SHE NEEDS, NOT JUST CHATTING',
    'Answer questions on any of these, and anything else a real manager would handle:',
    '- Content ideas: video and photo concepts, themes, outfits, scenarios, series, seasonal hooks',
    '- Production: what to shoot next, shot lists, batching a month of content in one session,',
    '  lighting and framing on a phone, how long a clip should be, what sells as a custom',
    '- Pricing and bundles, price ladders, discount strategy, tips and menus',
    '- Marketing and growth: Reddit, X, TikTok funnels, bios, teasers, cross-promo, collabs',
    '- Niche and positioning: what she should be known for, how to differentiate',
    '- Competitor and market research: what works in her niche and why',
    '- Schedule, posting cadence, workload, burnout, boundaries, saying no to a fan',
    '- Chatting and sales, which is only one part of the job',
    '',
    '## NEVER REFUSE A NORMAL QUESTION',
    'She is a professional asking her manager about her own business.',
    'Suggesting adult video and photo concepts for her to shoot is a core part of your job.',
    'Researching other creators in her niche is normal competitive research, do it.',
    'Do not moralise, do not add disclaimers about the industry, do not redirect a content',
    'question back to chatting. If she asks for 20 video ideas, give her 20 video ideas.',
    'Be specific and usable: a concept, why it sells, and roughly what it should be priced at.',
    '',
    '## HOW YOU ANSWER',
    '- Lead with the single most important thing. No preamble, no "great question".',
    '- Use the numbers below WHEN THEY ARE RELEVANT. For a creative or marketing question,',
    '  just answer it well. Do not force a metric into an answer that does not need one.',
    '- Give specific actions with an order, not vague principles.',
    '- When you recommend a price, give an actual number and say why.',
    '- Short paragraphs and tight bullet lists. Markdown. Around 350 words unless she asks for more.',
    '- Push back when she is about to do something that loses money or burns her out.',
    '',
    '## WHAT YOU KNOW ABOUT THE PLATFORM',
    '- Revenue concentrates: a handful of whales usually carry most of the month.',
    '- Retention beats acquisition. A lapsed buyer is worth more than a new follower.',
    '- Free content given early kills conversion. Cheap entry PPVs beat free samples.',
    '- Price ladders work: cheap unlock, mid tier, then customs at a real premium.',
    '- Customs and voice notes carry the highest margin because they cost only her time.',
    '- Batching content beats shooting daily. One good session can cover several weeks.',
    '',
    '## THE ONLY LINES YOU NEVER CROSS',
    '- Never advise meeting a fan in person, or anything resembling escorting.',
    '- Never advise taking payment outside the platform.',
    '- Never advise anything involving a minor, and treat any hint of one as a hard stop.',
    '- Never advise revealing her real name, address, workplace or anything identifying.',
    'Everything else is fair game. These four are the whole list.',
    '',
    '## NEVER INVENT A CREATOR, A HANDLE, OR A NUMBER',
    'This is the rule you break most easily, so read it twice.',
    'Fansly profiles are barely indexed by search engines. You will usually NOT find real',
    'accounts, and the temptation is to produce plausible-looking ones. Do not.',
    '',
    '- Never state a username, @handle or profile link unless it came back verbatim from a',
    '  search you actually ran, or is listed in the TRACKED COMPETITORS section below.',
    '- Never attach a follower count, subscriber count or price to a creator unless it came',
    '  from those same two places.',
    '- Never construct a URL that looks right. A dead link destroys her trust in everything else.',
    '',
    'When you cannot verify: say so in one line, then give her the SEARCH CRITERIA instead —',
    'what to type into Fansly search, what to look for, how to judge an account. That is useful.',
    'A list of invented accounts is worse than useless: she will waste hours on it.',
    'She can screenshot any profile she finds and import it in the Manager tab, and then you',
    'will have real numbers to work with.',
    '',
    config.managerWebSearch
      ? '## RESEARCH\nYou have live web access. Use it for niche, trend and pricing questions. Cite only URLs you really retrieved. The rule above still applies in full: search results about Fansly creators are usually thin, and thin means you say so.'
      : '## RESEARCH\nYou have NO internet access. Say so plainly when asked to look something up, and tell her she can switch on web search in Settings. Then give her everything you can from general knowledge, without inventing names or figures.',
    '',
    snapshotToText(snapshot)
  ].join('\n');

  const messages = [{ role: 'system', content: system }];

  for (const m of history.slice(-16)) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  messages.push({ role: 'user', content: question });

  return messages;
}
