// Builds static guide JSON so the site works without live API calls.
// Usage:
//   node scripts/build-guide.mjs --schedule page.html --events events.json \
//     --companies companies.json --recruiters posts.json --food freefood.json \
//     [--sheet tracker.csv]
// Omit a file to keep the current output for that piece.
// --live refetches the official schedule, freefood file, and guide events API.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const live = args.includes('--live');

const decode = s => String(s ?? '')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;|&#x27;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/\s+/g, ' ')
  .trim();

const clip = (s, n) => {
  const t = decode(s);
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};

function toEpoch(day, t) {
  const m = String(t).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return NaN;
  let h = +m[1] % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return Date.parse(`${day}T${String(h).padStart(2, '0')}:${m[2]}:00-06:00`);
}

const rooms = JSON.parse(readFileSync('data/rooms.json', 'utf8'));
const byLen = [...rooms].sort((a, b) => (b.label.length - a.label.length));
function roomForLabel(label) {
  if (!label) return null;
  return rooms.find(r => r.label === label || (r.also || []).includes(label)) || null;
}
function roomInText(text) {
  if (!text) return null;
  for (const r of byLen) {
    if (text.includes(r.label)) return r;
    for (const a of r.also || []) if (a && text.includes(a)) return r;
  }
  return null;
}

function parseSchedule(html) {
  const panels = [...html.matchAll(/id="schedule-panel-(\d{4}-\d{2}-\d{2})"/g)].map(m => ({ i: m.index, day: m[1] }));
  const sessions = [];
  const bad = [];
  for (const m of html.matchAll(/<article id="session-([0-9a-f-]{36})"[\s\S]*?<\/article>/g)) {
    const card = m[0];
    const id = m[1];
    const day = panels.filter(p => p.i < m.index).pop()?.day;
    const title = decode(card.match(/schedule-card__title[^>]*>([\s\S]*?)<\/h3>/)?.[1] || '');
    const time = decode(card.match(/schedule-card__time[^>]*>([\s\S]*?)<\/p>/)?.[1] || '');
    const track = decode(card.match(/schedule-card__track[^>]*>([\s\S]*?)<\/span>/)?.[1] || '');
    const ticketsRaw = card.match(/schedule-card__tickets[^>]*>([\s\S]*?)<\/p>/)?.[1];
    const levels = ticketsRaw
      ? decode(ticketsRaw).replace(/^Ticket Level:\s*/i, '').split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const speakers = [...card.matchAll(/schedule-card__speaker-pill[^>]*>([\s\S]*?)<\/button>/g)]
      .map(x => decode(x[1])).filter(Boolean)
      .filter((n, i, a) => a.indexOf(n) === i);
    const description = clip(card.match(/schedule-card__description[^>]*>([\s\S]*?)<\/div>/)?.[1] || '', 420);
    const tm = time.match(/^(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)\s*·\s*(.+)$/i);
    if (!day || !title || !tm) { bad.push(title || id); continue; }
    let start = toEpoch(day, tm[1]);
    let end = toEpoch(day, tm[2]);
    const room = tm[3].trim();
    if (!(end > start)) end += 24 * 60 * 60 * 1000;
    const place = roomForLabel(room);
    sessions.push({
      id, key: `s:${id}`, title, day,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      room, roomId: place?.id || null,
      track, levels, speakers, description
    });
  }
  sessions.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return { sessions, bad };
}

function boothNum(text) {
  if (!text) return null;
  const s = String(text);
  const m = s.match(/(?:booth\s*)?#\s*(\d{3,4})/i) || s.match(/\bbooth\s+(\d{3,4})\b/i) || s.match(/^(\d{3,4})\b/);
  return m ? m[1] : null;
}

function normTitle(s) {
  return decode(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function fetchLiveEvents() {
  const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
  const items = [];
  for (const date of days) {
    const r = await fetch(`https://afrotech.guide/api/v1/events?date=${date}&limit=50`);
    if (!r.ok) throw new Error(`events ${date} ${r.status}`);
    const j = await r.json();
    items.push(...(j.items || []));
  }
  return items.map(e => ({
    id: e.id,
    title: e.title,
    host: e.host || '',
    date: e.startAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(e.startAt)) : null,
    start_iso: e.startAt || null,
    end_iso: e.endAt || null,
    venue: e.venueName || '',
    address: e.address || '',
    tags: e.categories || [],
    price_type: e.priceType || '',
    price_amount: e.priceAmount ?? null,
    registration_url: e.ticketUrl || e.sourceUrl || '',
    description: e.description || '',
    source: 'afrotech.guide API'
  }));
}

let sessionMeta = null;
const schedulePath = flag('--schedule');
let sessions = null;
if (schedulePath) {
  const parsed = parseSchedule(readFileSync(schedulePath, 'utf8'));
  sessions = parsed.sessions;
  sessionMeta = { bad: parsed.bad.length, count: sessions.length };
  console.log(`sessions ${sessions.length} unparsed ${parsed.bad.length}`);
} else if (live) {
  const r = await fetch('https://afrotechconference.com/schedule');
  if (!r.ok) throw new Error('schedule ' + r.status);
  const parsed = parseSchedule(await r.text());
  sessions = parsed.sessions;
  sessionMeta = { bad: parsed.bad.length, count: sessions.length, live: true };
  console.log(`live sessions ${sessions.length} unparsed ${parsed.bad.length}`);
} else if (existsSync('data/sessions-full.json')) {
  sessions = JSON.parse(readFileSync('data/sessions-full.json', 'utf8'));
  console.log(`kept ${sessions.length} existing sessions`);
} else throw new Error('Pass --schedule page.html or --live');

let rawEvents = null;
if (flag('--events')) {
  const j = JSON.parse(readFileSync(flag('--events'), 'utf8'));
  rawEvents = j.events || j;
} else if (live) rawEvents = await fetchLiveEvents();
else if (existsSync('data/partner-events.json')) rawEvents = null;

let foods = null;
if (flag('--food')) foods = JSON.parse(readFileSync(flag('--food'), 'utf8')).events;
else if (live) {
  const r = await fetch('https://afrotech.guide/data/freefood-events.json');
  if (!r.ok) throw new Error('freefood ' + r.status);
  foods = (await r.json()).events;
} else if (existsSync('data/freefood.json')) foods = JSON.parse(readFileSync('data/freefood.json', 'utf8'));

const foodTitles = new Set((foods || []).map(f => normTitle(f.title)));

function mapEvent(e) {
  const start = e.start_iso || e.startAt || null;
  const end = e.end_iso || e.endAt || null;
  const day = e.date || (start ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(start)) : null);
  const venue = e.venue || e.venueName || '';
  const place = roomInText(`${venue} ${e.address || ''}`);
  const title = e.title;
  return {
    id: e.id,
    key: `e:${e.id}`,
    title,
    host: e.host || '',
    day,
    start: start ? new Date(start).toISOString() : null,
    end: end ? new Date(end).toISOString() : null,
    venue,
    address: e.address || '',
    tags: e.tags || e.categories || [],
    priceType: e.price_type || e.priceType || '',
    priceAmount: e.price_amount ?? e.priceAmount ?? null,
    url: e.registration_url || e.ticketUrl || e.source_url || '',
    description: clip(e.description || '', 360),
    roomId: place?.id || null,
    hasFood: foodTitles.has(normTitle(title)),
    source: e.source || 'partner list'
  };
}

let events = rawEvents ? rawEvents.map(mapEvent) : JSON.parse(readFileSync('data/partner-events.json', 'utf8'));

let sheetNote = null;
if (flag('--sheet')) {
  const text = readFileSync(flag('--sheet'), 'utf8');
  const rows = [];
  let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  const header = rows.findIndex(r => (r[0] || '').trim() === 'DATE');
  const data = header >= 0 ? rows.slice(header + 1).filter(r => (r[3] || '').trim()) : [];
  const have = new Set(events.map(e => normTitle(e.title) + '|' + e.day));
  let added = 0;
  for (const r of data) {
    const title = r[3].trim();
    const dayLabel = (r[0] || '').trim();
    const dm = dayLabel.match(/(\d{1,2})\/(\d{1,2})/);
    const day = dm ? `2026-11-${dm[2].padStart(2, '0')}` : null;
    const key = normTitle(title) + '|' + day;
    if (have.has(key)) continue;
    have.add(key);
    added++;
    const venue = r[11] || '';
    const place = roomInText(venue);
    events.push({
      id: 'sheet-' + added + '-' + normTitle(title).slice(0, 40).replace(/ /g, '-'),
      key: `e:sheet-${added}`,
      title, host: r[4] || '', day,
      start: null, end: null,
      timeLabel: [r[1], r[2]].filter(Boolean).join(' – '),
      venue, address: r[12] || '',
      tags: (r[10] || '').split(',').map(s => s.trim()).filter(Boolean),
      priceType: r[6] || '', priceAmount: null, url: '',
      description: clip(r[7] || '', 360),
      roomId: place?.id || null, hasFood: false,
      source: 'community tracker sheet'
    });
  }
  sheetNote = { rows: data.length, added };
  console.log(`sheet rows ${data.length} added ${added}`);
}

if (foods) {
  foods = foods.map(f => {
    const place = roomInText(`${f.venueName || ''} ${f.address || ''}`);
    const start = f.startAt || null;
    const day = start ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(start)) : null;
    return {
      id: f.id, key: `f:${f.id}`, title: f.title, host: f.host || '',
      day, start: start ? new Date(start).toISOString() : null,
      end: f.endAt ? new Date(f.endAt).toISOString() : null,
      venue: f.venueName || '', address: f.address || '',
      priceType: f.priceType || '', url: f.ticketUrl || f.foodSourceUrl || '',
      offerings: (f.offerings || []).map(o => ({ kind: o.kind, certainty: o.certainty, quote: o.quote || '', words: o.words || [] })),
      accessNote: f.accessNote || '',
      roomId: place?.id || null
    };
  });
  writeFileSync('data/freefood.json', JSON.stringify(foods));
  console.log(`food ${foods.length}`);
}

if (rawEvents || flag('--sheet')) {
  events.sort((a, b) => String(a.start || a.day || '').localeCompare(String(b.start || b.day || '')) || a.title.localeCompare(b.title));
  writeFileSync('data/partner-events.json', JSON.stringify(events));
  console.log(`events ${events.length}`);
}

let recruiters = null;
if (flag('--recruiters')) {
  const posts = JSON.parse(readFileSync(flag('--recruiters'), 'utf8'));
  recruiters = posts.map(p => ({
    person: p.person,
    company: p.company,
    role: p.role_focus || '',
    booth: p.booth_or_when || '',
    boothNum: boothNum(p.booth_or_when),
    link: p.link || '',
    date: p.date || '',
    platform: p.platform || ''
  }));
  writeFileSync('data/recruiters.json', JSON.stringify(recruiters));
  console.log(`recruiters ${recruiters.length}`);
} else if (existsSync('data/recruiters.json')) recruiters = JSON.parse(readFileSync('data/recruiters.json', 'utf8'));

let companies = null;
if (flag('--companies')) {
  const raw = JSON.parse(readFileSync(flag('--companies'), 'utf8'));
  companies = raw.map(c => ({
    id: c.id,
    name: c.name,
    booth: c.booth || '',
    boothNum: boothNum(c.booth),
    sponsor: !!c.sponsor,
    careers: c.careers_url || '',
    guide: c.guide_url || '',
    roles: c.role_families || []
  })).sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync('data/companies.json', JSON.stringify(companies));
  console.log(`companies ${companies.length}`);
} else if (existsSync('data/companies.json')) companies = JSON.parse(readFileSync('data/companies.json', 'utf8'));

const boothMap = new Map();
function addBooth(num, company, extra) {
  if (!num) return;
  if (!boothMap.has(num)) boothMap.set(num, { num, companies: [], notes: [] });
  const b = boothMap.get(num);
  if (company && !b.companies.includes(company)) b.companies.push(company);
  if (extra && !b.notes.includes(extra)) b.notes.push(extra);
}
for (const c of companies || []) addBooth(c.boothNum, c.name, c.booth && c.booth !== c.boothNum ? c.booth : '');
for (const r of recruiters || []) addBooth(r.boothNum, r.company, r.booth);
const booths = [...boothMap.values()].sort((a, b) => (+a.num) - (+b.num)).map(b => ({
  num: b.num,
  roomId: `booth-${b.num}`,
  companies: b.companies,
  label: b.notes.filter(Boolean).join(' · ') || `Booth ${b.num}`,
  level: '1',
  building: 'GRB',
  certainty: 'approximate',
  note: 'Booth number from a company or recruiter post. GRB floor plans do not show AfroTech booth spots, so there is no map coordinate.'
}));
writeFileSync('data/booths.json', JSON.stringify(booths));
console.log(`booths ${booths.length}`);

if (schedulePath || live || sessionMeta) writeFileSync('data/sessions-full.json', JSON.stringify(sessions));

const meta = {
  generated: '2026-10-31',
  timezone: 'America/Chicago',
  sessions: sessions.length,
  events: events.length,
  food: foods ? foods.length : JSON.parse(readFileSync('data/freefood.json', 'utf8')).length,
  recruiters: (recruiters || []).length,
  companies: (companies || []).length,
  booths: booths.length,
  unparsedSessions: sessionMeta?.bad || 0,
  sheet: sheetNote,
  sources: [
    { name: 'Official AfroTech 2026 schedule', url: 'https://afrotechconference.com/schedule', note: 'Session cards for Nov 2–6, including track, ticket level, room, and speakers. Pulled Oct 31, 2026.' },
    { name: 'Afrotech.guide', url: 'https://afrotech.guide/api/v1', note: 'Read-only API v1.4.0. Partner events and the free-food file. OpenAPI at https://afrotech.guide/openapi.json.' },
    { name: 'Free food and drinks', url: 'https://afrotech.guide/freefood?day=all', note: 'List from https://afrotech.guide/data/freefood-events.json. Offerings are quotes from listings, not a promise the food is still there.' },
    { name: 'Community tracker', url: 'https://docs.google.com/spreadsheets/d/1PLDLOdFCuwDAy4fe5y09hb4KgYlX3bsgX60U2z2KE_0/edit', note: 'Public sheet of community events. CSV export compared with the partner list.' },
    { name: 'Recruiter posts', url: 'https://afrotech.guide', note: 'LinkedIn, X, and company posts gathered Oct 30, 2026. Booth numbers are what the posts said.' },
    { name: 'GRB floor plans', url: 'https://www.grbhouston.com/planners/floor-plans/', note: 'Level 1 halls and Grand Lobby, Level 2 balconies, Level 3 ballrooms and meeting rooms. Dimensions: https://www.grbhouston.com/planners/dimensions-capacities/' }
  ]
};
writeFileSync('data/guide-meta.json', JSON.stringify(meta, null, 2) + '\n');
const missing = sessions.filter(s => !s.roomId);
console.log('sessions missing room', missing.map(s => s.room));
console.log('wrote guide files');
