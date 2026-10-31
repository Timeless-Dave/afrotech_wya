'use strict';

const TZ = 'America/Chicago';
const ROSTER = ['Angel', 'David', 'Aziz', 'Raphael', 'Yannick', 'Grace', 'Aldine', 'Peter', 'Nicholas', 'Kudzi', 'Kenny', 'Ms. Yussif'];
const POLL_MS = 20000;
const LIVE_BEAT_MS = 60000;
const STALE_MANUAL_MS = 45 * 60000;
const STALE_LIVE_MS = 5 * 60000;
const GRB = { lat: 29.7522, lng: -95.3586, radiusM: 450 };
const NO_GROUP_ROOMS = ['elsewhere-grb', 'outside-grb'];

const $view = document.getElementById('view');
const $sync = document.getElementById('sync');
const $tabs = document.getElementById('tabs');

// ---------- storage ----------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let session = load('wa_session', null);      // {token, person_id, name}
let cache = load('wa_state', null);          // {data, syncedAt}
let outbox = load('wa_outbox', []);          // [{fn, args}]
let schedule = [];
let rooms = [];
let net = { ok: navigator.onLine, lastTry: 0, error: '' };
let ui = { day: null, addOpen: false, addDay: null, mapLevel: '1', mapRoom: null, msg: '' };
let live = { watchId: null, timer: null, note: null, error: '' };

// ---------- time ----------
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

// ---------- api ----------
async function api(fn, args) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let res;
  try {
    const base = CONFIG.SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
    const key = CONFIG.SUPABASE_ANON_KEY;
    const headers = { 'Content-Type': 'application/json', apikey: key };
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // legacy anon key is a JWT; new publishable keys are not
    res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
      signal: ctrl.signal
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
    throw err;
  }
  return body;
}

// ---------- sync ----------
function queue(fn, args) {
  outbox.push({ fn, args });
  save('wa_outbox', outbox);
  applyLocal(fn, args);
  render();
  sync();
}

// Show my own change right away, before the server confirms it.
function applyLocal(fn, args) {
  if (!cache) return;
  const d = cache.data, me = session.person_id;
  if (fn === 'set_status') {
    d.status = d.status.filter(s => s.person_id !== me);
    d.status.push({ person_id: me, room_id: args.p_room, mode: args.p_mode, live_note: args.p_note, updated_at: args.p_client_ts });
  } else if (fn === 'set_attendance') {
    d.attendance = d.attendance.filter(a => !(a.person_id === me && a.event_id === args.p_event));
    if (args.p_attending) d.attendance.push({ person_id: me, event_id: args.p_event });
  } else if (fn === 'add_agreed') {
    if (!d.agreed.some(a => a.event_id === args.p_event)) d.agreed.push({ event_id: args.p_event, added_by: me });
  }
  save('wa_state', cache);
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
        ui.msg = `Change not saved: ${e.message}`; // server refused it, drop it
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

// ---------- derived data ----------
const roomById = id => rooms.find(r => r.id === id);
const roomName = id => roomById(id)?.short || id || 'Not set';
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
function roomForEvent(e) { return rooms.find(r => r.label === e.room)?.id; }

function badge(s) {
  if (!s) return '<span class="badge stale">No status</span>';
  const kind = s.mode === 'live' ? '<span class="badge live">Live</span>' : '<span class="badge">Manual</span>';
  return kind + (isStale(s) ? ' <span class="badge stale">Stale</span>' : '');
}

// ---------- views ----------
function viewSignIn() {
  const sel = ui.signName || '';
  return `<h1>Sign in</h1>
    <p class="muted">Pick your name.</p>
    <div class="grid">${ROSTER.map(n => `<button data-act="pick" data-name="${esc(n)}" class="${n === sel ? 'on' : ''}">${esc(n)}</button>`).join('')}</div>
    <h2>Group code</h2>
    <form data-act="signin">
      <input id="code" type="password" autocomplete="current-password" required>
      <p><button class="primary" style="width:100%" ${sel ? '' : 'disabled'}>Sign in${sel ? ' as ' + esc(sel) : ''}</button></p>
    </form>
    ${ui.msg ? `<p class="err">${esc(ui.msg)}</p>` : ''}`;
}

function viewFriends() {
  if (!cache) return '<h1>Friends</h1><p>No data yet. Connect once to load.</p>';
  const people = [...cache.data.people].sort((a, b) => (b.id === session.person_id) - (a.id === session.person_id));
  return `<h1>Where are my friends?</h1>` + people.map(p => {
    const s = statusOf(p.id), stale = isStale(s);
    const evs = currentEventsOf(p.id);
    const with_ = new Set();
    if (s && !stale && !NO_GROUP_ROOMS.includes(s.room_id)) {
      cache.data.status.forEach(o => { if (o.person_id !== p.id && o.room_id === s.room_id && !isStale(o)) with_.add(o.person_id); });
    }
    evs.forEach(e => goingTo(e.id).forEach(id => { if (id !== p.id) with_.add(id); }));
    return `<div class="row">
      <div class="top"><span class="name">${esc(p.name)}${p.id === session.person_id ? ' (you)' : ''}</span><span>${badge(s)}</span></div>
      <p class="${stale ? 'stale-text' : ''}">${s ? esc(roomName(s.room_id)) : 'Not set'}${s?.mode === 'live' && s.live_note ? ` · ${esc(s.live_note)}` : ''}</p>
      ${evs.length ? `<p>In: ${evs.map(e => esc(e.title)).join('; ')}</p>` : ''}
      ${with_.size ? `<p>With: ${[...with_].map(personName).map(esc).join(', ')}</p>` : ''}
      <p class="muted">${s ? `Updated ${fmtWhen(Date.parse(s.updated_at))}` : ''}</p>
    </div>`;
  }).join('');
}

function eventLine(e) {
  return `${fmtTime(Date.parse(e.start))} to ${fmtTime(Date.parse(e.end))} · ${esc(e.room)}`;
}

function viewNow() {
  const evs = agreedEvents().filter(e => isRunning(e));
  return `<h1>Right now</h1><p class="muted">${fmtWhen(now())}</p>` + (evs.length ? evs.map(e => {
    const going = goingTo(e.id);
    return `<div class="card">
      <div class="name">${esc(e.title)}</div>
      <p class="muted">${eventLine(e)}</p>
      <p>Going: ${going.length ? going.map(personName).map(esc).join(', ') : 'No one yet'}</p>
    </div>`;
  }).join('') : '<p>No agreed event is running now.</p>');
}

function goingButton(e) {
  const on = isGoing(session.person_id, e.id);
  return `<button data-act="attend" data-id="${e.id}" data-on="${on ? 1 : 0}" class="${on ? 'on' : ''}">${on ? 'Going' : 'Mark going'}</button>`;
}

function dayTabs(days, cur, act) {
  return `<div class="seg">${days.map(d => `<button data-act="${act}" data-day="${d}" class="${d === cur ? 'on' : ''}">${fmtDay(d)}</button>`).join('')}</div>`;
}

function viewSchedule() {
  const days = [...new Set(schedule.map(e => e.day))];
  if (ui.addOpen) {
    const day = ui.addDay || days[0];
    const agreedIds = new Set(cache?.data.agreed.map(a => a.event_id));
    return `<div class="top"><h1>Add event</h1><button data-act="addclose">Done</button></div>
      <p class="muted">Student and Premier events only.</p>
      ${dayTabs(days, day, 'addday')}
      ${schedule.filter(e => e.day === day).map(e => `<div class="row">
        <div>${esc(e.title)}</div><p class="muted">${eventLine(e)}</p>
        ${agreedIds.has(e.id) ? '<p class="muted">Agreed</p>' : `<button data-act="add" data-id="${e.id}">Add</button>`}
      </div>`).join('')}`;
  }
  const evs = agreedEvents();
  const byDay = days.map(d => [d, evs.filter(e => e.day === d)]).filter(([, l]) => l.length);
  return `<div class="top"><h1>Agreed schedule</h1><button class="primary" data-act="addopen">Add event</button></div>
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
  return cache ? cache.data.status.filter(s => s.room_id === roomId) : [];
}

function viewMap() {
  const lv = ui.mapLevel;
  const levels = [['1', 'Level 1'], ['2', 'Level 2'], ['3', 'Level 3'], ['none', 'Not on plan']];
  let body;
  if (lv === 'none') {
    body = `<p class="muted">Not on the floor plan. Position unknown.</p>
      <div class="grid">${rooms.filter(r => r.level === 'none').map(r => {
        const n = peopleIn(r.id).length;
        return `<button class="offplan ${ui.mapRoom === r.id ? 'sel' : ''}" data-act="room" data-id="${r.id}">${esc(r.short)}${n ? ` (${n})` : ''}</button>`;
      }).join('')}</div>`;
  } else {
    const rs = rooms.filter(r => r.level === lv);
    const h = Math.max(...rs.map(r => r.y + r.h)) + 10;
    body = `<svg viewBox="0 0 320 ${h}" role="img" aria-label="Level ${lv} schematic">
      ${rs.map(r => {
        const n = peopleIn(r.id).length;
        const words = r.short.split(', ');
        return `<g data-act="room" data-id="${r.id}">
          <rect class="room ${ui.mapRoom === r.id ? 'sel' : ''}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="4" data-act="room" data-id="${r.id}"></rect>
          ${words.map((w, i) => `<text x="${r.x + 5}" y="${r.y + 14 + i * 12}">${esc(w)}</text>`).join('')}
          ${n ? `<circle class="count" cx="${r.x + r.w - 12}" cy="${r.y + r.h - 12}" r="9"></circle>
          <text class="count-text" x="${r.x + r.w - 12}" y="${r.y + r.h - 8.5}" text-anchor="middle">${n}</text>` : ''}
        </g>`;
      }).join('')}
    </svg>`;
  }
  let panel = '';
  const r = ui.mapRoom && roomById(ui.mapRoom);
  if (r) {
    const here = peopleIn(r.id);
    const evs = agreedEvents().filter(e => isRunning(e) && roomForEvent(e) === r.id);
    panel = `<div class="card">
      <div class="name">${esc(r.label)}</div>
      <p>Agreed event now: ${evs.length ? evs.map(e => esc(e.title)).join('; ') : 'None'}</p>
      ${here.length ? here.map(s => `<div class="top row"><span>${esc(personName(s.person_id))}</span><span>${badge(s)}</span></div>`).join('') : '<p>No one marked here.</p>'}
    </div>`;
  }
  return `<h1>Map</h1>
    <p class="muted">Schematic. Not to scale. Positions are approximate.</p>
    <div class="seg">${levels.map(([k, l]) => `<button data-act="level" data-level="${k}" class="${k === lv ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${body}${panel}`;
}

function viewMe() {
  const me = session.person_id;
  const s = statusOf(me);
  const groups = [['1', 'Level 1'], ['2', 'Level 2'], ['3', 'Level 3'], ['none', 'Other']];
  const today = chicagoDay(now());
  const todays = agreedEvents().filter(e => e.day === today);
  return `<h1>My status</h1>
    <p>${badge(s)} ${s ? `<span class="muted">Updated ${fmtWhen(Date.parse(s.updated_at))}</span>` : ''}</p>
    <h2>Where am I?</h2>
    <select id="room" data-act="room-set" aria-label="Room">
      <option value="">Pick a room</option>
      ${groups.map(([k, l]) => `<optgroup label="${l}">${rooms.filter(r => r.level === k).map(r =>
        `<option value="${r.id}" ${s?.room_id === r.id ? 'selected' : ''}>${esc(r.short)}</option>`).join('')}</optgroup>`).join('')}
    </select>
    <p><button data-act="still" ${s ? '' : 'disabled'}>Still here</button></p>
    <h2>Live location</h2>
    <p class="muted">Only while this page is open and this is on. Shows At GRB or Away from GRB. Your room is still the one you pick.</p>
    <button data-act="live" class="${live.watchId !== null ? 'on' : ''}">${live.watchId !== null ? 'Sharing live. Tap to stop' : 'Share live location'}</button>
    ${live.error ? `<p class="err">${esc(live.error)}</p>` : ''}
    <h2>My events today</h2>
    ${todays.length ? todays.map(e => `<div class="row"><div>${esc(e.title)}</div><p class="muted">${eventLine(e)}</p>${goingButton(e)}</div>`).join('') : '<p>No agreed events today.</p>'}
    <h2>Signed in as ${esc(session.name)}</h2>
    <button data-act="signout">Sign out</button>`;
}

// ---------- render ----------
const VIEWS = { friends: viewFriends, now: viewNow, map: viewMap, schedule: viewSchedule, me: viewMe };
function route() { const r = location.hash.slice(1); return VIEWS[r] ? r : 'friends'; }

function render() {
  renderSync();
  if (!session) {
    const code = document.getElementById('code')?.value || '';
    $tabs.hidden = true; $view.innerHTML = viewSignIn();
    document.getElementById('code').value = code;
    return;
  }
  $tabs.hidden = false;
  const r = route();
  $tabs.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + r));
  if (document.activeElement?.id === 'room') return; // don't close an open picker
  const msg = ui.msg ? `<p class="err">${esc(ui.msg)}</p>` : '';
  $view.innerHTML = msg + VIEWS[r]();
}

// ---------- actions ----------
function setStatus(roomId, mode) {
  queue('set_status', {
    p_room: roomId, p_mode: mode,
    p_note: mode === 'live' ? live.note : null,
    p_client_ts: new Date().toISOString()
  });
}

function startLive() {
  if (!navigator.geolocation) { live.error = 'Location not available on this device.'; return render(); }
  if (!statusOf(session.person_id)) { live.error = 'Pick your room first.'; return render(); }
  live.error = '';
  live.watchId = navigator.geolocation.watchPosition(pos => {
    const first = live.note === null;
    live.note = distanceM(pos.coords.latitude, pos.coords.longitude) <= GRB.radiusM ? 'At GRB' : 'Away from GRB';
    if (first) beat();
  }, err => {
    live.error = err.code === 1 ? 'Location permission denied.' : 'Could not get location.';
    stopLive(false);
  }, { enableHighAccuracy: false, maximumAge: 60000, timeout: 30000 });
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
  live.watchId = null; live.timer = null; live.note = null;
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
  location.hash = '';
  render();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act !== 'pick') ui.msg = '';
  if (act === 'pick') { ui.signName = el.dataset.name; render(); }
  else if (act === 'attend') queue('set_attendance', { p_event: el.dataset.id, p_attending: el.dataset.on !== '1' });
  else if (act === 'add') queue('add_agreed', { p_event: el.dataset.id });
  else if (act === 'addopen') { ui.addOpen = true; render(); scrollTo(0, 0); }
  else if (act === 'addclose') { ui.addOpen = false; render(); }
  else if (act === 'addday') { ui.addDay = el.dataset.day; render(); }
  else if (act === 'level') { ui.mapLevel = el.dataset.level; ui.mapRoom = null; render(); }
  else if (act === 'room') { ui.mapRoom = el.dataset.id; render(); }
  else if (act === 'still') { const s = statusOf(session.person_id); if (s) setStatus(s.room_id, live.watchId !== null ? 'live' : 'manual'); }
  else if (act === 'live') live.watchId !== null ? stopLive() : startLive();
  else if (act === 'signout') signOut(false);
});

document.addEventListener('change', e => {
  if (e.target.id === 'room' && e.target.value) {
    const v = e.target.value;
    e.target.blur();
    setStatus(v, live.watchId !== null ? 'live' : 'manual');
  }
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.dataset.act !== 'signin' || !ui.signName) return;
  const code = document.getElementById('code').value;
  ui.msg = '';
  try {
    const r = await api('sign_in', { p_name: ui.signName, p_code: code });
    session = { token: r.token, person_id: r.person_id, name: ui.signName };
    save('wa_session', session);
    net.ok = true;
    location.hash = '#friends';
    await sync();
  } catch (err) {
    ui.msg = err.setup ? 'Cannot reach the group server. Close and reopen the page.' :
      err.network ? 'No connection. Sign in needs a connection.' : err.message === 'wrong code' ? 'Wrong group code.' : err.message;
    render();
  }
});

window.addEventListener('hashchange', () => { ui.addOpen = false; render(); scrollTo(0, 0); });
window.addEventListener('online', sync);
window.addEventListener('offline', () => { net.ok = false; render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(() => { if (!document.hidden) sync(); }, POLL_MS);
setInterval(() => { if (!document.hidden) render(); }, 30000); // keep times and Right now current

// ---------- start ----------
(async () => {
  const get = p => fetch(p).then(r => { if (!r.ok) throw new Error(p); return r.json(); });
  try { [schedule, rooms] = await Promise.all([get('data/schedule.json'), get('data/rooms.json')]); }
  catch { $view.innerHTML = '<p>Could not load the schedule. Connect once to load.</p>'; return; }
  render();
  sync();
  try { if (session && sessionStorage.getItem('wa_live')) startLive(); } catch {}
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
