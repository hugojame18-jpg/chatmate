// Strategy is deterministic: the code decides WHAT to do, the model only handles wording.
// That is what stops a model from discounting on its own or freestyling every message.

// Personality is set per fan: the same creator plays a different character depending
// on what each fan responds to. This changes attitude and posture, never her limits.
export const PERSONALITIES = {
  sweet: {
    label: 'Sweet',
    hint: 'soft, affectionate, a little shy. warm, eager to please, lets him feel like he is special. never crude before he is.'
  },
  submissive: {
    label: 'Submissive',
    hint: 'eager to obey and be told what to do. asks him what he wants, calls him pet names, lets him lead and decide.'
  },
  dominant: {
    label: 'Dominant',
    hint: 'in control and commanding. gives instructions instead of asking, sets the terms, makes him earn it. short sentences, no pleading.'
  },
  bratty: {
    label: 'Bratty',
    hint: 'teasing and cheeky, challenges him, plays hard to get. makes him chase, acts unimpressed to provoke him.'
  },
  girlfriend: {
    label: 'Girlfriend',
    hint: 'real intimacy. remembers his day, asks about his life, talks like a partner. affection first, heat second.'
  },
  mysterious: {
    label: 'Mysterious',
    hint: 'cool and unhurried. says less than he wants, hints instead of stating, lets the silence pull him in.'
  }
};

export function resolvePersonality(fan, config) {
  const key = (fan?.personality || '').trim() || config?.defaultPersonality || 'sweet';
  return PERSONALITIES[key] ? key : 'sweet';
}

// The CTA gets heavier as the relationship deepens, because the PPVs get pricier.
// A $12 first buy needs a light nudge; a $150 custom needs a real close.
const CTA_LADDER = {
  1: 'Light invite. One short line that is easy to say yes to. Curiosity, zero pressure. Think "wanna see?".',
  2: 'Clear invite. Name what it is in a tempting way and tell him it is sitting there waiting for him. Ask for the yes.',
  3: 'Assumptive close. Talk as if he is already opening it. Give an instruction rather than asking a question.',
  4: 'Exclusive close. This is high ticket. Frame it as made specifically for him, rare, and happening now. Be direct about wanting him to take it.'
};

export function ctaLevelFor(fan) {
  const bought = Number(fan?.purchase_count || 0);
  if (bought === 0) return 1;
  if (bought <= 2) return 2;
  if (bought <= 4) return 3;
  return 4;
}

export const STAGES = {
  nouveau:  { label: 'New',    color: '#7c8aa5' },
  chauffe:  { label: 'Warm',   color: '#e0a63a' },
  acheteur: { label: 'Buyer',  color: '#3fb27f' },
  whale:    { label: 'Whale',  color: '#c9459f' }
};

export function computeStage(fan, config) {
  const spent = Number(fan.total_spent || 0);
  const purchases = Number(fan.purchase_count || 0);
  const messages = Number(fan.message_count || 0);

  if (spent >= Number(config.whaleThreshold || 200) || purchases >= 5) return 'whale';
  if (purchases >= 1) return 'acheteur';
  if (messages >= 10) return 'chauffe';
  return 'nouveau';
}

export function daysSince(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  return Math.floor(diff / 86400000);
}

const PLAYBOOK = {
  nouveau: {
    objectif: 'Build the connection. No selling at this stage.',
    faire: [
      'Ask for his first name and use it in every message after that',
      'Ask ONE open question about what he likes',
      'Keep it short and warm, one or two sentences max'
    ],
    eviter: ['Offering any paid content', 'Sending an obviously copy-pasted greeting']
  },
  chauffe: {
    objectif: 'Turn the conversation into a first purchase, at a low price.',
    faire: [
      'Reference a detail he already gave you (memory drives conversion)',
      'Tease one specific piece of content without describing all of it',
      'Offer ONE item, at the lowest entry price'
    ],
    eviter: ['Offering several items at once', 'Pushing after he says no twice']
  },
  acheteur: {
    objectif: 'Raise the average order and build a habit.',
    faire: [
      'Thank him for his last purchase by name',
      'Offer the next tier up, or a bundle of two items',
      'Open the door to a custom if what he wants is doable'
    ],
    eviter: ['Re-offering something he already bought', 'Dropping the price for nothing in return']
  },
  whale: {
    objectif: 'Retention. He is the one making the month.',
    faire: [
      'Reply first and personalize heavily',
      'Offer customs and exclusives rather than catalog items',
      'Take this conversation over yourself when it matters'
    ],
    eviter: ['Treating this like any other thread', 'Leaving him waiting for hours']
  }
};

// Rough detection of "she already made an offer recently". Prevents the model from
// pitching on every single message, which is the fastest way to kill a thread.
//
// Creators rarely write "$38" in a DM. They write "38 if you want it". So a bare
// number counts as a price when the message also reads like an offer, and never
// when the number is obviously a duration or an age.
// Phones substitute curly apostrophes, so "it's" arrives as "it’s" and every
// pattern written with a straight quote silently stops matching. Normalise first.
export const normalizeText = (s) => String(s || '').replace(/[‘’ʼ´`]/g, "'");

const EXPLICIT_PRICE = /(?:[$€£]\s?\d{1,4})|(?:\d{1,4}\s?[$€£])|(?:\b\d{1,4}\s?(?:usd|eur|gbp|dollars?|bucks|euros?)\b)/i;
const BARE_NUMBER = /\b\d{1,4}\b(?!\s*(?:min|mins|minute|minutes|sec|secs|second|seconds|hour|hours|hrs?|am|pm|year|years|yo|%|k\b))/i;
const OFFER_WORDS = /\b(?:for|only|just|it'?s|its|unlock|tip|price|costs?|worth|buy|grab|yours|send\s+it|if\s+you\s+want)\b/i;
const DECLINE_RE = /\b(?:no\s+thanks|not\s+(?:now|today|right\s+now)|maybe\s+later|too\s+(?:much|expensive|pricey)|can'?t\s+afford|broke|i'?ll\s+pass|nah)\b/i;

/** Does this creator message read like a priced offer? */
export function looksLikeOffer(text) {
  const s = normalizeText(text);
  if (EXPLICIT_PRICE.test(s)) return true;
  return BARE_NUMBER.test(s) && OFFER_WORDS.test(s);
}

/** Does the text actually state a price? Prices are banned from replies now. */
export function containsPrice(text) {
  return EXPLICIT_PRICE.test(normalizeText(text));
}

// A sell message that describes an item and then just stops converts far worse
// than one that ends on an ask. Used to flag replies with no closing move.
const CTA_MARKERS = new RegExp([
  '\\?',                                        // any question is an ask
  '\\bwanna\\b',
  '\\bwant\\s+(?:it|me|to\\s+see|to\\s+hear)\\b',
  '\\bunlock\\b',
  '\\b(?:open|tap|check|see|take|grab|watch|hear)\\s+(?:it|this|that|them)\\b',
  '\\bit\'?s\\s+(?:yours|there|waiting|all\\s+yours)\\b',
  '\\byours\\s+if\\b',
  '\\bwaiting\\b',                              // "right there waiting"
  '\\bsay\\s+(?:yes|the\\s+word)\\b',
  '\\byes\\s+or\\s+no\\b',
  '\\btell\\s+me\\b',
  '\\blet\\s+me\\s+send\\b',
  '\\bsending\\s+it\\b',
  '\\bcome\\s+get\\b',
  '\\bgo\\s+(?:on|look|get)\\b',
  '\\bready\\s+for\\s+(?:it|that)\\b',
  '\\bdon\'?t\\s+(?:keep\\s+me\\s+waiting|make\\s+me\\s+wait)\\b',
  '\\bbefore\\s+i\\s+change\\s+my\\s+mind\\b'
].join('|'), 'i');

export function hasCTA(text) {
  return CTA_MARKERS.test(normalizeText(text));
}

function readOfferState(history = []) {
  let offerIndex = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m.role === 'creator' && looksLikeOffer(m.content)) { offerIndex = i; break; }
  }
  if (offerIndex === -1) return { messagesSinceOffer: null, declined: false };

  const after = history.slice(offerIndex + 1);
  return {
    messagesSinceOffer: after.length,
    declined: after.some((m) => m.role === 'fan' && DECLINE_RE.test(normalizeText(m.content)))
  };
}

// A direct buying question. Models are unreliable at spotting these and tend to
// deflect with a tease, which loses the sale, so we detect it in code and force
// the move instead of asking the model to decide.
const BUY_INTENT = [
  /\bhow\s+much\b/i,
  /\bwhat(?:'?s| is|\s+are)\s+(?:your\s+)?(?:the\s+)?prices?\b/i,
  /\byour\s+prices?\b/i,
  /\bprice\s+list\b/i,
  /\bwhat\s+(?:do\s+)?(?:you|u)\s+(?:have|got|sell)\b/i,
  /\bwhat'?s\s+(?:for\s+sale|on\s+(?:the\s+)?menu)\b/i,
  /\bfor\s+sale\b/i,
  /\bcan\s+(?:i|we)\s+buy\b/i,
  /\bi\s+(?:wanna|want\s+to|would\s+like\s+to)\s+buy\b/i,
  /\bi'?ll\s+(?:buy|take|pay)\b/i,
  /\bwhat\s+does\s+it\s+cost\b/i,
  /\bhow\s+do\s+i\s+(?:buy|get)\b/i,
  /\bppv\b/i,
  /\bsend\s+me\s+the\s+(?:link|menu)\b/i
];

function hasBuyIntent(text) {
  const s = normalizeText(text);
  return BUY_INTENT.some((re) => re.test(s));
}

/**
 * Builds the strategic brief injected into the prompt and shown in the app.
 */
export function buildStrategy({ fan, config, mediaLibrary, mediaSent, lastFanMessageAt, history = [], incoming = '' }) {
  const stage = computeStage(fan, config);
  const play = PLAYBOOK[stage];
  const silent = daysSince(lastFanMessageAt || fan.last_activity);
  const sentIds = new Set((mediaSent || []).map((m) => m.media_id));

  const available = (mediaLibrary || []).filter((m) => !sentIds.has(m.id));
  const alreadySent = (mediaSent || []).map((m) => m.title);

  // Which item to push: cheapest for new/warm, most expensive unseen for buyer/whale.
  let suggestedMedia = null;
  if (available.length) {
    const sorted = [...available].sort((a, b) => a.price - b.price);
    suggestedMedia = stage === 'whale' || stage === 'acheteur'
      ? sorted[sorted.length - 1]
      : sorted[0];
  }

  const offer = readOfferState(history);

  const flags = [];
  if (silent !== null && silent >= Number(config.silentDays || 5)) {
    flags.push(`Silent for ${silent} days: open with something light, not with an offer.`);
  }
  if (stage === 'whale') flags.push('WHALE: reply yourself if this message matters.');
  if (!available.length && mediaLibrary?.length) {
    flags.push('He has received the entire library. Offer nothing again: steer toward a custom.');
  }
  if (!mediaLibrary?.length) {
    flags.push('Library is empty: do not name any specific content until it is filled in.');
  }
  if (offer.declined) {
    flags.push('He already turned down an offer. Do NOT pitch again in this message. Rebuild the mood first.');
  } else if (offer.messagesSinceOffer !== null && offer.messagesSinceOffer < 6) {
    flags.push(`You already made an offer ${offer.messagesSinceOffer} message(s) ago. Do NOT pitch again yet.`);
  }

  // Hard gates the model must respect.
  // A direct buying question overrides the cooldowns: if he is asking to buy, sell.
  const buyIntent = hasBuyIntent(incoming);
  const nothingToSell = !available.length;

  const sellBlocked =
    nothingToSell ||
    (!buyIntent && (
      offer.declined ||
      (offer.messagesSinceOffer !== null && offer.messagesSinceOffer < 6) ||
      (stage === 'nouveau' && Number(fan.message_count || 0) < 4)
    ));

  const sellForced = buyIntent && !nothingToSell;

  if (sellForced) {
    flags.push('He is asking to buy. Answer with a concrete item and price, do not deflect.');
  }

  const ctaLevel = ctaLevelFor(fan);
  const personality = resolvePersonality(fan, config);

  return {
    sellForced,
    buyIntent,
    ctaLevel,
    ctaBrief: CTA_LADDER[ctaLevel],
    personality,
    personalityLabel: PERSONALITIES[personality].label,
    personalityHint: PERSONALITIES[personality].hint,
    stage,
    stageLabel: STAGES[stage].label,
    play,
    silent,
    suggestedMedia,
    alreadySent,
    available,
    flags,
    offer,
    sellBlocked
  };
}
