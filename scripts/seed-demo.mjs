/*
 * Fills a chatmate account with a believable two months of activity, so the
 * dashboard can be judged on something that looks like a real account instead of
 * one bar and four zeros.
 *
 *   node scripts/seed-demo.mjs <base-url> <email> <password>
 *
 * It only speaks to the public API — same routes the app itself uses — so it can
 * point at localhost or at the deployed site. It refuses to touch an account that
 * already has fans, so it can never be run over real data by accident.
 */

const [BASE, EMAIL, PASSWORD] = process.argv.slice(2);

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('usage: node scripts/seed-demo.mjs <base-url> <email> <password>');
  process.exit(1);
}

let cookie = '';

async function call(path, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error || ''}`);
  return data;
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* --------------------------------- Sign in -------------------------------- */

try {
  await call('/api/login', { email: EMAIL, password: PASSWORD });
  console.log('signed in');
} catch {
  await call('/api/signup', { email: EMAIL, password: PASSWORD });
  console.log('account created');
}

const existing = await call('/api/fans');
if (existing.length) {
  console.error(`\nThis account already has ${existing.length} fan(s). Refusing to seed over it.`);
  process.exit(1);
}

/* ---------------------------------- Fans ---------------------------------- */

const FANS = [
  { handle: '@marcus_d',  name: 'Marcus',  sub: true,  since: 74, kinks: 'lingerie, being teased, calls her ma\'am',
    personality: 'dominant',  spend: [120, 85, 200, 150, 95, 180] },
  { handle: '@jayfromtx', name: 'Jay',     sub: true,  since: 61, kinks: 'shower videos, morning texts',
    personality: 'girlfriend', spend: [45, 60, 45, 75, 60] },
  { handle: '@quietone88', name: 'Ben',    sub: true,  since: 52, kinks: 'feet, long conversations',
    personality: 'sweet',      spend: [30, 25, 40, 30] },
  { handle: '@rick_h',    name: 'Rick',    sub: true,  since: 40, kinks: 'roleplay, wants to feel in charge',
    personality: 'submissive', spend: [55, 40, 65] },
  { handle: '@tommy_g',   name: 'Tommy',   sub: false, since: 33, kinks: 'gym stuff, cocky',
    personality: 'bratty',     spend: [25, 35] },
  { handle: '@dave2211',  name: 'Dave',    sub: true,  since: 25, kinks: 'unknown',
    personality: 'mysterious', spend: [20] },
  { handle: '@newguy_92', name: '',        sub: false, since: 9,  kinks: '',
    personality: 'sweet',      spend: [] },
  { handle: '@lurker_x',  name: '',        sub: false, since: 5,  kinks: '',
    personality: 'sweet',      spend: [] },
  { handle: '@justlooking', name: '',      sub: true,  since: 3,  kinks: 'says he is shy',
    personality: 'sweet',      spend: [] }
];

const LABELS = ['shower set', 'lingerie video', 'custom clip', 'bundle', 'solo video', 'photo set'];

let purchases = 0;
let revenue = 0;

for (const f of FANS) {
  const fan = await call('/api/fans', {
    handle: f.handle,
    display_name: f.name,
    kinks: f.kinks,
    personality: f.personality
  });

  if (f.sub) await call(`/api/fans/${fan.id}`, { is_subscriber: 1 }, 'PATCH');

  // Spread his purchases from when he arrived up to a day or two ago, so the daily
  // chart has a shape, last month has something to compare against, and the current
  // month is not empty.
  const span = Math.max(2, f.since - 2);
  const steps = Math.max(1, f.spend.length - 1);
  f.dates = f.spend.map((_, i) => Math.max(1, Math.round(span - (i * (span - 1)) / steps)));

  for (let i = 0; i < f.spend.length; i++) {
    await call(`/api/fans/${fan.id}/purchases`, {
      amount: f.spend[i],
      label: pick(LABELS),
      created_at: daysAgo(f.dates[i])
    });
    purchases++;
    revenue += f.spend[i];
  }
}

console.log(`${FANS.length} fans · ${purchases} purchases · $${revenue}`);

/* --------------------------------- Library -------------------------------- */

const MEDIA = [
  ['Shower tease', 'shower, wet, solo', 25],
  ['Red lingerie set', 'lingerie, photos, tease', 20],
  ['Morning in bed', 'girlfriend, soft, video', 35],
  ['Custom clip — his name', 'custom, personal', 90],
  ['Full length solo', 'solo, explicit, video', 60],
  ['Gym fit try-on', 'gym, tease, video', 30]
];

for (const [title, tags, price] of MEDIA) await call('/api/media', { title, tags, price });
console.log(`${MEDIA.length} items in the PPV library`);

/* ---------------------------- Imported Fansly stats ----------------------- */

await call('/api/platform', {
  label: 'last 30 days',
  metrics: {
    profile_views: 18432,
    followers: 2140,
    subscribers: 6,
    engagement_rate: 7.4,
    avg_watch_time: 96
  },
  breakdowns: {
    traffic_sources: [
      { label: 'reddit', value: 48, unit: '%' },
      { label: 'fansly search', value: 24, unit: '%' },
      { label: 'x / twitter', value: 19, unit: '%' },
      { label: 'direct', value: 9, unit: '%' }
    ],
    top_content: [
      { label: 'Shower tease', value: 3120, unit: 'views' },
      { label: 'Red lingerie set', value: 2480, unit: 'views' },
      { label: 'Morning in bed', value: 1610, unit: 'views' }
    ],
    hashtags: [
      { label: '#lingerie', value: 4200, unit: 'views' },
      { label: '#shower', value: 2900, unit: 'views' },
      { label: '#girlnextdoor', value: 1750, unit: 'views' }
    ]
  }
});
console.log('one Fansly stats snapshot imported');

const dash = await call('/api/dashboard');
console.log('\nDashboard now reads:');
console.log(`  this month   $${dash.thisMonth}`);
console.log(`  last month   $${dash.lastMonth}   (${dash.monthDelta === null ? 'no comparison' : dash.monthDelta + '%'})`);
console.log(`  last 30 days $${dash.last30}`);
console.log(`  all time     $${dash.totals.revenue}`);
console.log(`  subscribers  ${dash.totals.subscribers} of ${dash.totals.fans} fans`);
console.log(`  stages       ${JSON.stringify(dash.byStage)}`);
console.log('\nDone.');
