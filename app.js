'use strict';

const TZ = 'America/Chicago';
const ROSTER = ['Angel', 'David', 'Aziz', 'Raphael', 'Yannick', 'Grace', 'Aldine', 'Peter', 'Nicholas', 'Kudzi', 'Kenny', 'Ms. Yussif'];
const LOCAL_NAMES = ['Aldine', 'Angel', 'Aziz', 'Grace', 'Kenny', 'Kudzi', 'Peter', 'Raphael', 'Yannick', 'Nicholas', 'David'];
const PUBLIC = new Set(['guide', 'now', 'map', 'signin']);
const FLOOR_HONEST = 'GPS cannot tell which floor you are on indoors. Set the level yourself. Phone altitude, when the phone has it, is only a hint. It is not a floor.';
const POLL_MS = 20000;
const POLL_FAST_MS = 12000;
const LIVE_BEAT_MS = 60000;
const STALE_MANUAL_MS = 45 * 60000;
const STALE_LIVE_MS = 5 * 60000;
const GRB = { lat: 29.7522, lng: -95.3586, radiusM: 450 };
const NO_GROUP_ROOMS = ['elsewhere-grb', 'outside-grb'];

const $view = document.getElementById('view');
const $sync = document.getElementById('sync');
const $tabs = document.getElementById('tabs');

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let session = load('wa_session', null);
let cache = load('wa_state', null);
let outbox = load('wa_outbox', []);
let stars = new Set(load('wa_stars', []));
let schedule = [];
let rooms = [];
let sessionsFull = [];
let partnerEvents = [];
let foods = [];
let recruiters = [];
let companies = [];
let booths = [];
let guideMeta = {};
let net = { ok: navigator.onLine, lastTry: 0, error: '' };
let ui = {
  day: null, eventDay: null, foodDay: 'all', addOpen: false, addDay: null,
  mapLevel: '1', mapRoom: null, msg: '', note: '', seg: 'now', q: '',
  studentOnly: false, foodMode: 'all', eventsFood: false, boothsOnly: true, showAll: false,
  phoneDraft: null, code: '', signName: ''
};
let live = { watchId: null, timer: null, note: null, altitude: null, error: '' };

const nowOverride = (() => {
  const q = new URLSearchParams(location.search).get('now');
  if (!q) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(q) ? q : q + '-06:00');
  return isNaN(t) ? null : t;
})();
const now = () => nowOverride ?? Date.now();
const fmtTime = t => new Date(t).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtDay = d => new Date(d + 'T12:00:00-06:00').toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const chicagoDay = t => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
function fmtWhen(t) {
  return chicagoDay(t) === chicagoDay(now()) ? fmtTime(t) : `${fmtDay(chicagoDay(t))}, ${fmtTime(t)}`;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function safeUrl(u) {
  try {
    const x = new URL(u, location.origin);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return '';
    return esc(x.href);
  } catch { return ''; }
}
function shortErr(e) {
  const line = String(e?.message || 'Something went wrong').split('\n')[0].replace(/^error:\s*/i, '');
  return line.length > 180 ? line.slice(0, 180) : line;
}
function pickDay(days) {
  const t = chicagoDay(now());
  if (days.includes(t)) return t;
  return days.find(d => d >= t) || days[days.length - 1] || null;
}
function localPhone(name) {
  const book = window.CREW_LOCAL?.phones || {};
  const direct = book[name] && String(book[name]).trim();
  if (direct) return direct;
  if (name === 'David' && book.Timeless) return String(book.Timeless).trim();
  return '';
}
function telHref(n) {
  return String(n || '').replace(/[^\d+]/g, '');
}

function pendingPair() {
  try { return sessionStorage.getItem('wa_pair') || ''; } catch { return ''; }
}

async function api(fn, args) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let res;
  try {
    const base = CONFIG.SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
    const key = CONFIG.SUPABASE_ANON_KEY;
    const headers = { 'Content-Type': 'application/json', apikey: key };
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers, body: JSON.stringify(args), signal: ctrl.signal
    });
  } catch (e) {
    const err = new Error('offline'); err.network = true; throw err;
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {
    // Not a Supabase reply (wrong URL, or an old cached copy of the app). Keep queued changes.
    const err = new Error('server'); err.network = true; err.setup = true; throw err;
  }
  if (!res.ok) {
    const err = new Error(body?.message || `error ${res.status}`);
    err.auth = body?.code === '28000';
    err.status = res.status;
    throw err;
  }
  return body;
}

function queue(fn, args) {
  outbox.push({ fn, args });
  save('wa_outbox', outbox);
  applyLocal(fn, args);
  render();
  sync();
}

function applyLocal(fn, args) {
  if (!cache || !session) return;
  const d = cache.data, me = session.person_id;
  if (fn === 'set_status' || fn === 'set_checkin') {
    const prev = d.status.find(s => s.person_id === me) || {};
    d.status = d.status.filter(s => s.person_id !== me);
    const next = {
      person_id: me, room_id: args.p_room, mode: args.p_mode,
      live_note: args.p_mode === 'live' ? args.p_note : null,
      updated_at: args.p_client_ts,
      level: prev.level || null, place_label: prev.place_label || null,
      altitude_m: prev.altitude_m ?? null, meet_pin: !!prev.meet_pin
    };
    if (fn === 'set_checkin') {
      next.level = args.p_level || null;
      next.place_label = args.p_label || null;
      next.altitude_m = args.p_alt ?? null;
      next.meet_pin = !!args.p_meet;
    }
    d.status.push(next);
  } else if (fn === 'set_attendance') {
    d.attendance = d.attendance.filter(a => !(a.person_id === me && a.event_id === args.p_event));
    if (args.p_attending) d.attendance.push({ person_id: me, event_id: args.p_event });
  } else if (fn === 'add_agreed') {
    if (!d.agreed.some(a => a.event_id === args.p_event)) d.agreed.push({ event_id: args.p_event, added_by: me });
  }
  save('wa_state', cache);
}

function missingFn(e, name) {
  const m = e.message || '';
  return m.includes(name) || m.includes('Could not find') || m.includes('does not exist') || e.status === 404;
}

let syncing = false;
async function sync() {
  if (!session || syncing) return;
  syncing = true;
  net.lastTry = Date.now();
  try {
    while (outbox.length) {
      const op = outbox[0];
      try {
        await api(op.fn, { p_token: session.token, ...op.args });
      } catch (e) {
        if (e.network) throw e;
        if (e.auth) throw e;
        if (op.fn === 'set_checkin' && missingFn(e, 'set_checkin')) {
          try {
            await api('set_status', {
              p_token: session.token, p_room: op.args.p_room, p_mode: op.args.p_mode,
              p_note: op.args.p_note, p_client_ts: op.args.p_client_ts
            });
            ui.note = 'Saved the room. Run supabase/crew.sql to store the floor and meet pin.';
          } catch (e2) {
            if (e2.network || e2.auth) throw e2;
            ui.msg = `Change not saved: ${shortErr(e2)}`;
          }
        } else ui.msg = `Change not saved: ${shortErr(e)}`;
      }
      outbox.shift();
      save('wa_outbox', outbox);
    }
    const data = await api('get_state', { p_token: session.token });
    cache = { data, syncedAt: Date.now() };
    save('wa_state', cache);
    net.ok = true; net.error = '';
  } catch (e) {
    if (e.auth) { signOut(true); ui.msg = 'Please sign in again.'; }
    net.ok = false; net.error = e.message;
  } finally {
    syncing = false;
    render();
  }
}

function renderSync() {
  if (!session) { $sync.textContent = net.ok ? '' : 'Offline'; $sync.className = 'sync' + (net.ok ? '' : ' offline'); return; }
  const waiting = outbox.length ? ` · ${outbox.length} change${outbox.length > 1 ? 's' : ''} waiting` : '';
  const at = cache?.syncedAt ? fmtTime(cache.syncedAt) : 'never';
  let text, off = false;
  if (!net.ok || !navigator.onLine) { text = cache ? `Offline. Showing saved ${at}` : 'Offline. No saved data yet'; off = true; }
  else if (cache && Date.now() - cache.syncedAt < POLL_MS * 2) text = `Live · synced ${at}`;
  else text = `Last synced ${at}`;
  if (nowOverride) text += ` · test time ${fmtWhen(now())}`;
  $sync.textContent = text + waiting;
  $sync.className = 'sync' + (off ? ' offline' : '');
}

const roomById = id => rooms.find(r => r.id === id);
const roomName = id => roomById(id)?.short || (String(id || '').startsWith('booth-') ? `Booth ${String(id).slice(6)}` : id) || 'Not set';
const eventById = id => schedule.find(e => e.id === id);
const isRunning = (e, t = now()) => Date.parse(e.start) <= t && t < Date.parse(e.end);
function agreedEvents() {
  if (!cache) return [];
  return cache.data.agreed.map(a => eventById(a.event_id)).filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start));
}
const goingTo = id => cache ? cache.data.attendance.filter(a => a.event_id === id).map(a => a.person_id) : [];
const isGoing = (pid, eid) => cache?.data.attendance.some(a => a.person_id === pid && a.event_id === eid);
const personName = id => cache?.data.people.find(p => p.id === id)?.name || '?';
const statusOf = pid => cache?.data.status.find(s => s.person_id === pid);
function isStale(s) {
  if (!s) return true;
  const age = now() - Date.parse(s.updated_at);
  return age > (s.mode === 'live' ? STALE_LIVE_MS : STALE_MANUAL_MS);
}
const currentEventsOf = pid => agreedEvents().filter(e => isRunning(e) && isGoing(pid, e.id));
function roomForLabel(label) {
  return rooms.find(r => r.label === label || (r.also || []).includes(label)) || null;
}
function roomForEvent(e) { return roomForLabel(e.room)?.id; }

function placeText(s) {
  if (!s) return 'Not set';
  const room = roomById(s.room_id);
  const lv = s.level || (room && room.level !== 'none' ? room.level : '');
  const levelTxt = lv === '1' || lv === '2' || lv === '3' ? `Level ${lv}` : '';
  const name = s.place_label || room?.short || roomName(s.room_id);
  const approx = room?.certainty === 'approximate' || String(s.room_id).startsWith('booth-') ? ' · approximate' : '';
  const unknown = !levelTxt ? 'Floor not verified · ' : '';
  return `${unknown}${[levelTxt, name].filter(Boolean).join(' · ')}${approx}`;
}
function placeBits(roomId) {
  const r = roomById(roomId);
  if (!r) return 'Place not on the map';
  const building = r.building === 'GRB' ? 'GRB' : r.building === 'offsite' ? 'Offsite' : 'Building not verified';
  const level = r.level === '1' || r.level === '2' || r.level === '3' ? `Level ${r.level}` : 'Level not verified';
  const flag = r.certainty === 'approximate' ? ' · approximate' : r.certainty === 'unknown' ? ' · floor not verified' : '';
  return `${building} · ${level} · ${r.short}${flag}`;
}
function badge(s) {
  if (!s) return '<span class="badge stale">No status</span>';
  const kind = s.mode === 'live' ? '<span class="badge live">Live</span>' : '<span class="badge">Manual</span>';
  return kind + (isStale(s) ? ' <span class="badge stale">Stale</span>' : '') + (s.meet_pin ? ' <span class="badge">Meet pin</span>' : '');
}
function numberFor(person) {
  if (!person) return null;
  if (person.phone) return { n: person.phone, local: false };
  const n = localPhone(person.name);
  return n ? { n, local: true } : null;
}
function phoneLinks(person) {
  if (!person || person.id === session?.person_id) return '';
  const got = numberFor(person);
  if (!got) return '';
  const href = telHref(got.n);
  if (!href) return '';
  return `<div class="actions"><a class="btn" href="tel:${esc(href)}">Call</a><a class="btn" href="sms:${esc(href)}">Text</a>${got.local ? '<span class="muted">On this device only</span>' : ''}</div>`;
}

function guidePool() {
  return [
    ...sessionsFull.map(s => ({ ...s, kind: 'session' })),
    ...partnerEvents.map(s => ({ ...s, kind: 'event' })),
    ...foods.map(s => ({ ...s, kind: 'food' }))
  ];
}
function starredItems() {
  return guidePool().filter(it => stars.has(it.key))
    .sort((a, b) => String(a.start || a.day || '').localeCompare(String(b.start || b.day || '')));
}
function itemConflicts(it, list) {
  if (!it.start || !it.end) return [];
  const s = Date.parse(it.start), e = Date.parse(it.end);
  if (!(e > s)) return [];
  return list.filter(o => o.key !== it.key && o.start && o.end && Date.parse(o.start) < e && s < Date.parse(o.end));
}
function happening(list, t = now()) {
  return list.filter(it => it.start && it.end && Date.parse(it.start) <= t && t < Date.parse(it.end))
    .sort((a, b) => a.start.localeCompare(b.start));
}
function upcoming(list, t = now()) {
  const fut = list.filter(it => it.start && Date.parse(it.start) > t);
  if (!fut.length) return [];
  const next = Math.min(...fut.map(it => Date.parse(it.start)));
  return fut.filter(it => Date.parse(it.start) === next).sort((a, b) => a.title.localeCompare(b.title));
}
function whenLine(it) {
  if (!it.start) return it.timeLabel || 'Time not listed';
  const a = fmtTime(Date.parse(it.start));
  const b = it.end ? fmtTime(Date.parse(it.end)) : 'end not listed';
  return `${a} to ${b}`;
}
function priceLine(it) {
  if (it.priceAmount != null && it.priceAmount !== '') return `${it.priceType || 'Paid'} $${it.priceAmount}`;
  return it.priceType || '';
}
function looksLikeFood(it) {
  if (it.hasFood || it.kind === 'food') return true;
  const t = `${it.title || ''} ${it.description || ''} ${(it.tags || []).join(' ')}`.toLowerCase();
  return /food|drink|breakfast|lunch|dinner|brunch|coffee|cocktail|happy hour|bites|refreshment/.test(t);
}
function toggleStar(key) {
  if (stars.has(key)) stars.delete(key); else stars.add(key);
  save('wa_stars', [...stars]);
  render();
}

function viewSignIn() {
  const sel = ui.signName || '';
  const wait = pendingPair() ? '<p class="note">A pair link is waiting. Sign in, then accept it on Crew.</p>' : '';
  return `<h1>Sign in</h1>
    <p class="muted">Pick your name. The guide and the map work before you sign in. On the roster, Timeless is David.</p>
    ${wait}
    <div class="grid">${ROSTER.map(n => `<button data-act="pick" data-name="${esc(n)}" class="${n === sel ? 'on' : ''}">${esc(n)}</button>`).join('')}</div>
    <h2>Group code</h2>
    <form data-act="signin">
      <input id="code" type="password" autocomplete="current-password" required value="${esc(ui.code || '')}">
      <p><button class="primary" style="width:100%" ${sel ? '' : 'disabled'}>Sign in${sel ? ' as ' + esc(sel) : ''}</button></p>
    </form>`;
}

function viewFriends() {
  if (!cache) return '<h1>Friends</h1><p>No data yet. Connect once to load.</p>';
  const people = [...cache.data.people].sort((a, b) => (b.id === session.person_id) - (a.id === session.person_id));
  return `<h1>Where are my friends?</h1>
    <p class="muted">Call and text show up when someone you paired with saved a number, or when this device has config.local.js.</p>` + people.map(p => {
    const s = statusOf(p.id), stale = isStale(s);
    const evs = currentEventsOf(p.id);
    const with_ = new Set();
    if (s && !stale && !NO_GROUP_ROOMS.includes(s.room_id)) {
      cache.data.status.forEach(o => { if (o.person_id !== p.id && o.room_id === s.room_id && !isStale(o)) with_.add(o.person_id); });
    }
    evs.forEach(e => goingTo(e.id).forEach(id => { if (id !== p.id) with_.add(id); }));
    return `<div class="row">
      <div class="top"><span class="name">${esc(p.name)}${p.id === session.person_id ? ' (you)' : ''}</span><span>${badge(s)}</span></div>
      <p class="${stale ? 'stale-text' : ''}">${s ? esc(placeText(s)) : 'Not set'}${s?.mode === 'live' && s.live_note ? ` · ${esc(s.live_note)}` : ''}</p>
      ${evs.length ? `<p>In: ${evs.map(e => esc(e.title)).join('; ')}</p>` : ''}
      ${with_.size ? `<p>With: ${[...with_].map(personName).map(esc).join(', ')}</p>` : ''}
      <p class="muted">${s ? `Updated ${fmtWhen(Date.parse(s.updated_at))}` : ''}</p>
      ${phoneLinks(p)}
    </div>`;
  }).join('');
}

function eventLine(e) {
  return `${fmtTime(Date.parse(e.start))} to ${fmtTime(Date.parse(e.end))} · ${esc(e.room)}`;
}
function card(it) {
  const on = stars.has(it.key);
  const conflicts = on ? itemConflicts(it, starredItems()) : [];
  const link = it.url ? safeUrl(it.url) : '';
  const place = it.roomId ? placeBits(it.roomId) : (it.venue || it.room || 'Place not listed');
  return `<div class="row">
    <div class="name">${esc(it.title)}</div>
    ${it.host ? `<p class="muted">${esc(it.host)}</p>` : ''}
    <p class="muted">${it.day ? esc(fmtDay(it.day)) + ' · ' : ''}${esc(whenLine(it))}</p>
    <p class="muted">${esc(place)}</p>
    ${it.track ? `<p class="muted">${esc(it.track)}</p>` : ''}
    ${it.levels?.length ? `<p class="muted">Ticket: ${esc(it.levels.join(', '))}</p>` : ''}
    ${it.speakers?.length ? `<p>Speakers: ${esc(it.speakers.join(', '))}</p>` : ''}
    ${it.tags?.length ? `<p class="muted">${esc(it.tags.join(' · '))}</p>` : ''}
    ${priceLine(it) ? `<p class="muted">${esc(priceLine(it))}</p>` : ''}
    ${(it.offerings || []).map(o => `<p>${esc(o.kind)} · ${esc(o.certainty)}${o.quote ? `: ${esc(o.quote)}` : ''}</p>`).join('')}
    ${it.accessNote ? `<p class="muted">${esc(it.accessNote)}</p>` : ''}
    ${it.hasFood ? '<p class="muted">Listed on the free food page too.</p>' : ''}
    ${conflicts.length ? `<p class="conflict">Overlaps ${conflicts.map(c => esc(c.title)).join('; ')}</p>` : ''}
    <div class="actions">
      <button data-act="star" data-key="${esc(it.key)}" class="${on ? 'on' : ''}" aria-pressed="${on ? 'true' : 'false'}">${on ? 'Starred' : 'Star'}</button>
      ${it.roomId ? `<button data-act="goto-room" data-id="${esc(it.roomId)}">Map</button>` : ''}
      ${link ? `<a class="btn" href="${link}" target="_blank" rel="noopener noreferrer">Link</a>` : ''}
    </div>
  </div>`;
}
function dayButtons(days, cur, act) {
  return `<div class="seg">${days.map(d => `<button data-act="${act}" data-day="${esc(d)}" class="${d === cur ? 'on' : ''}">${d === 'all' ? 'All' : fmtDay(d)}</button>`).join('')}</div>`;
}
function segBar() {
  const segs = [['now', 'Now / Next'], ['agenda', 'Agenda'], ['events', 'Side events'], ['food', 'Free food'], ['recruiters', 'Recruiters'], ['companies', 'Companies'], ['starred', 'My schedule']];
  return `<div class="seg">${segs.map(([k, l]) => `<button data-act="seg" data-seg="${k}" class="${ui.seg === k && !ui.q.trim() ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function sourcesFooter() {
  const src = guideMeta.sources || [];
  if (!src.length) return '';
  return `<h2>Sources</h2><ul class="src">${src.map(s => {
    const href = s.url ? safeUrl(s.url) : '';
    const name = href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>` : esc(s.name);
    return `<li>${name}. ${esc(s.note || '')}</li>`;
  }).join('')}</ul>
    <p class="muted">Saved ${esc(guideMeta.generated || '')}. ${esc(guideMeta.sessions || '')} official sessions, ${esc(guideMeta.events || '')} side events. Times are America/Chicago. The live agenda can change.</p>`;
}
function viewAgendaNow() {
  const pool = guidePool();
  const mine = pool.filter(it => stars.has(it.key));
  const nowMine = happening(mine);
  const nextMine = upcoming(mine);
  const nowAll = happening(pool);
  const nextAll = upcoming(sessionsFull);
  const shown = ui.showAll ? nowAll : nowAll.slice(0, 8);
  const block = (title, list, empty) => `<h2>${title}</h2>${list.length ? `<div class="cards">${list.map(card).join('')}</div>` : `<p>${empty}</p>`}`;
  return `<p class="muted">${fmtWhen(now())} · Chicago</p>`
    + block('Starred now', nowMine, 'Nothing you starred is on right now.')
    + block('Starred next', nextMine, 'No starred item is coming up.')
    + block('On now', shown, 'Nothing in the saved guide is on at this time.')
    + (nowAll.length > 8 && !ui.showAll ? `<p><button data-act="showall">Show all ${nowAll.length} on now</button></p>` : '')
    + block('Next on the official agenda', nextAll, 'No later official session in the saved agenda.');
}
function viewAgenda() {
  if (!sessionsFull.length) return '<p>Agenda file missing. Run npm run build:guide.</p>';
  const days = [...new Set(sessionsFull.map(s => s.day))];
  if (!days.includes(ui.day)) ui.day = pickDay(days);
  let list = sessionsFull.filter(s => s.day === ui.day).map(s => ({ ...s, kind: 'session' }));
  if (ui.studentOnly) list = list.filter(s => !s.levels?.length || s.levels.includes('Student'));
  return `${dayButtons(days, ui.day, 'day')}
    <div class="seg"><button data-act="student" class="${ui.studentOnly ? 'on' : ''}">${ui.studentOnly ? 'Student and open tickets' : 'All ticket levels'}</button></div>
    <p class="muted">${list.length} sessions. Star one to keep it in My schedule. Speakers are whoever the official card listed.</p>
    <div class="cards">${list.map(card).join('')}</div>`;
}
function viewEvents() {
  const days = [...new Set(partnerEvents.map(e => e.day).filter(Boolean))];
  if (!days.includes(ui.eventDay)) ui.eventDay = pickDay(days);
  let list = partnerEvents.filter(e => e.day === ui.eventDay).map(e => ({ ...e, kind: 'event' }));
  if (ui.eventsFood) list = list.filter(looksLikeFood);
  return `${dayButtons(days, ui.eventDay, 'evday')}
    <div class="seg"><button data-act="eventsfood" class="${ui.eventsFood ? 'on' : ''}">${ui.eventsFood ? 'Food and drinks' : 'All side events'}</button></div>
    <p class="muted">Partner and community events for Nov 1–7. Confirm the link before you go.</p>
    <div class="cards">${list.map(card).join('') || '<p>Nothing in this filter.</p>'}</div>`;
}
function viewFood() {
  const days = ['all', ...new Set(foods.map(f => f.day).filter(Boolean))];
  const day = days.includes(ui.foodDay) ? ui.foodDay : 'all';
  ui.foodDay = day;
  let list = foods.filter(f => day === 'all' || f.day === day);
  if (ui.foodMode === 'free') list = list.filter(f => f.priceType === 'Free');
  if (ui.foodMode === 'comp') list = list.filter(f => (f.offerings || []).some(o => o.certainty === 'complimentary' || o.certainty === 'included'));
  const modes = [['all', 'All listings'], ['comp', 'Included'], ['free', 'Free entry']];
  return `${dayButtons(days, day, 'foodday')}
    <div class="seg">${modes.map(([k, l]) => `<button data-act="foodmode" data-mode="${k}" class="${ui.foodMode === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <p class="muted">From the AfroTech.guide free food list. “Included” means the listing quoted complimentary or included food or drinks. It can sell out.</p>
    <div class="cards">${list.map(f => card({ ...f, kind: 'food' })).join('') || '<p>Nothing in this filter.</p>'}</div>`;
}
function viewRecruiters() {
  const rows = [...recruiters].sort((a, b) => a.company.localeCompare(b.company) || a.person.localeCompare(b.person));
  return `<p class="muted">Name, company, booth, and the post the booth came from. Booth spots are not on the GRB plan.</p>
    <div class="cards">${rows.map(r => {
      const href = r.link ? safeUrl(r.link) : '';
      return `<div class="row">
        <div class="name">${esc(r.person)}</div>
        <p>${esc(r.company)}${r.boothNum ? ` · Booth ${esc(r.boothNum)}` : ''}</p>
        ${r.role ? `<p class="muted">${esc(r.role)}</p>` : ''}
        ${r.booth ? `<p class="muted">${esc(r.booth)}</p>` : ''}
        <div class="actions">
          ${href ? `<a class="btn" href="${href}" target="_blank" rel="noopener noreferrer">Post</a>` : ''}
          ${session && r.boothNum ? `<button data-act="booth-here" data-num="${esc(r.boothNum)}">I'm at this booth</button>` : ''}
        </div>
      </div>`;
    }).join('')}</div>`;
}
function viewCompanies() {
  let list = [...companies];
  if (ui.boothsOnly) list = list.filter(c => c.boothNum);
  return `<div class="seg"><button data-act="booths-toggle" class="${ui.boothsOnly ? 'on' : ''}">${ui.boothsOnly ? 'Booths only' : 'All companies'}</button></div>
    <p class="muted">${list.length} companies. Search finds the rest by name.</p>
    <div class="cards">${list.map(c => {
      const href = c.careers ? safeUrl(c.careers) : '';
      const guide = c.guide ? safeUrl(c.guide) : '';
      return `<div class="row">
        <div class="name">${esc(c.name)}</div>
        <p class="muted">${c.boothNum ? `Booth ${esc(c.boothNum)} · approximate` : 'No booth number in the saved list'}${c.sponsor ? ' · sponsor' : ''}</p>
        ${c.roles?.length ? `<p class="muted">${esc(c.roles.slice(0, 4).join(' · '))}</p>` : ''}
        <div class="actions">
          ${href ? `<a class="btn" href="${href}" target="_blank" rel="noopener noreferrer">Careers</a>` : ''}
          ${guide ? `<a class="btn" href="${guide}" target="_blank" rel="noopener noreferrer">Guide</a>` : ''}
          ${session && c.boothNum ? `<button data-act="booth-here" data-num="${esc(c.boothNum)}">I'm at this booth</button>` : ''}
        </div>
      </div>`;
    }).join('')}</div>`;
}
function viewStarred() {
  const items = starredItems();
  const overlapping = items.filter(it => itemConflicts(it, items).length);
  const byDay = [...new Set(items.map(it => it.day || 'unscheduled'))];
  return `<p class="muted">Stored on this phone only. Overlaps use the saved start and end.</p>
    ${overlapping.length ? `<p class="conflict">${overlapping.length} starred ${overlapping.length > 1 ? 'items overlap' : 'item overlaps another'}.</p>` : ''}
    ${items.length ? byDay.map(d => `<h2>${d === 'unscheduled' ? 'Time not listed' : fmtDay(d)}</h2><div class="cards">${items.filter(it => (it.day || 'unscheduled') === d).map(card).join('')}</div>`).join('') : '<p>No stars yet. Star a session, side event, or food stop.</p>'}`;
}
function viewSearch(q) {
  const n = q.toLowerCase();
  const has = text => String(text || '').toLowerCase().includes(n);
  const cap = (list, map) => {
    const rows = list.filter(map);
    return { n: rows.length, rows: rows.slice(0, 30) };
  };
  const ss = cap(sessionsFull, s => has([s.title, s.room, s.track, ...(s.speakers || []), ...(s.levels || [])].join(' ')));
  const ev = cap(partnerEvents, e => has([e.title, e.host, e.venue, e.description, ...(e.tags || [])].join(' ')));
  const fd = cap(foods, f => has([f.title, f.host, f.venue, ...(f.offerings || []).map(o => o.quote)].join(' ')));
  const rc = cap(recruiters, r => has([r.person, r.company, r.booth, r.role].join(' ')));
  const co = cap(companies, c => has([c.name, c.booth, ...(c.roles || [])].join(' ')));
  const block = (title, pack, draw) => pack.n ? `<h2>${title} (${pack.n})</h2><div class="cards">${pack.rows.map(draw).join('')}</div>${pack.n > pack.rows.length ? '<p class="muted">Showing the first 30.</p>' : ''}` : '';
  const body = [
    block('Sessions', ss, s => card({ ...s, kind: 'session' })),
    block('Side events', ev, e => card({ ...e, kind: 'event' })),
    block('Free food', fd, f => card({ ...f, kind: 'food' })),
    block('Recruiters', rc, r => `<div class="row"><div class="name">${esc(r.person)}</div><p>${esc(r.company)}${r.boothNum ? ` · Booth ${esc(r.boothNum)}` : ''}</p></div>`),
    block('Companies', co, c => `<div class="row"><div class="name">${esc(c.name)}</div><p class="muted">${c.boothNum ? `Booth ${esc(c.boothNum)}` : 'No booth number'}</p></div>`)
  ].join('');
  return body || '<p>No matches.</p>';
}
function viewGuide() {
  const q = ui.q.trim();
  let body;
  if (q) body = viewSearch(q);
  else if (ui.seg === 'agenda') body = viewAgenda();
  else if (ui.seg === 'events') body = viewEvents();
  else if (ui.seg === 'food') body = viewFood();
  else if (ui.seg === 'recruiters') body = viewRecruiters();
  else if (ui.seg === 'companies') body = viewCompanies();
  else if (ui.seg === 'starred') body = viewStarred();
  else body = viewAgendaNow();
  return `<h1>Guide</h1>
    <form data-act="search" role="search"><label class="search">Search sessions, events, and companies
      <input id="q" type="search" enterkeyhint="search" value="${esc(ui.q)}" autocomplete="off">
    </label></form>
    ${segBar()}
    ${body}
    ${sourcesFooter()}`;
}

function viewNow() {
  const agreed = session ? agreedEvents().filter(e => isRunning(e)) : [];
  return `<h1>Now / Next</h1>${viewAgendaNow()}
    ${session ? `<h2>Agreed right now</h2>${agreed.length ? agreed.map(e => {
      const going = goingTo(e.id);
      return `<div class="card"><div class="name">${esc(e.title)}</div><p class="muted">${eventLine(e)}</p><p>Going: ${going.length ? going.map(personName).map(esc).join(', ') : 'No one yet'}</p></div>`;
    }).join('') : '<p>No agreed event is running now.</p>'}` : '<p class="muted"><a href="#signin">Sign in</a> to see the group’s agreed list.</p>'}`;
}

function goingButton(e) {
  const on = isGoing(session.person_id, e.id);
  return `<button data-act="attend" data-id="${esc(e.id)}" data-on="${on ? 1 : 0}" class="${on ? 'on' : ''}">${on ? 'Going' : 'Mark going'}</button>`;
}
function dayTabs(days, cur, act) {
  return dayButtons(days, cur, act);
}
function viewSchedule() {
  const days = [...new Set(schedule.map(e => e.day))];
  if (ui.addOpen) {
    const day = ui.addDay || days[0];
    const agreedIds = new Set(cache?.data.agreed.map(a => a.event_id));
    return `<div class="top"><h1>Add event</h1><button data-act="addclose">Done</button></div>
      <p class="muted">Student and Premiere events only, through Thu Nov 5 at noon.</p>
      ${dayTabs(days, day, 'addday')}
      ${schedule.filter(e => e.day === day).map(e => `<div class="row">
        <div>${esc(e.title)}</div><p class="muted">${eventLine(e)}</p>
        ${agreedIds.has(e.id) ? '<p class="muted">Agreed</p>' : `<button data-act="add" data-id="${esc(e.id)}">Add</button>`}
      </div>`).join('')}`;
  }
  const evs = agreedEvents();
  const byDay = days.map(d => [d, evs.filter(e => e.day === d)]).filter(([, l]) => l.length);
  return `<div class="top"><h1>Agreed schedule</h1><button class="primary" data-act="addopen">Add event</button></div>
    <p class="muted">This is the group list. The full week, stars, and conflicts are on <a href="#guide">Guide</a>.</p>
    ${byDay.length ? '' : '<p>No agreed events yet.</p>'}
    ${byDay.map(([d, l]) => `<h2>${fmtDay(d)}</h2>` + l.map(e => {
      const going = goingTo(e.id);
      return `<div class="row">
        <div class="name">${esc(e.title)}</div>
        <p class="muted">${eventLine(e)}${isRunning(e) ? ' · <b>Now</b>' : ''}</p>
        <p class="muted">Going: ${going.length ? going.map(personName).map(esc).join(', ') : 'No one yet'}</p>
        ${goingButton(e)}
      </div>`;
    }).join('')).join('')}`;
}

function peopleIn(roomId) {
  return cache?.data?.status?.filter(s => s.room_id === roomId) || [];
}
function wrapLabel(s, n) {
  const words = String(s).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > n && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 5);
}
function viewMap() {
  const lv = ui.mapLevel;
  const levels = [['1', 'Level 1'], ['2', 'Level 2'], ['3', 'Level 3'], ['none', 'Off plan']];
  const drawn = rooms.filter(r => r.level === lv && r.x != null && r.y != null);
  let body;
  if (!drawn.length) {
    body = `<p class="muted">${lv === 'none' ? 'These names are not placed on a floor.' : 'No drawn rooms on this level.'}</p>`;
  } else {
    const h = Math.max(...drawn.map(r => r.y + r.h)) + 12;
    body = `<svg viewBox="0 0 360 ${h}" role="img" aria-label="${lv === 'none' ? 'Off plan' : 'Level ' + lv} schematic">
      ${drawn.map(r => {
        const here = peopleIn(r.id);
        const n = here.length;
        const pin = here.some(s => s.meet_pin);
        const lines = wrapLabel(r.short, Math.max(8, Math.floor(r.w / 6.2)));
        return `<g>
          <rect class="room ${r.certainty === 'approximate' ? 'approx' : ''} ${ui.mapRoom === r.id ? 'sel' : ''}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="4" data-act="room" data-id="${esc(r.id)}"></rect>
          ${lines.map((w, i) => `<text x="${r.x + 6}" y="${r.y + 16 + i * 13}">${esc(w)}</text>`).join('')}
          ${n ? `<circle class="count" cx="${r.x + r.w - 14}" cy="${r.y + r.h - 14}" r="10"></circle>
            <text class="count-text" x="${r.x + r.w - 14}" y="${r.y + r.h - 10}" text-anchor="middle">${n}</text>` : ''}
          ${pin ? `<circle class="pin" cx="${r.x + 14}" cy="${r.y + r.h - 14}" r="6"></circle>` : ''}
        </g>`;
      }).join('')}
    </svg>`;
  }
  const loose = (cache?.data?.status || []).filter(s => {
    if (String(s.room_id).startsWith('booth-')) return false;
    const r = roomById(s.room_id);
    if (r && r.x != null && r.level === lv) return false;
    const level = s.level && s.level !== 'off' ? s.level : (r && r.level !== 'none' ? r.level : 'none');
    return level === lv;
  });
  const boothList = lv === '1' ? `<h2>Booths</h2>
    <p class="muted">Numbers come from recruiter and company posts. There is no booth coordinate on the GRB plan.</p>
    <div class="grid">${booths.map(b => {
      const who = (cache?.data?.status || []).filter(s => s.room_id === b.roomId);
      return `<button class="offplan ${who.length ? 'sel' : ''}" data-act="room" data-id="${esc(b.roomId)}">Booth ${esc(b.num)} · ${esc(b.companies.join(', '))}${who.length ? ` (${who.length})` : ''}</button>`;
    }).join('')}</div>` : '';
  const extraRooms = rooms.filter(r => r.level === lv && r.x == null && !String(r.id).startsWith('level-'));
  const extra = extraRooms.length ? `<div class="grid">${extraRooms.map(r => {
    const n = peopleIn(r.id).length;
    return `<button class="offplan ${ui.mapRoom === r.id ? 'sel' : ''}" data-act="room" data-id="${esc(r.id)}">${esc(r.short)}${n ? ` (${n})` : ''}</button>`;
  }).join('')}</div>` : '';
  let panel = '';
  const r = ui.mapRoom && (roomById(ui.mapRoom) || (String(ui.mapRoom).startsWith('booth-') ? {
    id: ui.mapRoom, label: roomName(ui.mapRoom), short: roomName(ui.mapRoom),
    certainty: 'approximate', note: 'Booth number only. Position on Level 1 is approximate.', level: '1'
  } : null));
  if (r) {
    const here = peopleIn(r.id);
    const evs = agreedEvents().filter(e => isRunning(e) && roomForEvent(e) === r.id);
    const mine = session && statusOf(session.person_id);
    const pinned = mine && mine.room_id === r.id && mine.meet_pin;
    panel = `<div class="card">
      <div class="name">${esc(r.label || r.short)}</div>
      ${r.note ? `<p class="muted">${esc(r.note)}</p>` : ''}
      <p>Agreed event now: ${evs.length ? evs.map(e => esc(e.title)).join('; ') : 'None'}</p>
      ${here.length ? here.map(s => `<div class="row"><div class="top"><span>${esc(personName(s.person_id))}</span><span>${badge(s)}</span></div><p class="muted">Updated ${fmtWhen(Date.parse(s.updated_at))}</p>${phoneLinks(cache.data.people.find(p => p.id === s.person_id))}</div>`).join('') : '<p>No one checked in here.</p>'}
      ${loose.length && !here.length ? '' : ''}
      ${session ? `<button data-act="meet" data-id="${esc(r.id)}" data-on="${pinned ? 1 : 0}">${pinned ? 'Clear meet pin' : 'Meet me here'}</button>` : '<p class="muted"><a href="#signin">Sign in</a> to drop a meet pin.</p>'}
    </div>`;
  }
  const looseHtml = loose.length ? `<h2>Checked in, not inside a drawn room</h2>` + loose.map(s =>
    `<div class="row"><div class="top"><span>${esc(personName(s.person_id))}</span><span>${badge(s)}</span></div><p>${esc(placeText(s))}</p><p class="muted">Updated ${fmtWhen(Date.parse(s.updated_at))}</p></div>`).join('') : '';
  return `<h1>Map</h1>
    <p class="muted">George R. Brown Convention Center. Schematic, not to scale. Solid rooms are named on the GRB floor plan. Dashed rooms are AfroTech names and their position is approximate. <a href="https://www.grbhouston.com/planners/floor-plans/" target="_blank" rel="noopener noreferrer">Official plans</a>.</p>
    <p class="muted">${FLOOR_HONEST}</p>
    <div class="seg">${levels.map(([k, l]) => `<button data-act="level" data-level="${k}" class="${k === lv ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${lv === '1' ? '<p class="muted">Halls are drawn A to E in the order on the GRB plan. That is not a compass heading.</p>' : ''}
    ${lv === '2' ? '<p class="muted">Avenida is balcony C South. McKinney is C North. Walker is the balcony lettered B. Conference rooms 212–215 are also on this level and are not drawn.</p>' : ''}
    ${lv === '3' ? '<p class="muted">Halls, the ballroom, and meeting rooms are grouped by type. Adjacency on this drawing is not measured.</p>' : ''}
    ${body}${extra}${boothList}${looseHtml}${panel}`;
}

function roomChoices(selected) {
  const groups = [['1', 'Level 1'], ['2', 'Level 2'], ['3', 'Level 3'], ['none', 'Other']];
  return `<select id="room" aria-label="Room"><option value="">Pick a room</option>${groups.map(([k, l]) =>
    `<optgroup label="${l}">${rooms.filter(r => r.level === k).map(r => {
      const tag = r.certainty === 'approximate' ? ' (approx.)' : r.certainty === 'unknown' ? ' (floor unknown)' : '';
      return `<option value="${esc(r.id)}" ${selected === r.id ? 'selected' : ''}>${esc(r.short)}${tag}</option>`;
    }).join('')}</optgroup>`).join('')}</select>`;
}
function altHint() {
  if (live.watchId === null && live.altitude == null) return '';
  if (live.altitude == null) return 'This phone did not share altitude. That is common indoors. Confirm the level yourself.';
  return `Phone altitude about ${Math.round(live.altitude)} m. Hint only, not a floor.`;
}
function viewCrew() {
  if (!session) return viewSignIn();
  const crewReady = !!(cache?.data && Object.prototype.hasOwnProperty.call(cache.data, 'paired_ids'));
  const me = cache?.data?.people?.find(p => p.id === session.person_id);
  const phoneShown = ui.phoneDraft == null ? (me?.phone || '') : ui.phoneDraft;
  const code = cache?.data?.pair_code || '';
  const link = code ? `${location.origin}${location.pathname}#pair=${code}` : '';
  const ids = cache?.data?.paired_ids || [];
  const paired = ids.map(id => cache.data.people.find(p => p.id === id)).filter(Boolean);
  const s = statusOf(session.person_id);
  const locals = LOCAL_NAMES.map(name => {
    const n = localPhone(name);
    return n ? { label: name === 'David' ? 'David (Timeless)' : name, phone: n } : null;
  }).filter(Boolean);
  const wait = pendingPair();
  return `<h1>Crew</h1>
    <p class="muted">${FLOOR_HONEST} Sharing stays on only while this page is open and you leave it on.</p>
    ${crewReady ? '' : '<p class="conflict">Pairing is not on this server yet. Run supabase/crew.sql in the Supabase SQL editor. The guide, map, and group tracker still work.</p>'}
    ${wait ? `<div class="card"><p>A pair link is waiting.</p><div class="actions"><button class="primary" data-act="accept-pending">Accept</button><button data-act="dismiss-pair">Not now</button></div></div>` : ''}
    <h2>Where I am</h2>
    <p>${badge(s)} ${s ? `<span class="muted">Updated ${fmtWhen(Date.parse(s.updated_at))}</span>` : ''}</p>
    <p>${s ? esc(placeText(s)) : 'No check-in yet.'}</p>
    <div class="seg">
      <button data-act="set-level" data-level="1">Level 1</button>
      <button data-act="set-level" data-level="2">Level 2</button>
      <button data-act="set-level" data-level="3">Level 3</button>
    </div>
    ${roomChoices(s?.room_id)}
    <form data-act="booth">
      <label class="search">Booth number
        <input id="booth" inputmode="numeric" placeholder="812" autocomplete="off">
      </label>
      <button>Check in at this booth</button>
    </form>
    <p class="actions"><button data-act="still" ${s ? '' : 'disabled'}>Still here</button>
      <button data-act="live" class="${live.watchId !== null ? 'on' : ''}">${live.watchId !== null ? 'Stop sharing location' : 'Share live location'}</button></p>
    ${altHint() ? `<p class="muted">${esc(altHint())}</p>` : ''}
    ${live.error ? `<p class="err">${esc(live.error)}</p>` : ''}
    <h2>Pair</h2>
    <p class="muted">Send a link or read the code. The other person accepts. You can then see each other’s number. A new link turns the old one off. Anyone with the link can pair until it expires (7 days).</p>
    ${code ? `<p class="codebig">${esc(code)}</p><p class="muted">${esc(link)}</p>
      <div class="actions"><button data-act="copy-pair">Copy link</button><button data-act="share-pair">Share</button><button data-act="make-pair">New code</button></div>`
      : '<p><button class="primary" data-act="make-pair">Create a pair link</button></p>'}
    <form data-act="pair">
      <label class="search">Their code
        <input id="pair-in" autocomplete="off" placeholder="paste code">
      </label>
      <button>Accept code</button>
    </form>
    <h2>My number</h2>
    <form data-act="phone">
      <label class="search">Phone
        <input id="phone" type="tel" autocomplete="tel" inputmode="tel" value="${esc(phoneShown)}" placeholder="+1 555 0100">
      </label>
      <button class="primary">Save number</button>
    </form>
    <p class="muted">Stored for people you pair with. It is not in the public repo. Leave it blank and save to clear it.</p>
    <h2>Paired</h2>
    ${paired.length ? paired.map(p => {
      const st = statusOf(p.id);
      return `<div class="row">
        <div class="top"><span class="name">${esc(p.name)}</span><span>${badge(st)}</span></div>
        <p>${st ? esc(placeText(st)) : 'No check-in yet'}</p>
        <p class="muted">${st ? `Updated ${fmtWhen(Date.parse(st.updated_at))}` : ''}</p>
        ${phoneLinks(p)}
        <button data-act="unpair" data-id="${p.id}">Unpair</button>
      </div>`;
    }).join('') : '<p>No one paired yet.</p>'}
    ${locals.length ? `<h2>Private list on this device</h2><p class="muted">From config.local.js. These numbers stay on this device. They are not uploaded.</p>${locals.map(row => {
      const href = telHref(row.phone);
      return `<div class="row"><div class="name">${esc(row.label)}</div><div class="actions"><a class="btn" href="tel:${esc(href)}">Call</a><a class="btn" href="sms:${esc(href)}">Text</a></div></div>`;
    }).join('')}` : ''}`;
}

function viewMe() {
  const me = session.person_id;
  const s = statusOf(me);
  const today = chicagoDay(now());
  const todays = agreedEvents().filter(e => e.day === today);
  return `<h1>My status</h1>
    <p>${badge(s)} ${s ? `<span class="muted">Updated ${fmtWhen(Date.parse(s.updated_at))}</span>` : ''}</p>
    ${s ? `<p>${esc(placeText(s))}</p>` : ''}
    <h2>Where am I?</h2>
    <p class="muted">${FLOOR_HONEST}</p>
    ${roomChoices(s?.room_id)}
    <p><button data-act="still" ${s ? '' : 'disabled'}>Still here</button></p>
    <h2>Live location</h2>
    <p class="muted">Only while this page is open and this is on. The server stores “At GRB” or “Away from GRB”, not a coordinate. Your room is still the one you pick.</p>
    <button data-act="live" class="${live.watchId !== null ? 'on' : ''}">${live.watchId !== null ? 'Stop sharing location' : 'Share live location'}</button>
    ${altHint() ? `<p class="muted">${esc(altHint())}</p>` : ''}
    ${live.error ? `<p class="err">${esc(live.error)}</p>` : ''}
    <h2>My events today</h2>
    ${todays.length ? todays.map(e => `<div class="row"><div>${esc(e.title)}</div><p class="muted">${eventLine(e)}</p>${goingButton(e)}</div>`).join('') : '<p>No agreed events today.</p>'}
    <p class="muted">Phone, pairing, and booth check-in are on <a href="#crew">Crew</a>.</p>
    <h2>Signed in as ${esc(session.name)}${session.name === 'David' ? ' (Timeless)' : ''}</h2>
    <button data-act="signout">Sign out</button>`;
}

const VIEWS = { guide: viewGuide, now: viewNow, map: viewMap, schedule: viewSchedule, crew: viewCrew, friends: viewFriends, me: viewMe, signin: viewSignIn };
function route() {
  let r = location.hash.replace(/^#/, '').split('&')[0];
  if (r.startsWith('pair=')) r = session ? 'crew' : 'guide';
  if (!VIEWS[r]) return session ? 'friends' : 'guide';
  if (!session && !PUBLIC.has(r)) return 'signin';
  if (session && r === 'signin') return 'friends';
  return r;
}
function setTabs() {
  const signed = !!session;
  document.body.classList.toggle('signed-in', signed);
  const show = signed
    ? ['guide', 'now', 'map', 'schedule', 'crew', 'friends', 'me']
    : ['guide', 'now', 'map', 'signin'];
  $tabs.hidden = false;
  const r = route();
  $tabs.querySelectorAll('a').forEach(a => {
    const id = a.getAttribute('href').slice(1);
    a.hidden = !show.includes(id);
    a.classList.toggle('on', id === r);
  });
}
function snapshotFields(active) {
  const q = document.getElementById('q');
  if (q) ui.q = q.value;
  const phone = document.getElementById('phone');
  if (phone) ui.phoneDraft = phone.value;
  const code = document.getElementById('code');
  if (code) ui.code = code.value;
  ui._keep = null;
  ui._caret = null;
  if (active && active.id && active.matches && active.matches('input, textarea')) {
    ui._keep = active.id;
    ui._caret = active.selectionStart;
  }
}
function render() {
  renderSync();
  const active = document.activeElement;
  if (active && active.tagName === 'SELECT') return;
  snapshotFields(active);
  setTabs();
  const r = route();
  const banner = `${ui.msg ? `<p class="err">${esc(ui.msg)}</p>` : ''}${ui.note ? `<p class="note">${esc(ui.note)}</p>` : ''}`;
  $view.innerHTML = banner + VIEWS[r]();
  if (ui._route !== r) {
    ui._route = r;
    $tabs.querySelector('a.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
  if (ui._keep) {
    const el = document.getElementById(ui._keep);
    if (el) {
      el.focus();
      if (ui._caret != null && el.setSelectionRange) {
        try { el.setSelectionRange(ui._caret, ui._caret); } catch {}
      }
    }
  }
}

function setStatus(roomId, mode) {
  queue('set_status', {
    p_room: roomId, p_mode: mode,
    p_note: mode === 'live' ? live.note : null,
    p_client_ts: new Date().toISOString()
  });
}
function setCheckin(roomId, extra = {}) {
  if (!session) { ui.msg = 'Sign in to save a check-in.'; location.hash = '#signin'; return; }
  const room = roomById(roomId);
  const level = extra.level || (room && room.level !== 'none' ? room.level : null);
  const label = extra.label || room?.short || roomName(roomId);
  queue('set_checkin', {
    p_room: roomId,
    p_mode: live.watchId !== null ? 'live' : 'manual',
    p_note: live.watchId !== null ? live.note : null,
    p_level: level,
    p_label: label,
    p_alt: typeof live.altitude === 'number' ? Math.round(live.altitude * 10) / 10 : null,
    p_meet: !!extra.meet,
    p_client_ts: new Date().toISOString()
  });
}

function startLive() {
  if (!navigator.geolocation) { live.error = 'Location not available on this device.'; return render(); }
  if (!statusOf(session.person_id)) { live.error = 'Pick your room or level first.'; return render(); }
  live.error = '';
  live.watchId = navigator.geolocation.watchPosition(pos => {
    const note = distanceM(pos.coords.latitude, pos.coords.longitude) <= GRB.radiusM ? 'At GRB' : 'Away from GRB';
    const alt = typeof pos.coords.altitude === 'number' ? pos.coords.altitude : null;
    const first = live.note === null;
    const changed = note !== live.note || (alt == null) !== (live.altitude == null);
    live.note = note;
    live.altitude = alt;
    if (first) beat();
    else if (changed) render();
  }, err => {
    live.error = err.code === 1 ? 'Location permission denied.' : 'Could not get location.';
    stopLive(false);
  }, { enableHighAccuracy: true, maximumAge: 60000, timeout: 30000 });
  live.timer = setInterval(beat, LIVE_BEAT_MS);
  try { sessionStorage.setItem('wa_live', '1'); } catch {}
  render();
}
function beat() {
  const s = statusOf(session?.person_id);
  if (live.note === null || !s) return;
  setStatus(s.room_id, 'live');
}
function stopLive(sendManual = true) {
  if (live.watchId !== null) navigator.geolocation.clearWatch(live.watchId);
  clearInterval(live.timer);
  live.watchId = null; live.timer = null; live.note = null; live.altitude = null;
  try { sessionStorage.removeItem('wa_live'); } catch {}
  const s = session && statusOf(session.person_id);
  if (sendManual && s) setStatus(s.room_id, 'manual');
  else render();
}
function distanceM(lat, lng) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(lat - GRB.lat), dLng = toR(lng - GRB.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(GRB.lat)) * Math.cos(toR(lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function signOut(local) {
  if (live.watchId !== null) stopLive(false);
  if (!local && session) api('sign_out', { p_token: session.token }).catch(() => {});
  session = null; cache = null; outbox = [];
  ['wa_session', 'wa_state', 'wa_outbox'].forEach(k => { try { localStorage.removeItem(k); } catch {} });
  location.hash = '#guide';
  render();
}
function pairLink(code) {
  return `${location.origin}${location.pathname}#pair=${code}`;
}
async function acceptPair(code) {
  if (!session) { ui.msg = 'Sign in first.'; location.hash = '#signin'; render(); return; }
  try {
    const r = await api('accept_pair', { p_token: session.token, p_code: code });
    try { sessionStorage.removeItem('wa_pair'); } catch {}
    ui.note = r?.paired_with ? `Paired with ${r.paired_with}.` : 'Paired.';
    ui.msg = '';
    await sync();
  } catch (err) {
    ui.msg = err.network ? 'No connection.' : shortErr(err);
    render();
  }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'FORM') return;
  const act = el.dataset.act;
  if (act !== 'pick') { ui.msg = ''; ui.note = ''; }
  if (act === 'pick') { ui.signName = el.dataset.name; render(); }
  else if (act === 'attend') queue('set_attendance', { p_event: el.dataset.id, p_attending: el.dataset.on !== '1' });
  else if (act === 'add') queue('add_agreed', { p_event: el.dataset.id });
  else if (act === 'addopen') { ui.addOpen = true; render(); scrollTo(0, 0); }
  else if (act === 'addclose') { ui.addOpen = false; render(); }
  else if (act === 'addday') { ui.addDay = el.dataset.day; render(); }
  else if (act === 'level') { ui.mapLevel = el.dataset.level; ui.mapRoom = null; render(); }
  else if (act === 'room') { ui.mapRoom = el.dataset.id; render(); }
  else if (act === 'still') {
    const s = statusOf(session.person_id);
    if (s) setCheckin(s.room_id, { meet: !!s.meet_pin, level: s.level, label: s.place_label });
  }
  else if (act === 'live') live.watchId !== null ? stopLive() : startLive();
  else if (act === 'signout') signOut(false);
  else if (act === 'star') toggleStar(el.dataset.key);
  else if (act === 'seg') { ui.seg = el.dataset.seg; ui.showAll = false; render(); }
  else if (act === 'day') { ui.day = el.dataset.day; render(); }
  else if (act === 'evday') { ui.eventDay = el.dataset.day; render(); }
  else if (act === 'foodday') { ui.foodDay = el.dataset.day; render(); }
  else if (act === 'student') { ui.studentOnly = !ui.studentOnly; render(); }
  else if (act === 'foodmode') { ui.foodMode = el.dataset.mode; render(); }
  else if (act === 'eventsfood') { ui.eventsFood = !ui.eventsFood; render(); }
  else if (act === 'booths-toggle') { ui.boothsOnly = !ui.boothsOnly; render(); }
  else if (act === 'showall') { ui.showAll = true; render(); }
  else if (act === 'goto-room') {
    const room = roomById(el.dataset.id);
    ui.mapRoom = el.dataset.id;
    ui.mapLevel = room && room.level !== 'none' ? room.level : 'none';
    if (location.hash === '#map') render();
    else location.hash = '#map';
  }
  else if (act === 'set-level') {
    const level = el.dataset.level;
    setCheckin('level-' + level, { level, label: `Level ${level}, room not set`, meet: false });
  }
  else if (act === 'booth-here') {
    setCheckin('booth-' + el.dataset.num, { level: '1', label: 'Booth ' + el.dataset.num, meet: false });
  }
  else if (act === 'meet') {
    const id = el.dataset.id;
    const on = el.dataset.on === '1';
    const room = roomById(id);
    setCheckin(id, {
      meet: !on,
      level: room && room.level !== 'none' ? room.level : '1',
      label: room?.short || roomName(id)
    });
  }
  else if (act === 'make-pair') {
    api('create_pair_code', { p_token: session.token }).then(async () => {
      ui.note = 'Pair link ready. It replaces any older link.';
      await sync();
    }).catch(err => { ui.msg = err.network ? 'No connection.' : shortErr(err); render(); });
  }
  else if (act === 'copy-pair' || act === 'share-pair') {
    const code = cache?.data?.pair_code;
    if (!code) { ui.msg = 'Create a link first.'; render(); return; }
    const link = pairLink(code);
    const job = act === 'share-pair' && navigator.share
      ? navigator.share({ title: 'AfroTech crew', url: link }).then(() => 'Link shared.')
      : (navigator.clipboard ? navigator.clipboard.writeText(link).then(() => 'Link copied.') : Promise.reject());
    job.then(m => { ui.note = m; render(); }).catch(() => { ui.note = link; render(); });
  }
  else if (act === 'accept-pending') acceptPair(pendingPair());
  else if (act === 'dismiss-pair') { try { sessionStorage.removeItem('wa_pair'); } catch {} render(); }
  else if (act === 'unpair') {
    api('unpair', { p_token: session.token, p_other: +el.dataset.id })
      .then(() => sync())
      .catch(err => { ui.msg = shortErr(err); render(); });
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'q') render();
});
document.addEventListener('change', e => {
  if (e.target.id === 'room' && e.target.value) {
    const v = e.target.value;
    e.target.blur();
    setCheckin(v, { meet: false });
  }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  const act = e.target.dataset.act;
  if (act === 'search') return;
  if (act === 'signin') {
    if (!ui.signName) return;
    const code = document.getElementById('code').value;
    ui.code = code;
    ui.msg = '';
    try {
      const r = await api('sign_in', { p_name: ui.signName, p_code: code });
      session = { token: r.token, person_id: r.person_id, name: ui.signName };
      save('wa_session', session);
      net.ok = true;
      location.hash = pendingPair() ? '#crew' : '#friends';
      await sync();
    } catch (err) {
      ui.msg = err.setup ? 'Cannot reach the group server. Close and reopen the page.' :
        err.network ? 'No connection. Sign in needs a connection.' : err.message === 'wrong code' ? 'Wrong group code.' : shortErr(err);
      render();
    }
    return;
  }
  if (!session) { ui.msg = 'Sign in first.'; render(); return; }
  if (act === 'phone') {
    const v = document.getElementById('phone')?.value || '';
    try {
      await api('set_phone', { p_token: session.token, p_phone: v });
      ui.phoneDraft = null;
      ui.note = v.trim() ? 'Number saved for people you pair with.' : 'Number cleared.';
      await sync();
    } catch (err) {
      ui.msg = err.network ? 'No connection. Saving a number needs a connection.' : shortErr(err);
      render();
    }
  } else if (act === 'pair') {
    const code = document.getElementById('pair-in')?.value || '';
    acceptPair(code);
  } else if (act === 'booth') {
    const num = (document.getElementById('booth')?.value || '').replace(/\D/g, '');
    if (!num) { ui.msg = 'Type a booth number.'; render(); return; }
    setCheckin('booth-' + num, { level: '1', label: 'Booth ' + num, meet: false });
  }
});

window.addEventListener('hashchange', () => {
  ui.addOpen = false;
  render();
  scrollTo(0, 0);
  $tabs.querySelector('a.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
});
window.addEventListener('online', sync);
window.addEventListener('offline', () => { net.ok = false; render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
function pollIntervalMs() {
  let r = location.hash.replace(/^#/, '').split('&')[0];
  if (r.startsWith('pair=')) r = session ? 'crew' : 'guide';
  return (r === 'friends' || r === 'crew' || r === 'map') ? POLL_FAST_MS : POLL_MS;
}
let pollTimer = null;
function armPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) sync(); }, pollIntervalMs());
}
armPoll();
window.addEventListener('hashchange', armPoll);
setInterval(() => { if (!document.hidden) render(); }, 30000);

(function capturePair() {
  const m = location.hash.match(/^#pair=([0-9a-f]{6,64})$/i);
  if (!m) return;
  try { sessionStorage.setItem('wa_pair', m[1].toLowerCase()); } catch {}
  history.replaceState(null, '', location.pathname + location.search + (session ? '#crew' : '#guide'));
})();

async function loadLocalCrew() {
  try {
    const r = await fetch('config.local.js', { cache: 'no-store' });
    if (!r.ok) return;
    const t = await r.text();
    if (!t.includes('CREW_LOCAL')) return;
    const s = document.createElement('script');
    s.textContent = t;
    document.head.appendChild(s);
  } catch {}
}
async function loadJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(path);
  return r.json();
}

(async () => {
  await loadLocalCrew();
  try { [schedule, rooms] = await Promise.all([loadJson('data/schedule.json'), loadJson('data/rooms.json')]); }
  catch { $view.innerHTML = '<p>Could not load the schedule. Connect once to load.</p>'; return; }
  const opt = async p => { try { return await loadJson(p); } catch { return null; } };
  const [sf, pe, fd, rc, co, bo, gm] = await Promise.all([
    opt('data/sessions-full.json'), opt('data/partner-events.json'), opt('data/freefood.json'),
    opt('data/recruiters.json'), opt('data/companies.json'), opt('data/booths.json'), opt('data/guide-meta.json')
  ]);
  sessionsFull = sf || [];
  partnerEvents = pe || [];
  foods = fd || [];
  recruiters = rc || [];
  companies = co || [];
  booths = bo || [];
  guideMeta = gm || {};
  ui.day = pickDay([...new Set(sessionsFull.map(s => s.day))]);
  ui.eventDay = pickDay([...new Set(partnerEvents.map(e => e.day).filter(Boolean))]);
  render();
  sync();
  try { if (session && sessionStorage.getItem('wa_live')) startLive(); } catch {}
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
