// Guardrails. They protect the account, the money, and the person behind the account.
// Two levels:
//   'block' : no reply is generated at all, a clear instruction is shown instead.
//   'warn'  : replies are generated, but a warning is shown above them.
//
// Patterns are English-first (US audience) with French kept as a fallback.

const BLOCK_RULES = [
  {
    code: 'minor',
    label: 'This fan may be a minor',
    advice:
      'Do not reply, do not negotiate, do not send anything. Block and report the account on Fansly. ' +
      'No replies will be generated for this conversation until you clear it.',
    patterns: [
      /\bi'?m\s*(?:only\s*)?(?:1[0-7]|[1-9])\s*(?:years?\s*old|yo|y\/o)?\b/i,
      /\b(?:1[0-7]|[1-9])\s*(?:years?\s*old|yo|y\/o)\b/i,
      /\bjust\s+turned\s+(?:1[0-7]|[1-9])\b/i,
      /\b(?:almost|nearly|turning)\s+18\b/i,
      /\bunder\s*age(?:d)?\b/i,
      /\bunderage\b/i,
      /\bjailbait\b/i,
      /\bminor\b/i,
      /\b(?:middle|high|junior\s+high)\s*school\b/i,
      /\b(?:freshman|sophomore)\b/i,
      /\b(?:9|10|11|12)th\s+grade\b/i,
      /\bgrade\s+(?:9|10|11|12)\b/i,
      /\bmy\s+(?:mom|mum|dad|parents)\s+(?:would|will|might|don'?t|doesn'?t)\s+(?:kill|know|find|let)\b/i,
      /\bmy\s+parents\s+don'?t\s+know\b/i,
      // Francais
      /\b(?:j'?ai|jai|j ai)\s*(?:1[0-7]|[1-9])\s*ans\b/i,
      /\bmineur(?:e|s)?\b/i,
      /\bau\s+coll[eè]ge\b/i,
      /\ben\s+(?:6|5|4|3)(?:e|eme|ème)\b/i
    ]
  },
  {
    code: 'irl',
    label: 'He wants to meet in person',
    advice:
      'Shut it down clearly and without ambiguity. Give no city, no timeframe, no maybe. ' +
      'A scripted reply is offered below, you can copy it as is.',
    scripted:
      "i only do online stuff babe, never in person, that's not something i budge on 💋 " +
      "but i'm right here whenever you want me",
    patterns: [
      /\b(?:meet|meeting|link)\s*(?:up)?\s*(?:irl|in\s+person|for\s+real|sometime|somewhere)\b/i,
      /\blet'?s\s+meet\b/i,
      /\bcan\s+(?:i|we)\s+(?:meet|see)\s+you\b/i,
      /\bmeet\s+(?:me|you|up)\b/i,
      /\bhook\s*up\b/i,
      /\bcome\s+(?:to|over)\s+(?:my|your)\s+(?:place|house|hotel|room|apartment)\b/i,
      /\b(?:my|a)\s+hotel\s+room\b/i,
      /\bfly\s+(?:you|me)\s+(?:out|over)\b/i,
      /\bhow\s+much\s+for\s+(?:a\s+night|an?\s+hour|your\s+time|the\s+night)\b/i,
      /\bescort(?:ing)?\b/i,
      /\bfull\s+service\b/i,
      /\byour\s+address\b/i,
      // Francais
      /\b(?:se\s+voir|se\s+rencontrer|te\s+rencontrer|te\s+voir)\s+(?:en\s+vrai|irl)?\b/i,
      /\bon\s+se\s+(?:voit|capte|rejoint)\b/i,
      /\bcombien\s+pour\s+(?:une\s+nuit|la\s+nuit|te\s+voir)\b/i
    ]
  }
];

const WARN_RULES = [
  {
    code: 'doxx',
    label: 'He is digging for personal info',
    advice:
      'Never give a real name, city, state, neighborhood, school, employer, or any photo with a ' +
      'recognizable location. Deflect with humor and turn it back on him.',
    patterns: [
      /\b(?:your|whats?\s+your|what'?s\s+your)\s+real\s+name\b/i,
      /\breal\s+name\b/i,
      /\bwhere\s+(?:do\s+you|are\s+you|u)\s+(?:live|from|at|based)\b/i,
      /\bwhat\s+(?:city|state|town|country|area)\b/i,
      /\bwhat\s+part\s+of\s+(?:the\s+)?(?:us|country|state)\b/i,
      /\byour\s+(?:zip|zipcode|area\s+code)\b/i,
      /\b(?:your|whats?\s+your)\s+(?:school|college|university|job|work|workplace)\b/i,
      /\b(?:personal|private|real|main)\s+(?:snap|snapchat|insta|instagram|facebook|tiktok|account)\b/i,
      /\bwhat'?s\s+your\s+@\b/i,
      // Francais
      /\b(?:ton|ton\s+vrai)\s+(?:vrai\s+)?(?:nom|pr[eé]nom)\b/i,
      /\btu\s+(?:habites|vis|es)\s+(?:o[uù]|dans\s+quelle)/i
    ]
  },
  {
    code: 'offsite',
    label: 'He wants to move off Fansly or pay elsewhere',
    advice:
      'Classic scam setup: off-platform payment means zero protection, chargeback risk, and a ' +
      'possible account ban. Keep every payment and every send on Fansly.',
    patterns: [
      /\b(?:cash\s*app|cashapp|venmo|zelle|paypal|apple\s*pay|google\s*pay|wire\s+transfer|western\s+union|chime)\b/i,
      /\b(?:bitcoin|btc|ethereum|crypto|usdt)\b/i,
      /\bgift\s*card\b/i,
      /\b(?:amazon|visa)\s+gift\b/i,
      /\b(?:whatsapp|telegram|signal|kik|discord|snapchat|snap)\b/i,
      /\b(?:off|outside)\s+(?:of\s+)?(?:the\s+)?(?:app|site|platform|fansly)\b/i,
      /\btake\s+this\s+(?:some)?where\s+else\b/i,
      /\bmy\s+(?:number|cell|phone)\b/i,
      /\btext\s+me\s+at\b/i,
      // Francais
      /\b(?:virement|iban|rib|lydia|revolut)\b/i,
      /\b(?:en\s+dehors|hors)\s+(?:de\s+)?fansly\b/i
    ]
  },
  {
    code: 'freeloader',
    label: 'He is asking for free content',
    advice:
      'Do not cave on price this early. A fan who gets something free almost never buys later. ' +
      'Offer a cheaper option instead of a discount.',
    patterns: [
      /\bfor\s+free\b/i,
      /\bfree\s+(?:pic|pics|photo|photos|video|vid|content|preview|sample|taste)\b/i,
      /\bsend\s+(?:me\s+)?(?:something|one|a\s+pic|a\s+photo)\s+free\b/i,
      /\bcan\s+(?:you|u)\s+(?:just\s+)?send\s+(?:me\s+)?(?:one|something)\b/i,
      /\b(?:i'?m|im)\s+broke\b/i,
      /\b(?:no|don'?t\s+have|dont\s+have)\s+(?:any\s+)?money\b/i,
      /\bcan'?t\s+afford\b/i,
      /\bdiscount\b/i,
      /\bhook\s+me\s+up\b/i,
      // Francais
      /\bgratui?t(?:e|ement)?\b/i,
      /\bj'?ai\s+pas\s+(?:d'?argent|de\s+sous|de\s+thune)\b/i
    ]
  },
  {
    code: 'chargeback',
    label: 'Dispute or refund risk',
    advice:
      'Never promise anything that is not already in the library. Be specific about what he is ' +
      'buying (length, format, content) so he cannot claim he got something else.',
    patterns: [
      /\brefund\b/i,
      /\bcharge\s*back\b/i,
      /\bdispute\s+(?:the\s+)?(?:charge|payment)\b/i,
      /\bi\s+paid\s+(?:and|but)\s+(?:i\s+)?(?:got|received)\s+nothing\b/i,
      /\b(?:scam|scammer|scammed|ripped\s+me\s+off)\b/i,
      /\breport\s+(?:you|this)\b/i,
      // Francais
      /\brembours(?:e|ement|er)\b/i,
      /\bj'?ai\s+pay[eé]\s+et\s+(?:j'?ai\s+)?(?:rien|pas)\s+re[cç]u\b/i
    ]
  }
];

function matchRules(rules, text) {
  const hits = [];
  for (const rule of rules) {
    const pattern = rule.patterns.find((p) => p.test(text));
    if (pattern) {
      hits.push({
        code: rule.code,
        label: rule.label,
        advice: rule.advice,
        scripted: rule.scripted || null,
        matched: (text.match(pattern) || [''])[0].trim()
      });
    }
  }
  return hits;
}

/**
 * Screen an incoming fan message.
 * @returns {{ blocked: boolean, blocks: object[], warnings: object[] }}
 */
export function screenIncoming(text) {
  // Phones substitute curly apostrophes ("i'm" -> "i’m"), which would silently
  // break every pattern written with a straight quote. Normalise before matching.
  const input = String(text || '').replace(/[‘’ʼ´`]/g, "'");
  const blocks = matchRules(BLOCK_RULES, input);
  const warnings = matchRules(WARN_RULES, input);
  return { blocked: blocks.length > 0, blocks, warnings };
}

/**
 * Outgoing filter: make sure a generated reply contains none of the banned words
 * (real first name, city, school...) entered in Settings.
 * @returns {{ clean: boolean, leaked: string[] }}
 */
export function screenOutgoing(text, forbiddenWords = []) {
  const input = String(text || '').toLowerCase();
  const leaked = (forbiddenWords || [])
    .map((w) => String(w || '').trim())
    .filter((w) => w.length >= 3)
    .filter((w) => input.includes(w.toLowerCase()));
  return { clean: leaked.length === 0, leaked };
}
