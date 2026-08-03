// API routes. The only outbound calls are to the chosen AI provider, and to
// Fansly's PUBLIC profile endpoint for read-only stats. Nothing is ever written
// to Fansly and no account of hers is ever used.

import * as db from './db.js';
import {
  buildStrategy, computeStage, containsPrice, ctaLevelFor, daysSince, hasCTA,
  looksLikeOffer, PERSONALITIES, resolvePersonality, STAGES
} from './strategy.js';
import { buildMessagesPayload } from './prompt.js';
import {
  extractProfile, extractStats, extractStatsFromHar, generateSuggestions, generateText,
  transcribeScreenshots, LlmError
} from './llm.js';
import { collectFromHar, prepare } from './har.js';
import { buildManagerPayload, buildStrategyPayload, buildSnapshot } from './manager.js';
import {
  buildBriefing, buildCeoFocus, buildHealthScore, buildRootCause, buildTrends
} from './dashboard.js';
import { fetchAccount, FanslyError } from './fansly.js';
import { screenIncoming, screenOutgoing } from './safety.js';

const ok = (data) => ({ status: 200, body: data });
const bad = (message, status = 400, extra) => ({ status, body: { error: message, ...extra } });

function decorateFan(fan, config) {
  const lastFanMsg = db.db
    .prepare("SELECT created_at FROM messages WHERE fan_id = ? AND role = 'fan' ORDER BY id DESC LIMIT 1")
    .get(fan.id);
  const lastReply = db.db
    .prepare("SELECT created_at FROM messages WHERE fan_id = ? AND role = 'creator' ORDER BY id DESC LIMIT 1")
    .get(fan.id);

  const stage = computeStage(fan, config);
  const waiting =
    !!lastFanMsg && (!lastReply || new Date(lastFanMsg.created_at) > new Date(lastReply.created_at));

  return {
    ...fan,
    stage,
    stage_label: STAGES[stage].label,
    stage_color: STAGES[stage].color,
    silent_days: daysSince(lastFanMsg?.created_at || fan.last_activity),
    waiting_reply: waiting
  };
}

/**
 * A monthly target has to speak in whole-month terms — percent complete, pace,
 * dollars needed per remaining day — but "the month" changes shape depending on
 * where `now` falls, so all of that lives in one place next to the goal itself
 * rather than half in the route and half wherever it gets rendered.
 */
function buildGoal(userId, now, thisMonthRevenue) {
  const target = Number(db.getConfig(userId).revenueGoal) || 0;
  if (!target) return { target: 0 };

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysElapsed = now.getDate();
  const daysLeft = daysInMonth - daysElapsed;
  const expectedByNow = target * (daysElapsed / daysInMonth);

  return {
    target,
    pct: Math.round((thisMonthRevenue / target) * 100),
    onPace: thisMonthRevenue >= expectedByNow,
    neededPerDay: daysLeft > 0 ? Math.max(0, (target - thisMonthRevenue) / daysLeft) : 0,
    projected: daysElapsed > 0 ? Math.round((thisMonthRevenue / daysElapsed) * daysInMonth) : 0,
    daysLeft
  };
}

/* -------------------------------------------------------------------------- */

export const routes = {
  'GET /api/config': ({ userId }) => {
    const cfg = db.getConfig(userId);
    // La cle n'est jamais renvoyee en clair au navigateur.
    return ok({ ...cfg, llmApiKey: cfg.llmApiKey ? '••••••••' : '', hasKey: !!cfg.llmApiKey });
  },

  'POST /api/config': ({ body, userId }) => {
    const patch = { ...body };
    if (patch.llmApiKey === '••••••••' || patch.llmApiKey === undefined) delete patch.llmApiKey;
    if (typeof patch.forbiddenWords === 'string') {
      patch.forbiddenWords = patch.forbiddenWords.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const saved = db.saveConfig(userId, patch);
    return ok({ ...saved, llmApiKey: saved.llmApiKey ? '••••••••' : '', hasKey: !!saved.llmApiKey });
  },

  // Named for what it serves. It used to be called /api/dashboard, which collided
  // with the real dashboard: two identical keys in this object, the second one
  // silently winning, and the Follow-ups tab breaking with no error anywhere.
  'GET /api/followups': ({ userId }) => {
    const config = db.getConfig(userId);
    const fans = db.listFans(userId).map((f) => decorateFan(f, config));
    return ok({
      total_fans: fans.length,
      waiting: fans.filter((f) => f.waiting_reply && !f.blocked).length,
      whales: fans.filter((f) => f.stage === 'whale').length,
      revenue: fans.reduce((sum, f) => sum + Number(f.total_spent || 0), 0),
      relances: fans
        .filter((f) => !f.blocked && f.silent_days !== null && f.silent_days >= Number(config.silentDays || 5))
        .sort((a, b) => b.total_spent - a.total_spent)
        .slice(0, 15)
    });
  },

  'GET /api/fans': ({ userId }) => {
    const config = db.getConfig(userId);
    return ok(db.listFans(userId).map((f) => decorateFan(f, config)));
  },

  'POST /api/fans': ({ body, userId }) => {
    const handle = String(body?.handle || '').trim();
    if (!handle) return bad('Fan handle is required.');

    const config = db.getConfig(userId);
    return ok(decorateFan(db.createFan(userId, { ...body, handle }), config));
  },

  'GET /api/fans/:id': ({ params, userId }) => {
    const config = db.getConfig(userId);
    const fan = db.getFan(userId, params.id);
    if (!fan) return bad('Fan not found.', 404);

    const messages = db.listMessages(fan.id);
    const mediaSent = db.listMediaSent(fan.id);
    const lastFanMsg = [...messages].reverse().find((m) => m.role === 'fan');
    const strategy = buildStrategy({
      fan,
      config,
      mediaLibrary: db.listMedia(userId),
      mediaSent,
      history: messages,
      lastFanMessageAt: lastFanMsg?.created_at
    });

    return ok({
      fan: decorateFan(fan, config),
      messages,
      purchases: db.listPurchases(fan.id),
      pending_offers: db.listPendingOffers(userId, fan.id),
      media_sent: mediaSent,
      strategy: {
        stage: strategy.stage,
        stage_label: strategy.stageLabel,
        objectif: strategy.play.objectif,
        faire: strategy.play.faire,
        eviter: strategy.play.eviter,
        flags: strategy.flags,
        sell_blocked: strategy.sellBlocked,
        cta_level: strategy.ctaLevel,
        personality: strategy.personality,
        personality_label: strategy.personalityLabel,
        suggested_media: strategy.suggestedMedia,
        available_count: strategy.available.length
      }
    });
  },

  'PATCH /api/fans/:id': ({ params, body, userId }) => {
    const fan = db.getFan(userId, params.id);
    if (!fan) return bad('Fan not found.', 404);
    return ok(decorateFan(db.updateFan(userId, fan.id, body), db.getConfig(userId)));
  },

  'DELETE /api/fans/:id': ({ params, userId }) => {
    if (!db.deleteFan(userId, params.id)) return bad('Fan not found.', 404);
    return ok({ deleted: true });
  },

  'POST /api/fans/:id/messages': ({ params, body, userId }) => {
    const fan = db.getFan(userId, params.id);
    if (!fan) return bad('Fan not found.', 404);
    const role = body?.role === 'creator' ? 'creator' : 'fan';
    const content = String(body?.content || '').trim();
    if (!content) return bad('Empty message.');

    return ok(db.addMessage(fan.id, role, content));
  },

  'DELETE /api/messages/:id': ({ params, userId }) => {
    if (!db.deleteMessage(userId, params.id)) return bad('Message not found.', 404);
    return ok({ deleted: true });
  },

  // Import en masse : elle colle une conversation existante d'un coup.
  // Formats reconnus en debut de ligne : "lui:", "moi:", "fan:", "elle:", "him:", "me:".
  'POST /api/fans/:id/import': ({ params, body, userId }) => {
    const fan = db.getFan(userId, params.id);
    if (!fan) return bad('Fan not found.', 404);

    const raw = String(body?.text || '').trim();
    if (!raw) return bad('Nothing to import.');

    const FAN_PREFIX = /^\s*(lui|fan|him|he|client|l)\s*[:\-–]\s*/i;
    const HER_PREFIX = /^\s*(moi|elle|me|she|i)\s*[:\-–]\s*/i;

    const parsed = [];
    let current = null;

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let role = null;
      let text = line;

      if (FAN_PREFIX.test(line)) {
        role = 'fan';
        text = line.replace(FAN_PREFIX, '');
      } else if (HER_PREFIX.test(line)) {
        role = 'creator';
        text = line.replace(HER_PREFIX, '');
      }

      if (role) {
        if (current) parsed.push(current);
        current = { role, content: text.trim() };
      } else if (current) {
        current.content += `\n${line.trim()}`;
      } else {
        // Pas de prefixe du tout : on considere que c'est lui qui parle.
        current = { role: 'fan', content: line.trim() };
      }
    }
    if (current) parsed.push(current);

    const kept = parsed.filter((p) => p.content);
    for (const p of kept) db.addMessage(fan.id, p.role, p.content);

    return ok({ imported: kept.length, messages: db.listMessages(fan.id) });
  },

  // Coeur du produit : elle colle le message du fan, on renvoie 3 propositions.
  'POST /api/fans/:id/suggest': async ({ params, body, userId }) => {
    const config = db.getConfig(userId);
    const fan = db.getFan(userId, params.id);
    if (!fan) return bad('Fan not found.', 404);

    const incoming = String(body?.message || '').trim();
    if (!incoming) return bad('Paste his message first.');

    const screen = screenIncoming(incoming);

    // On enregistre le message meme s'il declenche une alerte : la trace compte.
    if (body?.save !== false) db.addMessage(fan.id, 'fan', incoming);

    if (screen.blocked) {
      const primary = screen.blocks[0];
      if (primary.code === 'minor') {
        db.updateFan(userId, fan.id, { blocked: 1, block_reason: primary.label });
      }
      return ok({
        blocked: true,
        blocks: screen.blocks,
        warnings: screen.warnings,
        move: 'block',
        reponses: primary.scripted ? [{ push: 'medium', texte: primary.scripted }] : []
      });
    }

    if (fan.blocked) {
      return ok({
        blocked: true,
        blocks: [{
          code: 'manual',
          label: 'This fan is blocked',
          advice: fan.block_reason || 'Unblock him from his fan card if this was a mistake.'
        }],
        warnings: [],
        move: 'block',
        reponses: []
      });
    }

    const messages = db.listMessages(fan.id);
    const history = messages.slice(0, -1); // le dernier est le message qu'on traite
    const mediaSent = db.listMediaSent(fan.id);
    const strategy = buildStrategy({
      fan,
      config,
      mediaLibrary: db.listMedia(userId),
      mediaSent,
      history,
      incoming,
      lastFanMessageAt: [...history].reverse().find((m) => m.role === 'fan')?.created_at
    });

    const payload = buildMessagesPayload({ config, fan, strategy, history, incoming });

    let result;
    try {
      result = await generateSuggestions({ config, fan, strategy, messages: payload, incoming });
    } catch (err) {
      if (err instanceof LlmError) {
        return { status: 502, body: { error: err.message, hint: err.hint, provider_error: true } };
      }
      throw err;
    }

    // Per-variant checks. Prices are banned from the text now: on Fansly the price
    // rides on the PPV itself, so one in the message is a mistake, not an offer.
    const reponses = result.reponses.map((r) => {
      const leak = screenOutgoing(r.texte, config.forbiddenWords);
      return {
        ...r,
        leaked: leak.clean ? null : leak.leaked,
        has_price: containsPrice(r.texte),
        no_cta: result.move === 'sell' && !hasCTA(r.texte)
      };
    });

    // Backstop: selling was blocked but the model pushed an offer anyway.
    const soldAnyway = strategy.sellBlocked && reponses.some((r) => looksLikeOffer(r.texte));
    // And the opposite: he asked to buy and the model did not move to sell.
    const missedSale = strategy.sellForced && result.move !== 'sell';

    return ok({
      blocked: false,
      warnings: screen.warnings,
      lecture: result.lecture,
      move: result.move,
      raison: result.raison,
      reponses,
      price_leak: reponses.some((r) => r.has_price),
      sold_anyway: soldAnyway,
      missed_sale: missedSale,
      demo: !!result.demo,
      malformed: !!result.malformed,
      strategy: {
        stage_label: strategy.stageLabel,
        objectif: strategy.play.objectif,
        flags: strategy.flags,
        sell_blocked: strategy.sellBlocked,
        sell_forced: strategy.sellForced,
        cta_level: strategy.ctaLevel,
        personality: strategy.personality,
        personality_label: strategy.personalityLabel,
        suggested_media: strategy.suggestedMedia
      }
    });
  },

  // She copied a reply and is about to send it on Fansly, so we archive it.
  // When it was a pitch, we also open an offer whose outcome she confirms after.
  'POST /api/fans/:id/sent': ({ params, body, userId }) => {
    const fan = db.getFan(userId, params.id);
    if (!fan) return bad('Fan not found.', 404);
    const content = String(body?.content || '').trim();
    if (!content) return bad('Empty reply.');

    const message = db.addMessage(fan.id, 'creator', content);

    let offer = null;
    if (body?.offer) {
      const config = db.getConfig(userId);
      offer = db.createOffer(userId, fan.id, {
        media_id: body.offer.media_id ?? null,
        media_title: body.offer.media_title || '',
        price: body.offer.price,
        push: body.offer.push,
        personality: body.offer.personality || resolvePersonality(fan, config),
        cta_level: body.offer.cta_level ?? ctaLevelFor(fan),
        stage: body.offer.stage || STAGES[computeStage(fan, config)].label,
        message: content
      });
    }

    return ok({ message, offer });
  },

  /* ------------------------------- Vision -------------------------------- */

  'POST /api/vision/transcribe': async ({ body, userId }) => {
    const images = Array.isArray(body?.images) ? body.images.filter((s) => typeof s === 'string') : [];
    if (!images.length) return bad('No screenshot received.');
    if (images.length > 8) return bad('Eight screenshots at a time maximum.');

    const config = db.getConfig(userId);
    try {
      const text = await transcribeScreenshots({ config, images });
      return ok({ transcript: String(text || '').trim() });
    } catch (err) {
      if (err instanceof LlmError) {
        return { status: 502, body: { error: err.message, hint: err.hint, provider_error: true } };
      }
      throw err;
    }
  },

  /* ------------------------------- Offers -------------------------------- */

  'GET /api/offers/pending': ({ query, userId }) => {
    const fanId = query.get('fan');
    return ok(db.listPendingOffers(userId, fanId ? Number(fanId) : null));
  },

  'GET /api/stats': ({ userId }) => ok(db.offerStats(userId)),

  // Answering "did he buy?" is what feeds every conversion number in the app.
  // On a yes we also log the purchase and mark the item as sent, so she never
  // has to record the same thing twice.
  'POST /api/offers/:id/outcome': ({ params, body, userId }) => {
    const offer = db.getOffer(userId, params.id);
    if (!offer) return bad('Offer not found.', 404);

    const outcome = ['bought', 'declined'].includes(body?.outcome) ? body.outcome : null;
    if (!outcome) return bad('Outcome must be "bought" or "declined".');

    const resolved = db.resolveOffer(userId, offer.id, outcome);

    if (outcome === 'bought') {
      const amount = Number(body?.amount ?? offer.price) || 0;
      if (amount > 0) db.addPurchase(userId, offer.fan_id, amount, offer.media_title || 'PPV');
      if (offer.media_id) db.markMediaSent(offer.fan_id, offer.media_id, amount);
    }

    return ok({ offer: resolved, fan: decorateFan(db.getFan(offer.fan_id), db.getConfig(userId)) });
  },

  'POST /api/fans/:id/purchases': ({ params, body, userId }) => {
    const fan = db.getFan(userId, params.id);
    if (!fan) return bad('Fan not found.', 404);
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return bad('Invalid amount.');

    // Optional back-date, for a sale logged a day or two late. Rejected outright if
    // it is not a real past date: a bad timestamp would land the money on a random
    // day of the chart, and a wrong chart is worse than a refused entry.
    let when = null;
    if (body?.created_at) {
      const d = new Date(body.created_at);
      if (Number.isNaN(d.getTime())) return bad('That purchase date is not a date.');
      if (d.getTime() > Date.now() + 86400000) return bad('That purchase date is in the future.');
      when = d.toISOString();
    }

    const updated = db.addPurchase(userId, fan.id, amount, String(body?.label || '').trim(), when);
    return ok(decorateFan(updated, db.getConfig(userId)));
  },

  /* ------------------------------ Manager -------------------------------- */

  'GET /api/manager': ({ userId }) => ok({
    messages: db.listManagerMessages(userId),
    snapshot: buildSnapshot(userId)
  }),

  'POST /api/manager': async ({ body, userId }) => {
    const question = String(body?.message || '').trim();
    if (!question) return bad('Ask something first.');

    const config = db.getConfig(userId);
    const history = db.listManagerMessages(userId);
    const snapshot = buildSnapshot(userId);

    db.addManagerMessage(userId, 'user', question);

    const payload = buildManagerPayload({ config, snapshot, history, question });

    let text;
    try {
      text = await generateText({ config, messages: payload, webSearch: !!config.managerWebSearch });
    } catch (err) {
      if (err instanceof LlmError) {
        return { status: 502, body: { error: err.message, hint: err.hint, provider_error: true } };
      }
      throw err;
    }

    const saved = db.addManagerMessage(userId, 'assistant', text);
    return ok({ reply: saved, snapshot });
  },

  'DELETE /api/manager': ({ userId }) => {
    db.clearManagerMessages(userId);
    return ok({ cleared: true });
  },

  /* -------------------- Account scan & scaling strategy ------------------- */

  // She screenshots her Fansly stats page; the vision model pulls the numbers out.
  // Nothing is stored until she confirms what was read.
  'POST /api/platform/scan': async ({ body, userId }) => {
    const images = Array.isArray(body?.images) ? body.images.filter(Boolean).slice(0, 8) : [];
    if (!images.length) return bad('No screenshots received.');

    try {
      return ok(await extractStats({ config: db.getConfig(userId), images }));
    } catch (err) {
      if (err instanceof LlmError) {
        return { status: 502, body: { error: err.message, hint: err.hint, provider_error: true } };
      }
      throw err;
    }
  },

  // HAR import: her browser already recorded these responses, so this route
  // reads a file and never contacts Fansly. `prepare` re-runs the redaction
  // server-side even though the browser already did it — the file may contain
  // her session token, and that must never reach a model.
  'POST /api/platform/har': async ({ body, userId }) => {
    const raw = Array.isArray(body?.blocks) ? body.blocks : collectFromHar(body?.har);
    const { blocks, chars } = prepare(raw);

    if (!blocks.length) {
      return bad('No Fansly statistics in that recording.', 400, {
        hint: 'Record with the Network tab open on your Insights or Earnings page, and let the numbers finish loading before exporting.'
      });
    }

    try {
      const stats = await extractStatsFromHar({ config: db.getConfig(userId), blocks });
      return ok({ ...stats, sources: blocks.map((b) => b.path), chars });
    } catch (err) {
      if (err instanceof LlmError) {
        return { status: 502, body: { error: err.message, hint: err.hint, provider_error: true } };
      }
      throw err;
    }
  },

  /* ------------------------------ Dashboard ------------------------------- */

  // Everything the dashboard draws, computed here rather than in the browser so
  // the numbers cannot drift between what is shown and what the manager reasons on.
  // One query set feeds the headline cards AND the health score / root cause /
  // CEO focus below, so nothing on the page can ever disagree with anything else.
  'GET /api/dashboard': ({ userId }) => {
    const snapshot = buildSnapshot(userId);
    const cur = snapshot.currency;
    const now = new Date();

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // Like for like. On the 2nd of the month, a full previous month against two
    // days of this one reads as a catastrophic drop that has not happened, so the
    // comparison window is only as long as this month has been running.
    const elapsed = now.getTime() - monthStart.getTime();
    const prevSoFar = new Date(prevStart.getTime() + elapsed);

    const thisMonth = db.revenueBetween(userId, monthStart.toISOString(), now.toISOString());
    const lastMonth = db.revenueBetween(userId, prevStart.toISOString(), prevSoFar.toISOString());
    const lastMonthFull = db.revenueBetween(userId, prevStart.toISOString(), monthStart.toISOString());

    const days = db.revenueByDay(userId, 30);
    const last30 = days.reduce((s, d) => s + d.total, 0);

    // 30 days against the 30 before them. Always the same length, whatever the
    // date, so this is the comparison the screen leads with — a month-to-date
    // percentage on the 2nd swings wildly off a tiny base and means nothing.
    const prev30 = db.revenueBetween(
      userId,
      new Date(Date.now() - 60 * 86400000).toISOString(),
      new Date(Date.now() - 30 * 86400000).toISOString()
    );
    const delta30 = prev30.total > 0 ? Math.round(((last30 - prev30.total) / prev30.total) * 100) : null;

    const dash = {
      currency: cur,
      totals: db.accountTotals(userId),
      byStage: snapshot.byStage,
      topSpenders: snapshot.topSpenders.slice(0, 5),
      goingQuiet: snapshot.goingQuiet.length,
      revenueByDay: days,
      newFansByDay: db.newFansByDay(userId, 30),
      last30,
      prev30: prev30.total,
      // Null rather than 0 when there is nothing to compare against: "+0%" against
      // an empty period is a made-up number, and she would act on it.
      delta30,
      thisMonth: thisMonth.total,
      lastMonth: lastMonth.total,
      lastMonthFull: lastMonthFull.total,
      monthDay: now.getDate(),
      monthDelta: lastMonth.total > 0
        ? Math.round(((thisMonth.total - lastMonth.total) / lastMonth.total) * 100)
        : null,
      offers: db.offerStats(userId),
      goal: buildGoal(userId, now, thisMonth.total)
    };

    const health = buildHealthScore(userId, dash);
    const rootCause = buildRootCause(userId, dash);

    return ok({
      ...dash,
      briefing: buildBriefing(userId),
      healthScore: health,
      trends: buildTrends(userId),
      rootCause,
      ceoFocus: buildCeoFocus(userId, { dash, health, rootCause, cur })
    });
  },

  'POST /api/goal': ({ body, userId }) => {
    const target = Number(body?.target);
    if (!Number.isFinite(target) || target < 0) return bad('Enter a whole number, 0 or more.');
    db.saveConfig(userId, { revenueGoal: Math.round(target) });
    return ok({ revenueGoal: Math.round(target) });
  },

  'GET /api/platform': ({ userId }) => ok(db.listPlatformStats(userId, 12)),

  'POST /api/platform': ({ body, userId }) => {
    const metrics = body?.metrics;
    if (!metrics || typeof metrics !== 'object' || !Object.keys(metrics).length) {
      return bad('Nothing to save.');
    }
    return ok(db.addPlatformStats(
      userId, String(body?.label || '').slice(0, 60), metrics, body?.breakdowns || null
    ));
  },

  'DELETE /api/platform/:id': ({ params, userId }) => {
    if (!db.listPlatformStats(userId, 999).some((r) => String(r.id) === String(params.id))) return bad('Not found.', 404);
    db.deletePlatformStats(userId, params.id);
    return ok({ deleted: true });
  },

  /* ------------------------- Fansly public lookup ------------------------ */

  // Reads a PUBLIC profile. No login, no write, nothing touched on the platform.
  // `save` decides whether the numbers are stored as one of her own snapshots.
  'POST /api/fansly/lookup': async ({ body, userId }) => {
    const input = String(body?.input || '').trim();
    if (!input) return bad('Paste a Fansly profile link or username.');

    let account;
    try {
      account = await fetchAccount(input);
    } catch (err) {
      if (err instanceof FanslyError) return { status: 502, body: { error: err.message, hint: err.hint } };
      throw err;
    }

    if (body?.save === 'me') {
      db.saveConfig(userId, { fanslyHandle: account.handle });
      db.addPlatformStats(userId, `@${account.handle}`, account.metrics);
    } else if (body?.save === 'competitor') {
      db.addCompetitor(userId, {
        handle: `@${account.handle}`,
        display_name: account.display_name,
        followers: account.metrics.followers,
        subscribers: account.metrics.subscribers,
        price: account.price_low,
        bio: account.bio,
        themes: '',
        notes: String(body?.notes || '')
      });
    }

    return ok(account);
  },

  /* ----------------------------- Competitors ----------------------------- */

  'GET /api/competitors': ({ userId }) => ok(db.listCompetitors(userId)),

  'POST /api/competitors/scan': async ({ body, userId }) => {
    const images = Array.isArray(body?.images) ? body.images.filter(Boolean).slice(0, 6) : [];
    if (!images.length) return bad('No screenshots received.');

    try {
      return ok(await extractProfile({ config: db.getConfig(userId), images }));
    } catch (err) {
      if (err instanceof LlmError) {
        return { status: 502, body: { error: err.message, hint: err.hint, provider_error: true } };
      }
      throw err;
    }
  },

  'POST /api/competitors': ({ body, userId }) => {
    if (!String(body?.handle || '').trim() && !String(body?.display_name || '').trim()) {
      return bad('A handle or a name is required.');
    }
    return ok(db.addCompetitor(userId, body));
  },

  'DELETE /api/competitors/:id': ({ params, userId }) => {
    if (!db.listCompetitors(userId).some((r) => String(r.id) === String(params.id))) return bad('Not found.', 404);
    db.deleteCompetitor(userId, params.id);
    return ok({ deleted: true });
  },

  'GET /api/strategy': ({ userId }) => ok(db.listStrategies(userId)),

  'GET /api/strategy/:id': ({ params, userId }) => {
    const s = db.getStrategy(userId, params.id);
    return s ? ok(s) : bad('Strategy not found.', 404);
  },

  'DELETE /api/strategy/:id': ({ params, userId }) => {
    if (!db.getStrategy(userId, params.id)) return bad('Not found.', 404);
    db.deleteStrategy(userId, params.id);
    return ok({ deleted: true });
  },

  'POST /api/strategy': async ({ body, userId }) => {
    const config = db.getConfig(userId);
    const snapshot = buildSnapshot(userId);
    const payload = buildStrategyPayload({ config, snapshot, focus: String(body?.focus || '') });

    let text;
    try {
      text = await generateText({ config, messages: payload, webSearch: !!config.managerWebSearch });
    } catch (err) {
      if (err instanceof LlmError) {
        return { status: 502, body: { error: err.message, hint: err.hint, provider_error: true } };
      }
      throw err;
    }

    const title = new Date().toISOString().slice(0, 10) +
      (body?.focus ? ` — ${String(body.focus).slice(0, 40)}` : ' — scaling plan');

    return ok(db.saveStrategy(userId, title, text));
  },

  'GET /api/personalities': ({ userId }) =>
    ok(Object.entries(PERSONALITIES).map(([key, p]) => ({ key, label: p.label, hint: p.hint }))),

  'GET /api/media': ({ userId }) => ok(db.listMedia(userId)),

  'POST /api/media': ({ body, userId }) => {
    const title = String(body?.title || '').trim();
    if (!title) return bad('Title is required.');

    return ok(db.createMedia(userId, {
      title,
      tags: String(body?.tags || '').trim(),
      price: Number(body?.price) || 0,
      notes: String(body?.notes || '').trim()
    }));
  },

  'DELETE /api/media/:id': ({ params, userId }) => {
    if (!db.deleteMedia(userId, params.id)) return bad('Content not found.', 404);
    return ok({ deleted: true });
  },

  'POST /api/fans/:id/media-sent': ({ params, body, userId }) => {
    const fan = db.getFan(userId, params.id);
    if (!fan) return bad('Fan not found.', 404);
    const mediaId = Number(body?.media_id);
    if (!mediaId) return bad('Invalid content item.');
    return ok(db.markMediaSent(fan.id, mediaId, Number(body?.price) || 0));
  }
};
