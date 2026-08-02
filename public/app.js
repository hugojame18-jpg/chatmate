/* Single-page UI, no framework.
   Rule number one: nothing is ever sent to Fansly. Copy, then paste by hand. */

const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const backEl = document.getElementById('back');
const pillEl = document.getElementById('topPill');
const toastEl = document.getElementById('toast');

/* --------------------------------- Helpers -------------------------------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

async function api(path, { method = 'GET', body } = {}) {
  const send = () => fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  let res;
  try {
    res = await send();
  } catch (err) {
    /* The request never left, or died on a connection that was being closed at
       both ends at once. Reading the same data again is free and harmless, so
       one silent retry turns a visible error into nothing at all. Writes are
       never retried: a repeated POST can bill a second AI call or duplicate a
       row, and a wrong write is worse than a visible failure. */
    if (method !== 'GET') throw err;
    await new Promise((r) => setTimeout(r, 400));
    res = await send();
  }

  // Session expired or signed out elsewhere: back to the login screen.
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.hint = data.hint;
    err.providerError = data.provider_error;
    throw err;
  }
  return data;
}

/* The modern clipboard API needs HTTPS or localhost. On a phone over local wifi
   we are on plain http, hence the fallback. */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

/* ------------------------------ Bottom sheet ------------------------------- */

/* Everything secondary lives in here. The conversation screen stays down to the
   only thing she does a hundred times a day: paste, generate, copy. */
function openSheet(title, html) {
  closeSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.id = 'sheetBackdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.id = 'sheet';
  sheet.innerHTML = `<div class="grabber"></div><h2>${esc(title)}</h2>${html}`;

  backdrop.onclick = closeSheet;
  document.body.append(backdrop, sheet);
  document.body.style.overflow = 'hidden';
  return sheet;
}

function closeSheet() {
  document.getElementById('sheetBackdrop')?.remove();
  document.getElementById('sheet')?.remove();
  document.body.style.overflow = '';
}

/* Stable colour per fan so she recognises a thread by its avatar. */
function avatarStyle(seed) {
  let h = 0;
  for (const ch of String(seed || '?')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `background:linear-gradient(135deg,hsl(${h} 65% 52%),hsl(${(h + 40) % 360} 70% 44%))`;
}

const STAGE_ORDER = ['New', 'Warm', 'Buyer', 'Whale'];
const journey = (label) => {
  const at = STAGE_ORDER.indexOf(label);
  return `<span class="journey">${STAGE_ORDER
    .map((_, i) => `<i class="${i <= at ? 'done' : ''}"></i>`).join('')}</span>`;
};

const PERSONA_EMOJI = {
  sweet: '🍯', submissive: '🎀', dominant: '😈',
  bratty: '😏', girlfriend: '💗', mysterious: '🌙'
};

/* ---------------------------- Screenshot import ---------------------------- */

/** Opens the photo picker and returns downscaled JPEG data URLs. */
function pickScreenshots() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = async () => {
      const files = [...(input.files || [])].slice(0, 8);
      const out = [];
      for (const file of files) out.push(await shrinkImage(file));
      document.body.removeChild(input);
      resolve(out.filter(Boolean));
    };
    input.click();
  });
}

/* A HAR is a recording her browser already made of her own Insights pages, so
   importing one sends nothing to Fansly. It is also huge (often 100 MB+) and holds
   her live session token, so it is filtered and scrubbed HERE, on her own device.
   Only the small cleaned result is uploaded — and the server scrubs it again. */
function pickHar() {
  const isFanslyApi = (url) => {
    try {
      const u = new URL(url);
      return /(^|\.)fansly\.com$/i.test(u.hostname) && /\/api\//i.test(u.pathname);
    } catch { return false; }
  };

  const scrub = (text) => String(text)
    .replace(/"(\w*(?:token|auth|session|password|secret|apikey|checkkey|signature)\w*)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"')
    .replace(/[A-Za-z0-9_-]{40,}/g, (m) =>
      (/[A-Za-z]/.test(m) && /[0-9]/.test(m)) ? '[redacted]' : m);

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.har,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = async () => {
      const file = (input.files || [])[0];
      document.body.removeChild(input);
      if (!file) return resolve(null);

      let har;
      try {
        har = JSON.parse(await file.text());
      } catch {
        return resolve({ error: 'That file could not be read as a recording.' });
      }
      if (!Array.isArray(har?.log?.entries)) {
        return resolve({ error: 'That is not a HAR recording.' });
      }

      const blocks = [];
      for (const e of har.log.entries) {
        const url = e?.request?.url;
        const body = e?.response?.content?.text;
        if (!url || !isFanslyApi(url)) continue;
        if (typeof body !== 'string' || !/^\s*[{[]/.test(body)) continue;
        blocks.push({ url, body: scrub(body).slice(0, 8000) });
        if (blocks.length >= 120) break;
      }
      resolve({ blocks });
    };
    input.click();
  });
}

/* Phone screenshots are 2-4 MB each. Sending them raw would be slow and would cost
   far more per call, so they are resized before they ever leave the browser. */
function shrinkImage(file, maxSide = 1400, quality = 0.75) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(null);
      img.src = reader.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * Full flow: pick screenshots, read them, drop the transcript into a textarea.
 * `mode` is 'append' (training field) or 'replace' (fan import field).
 */
async function importFromScreenshots(btn, targetId, mode = 'append') {
  const images = await pickScreenshots();
  if (!images.length) return;

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = `⏳ Reading ${images.length} screenshot(s)…`;

  try {
    const res = await api('/vision/transcribe', { method: 'POST', body: { images } });
    const target = document.getElementById(targetId);
    if (!res.transcript) {
      toast('Nothing readable in those screenshots');
    } else if (mode === 'append' && target.value.trim()) {
      target.value = `${target.value.trim()}\n\n--- next ---\n\n${res.transcript}`;
      toast('Added — check it, then save');
    } else {
      target.value = res.transcript;
      toast('Transcribed — check it before saving');
    }
    target.scrollIntoView({ block: 'center' });
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

const initials = (s) => String(s || '?').replace(/^@/, '').slice(0, 2).toUpperCase();

function money(n, cur = 'USD') {
  const sym = { USD: '$', EUR: '€', GBP: '£' }[cur] || '';
  return cur === 'USD' || cur === 'GBP' ? `${sym}${Number(n || 0).toFixed(0)}` : `${Number(n || 0).toFixed(0)}${sym}`;
}

function ago(days) {
  if (days === null || days === undefined) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

/* ---------------------------------- State --------------------------------- */

let config = {};

function setHeader(title, { back = false, pill = '' } = {}) {
  titleEl.textContent = title;
  backEl.hidden = !back;
  pillEl.textContent = pill;
  pillEl.style.display = pill ? '' : 'none';
}

function setTab(name) {
  document.querySelectorAll('.tabbar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === name);
  });
}

/* ------------------------------- View: Fans -------------------------------- */

async function viewFans() {
  setHeader('Fans');
  setTab('fans');
  view.innerHTML = '<div class="loading">Loading…</div>';

  const [fans, dash] = await Promise.all([api('/fans'), api('/dashboard')]);
  const cur = config.currency;

  const waiting = fans.filter((f) => f.waiting_reply && !f.blocked);
  const others = fans.filter((f) => !f.waiting_reply || f.blocked);

  const item = (f) => `
    <a class="fan-item ${f.waiting_reply && !f.blocked ? 'waiting' : ''}" href="#/fan/${f.id}">
      <div class="avatar" style="${avatarStyle(f.handle)}">${esc(initials(f.display_name || f.handle))}</div>
      <div class="grow">
        <div class="row between" style="margin-bottom:3px">
          <strong class="truncate">${esc(f.display_name || f.handle)}</strong>
          <span class="tiny">${money(f.total_spent, cur)}</span>
        </div>
        <div class="tiny truncate" style="margin-bottom:5px">
          ${f.blocked ? '🚫 blocked · ' : ''}${esc(f.last_message || 'no messages yet')}
        </div>
        <div class="row" style="gap:8px">
          ${journey(f.stage_label)}
          <span class="tiny">${esc(ago(f.silent_days))}</span>
        </div>
      </div>
      ${f.waiting_reply && !f.blocked ? '<span class="dot"></span>' : ''}
    </a>`;

  // One sentence telling her what to do, instead of four numbers to interpret.
  const headline = !fans.length
    ? 'Add your first fan 👋'
    : waiting.length
      ? `<em>${waiting.length}</em> ${waiting.length > 1 ? 'people are' : 'person is'} waiting on you`
      : 'All caught up ✨';

  const hour = new Date().getHours();
  const greet = hour < 6 ? 'Late night' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';

  view.innerHTML = `
    <div class="hero">
      <div class="greet">${greet}</div>
      <div class="headline">${headline}</div>
    </div>

    ${waiting.length ? waiting.map(item).join('') : ''}

    ${others.length ? `
      <div class="row between" style="margin:22px 0 11px">
        <span class="tiny" style="font-weight:700;letter-spacing:.5px">EVERYONE ELSE</span>
        <span class="tiny">${money(dash.revenue, cur)} · ${dash.whales} whale${dash.whales === 1 ? '' : 's'}</span>
      </div>
      ${others.map(item).join('')}` : ''}

    ${!fans.length ? `
      <div class="empty">
        <span class="big-emoji">💬</span>
        No fans yet.<br>Add one below and paste his first message.
      </div>` : ''}

    <button class="big" id="addFanBtn" style="margin-top:14px">➕ Add a fan</button>
  `;

  document.getElementById('addFanBtn').onclick = () => {
    const sheet = openSheet('New fan', `
      <div class="stack">
        <div><label>His handle on Fansly</label><input id="nfHandle" placeholder="@mike92" /></div>
        <div><label>His name, if you know it</label><input id="nfName" placeholder="Mike" /></div>
        <div><label>What he likes</label><input id="nfKinks" placeholder="lingerie, voice notes" /></div>
        <button class="primary big" id="nfSave">Add him</button>
      </div>`);

    const handleInput = sheet.querySelector('#nfHandle');
    handleInput.focus();

    const save = async () => {
      const handle = handleInput.value.trim();
      if (!handle) return toast('He needs a handle');
      const fan = await api('/fans', {
        method: 'POST',
        body: {
          handle,
          display_name: sheet.querySelector('#nfName').value.trim(),
          kinks: sheet.querySelector('#nfKinks').value.trim()
        }
      });
      closeSheet();
      location.hash = `#/fan/${fan.id}`;
    };
    sheet.querySelector('#nfSave').onclick = save;
    handleInput.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  };
}

/* ----------------------------- View: Follow-ups ---------------------------- */

async function viewRelances() {
  setHeader('Follow-ups');
  setTab('relances');
  view.innerHTML = '<div class="loading">Loading…</div>';

  const dash = await api('/dashboard');
  const cur = config.currency;

  view.innerHTML = `
    <div class="hero">
      <div class="greet">Quiet for ${config.silentDays}+ days</div>
      <div class="headline">${dash.relances.length
        ? `<em>${dash.relances.length}</em> worth waking up`
        : 'Nobody to chase 👌'}</div>
    </div>

    ${dash.relances.length ? `
      <div class="alert info">
        Biggest spenders first. Something light brings more back than a pitch.
      </div>` : ''}

    ${dash.relances.map((f) => `
      <a class="fan-item" href="#/fan/${f.id}">
        <div class="avatar" style="${avatarStyle(f.handle)}">${esc(initials(f.display_name || f.handle))}</div>
        <div class="grow">
          <div class="row between" style="margin-bottom:3px">
            <strong class="truncate">${esc(f.display_name || f.handle)}</strong>
            <span class="tiny">${money(f.total_spent, cur)}</span>
          </div>
          <div class="row" style="gap:8px">
            ${journey(f.stage_label)}
            <span class="tiny">silent ${f.silent_days}d</span>
          </div>
        </div>
      </a>`).join('') || `
      <div class="empty">
        <span class="big-emoji">🎉</span>
        Everyone has heard from you recently.
      </div>`}
  `;
}

/* --------------------------- View: Conversation ---------------------------- */

async function viewFan(id) {
  setTab('fans');
  view.innerHTML = '<div class="loading">Loading…</div>';

  const [data, media, personalities] = await Promise.all([
    api(`/fans/${id}`), api('/media'), api('/personalities')
  ]);
  const { fan, messages, strategy, media_sent: mediaSent, purchases, pending_offers: pending } = data;
  const cur = config.currency;

  setHeader(fan.display_name || fan.handle, { back: true, pill: fan.stage_label });
  pillEl.style.background = fan.stage_color;
  pillEl.style.color = '#fff';

  const recent = messages.slice(-4);
  const hidden = messages.length - recent.length;

  view.innerHTML = `
    ${fan.blocked ? `
      <div class="alert block">
        <strong>🚫 Blocked — ${esc(fan.block_reason)}</strong>
        No replies will be generated. Open his card below if this was a false alarm.
      </div>` : ''}

    ${(pending || []).length ? `<div id="pendingOffers"></div>` : ''}

    <div class="row between" style="margin:2px 0 12px">
      <div class="row" style="gap:9px">
        ${journey(strategy.stage_label)}
        <span class="tiny">${esc(strategy.stage_label)} · ${money(fan.total_spent, cur)}</span>
      </div>
      <button class="chip" id="openCard">${PERSONA_EMOJI[strategy.personality] || '🎭'} ${esc(strategy.personality_label)}</button>
    </div>

    <div class="card" id="threadCard">
      ${hidden > 0 ? `<button class="ghost sm" id="showAll" style="width:100%;margin-bottom:9px">↑ ${hidden} earlier message${hidden > 1 ? 's' : ''}</button>` : ''}
      <div class="thread" id="thread">
        ${recent.map((m) => `<div class="bubble ${m.role}">${esc(m.content)}</div>`).join('')
          || '<div class="tiny">Nothing yet. Paste his message below to get started.</div>'}
      </div>
    </div>

    <div class="compose">
      <textarea id="incoming" placeholder="Paste what he just wrote…"></textarea>
      <button class="primary big" id="generate" style="margin-top:11px">✨ Write my replies</button>
    </div>

    <div id="output"></div>

    <button class="ghost sm" id="openCard2" style="width:100%">⚙️ His card, purchases, content, import</button>
  `;

  // Built as a string, not rendered: putting it in the DOM twice would duplicate
  // every id and getElementById would grab the hidden copy.
  const fanCardHtml = `
      <div class="stack">
        <label>Character she plays with him</label>
        <div class="chips">
          ${personalities.map((p) => `
            <button class="chip ${p.key === strategy.personality ? 'on' : ''}" data-persona="${p.key}">
              ${PERSONA_EMOJI[p.key] || ''} ${esc(p.label)}</button>`).join('')}
        </div>
        <div class="tiny" id="personaHint">${esc(personalities.find((p) => p.key === strategy.personality)?.hint || '')}</div>

        <hr />

        <div><label>His name — fill this in, or the AI will invent one</label><input id="fDisplay" value="${esc(fan.display_name)}" /></div>
        <div><label>What he likes (fed into every generation)</label><textarea id="fKinks" style="min-height:64px">${esc(fan.kinks)}</textarea></div>
        <div><label>Free notes</label><textarea id="fNotes" style="min-height:64px">${esc(fan.notes)}</textarea></div>
        <div><label>Timezone / when he is around</label><input id="fTz" value="${esc(fan.timezone)}" placeholder="e.g. EST, writes at night" /></div>
        <button class="sm primary" id="saveFan">Save his card</button>

        <hr />

        <label>Reply you wrote yourself</label>
        <textarea id="manual" style="min-height:64px" placeholder="Keeps the history complete so the AI stays in context."></textarea>
        <button class="sm" id="saveManual">Save to history</button>

        <hr />

        <label>Log a purchase</label>
        <div class="row" style="gap:8px">
          <input id="pAmount" type="number" inputmode="decimal" placeholder="Amount" style="max-width:110px" />
          <input id="pLabel" class="grow" placeholder="What for? (optional)" />
          <button class="sm" id="addPurchase">+</button>
        </div>
        ${purchases.length ? `<div class="tiny">${purchases.slice(0, 6).map((p) => `${money(p.amount, cur)} ${esc(p.label)}`).join(' · ')}</div>` : ''}

        <hr />

        <label>Mark content as sent (prevents duplicates)</label>
        <div class="chips">
          ${media.filter((m) => !mediaSent.some((s) => s.media_id === m.id))
            .map((m) => `<button class="chip" data-media="${m.id}" data-price="${m.price}">${esc(m.title)} · ${money(m.price, cur)}</button>`)
            .join('') || '<span class="tiny">He has received the whole library, or the library is empty.</span>'}
        </div>
        ${mediaSent.length ? `<div class="tiny">Already received: ${mediaSent.map((m) => esc(m.title)).join(', ')}</div>` : ''}

        <hr />

        <label>Import an existing conversation</label>
        <button class="sm" id="importShots" style="margin-bottom:8px">📷 From screenshots</button>
        <textarea id="importText" style="min-height:70px" placeholder="him: hey how are you&#10;me: hey you 😘&#10;him: what are you up to"></textarea>
        <button class="sm primary" id="doImport" style="margin-top:8px">Import into history</button>

        <hr />
        <div class="row" style="gap:8px">
          ${fan.blocked
            ? '<button class="sm" id="unblock">Unblock this fan</button>'
            : '<button class="sm" id="block">Block this fan</button>'}
          <button class="sm danger" id="delFan">Delete</button>
        </div>
      </div>`;

  const thread = document.getElementById('thread');
  thread.scrollTop = thread.scrollHeight;

  /* -- The sheet holds everything that is not "paste, generate, copy" -- */
  const openCard = () => {
    openSheet(fan.display_name || fan.handle, fanCardHtml);
    wireFanCard(id, personalities);
  };
  document.getElementById('openCard').onclick = openCard;
  document.getElementById('openCard2').onclick = openCard;

  const showAll = document.getElementById('showAll');
  if (showAll) showAll.onclick = () => {
    thread.innerHTML = messages.map((m) => `<div class="bubble ${m.role}">${esc(m.content)}</div>`).join('');
    showAll.remove();
  };

  /* -- Pitches still waiting on an answer -- */
  const pendingHost = document.getElementById('pendingOffers');
  if (pendingHost) {
    for (const offer of pending) askOutcome(pendingHost, offer, id);
  }

  /* -- Generation -- */
  const incoming = document.getElementById('incoming');
  const output = document.getElementById('output');
  const genBtn = document.getElementById('generate');

  genBtn.onclick = async () => {
    const message = incoming.value.trim();
    if (!message) return toast('Paste his message first');

    genBtn.disabled = true;
    genBtn.textContent = '⏳ Thinking…';
    output.innerHTML = '';

    try {
      const res = await api(`/fans/${id}/suggest`, { method: 'POST', body: { message } });
      incoming.value = '';
      renderReply(output, res, id, message);
      await refreshThread(id, thread);
    } catch (err) {
      output.innerHTML = `
        <div class="alert block">
          <strong>${esc(err.message)}</strong>
          ${err.hint ? esc(err.hint) : 'Check the AI engine settings.'}
          ${err.providerError ? '<div class="tiny" style="margin-top:8px">His message was still saved to the history.</div>' : ''}
        </div>`;
      await refreshThread(id, thread);
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = '✨ Write my replies';
    }
  };

}

/* Wires the fan sheet once it is open. Lives apart from viewFan because the
   elements only exist from the moment the sheet is rendered. */
function wireFanCard(id, personalities) {
  const sheet = document.getElementById('sheet');
  if (!sheet) return;
  const $ = (sel) => sheet.querySelector(sel);
  const reopen = () => { closeSheet(); viewFan(id); };

  sheet.querySelectorAll('[data-persona]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/fans/${id}`, { method: 'PATCH', body: { personality: btn.dataset.persona } });
      sheet.querySelectorAll('[data-persona]').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      const p = personalities.find((x) => x.key === btn.dataset.persona);
      $('#personaHint').textContent = p?.hint || '';
      toast(`Now playing ${p?.label}`);
    };
  });

  $('#saveFan').onclick = async () => {
    await api(`/fans/${id}`, {
      method: 'PATCH',
      body: {
        display_name: $('#fDisplay').value,
        kinks: $('#fKinks').value,
        notes: $('#fNotes').value,
        timezone: $('#fTz').value
      }
    });
    toast('Saved');
  };

  $('#saveManual').onclick = async () => {
    const content = $('#manual').value.trim();
    if (!content) return;
    await api(`/fans/${id}/sent`, { method: 'POST', body: { content } });
    toast('Added to history');
    reopen();
  };

  $('#addPurchase').onclick = async () => {
    const amount = Number($('#pAmount').value);
    if (!amount) return toast('Amount missing');
    await api(`/fans/${id}/purchases`, { method: 'POST', body: { amount, label: $('#pLabel').value } });
    toast('💰 Logged');
    reopen();
  };

  sheet.querySelectorAll('[data-media]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/fans/${id}/media-sent`, {
        method: 'POST',
        body: { media_id: Number(btn.dataset.media), price: Number(btn.dataset.price) }
      });
      toast('Marked as sent');
      reopen();
    };
  });

  $('#importShots').onclick = (e) => importFromScreenshots(e.currentTarget, 'importText', 'replace');

  $('#doImport').onclick = async () => {
    const text = $('#importText').value.trim();
    if (!text) return;
    const res = await api(`/fans/${id}/import`, { method: 'POST', body: { text } });
    toast(`${res.imported} messages imported`);
    reopen();
  };

  const blockBtn = $('#block');
  if (blockBtn) blockBtn.onclick = async () => {
    await api(`/fans/${id}`, { method: 'PATCH', body: { blocked: 1, block_reason: 'Blocked manually' } });
    reopen();
  };
  const unblockBtn = $('#unblock');
  if (unblockBtn) unblockBtn.onclick = async () => {
    await api(`/fans/${id}`, { method: 'PATCH', body: { blocked: 0, block_reason: '' } });
    reopen();
  };

  $('#delFan').onclick = async () => {
    if (!confirm('Delete this fan and their entire history?')) return;
    await api(`/fans/${id}`, { method: 'DELETE' });
    closeSheet();
    location.hash = '#/fans';
  };
}

async function refreshThread(id, thread) {
  const data = await api(`/fans/${id}`);
  // Only the tail: the point of the screen is the reply, not the archive.
  thread.innerHTML = data.messages.slice(-6)
    .map((m) => `<div class="bubble ${m.role}">${esc(m.content)}</div>`).join('');
  thread.scrollTop = thread.scrollHeight;
}

const MOVE_STYLE = {
  chat:  { label: 'JUST TALKING', color: '#7c8aa5' },
  tease: { label: 'TEASING',      color: '#e0a63a' },
  sell:  { label: 'SELLING',      color: '#c9459f' },
  block: { label: 'BLOCKED',      color: '#e05252' }
};

const PUSH_STYLE = {
  soft:   { label: 'GENTLE', note: 'barely pushes' },
  medium: { label: 'BALANCED', note: 'clean call to action' },
  hard:   { label: 'GO FOR IT', note: 'closes hard' }
};

function renderReply(container, res, fanId, incomingText) {
  const parts = [];

  for (const b of res.blocks || []) {
    parts.push(`
      <div class="alert block">
        <strong>⛔ ${esc(b.label)}</strong>
        ${esc(b.advice)}
        ${b.matched ? `<div class="tiny" style="margin-top:6px">Detected: "${esc(b.matched)}"</div>` : ''}
      </div>`);
  }

  for (const w of res.warnings || []) {
    parts.push(`
      <div class="alert warn">
        <strong>⚠️ ${esc(w.label)}</strong>
        ${esc(w.advice)}
      </div>`);
  }

  if (res.demo) {
    parts.push(`
      <div class="alert warn">
        <strong>Demo mode</strong>
        No AI engine is connected, the text below is a placeholder.
        Go to Settings to connect a model.
      </div>`);
  }

  if (res.missed_sale) {
    parts.push(`
      <div class="alert warn">
        <strong>⚠️ He asked to buy and it dodged</strong>
        He asked a direct buying question but the reply names no item and no price.
        Hit Another take, or add the price yourself before sending.
      </div>`);
  }

  if (res.sold_anyway) {
    parts.push(`
      <div class="alert warn">
        <strong>⚠️ It pitched when it should not have</strong>
        Selling was blocked for this message (you offered recently, or he turned one down).
        Strip the price out before sending, or hit Another take.
      </div>`);
  }

  const replies = res.reponses || [];

  if (replies.length) {
    const move = MOVE_STYLE[res.move] || MOVE_STYLE.chat;
    const cta = res.strategy?.cta_level;

    parts.push(`
      <div class="row between" style="margin:4px 2px 12px">
        <span class="pill stage" style="background:${move.color}">${move.label}</span>
        <span class="tiny">${cta ? `push ${'●'.repeat(cta)}${'○'.repeat(4 - cta)}` : ''}${res.strategy?.sell_blocked ? ' · 🔒' : ''}</span>
      </div>
      ${res.raison ? `<div class="tiny" style="margin:0 2px 12px">${esc(res.raison)}</div>` : ''}`);

    replies.forEach((r, i) => {
      const p = PUSH_STYLE[r.push] || PUSH_STYLE.medium;
      parts.push(`
        <div class="tier ${r.push}">
          <div class="tier-head">
            <span class="tier-name">${p.label}</span>
            <span class="tiny">${p.note}</span>
          </div>
          <div class="text" id="reply-${i}">${esc(r.texte)}</div>
          ${r.has_price ? '<div class="alert warn"><strong>There is a price in the text</strong>The PPV already carries its price. Delete the number before sending.</div>' : ''}
          ${r.no_cta ? '<div class="alert warn"><strong>No call to action</strong>It describes the content and stops. Use another one, or add an ask.</div>' : ''}
          ${r.leaked ? `<div class="alert block"><strong>Personal info detected</strong>Contains: ${esc(r.leaked.join(', '))}. Fix before sending.</div>` : ''}
          <div class="row" style="gap:8px">
            <button class="primary grow" data-copy="${i}">📋 Copy this one</button>
            <button data-edit="${i}">✏️</button>
          </div>
        </div>`);
    });

    parts.push('<button class="ghost sm" id="regen" style="width:100%">🔄 Give me three new ones</button>');

    if (res.lecture) {
      parts.push(`<div class="alert info" style="margin-top:14px"><strong>What he wants</strong>${esc(res.lecture)}</div>`);
    }
  } else if (!(res.blocks || []).length) {
    parts.push('<div class="empty">No reply generated.</div>');
  }

  container.innerHTML = parts.join('');

  container.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      const i = btn.dataset.copy;
      const text = container.querySelector(`#reply-${i}`).textContent;
      const done = await copyText(text);
      if (!done) return toast('Copy failed — select the text manually');

      // Copying means she is about to send it, so archive it right away.
      // If it was a pitch, open an offer so we can learn whether it converted.
      const media = res.strategy?.suggested_media;
      const isPitch = res.move === 'sell';
      const payload = { content: text };
      if (isPitch) {
        payload.offer = {
          media_id: media?.id ?? null,
          media_title: media?.title || '',
          price: media?.price ?? 0,
          push: (res.reponses[i] || {}).push || '',
          personality: res.strategy?.personality || '',
          cta_level: res.strategy?.cta_level || 0,
          stage: res.strategy?.stage_label || ''
        };
      }

      const saved = await api(`/fans/${fanId}/sent`, { method: 'POST', body: payload });
      toast('Copied and saved — paste it into Fansly');

      const thread = document.getElementById('thread');
      if (thread) refreshThread(fanId, thread);

      if (saved.offer) askOutcome(btn.closest('.tier'), saved.offer, fanId);
    };
  });

  container.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.onclick = () => {
      const el = container.querySelector(`#reply-${btn.dataset.edit}`);
      el.contentEditable = 'true';
      el.style.outline = '2px solid var(--accent)';
      el.focus();
      toast('Edit it, then hit Copy');
    };
  });

  const regenBtn = document.getElementById('regen');
  if (regenBtn) regenBtn.onclick = async () => {
    regenBtn.disabled = true;
    regenBtn.textContent = '⏳ Rewriting…';
    try {
      // save:false so his message is not logged a second time.
      const next = await api(`/fans/${fanId}/suggest`, {
        method: 'POST',
        body: { message: incomingText, save: false }
      });
      renderReply(container, next, fanId, incomingText);
    } catch (err) {
      toast(err.message);
      regenBtn.disabled = false;
      regenBtn.textContent = '🔄 Three new ones';
    }
  };
}

/* ---------------------- Account data (used by Settings) --------------------- */

/* Her own profile, her private stats and the tracked competitors. This lived on
   the Manager tab, which pushed the chat below three cards of setup work. It is
   maintenance she does weekly, so it belongs with the rest of the setup. */
function accountDataHtml(competitors, config, cur) {
  return `
    <div class="card">
      <h2>My account</h2>
      <div class="row" style="gap:8px;margin-bottom:9px">
        <input id="myHandle" class="grow" placeholder="fansly.com/her-username" value="${esc(config.fanslyHandle ? "@" + config.fanslyHandle : "")}" />
        <button class="primary" id="fetchMine">↻</button>
      </div>
      <div class="tiny">
        Paste her profile link once, then tap ↻ to pull followers, subscribers, likes,
        photos and videos straight from her public page.
      </div>

      <div style="margin-top:15px;padding-top:14px;border-top:1px solid var(--line)">
        <strong style="font-size:14px">Private stats</strong>
        <div class="tiny" style="margin:5px 0 10px">
          Earnings, traffic sources, watch time, top fans — the numbers only you can see.
          Screenshot them on your phone and send them here. Nothing is ever sent to Fansly.
        </div>
        <button class="primary" id="scanStats" style="width:100%">📷 Send my stats screenshots</button>
        <button class="chip" id="shotHow" style="margin-top:8px">Which screens?</button>
        <div id="shotHelp" hidden class="tiny" style="margin-top:10px;line-height:1.65">
          In the Fansly app, screenshot these — up to 8 at a time:
          <ol style="margin:7px 0 0;padding-left:18px">
            <li><b>Insights</b> — the overview with views and engagement.</li>
            <li><b>Insights</b> again, scrolled down to <b>traffic sources</b>.</li>
            <li><b>Earnings</b> — the totals and the breakdown.</li>
            <li><b>Top supporters</b>, if you can see it.</li>
          </ol>
          <div style="margin-top:9px">
            Set the period to <b>the same range on every screen</b> (last 30 days works well),
            and let the numbers finish loading before you screenshot. Blurry or half-loaded
            figures get skipped rather than guessed.
          </div>
        </div>
        <div id="scanResult"></div>

        <details style="margin-top:12px">
          <summary class="tiny" style="cursor:pointer">On a computer instead?</summary>
          <div class="tiny" style="margin:9px 0 0;line-height:1.65">
            A browser recording imports everything at once, no screenshots.
            In Chrome: open your <b>Insights</b> page, press <b>F12</b>, click <b>Network</b>,
            reload, do the same on <b>Earnings</b>, then <b>⤓ Export HAR</b>.
            Your login is stripped out here before anything is uploaded.
          </div>
          <button class="sm ghost" id="importHar" style="width:100%;margin-top:9px">📁 Import a recording</button>
          <div id="harResult"></div>
        </details>
      </div>
    </div>

    <div class="card">
      <h2>Competitors</h2>
      <div class="tiny" style="margin-bottom:11px">
        The manager is only allowed to name creators listed here. Find them in Fansly search,
        screenshot the profile, import it — then the numbers are real.
      </div>
      ${competitors.map((c) => `
        <div class="row between" style="padding:9px 0;border-bottom:1px solid var(--line)">
          <div class="grow">
            <strong>${esc(c.handle || c.display_name)}</strong>
            <div class="tiny">
              ${[c.followers != null ? `${c.followers.toLocaleString()} followers` : null,
                 c.subscribers != null ? `${c.subscribers.toLocaleString()} subs` : null,
                 c.price != null ? `${money(c.price, cur)}/mo` : null,
                 c.themes || null].filter(Boolean).join(" · ") || "no figures read"}
            </div>
          </div>
          <button class="sm danger" data-delcomp="${c.id}">✕</button>
        </div>`).join("")}
      <div class="row" style="gap:8px;margin:12px 0 8px">
        <input id="compLink" class="grow" placeholder="Paste a competitor profile link" />
        <button class="primary" id="fetchComp">+</button>
      </div>
      <button class="sm ghost" id="scanProfile" style="width:100%">📷 Or import from a screenshot</button>
      <div id="profileResult"></div>
    </div>`;
}

/** Wires everything accountDataHtml renders. `refresh` re-renders the host view. */
function bindAccountData(refresh) {
  /* -- One-tap refresh straight from her public Fansly page -- */
  const lookup = async (btn, input, save, notes) => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳';
    try {
      const res = await api('/fansly/lookup', { method: 'POST', body: { input, save, notes } });
      toast(`✅ ${res.display_name || res.handle} — ${res.metrics.followers.toLocaleString()} followers`);
      refresh();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = label;
    }
  };

  document.getElementById('fetchMine').onclick = (e) => {
    const v = document.getElementById('myHandle').value.trim();
    if (!v) return toast('Paste her profile link first');
    lookup(e.currentTarget, v, 'me');
  };

  document.getElementById('fetchComp').onclick = (e) => {
    const v = document.getElementById('compLink').value.trim();
    if (!v) return toast('Paste a profile link first');
    lookup(e.currentTarget, v, 'competitor');
  };

  /* Both stats imports end the same way: show everything that was read, let her
     check it, and store nothing until she taps save. Shared so the screenshot path
     shows the breakdowns too — it always extracted them, it just never showed them,
     which meant saving figures she had no way to verify. */
  const showStats = (box, res, onSaved) => {
    const metrics = Object.entries(res.metrics || {});
    const b = res.breakdowns || {};

    const rows = (title, list) => (list && list.length ? `
      <div class="tiny" style="margin:12px 0 5px;font-weight:700">${title}</div>
      ${list.map((r) => `
        <div class="row between" style="padding:5px 2px">
          <span class="tiny">${esc(r.label)}</span>
          <b>${r.value.toLocaleString()}${r.unit === '%' ? '%' : ''}</b>
        </div>`).join('')}` : '');

    box.innerHTML = `
      <div class="alert info" style="margin-top:12px">
        <strong>Read ${metrics.length} figure${metrics.length === 1 ? '' : 's'}${res.period ? ` · ${esc(res.period)}` : ''}</strong>
        Check them before saving. If one is wrong, retake that screen.
      </div>
      ${metrics.map(([k, v]) => `
        <div class="row between" style="padding:6px 2px">
          <span class="tiny">${esc(k.replace(/_/g, ' '))}</span><b>${v.toLocaleString()}</b>
        </div>`).join('')}
      ${rows('TRAFFIC SOURCES', b.traffic_sources)}
      ${rows('TOP CONTENT', b.top_content)}
      ${rows('HASHTAGS', b.hashtags)}
      <button class="primary sm" data-save-stats style="width:100%;margin-top:12px">Save this snapshot</button>`;

    box.querySelector('[data-save-stats]').onclick = async () => {
      await api('/platform', {
        method: 'POST',
        body: { metrics: res.metrics, breakdowns: res.breakdowns, label: res.period || 'private stats' }
      });
      toast('📊 Snapshot saved');
      onSaved();
    };
  };

  const showStatsError = (box, err) => {
    box.innerHTML = `<div class="alert block" style="margin-top:12px"><strong>${esc(err.message)}</strong>${esc(err.hint || '')}</div>`;
  };

  /* -- Screenshots: her only route, since she works from a phone -- */
  document.getElementById('shotHow').onclick = (e) => {
    const help = document.getElementById('shotHelp');
    help.hidden = !help.hidden;
    e.currentTarget.textContent = help.hidden ? 'Which screens?' : 'Hide';
  };

  document.getElementById('scanStats').onclick = async (e) => {
    const btn = e.currentTarget;
    const images = await pickScreenshots();
    if (!images.length) return;

    const box = document.getElementById('scanResult');
    box.innerHTML = '';
    btn.disabled = true;
    btn.textContent = `⏳ Reading ${images.length} screenshot${images.length === 1 ? '' : 's'}…`;

    try {
      showStats(box, await api('/platform/scan', { method: 'POST', body: { images } }), viewManager);
    } catch (err) {
      showStatsError(box, err);
    } finally {
      btn.disabled = false;
      btn.textContent = '📷 Send my stats screenshots';
    }
  };

  /* -- HAR import: reads a recording her browser already made. No request to Fansly. -- */
  document.getElementById('importHar').onclick = async (e) => {
    const btn = e.currentTarget;
    const box = document.getElementById('harResult');
    box.innerHTML = '';

    btn.disabled = true;
    btn.textContent = '⏳ Reading the file…';

    try {
      const picked = await pickHar();
      if (!picked) return;
      if (picked.error) throw new Error(picked.error);
      if (!picked.blocks.length) {
        throw Object.assign(new Error('No Fansly data in that recording.'), {
          hint: 'The Network tab has to be recording while the Insights page loads its numbers.'
        });
      }

      btn.textContent = `⏳ Reading ${picked.blocks.length} response(s)…`;
      showStats(box, await api('/platform/har', { method: 'POST', body: { blocks: picked.blocks } }), viewManager);
    } catch (err) {
      showStatsError(box, err);
    } finally {
      btn.disabled = false;
      btn.textContent = '📁 Import a recording';
    }
  };

  /* -- Competitor profiles, read off her own screenshots -- */
  view.querySelectorAll('[data-delcomp]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/competitors/${btn.dataset.delcomp}`, { method: 'DELETE' });
      refresh();
    };
  });

  document.getElementById('scanProfile').onclick = async (e) => {
    const btn = e.currentTarget;
    const images = await pickScreenshots();
    if (!images.length) return;

    const box = document.getElementById('profileResult');
    btn.disabled = true;
    btn.textContent = '⏳ Reading the profile…';
    box.innerHTML = '';

    try {
      const p = await api('/competitors/scan', { method: 'POST', body: { images } });
      box.innerHTML = `
        <div class="alert info" style="margin-top:12px">
          <strong>Check what was read</strong>
          Anything left empty was not legible — leave it empty rather than guessing.
        </div>
        <div class="stack">
          <div><label>Handle</label><input id="cpHandle" value="${esc(p.handle || '')}" /></div>
          <div class="row" style="gap:8px">
            <div class="grow"><label>Followers</label><input id="cpFollowers" type="number" value="${p.followers ?? ''}" /></div>
            <div class="grow"><label>Subs</label><input id="cpSubs" type="number" value="${p.subscribers ?? ''}" /></div>
            <div class="grow"><label>Price</label><input id="cpPrice" type="number" value="${p.price ?? ''}" /></div>
          </div>
          <div><label>Themes</label><input id="cpThemes" value="${esc(p.themes || '')}" /></div>
          <div><label>Your notes — what does she do well?</label><textarea id="cpNotes" style="min-height:60px"></textarea></div>
          <button class="primary sm" id="saveComp">Add this competitor</button>
        </div>`;

      document.getElementById('saveComp').onclick = async () => {
        await api('/competitors', {
          method: 'POST',
          body: {
            handle: document.getElementById('cpHandle').value,
            display_name: p.display_name || '',
            followers: document.getElementById('cpFollowers').value || null,
            subscribers: document.getElementById('cpSubs').value || null,
            price: document.getElementById('cpPrice').value || null,
            bio: p.bio || '',
            themes: document.getElementById('cpThemes').value,
            notes: document.getElementById('cpNotes').value
          }
        });
        toast('Competitor added');
        refresh();
      };
    } catch (err) {
      box.innerHTML = `<div class="alert block" style="margin-top:12px"><strong>${esc(err.message)}</strong>${esc(err.hint || '')}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '📷 Import a competitor profile';
    }
  };
}


/* ------------------------------ View: Manager ------------------------------ */

// Minimal markdown for the manager's answers. Escaped first, so nothing the model
// writes can inject markup.
function mini_md(src) {
  const out = [];
  let list = null;          // 'ul' | 'ol' while a list is open
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline_md(para.join('<br>'))}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const openList = (kind) => {
    if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
  };

  for (const rawLine of esc(src).split('\n')) {
    const line = rawLine.trimEnd();

    if (!line.trim()) { flushPara(); flushList(); continue; }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,6}\s+(.*)$/);

    if (heading) {
      flushPara(); flushList();
      out.push(`<h3>${inline_md(heading[1])}</h3>`);
    } else if (bullet) {
      flushPara(); openList('ul');
      out.push(`<li>${inline_md(bullet[1])}</li>`);
    } else if (numbered) {
      flushPara(); openList('ol');
      out.push(`<li>${inline_md(numbered[1])}</li>`);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

function inline_md(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/* Asking "did he buy?" right after she copies is the whole point: it is the only
   moment the answer is fresh, and it is what every conversion number is built on. */
function askOutcome(host, offer, fanId, onDone) {
  if (!host) return;
  const box = document.createElement('div');
  box.className = 'alert info';
  box.style.marginTop = '10px';
  box.innerHTML = `
    <strong>Did he buy${offer.media_title ? ` "${esc(offer.media_title)}"` : ''}?</strong>
    <div class="tiny" style="margin-bottom:9px">
      A yes logs the purchase and marks the content as sent — nothing else to record.
    </div>
    <div class="row" style="gap:8px">
      <button class="sm primary grow" data-out="bought">✅ Yes</button>
      <button class="sm grow" data-out="declined">✖️ No</button>
      <button class="sm ghost" data-out="later">Later</button>
    </div>`;
  host.appendChild(box);

  box.querySelectorAll('[data-out]').forEach((b) => {
    b.onclick = async () => {
      const outcome = b.dataset.out;
      if (outcome === 'later') {
        box.innerHTML = '<span class="tiny">Left pending — you can answer it from his fan card.</span>';
        return;
      }
      await api(`/offers/${offer.id}/outcome`, { method: 'POST', body: { outcome } });
      box.className = outcome === 'bought' ? 'alert info celebrate' : 'alert warn';
      box.innerHTML = outcome === 'bought'
        ? `<strong>💰 Nice one${offer.price ? ` — +${money(offer.price, config.currency)}` : ''}</strong>Purchase logged and content marked as sent.`
        : '<strong>Noted</strong>Counted as a miss — it is what makes your stats real.';
      if (onDone) onDone();
    };
  });
}

/* Grouped so it is obvious the manager handles the whole business, not just chatting. */
const MANAGER_PROMPTS = [
  ['💡 Content', [
    'Give me 20 video ideas I could shoot this week',
    'Photo set concepts that sell well in my niche',
    'Plan a shoot day so I can batch a month of content',
    'What should I offer as a custom, and at what price?'
  ]],
  ['📣 Marketing', [
    'How do I grow my Fansly with Reddit and X?',
    'Write me a bio and a promo caption',
    'What should I be known for? Help me pick a niche'
  ]],
  ['🔍 Research', [
    'What is working in my niche right now?',
    'Who are the top creators in my niche and what do they do well?'
  ]],
  ['💰 Money', [
    'How should I price my next PPV?',
    'How do I get more out of my whales?',
    'Why am I not converting more fans?'
  ]],
  ['💬 Chatting', [
    'What should I focus on this week?',
    'Who should I follow up with and what do I say?'
  ]]
];

/* Direction is what matters, so each metric is shown as latest + change since the
   first import, not as a wall of raw figures. */
function platformTrend(snaps) {
  const latest = snaps[snaps.length - 1];
  const first = snaps[0];
  const keys = Object.keys(latest.metrics).slice(0, 10);
  if (!keys.length) return '<div class="tiny">Nothing readable in the last import.</div>';

  // Durations are stored as seconds; "102" on screen reads as nothing useful.
  const show = (key, v) => {
    if (/(time|duration)/i.test(key) && v >= 60) {
      return `${Math.floor(v / 60)}m ${String(Math.round(v % 60)).padStart(2, '0')}s`;
    }
    if (/(rate|percent|share)/i.test(key)) return `${v}%`;
    return v.toLocaleString();
  };

  const rows = keys.map((k) => {
    const now = latest.metrics[k];
    const was = first.metrics[k];
    let delta = '';
    if (snaps.length > 1 && typeof was === 'number' && was !== 0) {
      const pct = Math.round(((now - was) / Math.abs(was)) * 100);
      const colour = pct > 0 ? 'var(--ok)' : pct < 0 ? 'var(--danger)' : 'var(--muted)';
      delta = `<span style="color:${colour};font-weight:700">${pct >= 0 ? '+' : ''}${pct}%</span>`;
    }
    return `
      <div class="row between" style="padding:7px 0;border-bottom:1px solid var(--line)">
        <span class="tiny">${esc(k.replace(/_/g, ' '))}</span>
        <span class="row" style="gap:9px">
          <b style="font-size:15px">${show(k, now)}</b>${delta}
        </span>
      </div>`;
  }).join('');

  const span = snaps.length > 1
    ? `${snaps.length} imports · since ${String(first.captured_at).slice(0, 10)}`
    : `1 import · ${String(latest.captured_at).slice(0, 10)}`;

  return `<div class="tiny" style="margin-bottom:6px">${span}</div>${rows}${breakdownBlocks(latest.breakdowns)}`;
}

/* Traffic sources, hashtags and best posts from the latest import. */
function breakdownBlocks(breakdowns) {
  if (!breakdowns) return '';

  const block = (rows, title, asBar) => {
    if (!Array.isArray(rows) || !rows.length) return '';
    const max = Math.max(...rows.map((r) => r.value), 1);
    return `
      <div style="margin-top:16px">
        <div class="tiny" style="font-weight:700;margin-bottom:8px">${title}</div>
        ${rows.map((r) => `
          <div class="meter">
            <span class="k" style="width:104px">${esc(r.label)}</span>
            <span class="track"><span class="fill" style="width:${Math.round((r.value / max) * 100)}%"></span></span>
            <span class="v" style="width:66px">${asBar ? `${r.value}%` : `${r.value.toLocaleString()}${r.unit ? ` ${esc(r.unit)}` : ''}`}</span>
          </div>`).join('')}
      </div>`;
  };

  return [
    block(breakdowns.traffic_sources, '📍 Where visits come from', true),
    block(breakdowns.top_content, '🔥 Best performing content', false),
    block(breakdowns.hashtags, '#️⃣ Hashtags that work', false)
  ].join('');
}

/** Which of the three Manager panes is open. Survives a re-render. */
let managerPane = 'chat';

async function viewManager() {
  setHeader('Manager');
  setTab('manager');
  view.innerHTML = '<div class="loading">Loading…</div>';

  const [{ messages, snapshot }, stats, platform, strategies] = await Promise.all([
    api('/manager'), api('/stats'), api('/platform'), api('/strategy')
  ]);
  const cur = snapshot.currency;
  const t = snapshot.totals;

  // Under this many resolved pitches a percentage is noise, so it is shown greyed
  // out rather than as a result she should act on.
  const RELIABLE = 8;

  const bar = (rows, title) => {
    if (!rows.length) return '';
    const best = Math.max(...rows.map((r) => r.rate), 1);
    return `
      <div style="margin-bottom:12px">
        <div class="tiny" style="margin-bottom:6px">${title}</div>
        ${rows.map((r) => {
          const thin = r.sent < RELIABLE;
          return `
          <div class="meter ${thin ? 'thin' : ''}">
            <span class="k">${esc(String(r.key)).slice(0, 12)}</span>
            <span class="track"><span class="fill" style="width:${Math.round((r.rate / best) * 100)}%"></span></span>
            <span class="v">${r.rate}% (${r.bought}/${r.sent})</span>
          </div>`;
        }).join('')}
      </div>`;
  };

  const anyThin = [...stats.byPush, ...stats.byPersonality, ...stats.byMedia, ...stats.byStage]
    .some((r) => r.sent < RELIABLE);

  const perf = stats.resolved
    ? `
      <div class="card">
        <h2>What actually converts</h2>
        <div class="row between" style="margin-bottom:12px">
          <div><b style="font-size:22px">${stats.rate}%</b> <span class="tiny">of pitches convert</span></div>
          <div class="tiny">${stats.bought}/${stats.resolved} closed · ${money(stats.revenue, cur)} earned${stats.pending ? ` · ${stats.pending} unanswered` : ''}</div>
        </div>
        ${bar(stats.byPush, 'By push level')}
        ${bar(stats.byPersonality, 'By character')}
        ${bar(stats.byMedia, 'By item')}
        ${bar(stats.byStage, 'By stage')}
        ${anyThin ? `<div class="tiny">⚠️ Greyed out means fewer than ${RELIABLE} answered pitches — that is chance, not a result. Do not change anything based on those yet.</div>` : ''}
      </div>`
    : `
      <div class="alert info">
        <strong>No conversion data yet</strong>
        ${stats.total
          ? `${stats.total} pitch(es) logged, ${stats.pending} still waiting on a yes or no.`
          : 'Answer "did he buy?" after each pitch and this fills in on its own.'}
        Once there is enough, you will see which push level, character and item actually sell.
      </div>`;

  /* Chat first, and the composer at the top of it. Everything used to live on one
     page with the chat underneath, so asking a question meant scrolling past every
     card on the screen. */
  const chatPane = `
    <div class="card composer">
      <textarea id="mgrInput" placeholder="Ask about content, pricing, growth — anything." style="min-height:62px"></textarea>
      <div class="row" style="gap:8px;margin-top:9px">
        <button class="primary grow" id="mgrSend">Ask</button>
        ${messages.length ? '<button class="sm danger" id="mgrClear">Clear</button>' : ''}
      </div>
      <select id="mgrPreset" style="margin-top:9px">
        <option value="">💡 Or pick a ready-made question…</option>
        ${MANAGER_PROMPTS.map(([group, qs]) => `
          <optgroup label="${esc(group)}">
            ${qs.map((q) => `<option value="${esc(q)}">${esc(q)}</option>`).join('')}
          </optgroup>`).join('')}
      </select>
      <div class="tiny" style="margin-top:9px">
        ${config.managerWebSearch
          ? '🌐 Web search is on — it can look up your niche and other creators.'
          : '🔒 No web access. Turn it on in Settings for research questions.'}
      </div>
    </div>

    <div id="mgrThread">
      ${messages.length ? messages.map((m) => `
        <div class="mgr ${m.role}">${m.role === 'assistant' ? mini_md(m.content) : esc(m.content)}</div>
      `).join('') : `
        <div class="empty" style="padding:30px 10px">
          <span class="big-emoji">📈</span>
          Ask anything about your account.<br>
          <span class="tiny">It reads your real numbers, not generic Fansly advice.</span>
        </div>`}
    </div>`;

  const statsPane = `
    <div class="hero">
      <div class="greet">Your account, in numbers</div>
      <div class="headline"><em>${money(t.revenue, cur)}</em> earned so far</div>
    </div>

    <div class="stat-grid" style="margin-bottom:14px">
      <div class="stat hi"><b>${stats.rate === null ? '—' : stats.rate + '%'}</b><span class="tiny">pitch → sale</span></div>
      <div class="stat"><b>${t.conversion}%</b><span class="tiny">${t.paying}/${t.fans} paying</span></div>
      <div class="stat"><b>${money(t.avg_order, cur)}</b><span class="tiny">avg order</span></div>
      <div class="stat"><b>${snapshot.goingQuiet.length}</b><span class="tiny">going quiet</span></div>
    </div>

    ${perf}

    <div class="card">
      <h2>From Fansly</h2>
      ${platform.length ? platformTrend(platform) : `
        <div class="tiny">
          Nothing imported yet. Send your Fansly stats screenshots from
          <b>Settings → My account</b> and they show up here.
        </div>`}
    </div>`;

  const planPane = `
    <div class="card">
      <h2>Scaling strategy</h2>
      <div class="tiny" style="margin-bottom:11px">
        A full written plan: bottleneck, content, pricing, growth, retention, and a
        week-by-week month. Uses everything the app knows${config.managerWebSearch ? ' plus live research' : ''}.
      </div>
      <input id="stratFocus" placeholder="Anything to focus on? (optional)" style="margin-bottom:9px" />
      <button class="primary" id="genStrategy" style="width:100%">📋 Write my scaling plan</button>
      ${strategies.length ? `
        <div class="tiny" style="margin:14px 0 7px;font-weight:700">SAVED PLANS</div>
        <div class="chips">
          ${strategies.map((s) => `<button class="chip" data-strategy="${s.id}">${esc(s.title)}</button>`).join('')}
        </div>` : ''}
    </div>

    <div id="strategyOut"></div>`;

  view.innerHTML = `
    <div class="segmented">
      ${[['chat', '💬 Chat'], ['stats', '📊 Stats'], ['plan', '🚀 Plan']]
        .map(([k, label]) => `<button data-pane="${k}" class="${managerPane === k ? 'on' : ''}">${label}</button>`)
        .join('')}
    </div>
    ${managerPane === 'stats' ? statsPane : managerPane === 'plan' ? planPane : chatPane}
  `;

  view.querySelectorAll('[data-pane]').forEach((btn) => {
    btn.onclick = () => {
      managerPane = btn.dataset.pane;
      viewManager();
    };
  });

  /* Only one pane is in the DOM at a time, so each block below checks that the
     element it drives is actually on screen. */

  /* -- The written plan -- */
  const showStrategy = (s) => {
    const out = document.getElementById('strategyOut');
    out.innerHTML = `
      <div class="card">
        <div class="row between" style="margin-bottom:12px">
          <strong>${esc(s.title)}</strong>
          <button class="sm danger" id="delStrategy">✕</button>
        </div>
        <div class="mgr assistant" style="margin:0">${mini_md(s.content)}</div>
        <button class="sm" id="copyStrategy" style="width:100%;margin-top:11px">📋 Copy the whole plan</button>
      </div>`;
    out.scrollIntoView({ block: 'start' });

    document.getElementById('copyStrategy').onclick = async () => {
      toast(await copyText(s.content) ? 'Copied' : 'Copy failed — select it manually');
    };
    document.getElementById('delStrategy').onclick = async () => {
      await api(`/strategy/${s.id}`, { method: 'DELETE' });
      viewManager();
    };
  };

  const genBtn = document.getElementById('genStrategy');
  if (genBtn) genBtn.onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '⏳ Writing your plan… (up to a minute)';
    try {
      const s = await api('/strategy', {
        method: 'POST',
        body: { focus: document.getElementById('stratFocus').value }
      });
      showStrategy(s);
      toast('Plan ready');
    } catch (err) {
      document.getElementById('strategyOut').innerHTML =
        `<div class="alert block"><strong>${esc(err.message)}</strong>${esc(err.hint || '')}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '📋 Write my scaling plan';
    }
  };

  view.querySelectorAll('[data-strategy]').forEach((btn) => {
    btn.onclick = async () => showStrategy(await api(`/strategy/${btn.dataset.strategy}`));
  });

  /* -- The chat -- */
  const input = document.getElementById('mgrInput');
  const thread = document.getElementById('mgrThread');
  const sendBtn = document.getElementById('mgrSend');
  if (!input) return;

  const ask = async (question) => {
    const q = (question || input.value).trim();
    if (!q) return;

    input.value = '';
    thread.insertAdjacentHTML('beforeend', `<div class="mgr user">${esc(q)}</div>`);
    thread.insertAdjacentHTML('beforeend', '<div class="mgr assistant" id="mgrPending">⏳ Thinking…</div>');
    document.getElementById('mgrPending').scrollIntoView({ block: 'center' });
    sendBtn.disabled = true;

    try {
      const res = await api('/manager', { method: 'POST', body: { message: q } });
      document.getElementById('mgrPending').outerHTML =
        `<div class="mgr assistant">${mini_md(res.reply.content)}</div>`;
    } catch (err) {
      document.getElementById('mgrPending').outerHTML =
        `<div class="alert block"><strong>${esc(err.message)}</strong>${esc(err.hint || '')}</div>`;
    } finally {
      sendBtn.disabled = false;
    }
  };

  sendBtn.onclick = () => ask();

  /* The ready-made questions used to be four groups of chips stacked down the
     page. As a dropdown they cost one line. Picking one fills the box rather
     than sending, so she can reword it first. */
  document.getElementById('mgrPreset').onchange = (e) => {
    if (!e.target.value) return;
    input.value = e.target.value;
    e.target.selectedIndex = 0;
    input.focus();
  };

  const clearBtn = document.getElementById('mgrClear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm('Clear the whole manager conversation?')) return;
    await api('/manager', { method: 'DELETE' });
    viewManager();
  };
}

/* ------------------------------ View: Content ------------------------------ */

async function viewMedia() {
  setHeader('Content');
  setTab('media');
  view.innerHTML = '<div class="loading">Loading…</div>';

  const media = await api('/media');
  const cur = config.currency;

  view.innerHTML = `
    <div class="alert info">
      <strong>PPV library</strong>
      The AI only offers what is listed here, and never sends the same item to the same fan twice.
    </div>

    <div class="card stack">
      <input id="mTitle" placeholder="Content title" />
      <input id="mTags" placeholder="Tags (e.g. lingerie, shower, solo)" />
      <div class="row" style="gap:8px">
        <input id="mPrice" type="number" inputmode="decimal" placeholder="Price" class="grow" />
        <button class="primary" id="addMedia">Add</button>
      </div>
    </div>

    ${media.map((m) => `
      <div class="card">
        <div class="row between">
          <div class="grow">
            <strong>${esc(m.title)}</strong>
            <div class="tiny">${esc(m.tags || 'no tags')} · ${money(m.price, cur)}</div>
          </div>
          <button class="sm danger" data-del="${m.id}">✕</button>
        </div>
      </div>`).join('') || '<div class="empty">Library is empty.<br>Add your content so the AI can offer it.</div>'}
  `;

  document.getElementById('addMedia').onclick = async () => {
    const title = document.getElementById('mTitle').value.trim();
    if (!title) return toast('Title missing');
    await api('/media', {
      method: 'POST',
      body: {
        title,
        tags: document.getElementById('mTags').value,
        price: Number(document.getElementById('mPrice').value) || 0
      }
    });
    viewMedia();
  };

  view.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/media/${btn.dataset.del}`, { method: 'DELETE' });
      viewMedia();
    };
  });
}

/* ----------------------------- View: Settings ------------------------------ */

async function viewReglages() {
  setHeader('Settings');
  setTab('reglages');
  view.innerHTML = '<div class="loading">Loading…</div>';

  const [cfg, competitors] = await Promise.all([api('/config'), api('/competitors')]);

  view.innerHTML = `
    ${accountDataHtml(competitors, cfg, cfg.currency)}

    <div class="card stack">
      <h2>Her voice</h2>
      <div><label>Stage name</label><input id="cName" value="${esc(cfg.personaName)}" /></div>
      <div><label>Tone</label><textarea id="cTone" style="min-height:60px">${esc(cfg.tone)}</textarea></div>
      <div>
        <label>Real messages she has sent — one per line</label>
        <textarea id="cSamples" style="min-height:110px" placeholder="Paste 20 to 50 of her real one-liners. This is what makes the AI sound like her instead of a bot.">${esc(cfg.styleSamples)}</textarea>
      </div>
      <div>
        <label>Real conversations she has already had — the strongest training signal</label>
        <button class="sm" id="convoShots" style="margin-bottom:8px">📷 Import from screenshots</button>
        <textarea id="cConvos" style="min-height:170px" placeholder="him: hey gorgeous&#10;me: hey you 😘&#10;him: what are you wearing&#10;me: ...&#10;&#10;--- next conversation ---&#10;&#10;him: ...">${esc(cfg.exampleConversations)}</textarea>
        <div class="tiny" style="margin-top:6px">
          Fastest way: screenshot a whole conversation on her phone and hit the button above.
        </div>
        <div class="tiny" style="margin-top:6px">
          Paste 3 to 10 full conversations, best ones first — especially the ones that ended in a sale.
          Use <b>him:</b> and <b>me:</b> at the start of each line, and separate conversations with a blank
          line. The AI copies not just her wording but <b>when and how she moves to a sale</b>.
        </div>
      </div>
      <div class="row" style="gap:8px">
        <div class="grow">
          <label>Level</label>
          <select id="cExplicit">
            <option value="doux"   ${cfg.explicitness === 'doux' ? 'selected' : ''}>Soft — suggestive only</option>
            <option value="moyen"  ${cfg.explicitness === 'moyen' ? 'selected' : ''}>Medium — openly flirty</option>
            <option value="direct" ${cfg.explicitness === 'direct' ? 'selected' : ''}>Direct — explicit, no filter</option>
          </select>
        </div>
        <div class="grow">
          <label>Default character</label>
          <select id="cPersona">
            ${['sweet', 'submissive', 'dominant', 'bratty', 'girlfriend', 'mysterious']
              .map((k) => `<option value="${k}" ${cfg.defaultPersonality === k ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`)
              .join('')}
          </select>
        </div>
      </div>
      <div class="tiny">Used for new fans. Override it per fan from their conversation screen.</div>
      <div class="row" style="gap:8px">
        <div class="grow">
          <label>Reply language</label>
          <select id="cLang">
            <option value="en" ${cfg.language === 'en' ? 'selected' : ''}>English</option>
            <option value="fr" ${cfg.language === 'fr' ? 'selected' : ''}>French</option>
          </select>
        </div>
      </div>
      <div><label>Hard limits, never cross these</label><textarea id="cLimits" style="min-height:60px" placeholder="e.g. no scat, never mention family, no face">${esc(cfg.hardLimits)}</textarea></div>
    </div>

    <div class="card stack">
      <h2>Safety</h2>
      <div>
        <label>Banned words in output — real first name, city, school, employer…</label>
        <input id="cForbidden" value="${esc((cfg.forbiddenWords || []).join(', '))}" placeholder="Emily, Austin, Riverside High" />
      </div>
      <div class="tiny">
        Any generated reply containing one of these is flagged in red before you copy it.
        These words stay on this machine and are never sent to the model.
      </div>
    </div>

    <div class="card stack">
      <h2>Money</h2>
      <div class="row" style="gap:8px">
        <div class="grow"><label>Currency</label>
          <select id="cCurrency">
            ${['USD', 'EUR', 'GBP'].map((c) => `<option ${cfg.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="grow"><label>Whale threshold</label><input id="cWhale" type="number" value="${cfg.whaleThreshold}" /></div>
        <div class="grow"><label>Follow up after (d)</label><input id="cSilent" type="number" value="${cfg.silentDays}" /></div>
      </div>
      <div><label>Price list</label><textarea id="cPrices" style="min-height:70px" placeholder="Solo photo 10&#10;5 min video 35&#10;10 min custom 120">${esc(cfg.priceList)}</textarea></div>
    </div>

    <div class="card stack">
      <h2>AI engine</h2>
      <div>
        <label>Provider</label>
        <select id="cProvider">
          <option value="mock"       ${cfg.llmProvider === 'mock' ? 'selected' : ''}>Demo mode — no key, placeholder text</option>
          <option value="openrouter" ${cfg.llmProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
          <option value="custom"     ${cfg.llmProvider === 'custom' ? 'selected' : ''}>Other / local model (OpenAI-compatible)</option>
        </select>
      </div>
      <div><label>Base URL</label><input id="cBaseUrl" value="${esc(cfg.llmBaseUrl)}" /></div>
      <div><label>Model</label><input id="cModel" value="${esc(cfg.llmModel)}" placeholder="exact model identifier" /></div>
      <div>
        <label>Vision model — used to read screenshots</label>
        <input id="cVision" value="${esc(cfg.llmVisionModel)}" placeholder="must accept images" />
      </div>
      <div>
        <label>Manager web access</label>
        <select id="cWeb">
          <option value="off" ${cfg.managerWebSearch ? '' : 'selected'}>Off — cheaper, no research</option>
          <option value="on"  ${cfg.managerWebSearch ? 'selected' : ''}>On — can look up your niche and other creators</option>
        </select>
        <div class="tiny" style="margin-top:6px">
          Lets the manager search the web for competitor and trend questions.
          Costs more per question, so leave it off unless she is researching.
        </div>
      </div>
      <div><label>API key ${cfg.hasKey ? '(already saved)' : ''}</label><input id="cKey" type="password" value="${esc(cfg.llmApiKey)}" placeholder="${cfg.hasKey ? 'leave as is to keep the current key' : 'paste your key here'}" /></div>
      <div class="tiny">
        The key stays in the local database on this machine. On OpenRouter, not every model allows
        adult content: if you get a 403 error, try an open-weight model.
      </div>
    </div>

    <button class="primary" id="saveCfg" style="width:100%">Save settings</button>

    <div class="card" style="margin-top:14px">
      <h2>Account</h2>
      <div class="row between">
        <span class="tiny" id="acctEmail">…</span>
        <button class="sm" id="logout">Sign out</button>
      </div>
    </div>

    <div class="alert info" style="margin-top:14px">
      <strong>Reminder</strong>
      This app has no connection to Fansly. It cannot send, read, or post anything.
      Everything goes through manual copy and paste.
    </div>
  `;

  bindAccountData(viewReglages);

  document.getElementById('saveCfg').onclick = async () => {
    const body = {
      personaName: document.getElementById('cName').value,
      tone: document.getElementById('cTone').value,
      styleSamples: document.getElementById('cSamples').value,
      exampleConversations: document.getElementById('cConvos').value,
      explicitness: document.getElementById('cExplicit').value,
      defaultPersonality: document.getElementById('cPersona').value,
      language: document.getElementById('cLang').value,
      hardLimits: document.getElementById('cLimits').value,
      forbiddenWords: document.getElementById('cForbidden').value,
      currency: document.getElementById('cCurrency').value,
      whaleThreshold: Number(document.getElementById('cWhale').value) || 200,
      silentDays: Number(document.getElementById('cSilent').value) || 5,
      priceList: document.getElementById('cPrices').value,
      llmProvider: document.getElementById('cProvider').value,
      llmBaseUrl: document.getElementById('cBaseUrl').value,
      llmModel: document.getElementById('cModel').value,
      llmVisionModel: document.getElementById('cVision').value,
      managerWebSearch: document.getElementById('cWeb').value === 'on'
    };
    const key = document.getElementById('cKey').value;
    if (key && key !== '••••••••') body.llmApiKey = key;

    config = await api('/config', { method: 'POST', body });
    toast('Settings saved');
  };

  fetch('/api/session').then((r) => r.json()).then((s) => {
    const el = document.getElementById('acctEmail');
    if (el && s.user) el.textContent = `Signed in as ${s.user.email}`;
  }).catch(() => {});

  document.getElementById('logout').onclick = async () => {
    await fetch('/api/logout');
    location.href = '/login.html';
  };

  document.getElementById('convoShots').onclick = (e) =>
    importFromScreenshots(e.currentTarget, 'cConvos', 'append');

  document.getElementById('cProvider').onchange = (e) => {
    const urls = { openrouter: 'https://openrouter.ai/api/v1', custom: 'http://localhost:1234/v1' };
    if (urls[e.target.value]) document.getElementById('cBaseUrl').value = urls[e.target.value];
  };
}

/* --------------------------------- Router ---------------------------------- */

async function router() {
  const hash = location.hash || '#/fans';
  pillEl.style.background = '';
  pillEl.style.color = '';

  try {
    const fanMatch = hash.match(/^#\/fan\/(\d+)$/);
    if (fanMatch) return await viewFan(Number(fanMatch[1]));
    if (hash.startsWith('#/relances')) return await viewRelances();
    if (hash.startsWith('#/manager')) return await viewManager();
    if (hash.startsWith('#/media')) return await viewMedia();
    if (hash.startsWith('#/reglages')) return await viewReglages();
    return await viewFans();
  } catch (err) {
    /* "Failed to fetch" means the request never reached anyone: she is offline, or
       the server was restarting (a deploy takes the container down for a few
       seconds). Neither is her fault and both fix themselves, so say so and give
       her the button instead of a dead end. */
    const offline = !navigator.onLine;
    const unreachable = offline || /failed to fetch|networkerror|load failed/i.test(err.message);

    view.innerHTML = `
      <div class="alert block">
        <strong>${offline ? 'You are offline' : unreachable ? 'Could not reach the app' : 'Something went wrong'}</strong>
        ${unreachable
          ? 'Nothing was lost. Check your connection, or wait a few seconds if the app was just updated.'
          : esc(err.message)}
      </div>
      <button class="primary" id="retryView" style="width:100%">↻ Try again</button>`;

    document.getElementById('retryView').onclick = (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = '⏳ Retrying…';
      router();
    };
  }
}

backEl.onclick = () => { location.hash = '#/fans'; };
window.addEventListener('hashchange', router);

(async () => {
  try {
    config = await api('/config');
  } catch { /* fall back to defaults */ }
  router();
})();
