// Adaptateur moteur IA.
// Changer de fournisseur = changer 'llmProvider' dans les reglages, rien d'autre.
//
//   mock       : mode demo, aucune cle requise. Sert a tester l'interface.
//   openrouter : https://openrouter.ai (une cle, des dizaines de modeles)
//   custom     : n'importe quelle API compatible OpenAI (modele local, LM Studio,
//                Ollama, ou tout autre fournisseur). On renseigne juste l'URL de base.

// A DM reply comes back in seconds; a full strategy report with web search can
// take well over a minute, so the ceiling is set for the slowest call.
const TIMEOUT_MS = 180000;

// How many times a cut-off answer may be resumed before we hand back what we have.
const MAX_CONTINUATIONS = 3;

class LlmError extends Error {
  constructor(message, { status = 0, hint = '' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.hint = hint;
  }
}

/* --------------------------- Mode demo (sans cle) -------------------------- */

function mockCompletion({ fan, strategy, incoming }) {
  const who = fan.display_name || fan.handle;
  const media = strategy.suggestedMedia;
  const short = incoming.length > 60 ? `${incoming.slice(0, 60)}...` : incoming;

  const canSell = !strategy.sellBlocked && media;
  const subject = canSell ? `"${media.title}"` : `"${short}"`;

  return {
    lecture:
      `[DEMO MODE - no AI engine connected] Stage "${strategy.stageLabel}", ` +
      `character "${strategy.personalityLabel}", CTA level ${strategy.ctaLevel}/4.`,
    move: canSell ? 'sell' : 'tease',
    raison: canSell
      ? 'Demo: selling is allowed here.'
      : 'Demo: selling is blocked here, so tease instead.',
    reponses: [
      { push: 'soft', texte: `[DEMO] Soft reply to ${who} about ${subject}. Barely any push.` },
      { push: 'medium', texte: `[DEMO] Balanced reply with a clean call to action, no price.` },
      { push: 'hard', texte: `[DEMO] Hard close at CTA level ${strategy.ctaLevel}. Connect an API key in Settings for real text.` }
    ],
    demo: true
  };
}

/* ------------------------------ Appel reel -------------------------------- */

function extractJson(raw) {
  const text = String(raw || '').trim();
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch { /* on tente l'extraction ci-dessous */ }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch { /* echec definitif */ }
  }
  return null;
}

const VALID_MOVES = new Set(['chat', 'tease', 'sell']);
const PUSH_ORDER = ['soft', 'medium', 'hard'];

function normalise(parsed, raw) {
  const list = Array.isArray(parsed?.reponses) ? parsed.reponses : [];

  const reponses = list
    .map((r, i) => ({
      push: PUSH_ORDER.includes(r?.push) ? r.push : (PUSH_ORDER[i] || 'medium'),
      texte: String(r?.texte ?? r?.text ?? '').trim()
    }))
    .filter((r) => r.texte)
    // Keep them in soft -> hard order whatever order the model emitted.
    .sort((a, b) => PUSH_ORDER.indexOf(a.push) - PUSH_ORDER.indexOf(b.push));

  if (reponses.length) {
    return {
      lecture: String(parsed.lecture || '').trim(),
      move: VALID_MOVES.has(parsed.move) ? parsed.move : 'chat',
      raison: String(parsed.raison || '').trim(),
      reponses
    };
  }

  // A model that answered with a single reply instead of the list.
  const single = String(parsed?.texte ?? parsed?.text ?? '').trim();
  if (single) {
    return {
      lecture: String(parsed.lecture || '').trim(),
      move: VALID_MOVES.has(parsed.move) ? parsed.move : 'chat',
      raison: String(parsed.raison || '').trim(),
      reponses: [{ push: 'medium', texte: single }]
    };
  }

  // Format ignored entirely: surface the raw output rather than lose the generation.
  const fallback = String(raw || '').trim();
  if (!fallback) throw new LlmError('The model returned an empty response.');
  return {
    lecture: 'The model did not follow the expected format, here is its raw output.',
    move: 'chat',
    raison: '',
    reponses: [{ push: 'medium', texte: fallback.slice(0, 1200) }],
    malformed: true
  };
}

/** Calls the provider and returns the raw assistant text. */
async function rawCompletion({ config, messages, temperature = 0.9, maxTokens = 900, modelOverride }) {
  const baseUrl = (config.llmBaseUrl || '').trim().replace(/\/+$/, '');
  const model = (modelOverride || config.llmModel || '').trim();
  const apiKey = (config.llmApiKey || '').trim();

  if (!baseUrl) throw new LlmError('Provider URL is missing.', { hint: 'Settings > AI engine' });
  if (!model) throw new LlmError('No model selected.', { hint: 'Settings > AI engine' });
  if (!apiKey && config.llmProvider === 'openrouter') {
    throw new LlmError('API key is missing.', { hint: 'Paste your OpenRouter key in Settings.' });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (config.llmProvider === 'openrouter') {
    headers['HTTP-Referer'] = 'http://localhost';
    headers['X-Title'] = 'chatmate';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new LlmError('The model took too long to respond.');
    throw new LlmError(`Could not reach the provider: ${err.message}`, {
      hint: 'Check your connection and the base URL in Settings.'
    });
  }
  clearTimeout(timer);

  const bodyText = await res.text();

  if (!res.ok) {
    let detail = bodyText.slice(0, 300);
    try {
      detail = JSON.parse(bodyText)?.error?.message || detail;
    } catch { /* on garde le texte brut */ }

    // OpenRouter caps how many tokens a request may reserve against the remaining
    // balance. Low credit therefore shows up as a truncated answer, not as an
    // obvious "out of money" error, so it is worth naming explicitly.
    const afford = /can only afford (\d+)/i.exec(detail);
    if (afford) {
      const err = new LlmError(
        `Not enough OpenRouter credit: this answer can only be ${afford[1]} tokens long.`,
        'Top up at openrouter.ai/settings/credits. Answers stay short and get cut off until you do.'
      );
      err.affordable = Number(afford[1]);
      throw err;
    }

    const hints = {
      401: 'API key is invalid or expired.',
      402: 'Out of OpenRouter credit. This is also what makes answers come back cut off. Top up at openrouter.ai/settings/credits.',
      403: 'This model refuses this kind of content. Try a less filtered open-weight model.',
      404: 'Model name not found. Check the exact identifier.',
      429: 'Too many requests, wait a few seconds.'
    };
    throw new LlmError(`Error ${res.status}: ${detail}`, { status: res.status, hint: hints[res.status] || '' });
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new LlmError('Unreadable response from the provider.');
  }

  const choice = payload?.choices?.[0];
  const raw = choice?.message?.content;
  if (!raw) throw new LlmError('The provider returned no content.');

  // "length" means the model was cut off mid-sentence by max_tokens, not that it
  // finished. Callers that produce long text use this to ask for the rest.
  return { text: raw, truncated: choice?.finish_reason === 'length' };
}

async function chatCompletion({ config, messages }) {
  const { text } = await rawCompletion({ config, messages, maxTokens: 1400 });
  return normalise(extractJson(text), text);
}

/**
 * Reads screenshots of a DM thread and returns it as a him:/me: transcript.
 * Saves her from retyping conversations by hand to train the model.
 */
export async function transcribeScreenshots({ config, images }) {
  if (!config.llmProvider || config.llmProvider === 'mock') {
    return 'him: [demo mode]\nme: connect an AI engine in Settings and screenshots will be read for real';
  }

  const visionConfig = {
    ...config,
    llmModel: (config.llmVisionModel || '').trim() || config.llmModel
  };

  const instructions = [
    'These are screenshots of a private DM thread on Fansly, between an adult content creator',
    'and one of her fans. They are in chronological order and may overlap slightly.',
    '',
    'Transcribe every message you can read, in order, one per line:',
    '- prefix HER messages with "me:"',
    '- prefix HIS messages with "him:"',
    '',
    'Her messages are the ones aligned to one side and styled as sent; his are the received ones.',
    'Keep the exact wording, spelling, typos, slang and emoji. Do not translate.',
    'Do not summarise, do not clean it up, do not censor anything, do not comment.',
    'Skip timestamps, read receipts, prices, buttons and anything that is not a message.',
    'If two screenshots overlap, output the repeated messages only once.',
    'Output the transcript and nothing else.'
  ].join('\n');

  const content = [{ type: 'text', text: instructions }];
  for (const url of images) content.push({ type: 'image_url', image_url: { url } });

  const { text } = await rawCompletion({
    config: visionConfig,
    messages: [{ role: 'user', content }],
    temperature: 0.1,
    maxTokens: 3000
  });
  return text;
}

/**
 * Reads a screenshot of a Fansly stats / earnings / insights page and pulls the
 * numbers out of it. Deliberately schema-free: those pages differ a lot, so the
 * model returns whatever labels it actually sees rather than guessing at ours.
 */
export async function extractStats({ config, images }) {
  if (!config.llmProvider || config.llmProvider === 'mock') {
    return { period: 'demo', metrics: { followers: 1234, subscribers: 56, earnings: 789 } };
  }

  const visionConfig = {
    ...config,
    llmModel: (config.llmVisionModel || '').trim() || config.llmModel
  };

  const instructions = [
    'These are screenshots of the statistics, earnings or insights pages of an adult',
    'content creator account (Fansly or similar).',
    '',
    'Extract everything you can actually read. Return ONLY valid JSON, no code fence:',
    '{',
    '  "period": "what timeframe the screen covers, e.g. \\"last 30 days\\" or \\"March 2026\\", or \\"\\" if unclear",',
    '  "metrics": { "snake_case_label": number, ... },',
    '  "breakdowns": {',
    '    "traffic_sources": [{"name": "where the visit came from", "share": percentage as a number}],',
    '    "top_content":     [{"title": "post or media label", "value": number, "unit": "views|likes|earnings|purchases"}],',
    '    "hashtags":        [{"tag": "#thetag", "value": number, "unit": "views|posts|engagement"}]',
    '  }',
    '}',
    '',
    'Rules:',
    '- Use the label shown on screen, lowercased with underscores: "total earnings" -> "total_earnings".',
    '- Numbers only: strip currency symbols, commas and percent signs. "1,234.50" -> 1234.5, "12%" -> 12.',
    '- Watch time, average view duration and engagement rate go in "metrics" as numbers.',
    '  Convert durations to seconds: "1m 30s" -> 90, "2:15" -> 135.',
    '- Read values off charts and bars too, including the labels around a pie or donut.',
    '- Any breakdown you cannot see must be an empty array. Never invent a source, a tag or a title.',
    '- Do not invent a metric you cannot see. Do not guess. Omit anything unreadable.',
    '- If several screenshots cover the same metric, keep the clearest value once.',
    '- Ignore navigation, buttons and decorative text.'
  ].join('\n');

  const content = [{ type: 'text', text: instructions }];
  for (const url of images) content.push({ type: 'image_url', image_url: { url } });

  const { text: raw } = await rawCompletion({
    config: visionConfig,
    messages: [{ role: 'user', content }],
    temperature: 0.1,
    maxTokens: 2000
  });

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed.metrics !== 'object' || !parsed.metrics) {
    throw new LlmError('Could not read any numbers from those screenshots.', {
      hint: 'Make sure the figures are legible, and try one page at a time.'
    });
  }

  // Keep only clean numeric values: a metric the app cannot plot is worse than none.
  const metrics = {};
  for (const [key, value] of Object.entries(parsed.metrics)) {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n)) metrics[String(key).slice(0, 40)] = n;
  }

  const b = parsed.breakdowns || {};
  const list = (rows, shape) => (Array.isArray(rows) ? rows : [])
    .map((r) => shape(r))
    .filter((r) => r && r.label && Number.isFinite(r.value))
    .slice(0, 15);

  const breakdowns = {
    traffic_sources: list(b.traffic_sources, (r) => ({
      label: String(r?.name || '').slice(0, 40),
      value: Number(r?.share),
      unit: '%'
    })),
    top_content: list(b.top_content, (r) => ({
      label: String(r?.title || '').slice(0, 60),
      value: Number(r?.value),
      unit: String(r?.unit || '').slice(0, 12)
    })),
    hashtags: list(b.hashtags, (r) => ({
      label: String(r?.tag || '').slice(0, 40),
      value: Number(r?.value),
      unit: String(r?.unit || '').slice(0, 12)
    }))
  };

  const hasAnything = Object.keys(metrics).length ||
    Object.values(breakdowns).some((v) => v.length);

  if (!hasAnything) throw new LlmError('No readable numbers in those screenshots.');

  return { period: String(parsed.period || '').slice(0, 60), metrics, breakdowns };
}

/**
 * Reads a screenshot of another creator's public profile. This is how real
 * competitor data gets into the app: she finds them in Fansly's own search,
 * screenshots them, and the model only ever reports what is on the picture.
 */
export async function extractProfile({ config, images }) {
  if (!config.llmProvider || config.llmProvider === 'mock') {
    return { handle: '@demo_creator', display_name: 'Demo', followers: 12000, subscribers: null, price: 9.99, bio: 'demo mode', themes: 'demo' };
  }

  const visionConfig = {
    ...config,
    llmModel: (config.llmVisionModel || '').trim() || config.llmModel
  };

  const instructions = [
    "These are screenshots of another content creator's public profile page.",
    '',
    'Return ONLY valid JSON, no code fence:',
    '{',
    '  "handle": "@username exactly as shown, or \\"\\" if not visible",',
    '  "display_name": "the shown display name, or \\"\\"",',
    '  "followers": number or null,',
    '  "subscribers": number or null,',
    '  "price": subscription price as a number, or null,',
    '  "bio": "the bio text, copied as written, or \\"\\"",',
    '  "themes": "short comma list of the content themes you can SEE, or \\"\\""',
    '}',
    '',
    'Absolute rule: report ONLY what is legible in the images.',
    'Never guess a handle, never estimate a follower count, never infer a price.',
    'If a field is not visible, return null or an empty string. An empty field is correct;',
    'an invented one is a serious error.',
    'Strip separators from numbers: "12.4K" -> 12400, "1,203" -> 1203.'
  ].join('\n');

  const content = [{ type: 'text', text: instructions }];
  for (const url of images) content.push({ type: 'image_url', image_url: { url } });

  const { text: raw } = await rawCompletion({
    config: visionConfig,
    messages: [{ role: 'user', content }],
    temperature: 0.1,
    maxTokens: 900
  });

  const parsed = extractJson(raw);
  if (!parsed || (!parsed.handle && !parsed.display_name)) {
    throw new LlmError('Could not read a profile in those screenshots.', {
      hint: 'Capture the top of the profile, where the handle and the counts are.'
    });
  }
  return parsed;
}

/**
 * Plain-text generation, used by the manager chat (no JSON contract there).
 */
export async function generateText({ config, messages, webSearch = false, maxTokens = 4000 }) {
  if (!config.llmProvider || config.llmProvider === 'mock') {
    return (
      '**Demo mode — no AI engine connected.**\n\n' +
      'Connect a model in Settings and the manager will answer using your real numbers: ' +
      'revenue, fan stages, who is going quiet, and what your library is missing.'
    );
  }

  // OpenRouter turns on its web search plugin for any model suffixed with ":online".
  const base = (config.llmModel || '').trim();
  const modelOverride =
    webSearch && config.llmProvider === 'openrouter' && base && !base.endsWith(':online')
      ? `${base}:online`
      : undefined;

  const call = (msgs, maxTokens) =>
    rawCompletion({ config, messages: msgs, temperature: 0.7, maxTokens, modelOverride });

  let first;
  try {
    first = await call(messages, maxTokens);
  } catch (err) {
    // Low balance: retry once with what the account can actually pay for, so she
    // gets a shorter answer rather than an error screen.
    if (err instanceof LlmError && err.affordable > 200) {
      first = await call(messages, err.affordable - 50);
      first.lowCredit = true;
    } else {
      throw err;
    }
  }

  let { text, truncated } = first;

  // A cut-off answer is worse than a short one: she reads a plan that stops
  // mid-sentence and cannot tell what is missing. Ask for the rest and stitch it.
  // No point asking for the rest when the balance is what capped it.
  let rounds = 0;
  while (truncated && !first.lowCredit && rounds < MAX_CONTINUATIONS) {
    rounds += 1;
    const next = await call([
      ...messages,
      { role: 'assistant', content: text },
      {
        role: 'user',
        content:
          'You were cut off. Continue from exactly where you stopped, mid-sentence if needed. ' +
          'Do not repeat anything already written, do not reintroduce the topic, do not add a preamble.'
      }
    ], maxTokens);

    // Join without a space when we resumed mid-word.
    text += /\s$/.test(text) || /^\s/.test(next.text) ? next.text : ` ${next.text}`;
    truncated = next.truncated;
  }

  // Models like wrapping a long markdown answer in a fence, which would then be
  // rendered as one big code block.
  const clean = String(text)
    .replace(/^\s*```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim();

  if (first.lowCredit) {
    return `${clean}\n\n---\n\n**⚠️ Cut short: your OpenRouter credit is nearly gone.** ` +
      'Top up at openrouter.ai/settings/credits to get full answers again.';
  }
  if (truncated) {
    return `${clean}\n\n---\n\n*(Answer stopped here after several continuations. Ask a narrower question for the rest.)*`;
  }
  return clean;
}

/**
 * Point d'entree unique. Retourne { lecture, reponses[], demo?, malformed? }.
 */
export async function generateSuggestions({ config, fan, strategy, messages, incoming }) {
  if (!config.llmProvider || config.llmProvider === 'mock') {
    return mockCompletion({ fan, strategy, incoming });
  }
  return chatCompletion({ config, messages });
}

export { LlmError };
