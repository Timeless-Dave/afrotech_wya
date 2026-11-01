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
const $install = document.getElementById('install');

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
  phoneDraft: null, code: '', signName: null, showCode: false, editCode: false,
  sel: new Set(), ring: null, ribbonPaused: load('wa_ribbon_paused', false)
};
let notifyOn = load('wa_notify', true);
let deferredInstall = null;

(function bootQuery() {
  const q = new URLSearchParams(location.search);
  const c = q.get('code');
  if (!c) return;
  ui.code = c;
  save('wa_group_code', c);
  // Keep the code out of the address bar so it is not shared by accident.
  q.delete('code');
  const rest = q.toString();
  try { history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch {}
})();
const savedCode = () => ui.code || load('wa_group_code', '') || '';
function inviteLink() {
  const c = load('wa_group_code', '');
  return c ? `${location.origin}${location.pathname}?code=${encodeURIComponent(c)}` : '';
}
function listNames(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} & ${names.length - 2} more`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

function clientId() {
  let c = load('wa_client', null);
  if (!c?.id) {
    c = { id: typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
    save('wa_client', c);
  }
  return c.id;
}
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIosInstall() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
async function showFriendNotification(title, body, tag, force = false) {
  if (!(notifyOn || force) || !('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, icon: 'assets/icon-192.png', badge: 'assets/icon-192.png', tag, data: { url: './#friends' } };
  if (force) { opts.requireInteraction = true; opts.vibrate = [300, 120, 300, 120, 600]; opts.renotify = true; }
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, opts);
  } catch {
    try { new Notification(title, opts); } catch {}
  }
}
function pingNotify(oldData, newData) {
  if (!session || !notifyOn || Notification.permission !== 'granted' || !newData?.people) return;
  const me = session.person_id;
  const onFriends = (location.hash || '').includes('friends');
  for (const p of newData.people) {
    if (p.id === me) continue;
    const ns = newData.status.find(s => s.person_id === p.id);
    const os = oldData?.status?.find(s => s.person_id === p.id);
    if (!ns || isStale(ns)) continue;
    if (os && os.room_id === ns.room_id && os.updated_at === ns.updated_at && os.place_label === ns.place_label) continue;
    if (document.visibilityState === 'visible' && onFriends) continue;
    showFriendNotification(`${p.name} updated`, placeText(ns), `friend-${p.id}`);
  }
}
async function askNotify() {
  if (!('Notification' in window)) { ui.note = 'This browser does not support alerts. Add the app to your Home Screen first.'; return false; }
  if (Notification.permission === 'granted') { notifyOn = true; save('wa_notify', true); return true; }
  if (Notification.permission === 'denied') { ui.note = 'Notifications are blocked in browser settings.'; return false; }
  const p = await Notification.requestPermission();
  notifyOn = p === 'granted';
  save('wa_notify', notifyOn);
  if (!notifyOn) ui.note = 'Alerts stay off. You can turn them on later from Me.';
  return notifyOn;
}
async function installPwa() {
  if (isIosInstall()) {
    ui.note = 'On iPhone: tap Share, then Add to Home Screen.';
    render();
    return;
  }
  if (!deferredInstall) {
    ui.note = 'Install is not available here yet. Try Chrome, Edge, or Android Chrome.';
    render();
    return;
  }
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  updateInstallBar();
  render();
}
function updateInstallBar() {
  if (!$install) return;
  if (isStandalone()) { $install.hidden = true; return; }
  if (load('wa_install_dismiss', false) && !deferredInstall) { $install.hidden = true; return; }
  if (deferredInstall) {
    $install.hidden = false;
    $install.innerHTML = `<p><strong>Get the app</strong><br><span>Full screen, faster check-ins.</span></p><div class="actions"><button type="button" class="primary" data-act="install-pwa">Install</button><button type="button" class="x" data-act="dismiss-install" aria-label="Not now">×</button></div>`;
    return;
  }
  if (isIosInstall() && session) {
    $install.hidden = false;
    $install.innerHTML = `<p><strong>Get the app</strong><br><span>Tap Share, then Add to Home Screen.</span></p><div class="actions"><button type="button" data-act="dismiss-install">Got it</button></div>`;
    return;
  }
  $install.hidden = true;
}

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
function ago(t) {
  const m = Math.round((now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return fmtWhen(t);
}
const ICONS = {
  star: '<path d="m12 3.2 2.7 5.5 6 .9-4.35 4.25 1.03 6L12 17l-5.38 2.85 1.03-6L3.3 9.6l6-.9z"/>',
  map: '<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z"/><path d="M9 4v14M15 6v14"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  phone: '<path d="M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1.5 1.5 0 0 1-1.5 1.5A15.5 15.5 0 0 1 3.5 5.5 1.5 1.5 0 0 1 5 4z"/>',
  sms: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.5"/>',
  live: '<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/>',
  users: '<path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19"/><circle cx="10" cy="7.5" r="3.5"/><path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.1a3.5 3.5 0 0 1 0 6.8"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12"/>'
};
const ico = name => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const initials = n => String(n || '?').replace(/^Ms\.\s*/, '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
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
    const oldData = cache?.data;
    const data = await api('get_state', { p_token: session.token });
    pingNotify(oldData, data);
    cache = { data, syncedAt: Date.now() };
    save('wa_state', cache);
    net.ok = true; net.error = '';
    await checkRings(data);
  } catch (e) {
    if (e.auth) { signOut(true); ui.msg = 'Session expired. Join again.'; }
    net.ok = false; net.error = e.message;
  } finally {
    syncing = false;
    render();
  }
}

let ringsOk = true;
async function checkRings(data) {
  if (!ringsOk || !session) return;
  const since = load('wa_ring_seen', null);
  if (!since) { save('wa_ring_seen', data?.server_time || new Date().toISOString()); return; }
  try {
    const list = await api('get_rings', { p_token: session.token, p_since: since });
    if (!list?.length) return;
    save('wa_ring_seen', list[list.length - 1].created_at);
    onRing(list);
  } catch (e) {
    if (!e.network && !e.auth && missingFn(e, 'get_rings')) ringsOk = false;
  }
}
function onRing(list) {
  const from = [...new Set(list.map(r => r.from_id))];
  ui.ring = { from, at: Date.now() };
  const names = listNames(from.map(personName));
  try { navigator.vibrate?.([300, 120, 300, 120, 600]); } catch {}
  ringTone();
  if (document.hidden) {
    const s = from.length === 1 ? statusOf(from[0]) : null;
    showFriendNotification(`${names} ${from.length > 1 ? 'are' : 'is'} ringing you`, s ? placeText(s) : 'Open the app to find them.', 'ring', true);
  }
}
function ringTone() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = ringTone.ctx || (ringTone.ctx = new AC());
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      const at = t + i * 0.28;
      o.type = 'sine';
      o.frequency.value = i % 2 ? 660 : 880;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
      o.connect(g).connect(ctx.destination);
      o.start(at);
      o.stop(at + 0.26);
    }
  } catch {}
}
async function ringPeople(ids) {
  ids = ids.filter(id => id !== session?.person_id);
  if (!ids.length) return;
  const names = listNames(ids.map(personName));
  try {
    const n = await api('send_ring', { p_token: session.token, p_to: ids });
    ui.note = n ? `Ringing ${names}. Their phone buzzes with an alert.` : `You just rang ${names}. Give it a few seconds.`;
    ui.sel.clear();
  } catch (e) {
    ui.msg = e.network ? 'No connection. Ringing needs a connection.'
      : missingFn(e, 'send_ring') ? 'Ringing is not on the server yet. Run supabase/ring.sql in Supabase.' : shortErr(e);
  }
  render();
}

const $ribbon = document.getElementById('ribbon');
const $ringbar = document.getElementById('ringbar');
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function shortPlace(s) {
  const id = String(s.room_id || '');
  if (id.startsWith('level-')) return `Level ${id.slice(6)}`;
  return s.place_label || roomById(id)?.short || roomName(id);
}
function agoShort(t) {
  const m = Math.round((now() - t) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}
function ribbonItems() {
  if (!cache || !session) return [];
  const groups = new Map();
  for (const s of cache.data.status) {
    if (s.person_id === session.person_id || isStale(s)) continue;
    const g = groups.get(s.room_id) || { room: s.room_id, ids: [], s, latest: 0, pin: false };
    g.ids.push(s.person_id);
    const t = Date.parse(s.updated_at);
    if (t > g.latest) { g.latest = t; g.s = s; }
    g.pin = g.pin || !!s.meet_pin;
    groups.set(s.room_id, g);
  }
  return [...groups.values()].sort((a, b) => (b.pin - a.pin) || (b.latest - a.latest));
}
function renderRibbon() {
  if (!$ribbon) return;
  if (!session || !cache) { $ribbon.hidden = true; ui._ribbonKey = ''; return; }
  $ribbon.hidden = false;
  const items = ribbonItems();
  const one = items.length ? items.map(g => `<button type="button" class="rib-item${g.pin ? ' pin' : ''}" data-act="goto-room" data-id="${esc(g.room)}" title="Open on the map">${g.pin ? ico('pin') : '<i class="dot"></i>'}<b>${esc(listNames(g.ids.map(personName)))}</b><span>${esc(shortPlace(g.s))}${g.pin ? ' · meet here' : ''}</span><em>${esc(agoShort(g.latest))}</em></button>`).join('')
    : `<a class="rib-item" href="#me"><i class="dot idle"></i><span>No fresh check-ins yet. Tap to share your spot.</span></a>`;
  const paused = ui.ribbonPaused || reduceMotion;
  const key = `${one}|${paused}|${innerWidth}`;
  if (key === ui._ribbonKey) return;
  ui._ribbonKey = key;
  const vp = $ribbon.querySelector('.rib-viewport');
  const track = $ribbon.querySelector('.rib-track');
  const btn = $ribbon.querySelector('.rib-label');
  btn.innerHTML = `${ico(paused ? 'play' : 'pause')}<span>Live</span>`;
  btn.setAttribute('aria-label', paused ? 'Play the live ticker' : 'Pause the live ticker');
  btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
  track.innerHTML = `<div class="rib-copy">${one}</div>`;
  const copyW = track.firstElementChild.scrollWidth;
  const moving = items.length > 0 && !paused && copyW > vp.clientWidth;
  if (moving) {
    track.insertAdjacentHTML('beforeend', `<div class="rib-copy" aria-hidden="true">${one.replace(/<button /g, '<button tabindex="-1" ')}</div>`);
    track.style.setProperty('--dur', `${Math.max(12, copyW / 45)}s`);
  }
  $ribbon.classList.toggle('moving', moving);
  $ribbon.classList.toggle('paused', paused);
}
function syncHeadHeight() {
  const h = document.querySelector('.appbar')?.offsetHeight;
  if (h && h !== ui._headH) { ui._headH = h; document.documentElement.style.setProperty('--head-h', h + 'px'); }
}
window.addEventListener('resize', () => { ui._ribbonKey = ''; renderRibbon(); syncHeadHeight(); });
function renderRingbar() {
  if (!$ringbar) return;
  const r = ui.ring;
  if (r && Date.now() - r.at > 10 * 60000) ui.ring = null;
  if (!ui.ring || !session || !cache) { $ringbar.hidden = true; return; }
  const people = r.from.map(id => cache.data.people.find(p => p.id === id)).filter(Boolean);
  if (!people.length) { $ringbar.hidden = true; return; }
  const first = people[0];
  const s = statusOf(first.id);
  const num = people.length === 1 ? numberFor(first) : null;
  const names = listNames(people.map(p => personName(p.id)));
  $ringbar.hidden = false;
  $ringbar.innerHTML = `<div class="ringbar-in">
      <span class="ring-ico">${ico('bell')}</span>
      <div class="grow"><strong>${esc(names)} ${people.length > 1 ? 'are' : 'is'} ringing you</strong><small>${s ? esc(placeText(s)) : 'No check-in yet'} · ${esc(ago(r.at))}</small></div>
    </div>
    <div class="ringbar-actions">
      ${s ? `<button type="button" class="sm primary" data-act="goto-room" data-id="${esc(s.room_id)}">${ico('map')}<span>Go to ${people.length > 1 ? 'them' : esc(first.name)}</span></button>` : ''}
      ${num ? `<a class="btn sm" href="tel:${esc(telHref(num.n))}">${ico('phone')}<span>Call</span></a>` : ''}
      <button type="button" class="sm" data-act="ring-back">${ico('bell')}<span>Ring back</span></button>
      <button type="button" class="sm ghost" data-act="ring-dismiss" aria-label="Dismiss">×</button>
    </div>`;
}

function renderSync() {
  const put = (short, full, cls) => {
    $sync.innerHTML = short ? `<span>${esc(short)}</span>` : '';
    $sync.title = full || '';
    $sync.className = 'sync' + (cls ? ' ' + cls : '');
  };
  if (!session) return net.ok ? put('', '', '') : put('Offline', 'Offline', 'offline');
  const n = outbox.length;
  const waiting = n ? ` · ${n} waiting` : '';
  const waitingFull = n ? ` · ${n} change${n > 1 ? 's' : ''} waiting` : '';
  const at = cache?.syncedAt ? fmtTime(cache.syncedAt) : 'never';
  let short, full, cls = '';
  if (!net.ok || !navigator.onLine) {
    short = 'Offline'; cls = 'offline';
    full = cache ? `Offline. Showing saved ${at}` : 'Offline. No saved data yet';
  } else if (cache && Date.now() - cache.syncedAt < POLL_MS * 2) { short = 'Live'; full = `Live · synced ${at}`; }
  else { short = `Synced ${at}`; full = `Last synced ${at}`; cls = 'idle'; }
  if (nowOverride) full += ` · test time ${fmtWhen(now())}`;
  put(short + waiting, full + waitingFull, cls);
}

let toastTimer = null;
const $toast = document.getElementById('toast');
function renderToast() {
  if (!$toast) return;
  const text = ui.msg || ui.note;
  const key = `${ui.msg ? 'e' : 'n'}:${text}`;
  if (!text) { $toast.hidden = true; ui._toast = ''; clearTimeout(toastTimer); return; }
  if (ui._toast === key) return;
  ui._toast = key;
  $toast.hidden = false;
  $toast.className = 'toast' + (ui.msg ? ' err' : '');
  $toast.innerHTML = `<p>${esc(text)}</p><button type="button" data-act="toast-close" aria-label="Dismiss">×</button>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.msg = ''; ui.note = ''; renderToast(); }, ui.msg ? 8000 : 5000);
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
const personName = id => {
  const p = cache?.data?.people?.find(x => x.id === id);
  if (!p) return '?';
  const dup = cache.data.people.filter(x => x.name === p.name).length > 1;
  return dup ? `${p.name} (#${p.id})` : p.name;
};
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
  const parts = levelTxt && String(name).startsWith(levelTxt) ? [name] : [levelTxt, name];
  return `${unknown}${parts.filter(Boolean).join(' · ')}${approx}`;
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
  if (!s) return '<span class="badges"><span class="badge stale">No status</span></span>';
  const kind = s.mode === 'live' && !isStale(s) ? '<span class="badge live">Live</span>' : s.mode === 'live' ? '<span class="badge">Live</span>' : '<span class="badge">Manual</span>';
  return `<span class="badges">${kind}${isStale(s) ? '<span class="badge stale">Stale</span>' : ''}${s.meet_pin ? '<span class="badge pin">Meet here</span>' : ''}</span>`;
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
  return callText(href, got.local ? '<span class="muted">On this device only</span>' : '');
}
function callText(href, extra = '') {
  return `<div class="actions"><a class="btn sm" href="tel:${esc(href)}">${ico('phone')}<span>Call</span></a><a class="btn sm" href="sms:${esc(href)}">${ico('sms')}<span>Text</span></a>${extra}</div>`;
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
  const name = ui.signName ?? (load('wa_last_name', '') || '');
  const known = !!savedCode() && !ui.editCode;
  const codeField = known
    ? `<div class="code-ok">${ico('check')}<span>Group code saved on this phone</span><button type="button" class="sm ghost" data-act="edit-code">Change</button></div>`
    : `<div class="field"><label for="code">Group code</label>
        <div class="pw">
          <input id="code" type="${ui.showCode ? 'text' : 'password'}" autocomplete="off" autocapitalize="off" spellcheck="false" required value="${esc(ui.code || '')}" placeholder="From your group chat" enterkeyhint="go">
          <button type="button" class="pw-toggle" data-act="toggle-code" aria-pressed="${ui.showCode ? 'true' : 'false'}" aria-label="${ui.showCode ? 'Hide' : 'Show'} group code">${ui.showCode ? 'Hide' : 'Show'}</button>
        </div>
        <p class="muted">Opened the invite link from your group chat? The code fills in by itself.</p>
      </div>`;
  const wait = pendingPair() ? '<p class="hint">A pair link is waiting. Join, then accept it on Crew.</p>' : '';
  return `<h1>Join your crew</h1>
    <p class="lead">Use the name your friends know. It stays on this phone until you log out. Add a last initial if your name is common.</p>
    ${wait}
    <div class="card">
      <form data-act="signin">
        <label class="field"><span>Your name</span>
          <input id="name" required autocomplete="nickname" maxlength="40" value="${esc(name)}" placeholder="First name or nickname" enterkeyhint="next">
        </label>
        ${codeField}
        <button type="submit" class="primary block">Continue</button>
      </form>
    </div>
    <h2>School crew quick pick</h2>
    <p class="muted">Tap your name. Tap it again to clear it.</p>
    <div class="roster">${ROSTER.map(n => `<button type="button" data-act="pick" data-name="${esc(n)}" class="${n === name ? 'on' : ''}">${esc(n)}</button>`).join('')}</div>`;
}

function onboardCard() {
  if (load('wa_onboarded', false) || !session) return '';
  return `<div class="card onboard">
    <p><strong>Quick start</strong></p>
    <ol>
      <li><a href="#me">Me</a> — pick your floor and room. Tap <strong>Still here</strong> when you stay put.</li>
      <li><a href="#friends">Friends</a> — see everyone on the link. It refreshes about every 12 seconds.</li>
      <li><a href="#crew">Crew</a> — pair to call and text. Turn on alerts on <a href="#me">Me</a>.</li>
    </ol>
    <button type="button" class="sm" data-act="dismiss-onboard">Got it</button>
  </div>`;
}

function personRow(p, extra = '') {
  const s = statusOf(p.id), stale = isStale(s);
  const evs = currentEventsOf(p.id);
  const with_ = new Set();
  if (s && !stale && !NO_GROUP_ROOMS.includes(s.room_id)) {
    cache.data.status.forEach(o => { if (o.person_id !== p.id && o.room_id === s.room_id && !isStale(o)) with_.add(o.person_id); });
  }
  evs.forEach(e => goingTo(e.id).forEach(id => { if (id !== p.id) with_.add(id); }));
  const isMe = p.id === session.person_id;
  const live = s && s.mode === 'live' && !stale;
  const sel = ui.sel.has(p.id);
  const pick = isMe ? '' : ` data-act="sel" data-id="${p.id}" role="button" tabindex="0" aria-pressed="${sel ? 'true' : 'false'}" aria-label="${sel ? 'Unselect' : 'Select'} ${esc(p.name)}"`;
  return `<div class="row${isMe ? ' me' : ''}${sel ? ' selected' : ''}">
    <div class="person${isMe ? '' : ' pickable'}"${pick}>
      <div class="avatar${live ? ' live' : ''}${!s || stale ? ' stale' : ''}" aria-hidden="true">${sel ? `<svg viewBox="0 0 24 24">${ICONS.check}</svg>` : esc(initials(p.name))}</div>
      <div class="person-body">
        <div class="top"><span class="name">${esc(personName(p.id))}${isMe ? ' <span class="muted">(you)</span>' : ''}</span>${badge(s)}</div>
        <p class="place${stale ? ' stale-text' : ''}">${s ? esc(placeText(s)) : 'Not set'}${s?.mode === 'live' && s.live_note ? ` · ${esc(s.live_note)}` : ''}</p>
        ${evs.length ? `<p class="muted">In: ${evs.map(e => esc(e.title)).join('; ')}</p>` : ''}
        ${with_.size ? `<p class="muted">With: ${[...with_].map(personName).map(esc).join(', ')}</p>` : ''}
        ${s ? `<p class="when">Updated ${esc(ago(Date.parse(s.updated_at)))}</p>` : ''}
      </div>
    </div>
    <div class="person-actions">${isMe ? `<div class="actions"><a class="btn sm" href="#me">${ico('pin')}<span>Update my spot</span></a></div>` : phoneLinks(p)}${extra}</div>
  </div>`;
}
function selBar() {
  if (!session || !cache) return '';
  ui.sel.forEach(id => { if (!cache.data.people.some(p => p.id === id)) ui.sel.delete(id); });
  if (!ui.sel.size) return '';
  const ppl = [...ui.sel].map(id => cache.data.people.find(p => p.id === id)).filter(Boolean);
  const nums = ppl.map(numberFor).filter(Boolean).map(x => telHref(x.n)).filter(Boolean);
  const smsHref = nums.length ? (isIosInstall() ? `sms:/open?addresses=${nums.join(',')}` : `sms:${nums.join(',')}`) : '';
  const one = ppl.length === 1 && nums.length === 1 ? nums[0] : '';
  const others = cache.data.people.filter(p => p.id !== session.person_id).length;
  return `<div class="selbar" role="region" aria-label="Selected people">
    <div class="selbar-top">
      <strong>${esc(listNames(ppl.map(p => p.name)))}</strong>
      ${ui.sel.size < others ? '<button type="button" class="sm ghost" data-act="sel-all">All</button>' : ''}
      <button type="button" class="sm ghost" data-act="sel-clear">Clear</button>
    </div>
    <div class="selbar-actions">
      <button type="button" class="primary" data-act="ring">${ico('bell')}<span>Ring</span></button>
      ${smsHref ? `<a class="btn" href="${esc(smsHref)}">${ico('sms')}<span>Text${nums.length < ppl.length ? ` (${nums.length})` : ''}</span></a>` : `<button type="button" disabled title="Pair on Crew to text">${ico('sms')}<span>Text</span></button>`}
      ${one ? `<a class="btn" href="tel:${esc(one)}">${ico('phone')}<span>Call</span></a>` : ''}
    </div>
    ${nums.length < ppl.length ? '<p class="selbar-note">Text and Call need a pairing. Ring works for everyone.</p>' : ''}
  </div>`;
}

function viewFriends() {
  const head = `<div class="page-head"><h1>Where are my friends?</h1><a class="btn sm" href="#crew">${ico('users')}<span>Crew</span></a></div>`;
  if (!cache) return `${head}<p class="empty">No data yet. Connect once to load.</p>`;
  const same = cache.data.same_names || [];
  const dupMe = same.includes(session.name);
  const warn = dupMe ? `<p class="conflict">More than one person is using “${esc(session.name)}”. You show as ${esc(personName(session.person_id))}. Re-join with a clearer name if friends get confused.</p>` : '';
  const people = [...cache.data.people].sort((a, b) => {
    if (a.id === session.person_id) return -1;
    if (b.id === session.person_id) return 1;
    const sa = statusOf(a.id), sb = statusOf(b.id);
    const fa = sa && !isStale(sa), fb = sb && !isStale(sb);
    if (fa !== fb) return fa ? -1 : 1;
    return String(sb?.updated_at || '').localeCompare(String(sa?.updated_at || ''));
  });
  const fresh = people.filter(p => { const s = statusOf(p.id); return s && !isStale(s); }).length;
  return `${onboardCard()}${head}
    <p class="lead">${people.length} on the link · ${fresh} checked in recently</p>
    ${warn}
    ${people.length > 1 && !ui.sel.size ? '<p class="hint">Tap people to select them, then Ring, Text, or Call. Tap again to unselect.</p>' : ''}
    ${people.map(p => personRow(p)).join('')}
    <p class="muted">Call and Text show up for people you pair with on <a href="#crew">Crew</a>.</p>
    ${selBar()}`;
}

function eventLine(e) {
  return `${fmtTime(Date.parse(e.start))} to ${fmtTime(Date.parse(e.end))} · ${esc(e.room)}`;
}
function card(it) {
  const on = stars.has(it.key);
  const conflicts = on ? itemConflicts(it, starredItems()) : [];
  const link = it.url ? safeUrl(it.url) : '';
  const place = it.roomId ? placeBits(it.roomId) : (it.venue || it.room || 'Place not listed');
  const tags = [
    it.track,
    priceLine(it),
    ...(it.levels?.length ? [`Ticket: ${it.levels.join(', ')}`] : []),
    ...(it.tags || [])
  ].filter(Boolean);
  return `<div class="row">
    <div class="top">
      <div>
        <div class="name">${esc(it.title)}</div>
        ${it.host ? `<p class="muted">${esc(it.host)}</p>` : ''}
      </div>
      <button class="star-btn ${on ? 'on' : ''}" data-act="star" data-key="${esc(it.key)}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${on ? 'Remove star' : 'Star'}: ${esc(it.title)}" title="${on ? 'Starred' : 'Star'}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.star}</svg></button>
    </div>
    <div class="meta">
      <span>${it.day ? esc(fmtDay(it.day)) + ' · ' : ''}${esc(whenLine(it))}</span>
      <span>${esc(place)}</span>
    </div>
    ${tags.length ? `<div class="tags">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${it.speakers?.length ? `<p class="desc">Speakers: ${esc(it.speakers.join(', '))}</p>` : ''}
    ${(it.offerings || []).map(o => `<p class="desc">${esc(o.kind)} · ${esc(o.certainty)}${o.quote ? `: ${esc(o.quote)}` : ''}</p>`).join('')}
    ${it.accessNote ? `<p class="muted">${esc(it.accessNote)}</p>` : ''}
    ${it.hasFood ? '<p class="muted">Listed on the free food page too.</p>' : ''}
    ${conflicts.length ? `<p class="conflict">Overlaps ${conflicts.map(c => esc(c.title)).join('; ')}</p>` : ''}
    ${it.roomId || link ? `<div class="actions">
      ${it.roomId ? `<button class="sm" data-act="goto-room" data-id="${esc(it.roomId)}">${ico('map')}<span>Map</span></button>` : ''}
      ${link ? `<a class="btn sm" href="${link}" target="_blank" rel="noopener noreferrer">${ico('ext')}<span>Details</span></a>` : ''}
    </div>` : ''}
  </div>`;
}
function dayButtons(days, cur, act) {
  return `<div class="chips" data-chips="${esc(act)}">${days.map(d => `<button data-act="${act}" data-day="${esc(d)}" class="${d === cur ? 'on' : ''}">${d === 'all' ? 'All days' : fmtDay(d)}</button>`).join('')}</div>`;
}
function toggleBtn(act, on, label) {
  return `<button class="toggle ${on ? 'on' : ''}" data-act="${act}" aria-pressed="${on ? 'true' : 'false'}"><span class="box"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.check}</svg></span>${esc(label)}</button>`;
}
function segBar() {
  const segs = [['now', 'Now / Next'], ['agenda', 'Agenda'], ['starred', 'My schedule'], ['events', 'Side events'], ['food', 'Free food'], ['recruiters', 'Recruiters'], ['companies', 'Companies']];
  return `<div class="chips sticky" data-chips="seg">${segs.map(([k, l]) => {
    const n = k === 'starred' && stars.size ? ` <span class="count-pill">${stars.size}</span>` : '';
    return `<button data-act="seg" data-seg="${k}" class="${ui.seg === k && !ui.q.trim() ? 'on' : ''}">${l}${n}</button>`;
  }).join('')}</div>`;
}
function sourcesFooter() {
  const src = guideMeta.sources || [];
  if (!src.length) return '';
  return `<div class="footer-src"><details class="about"><summary>Sources and data</summary><ul class="src">${src.map(s => {
    const href = s.url ? safeUrl(s.url) : '';
    const name = href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>` : esc(s.name);
    return `<li>${name}. ${esc(s.note || '')}</li>`;
  }).join('')}</ul>
    <p class="muted">Saved ${esc(guideMeta.generated || '')}. ${esc(guideMeta.sessions || '')} official sessions, ${esc(guideMeta.events || '')} side events. Times are America/Chicago. The live agenda can change.</p></details></div>`;
}
const emptyBox = t => `<p class="empty">${t}</p>`;
function viewAgendaNow() {
  const pool = guidePool();
  const mine = pool.filter(it => stars.has(it.key));
  const nowMine = happening(mine);
  const nextMine = upcoming(mine);
  const nowAll = happening(pool);
  const nextAll = upcoming(sessionsFull);
  const shown = ui.showAll ? nowAll : nowAll.slice(0, 8);
  const block = (title, list, empty, total = list.length) => `<h2>${title}${total ? ` <span class="count-pill">${total}</span>` : ''}</h2>${list.length ? `<div class="cards">${list.map(card).join('')}</div>` : emptyBox(empty)}`;
  const agreed = session ? agreedEvents().filter(e => isRunning(e)) : [];
  const agreedHtml = session && agreed.length ? `<h2>Group plan right now</h2>${agreed.map(e => {
    const going = goingTo(e.id);
    return `<div class="card"><div class="name">${esc(e.title)}</div><p class="muted">${eventLine(e)}</p><p class="desc">Going: ${going.length ? going.map(personName).map(esc).join(', ') : 'No one yet'}</p></div>`;
  }).join('')}` : '';
  return `<p class="muted">${fmtWhen(now())} · Chicago time</p>`
    + agreedHtml
    + block('Starred now', nowMine, 'Nothing you starred is on right now.')
    + block('Starred next', nextMine, 'No starred item is coming up. Tap the star on anything to save it.')
    + block('On now', shown, 'Nothing in the saved guide is on at this time.', nowAll.length)
    + (nowAll.length > 8 && !ui.showAll ? `<p><button class="block" data-act="showall">Show all ${nowAll.length} on now</button></p>` : '')
    + block('Next on the official agenda', nextAll, 'No later official session in the saved agenda.');
}
function viewAgenda() {
  if (!sessionsFull.length) return emptyBox('Agenda file missing. Run npm run build:guide.');
  const days = [...new Set(sessionsFull.map(s => s.day))];
  if (!days.includes(ui.day)) ui.day = pickDay(days);
  let list = sessionsFull.filter(s => s.day === ui.day).map(s => ({ ...s, kind: 'session' }));
  if (ui.studentOnly) list = list.filter(s => !s.levels?.length || s.levels.includes('Student'));
  return `${dayButtons(days, ui.day, 'day')}
    <div class="filters">${toggleBtn('student', ui.studentOnly, 'Student tickets only')}<span class="muted">${list.length} sessions</span></div>
    <div class="cards">${list.map(card).join('')}</div>`;
}
function viewEvents() {
  const days = [...new Set(partnerEvents.map(e => e.day).filter(Boolean))];
  if (!days.includes(ui.eventDay)) ui.eventDay = pickDay(days);
  let list = partnerEvents.filter(e => e.day === ui.eventDay).map(e => ({ ...e, kind: 'event' }));
  if (ui.eventsFood) list = list.filter(looksLikeFood);
  return `${dayButtons(days, ui.eventDay, 'evday')}
    <div class="filters">${toggleBtn('eventsfood', ui.eventsFood, 'Food and drinks')}<span class="muted">${list.length} events</span></div>
    <p class="muted">Partner and community events for Nov 1–7. Confirm the link before you go.</p>
    <div class="cards">${list.map(card).join('')}</div>${list.length ? '' : emptyBox('Nothing in this filter.')}`;
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
    <div class="cards">${list.map(f => card({ ...f, kind: 'food' })).join('')}</div>${list.length ? '' : emptyBox('Nothing in this filter.')}`;
}
function boothBtn(num) {
  return session && num ? `<button class="sm" data-act="booth-here" data-num="${esc(num)}">${ico('pin')}<span>I'm here</span></button>` : '';
}
function viewRecruiters() {
  const rows = [...recruiters].sort((a, b) => a.company.localeCompare(b.company) || a.person.localeCompare(b.person));
  return `<p class="muted">Name, company, booth, and the post the booth came from. Booth spots are not on the GRB plan.</p>
    <div class="cards">${rows.map(r => {
      const href = r.link ? safeUrl(r.link) : '';
      return `<div class="row">
        <div class="name">${esc(r.person)}</div>
        <div class="meta"><span>${esc(r.company)}${r.boothNum ? ` · Booth ${esc(r.boothNum)}` : ''}</span>${r.role ? `<span>${esc(r.role)}</span>` : ''}${r.booth ? `<span>${esc(r.booth)}</span>` : ''}</div>
        ${href || (session && r.boothNum) ? `<div class="actions">
          ${href ? `<a class="btn sm" href="${href}" target="_blank" rel="noopener noreferrer">${ico('ext')}<span>Post</span></a>` : ''}
          ${boothBtn(r.boothNum)}
        </div>` : ''}
      </div>`;
    }).join('')}</div>`;
}
function viewCompanies() {
  let list = [...companies];
  if (ui.boothsOnly) list = list.filter(c => c.boothNum);
  return `<div class="filters">${toggleBtn('booths-toggle', ui.boothsOnly, 'With a booth number')}<span class="muted">${list.length} companies</span></div>
    <p class="muted">Search finds the rest by name.</p>
    <div class="cards">${list.map(c => {
      const href = c.careers ? safeUrl(c.careers) : '';
      const guide = c.guide ? safeUrl(c.guide) : '';
      return `<div class="row">
        <div class="name">${esc(c.name)}</div>
        <div class="meta"><span>${c.boothNum ? `Booth ${esc(c.boothNum)} · approximate` : 'No booth number in the saved list'}${c.sponsor ? ' · sponsor' : ''}</span></div>
        ${c.roles?.length ? `<div class="tags">${c.roles.slice(0, 4).map(r => `<span class="tag">${esc(r)}</span>`).join('')}</div>` : ''}
        ${href || guide || (session && c.boothNum) ? `<div class="actions">
          ${href ? `<a class="btn sm" href="${href}" target="_blank" rel="noopener noreferrer">${ico('ext')}<span>Careers</span></a>` : ''}
          ${guide ? `<a class="btn sm" href="${guide}" target="_blank" rel="noopener noreferrer">${ico('ext')}<span>Guide</span></a>` : ''}
          ${boothBtn(c.boothNum)}
        </div>` : ''}
      </div>`;
    }).join('')}</div>`;
}
function viewStarred() {
  const items = starredItems();
  const overlapping = items.filter(it => itemConflicts(it, items).length);
  const byDay = [...new Set(items.map(it => it.day || 'unscheduled'))];
  return `<p class="muted">Stored on this phone only. Overlaps use the saved start and end.</p>
    ${overlapping.length ? `<p class="conflict">${overlapping.length} starred ${overlapping.length > 1 ? 'items overlap' : 'item overlaps another'}.</p>` : ''}
    ${items.length ? byDay.map(d => `<h2>${d === 'unscheduled' ? 'Time not listed' : fmtDay(d)}</h2><div class="cards">${items.filter(it => (it.day || 'unscheduled') === d).map(card).join('')}</div>`).join('') : emptyBox('No stars yet. Tap the star on a session, side event, or food stop.')}`;
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
  const block = (title, pack, draw) => pack.n ? `<h2>${title} <span class="count-pill">${pack.n}</span></h2><div class="cards">${pack.rows.map(draw).join('')}</div>${pack.n > pack.rows.length ? '<p class="muted">Showing the first 30.</p>' : ''}` : '';
  const body = [
    block('Sessions', ss, s => card({ ...s, kind: 'session' })),
    block('Side events', ev, e => card({ ...e, kind: 'event' })),
    block('Free food', fd, f => card({ ...f, kind: 'food' })),
    block('Recruiters', rc, r => `<div class="row"><div class="name">${esc(r.person)}</div><div class="meta"><span>${esc(r.company)}${r.boothNum ? ` · Booth ${esc(r.boothNum)}` : ''}</span></div>${r.boothNum && session ? `<div class="actions">${boothBtn(r.boothNum)}</div>` : ''}</div>`),
    block('Companies', co, c => `<div class="row"><div class="name">${esc(c.name)}</div><div class="meta"><span>${c.boothNum ? `Booth ${esc(c.boothNum)}` : 'No booth number'}</span></div>${c.boothNum && session ? `<div class="actions">${boothBtn(c.boothNum)}</div>` : ''}</div>`)
  ].join('');
  return body || emptyBox(`No matches for “${esc(q)}”.`);
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
    <form data-act="search" role="search" class="searchbox">
      ${ico('search')}
      <input id="q" type="search" enterkeyhint="search" value="${esc(ui.q)}" autocomplete="off" placeholder="Search sessions, events, companies" aria-label="Search sessions, events, and companies">
      ${ui.q ? '<button type="button" class="clear" data-act="clear-q" aria-label="Clear search">×</button>' : ''}
    </form>
    ${segBar()}
    ${body}
    ${sourcesFooter()}`;
}

function viewNow() {
  return `<h1>Now / Next</h1>${viewAgendaNow()}
    ${session ? '' : '<p class="hint"><a href="#signin">Join</a> to see the group’s agreed plan.</p>'}`;
}

function goingButton(e) {
  const on = isGoing(session.person_id, e.id);
  return `<button data-act="attend" data-id="${esc(e.id)}" data-on="${on ? 1 : 0}" class="sm ${on ? 'on' : ''}" aria-pressed="${on ? 'true' : 'false'}">${on ? `${ico('check')}<span>Going</span>` : 'Mark going'}</button>`;
}
function dayTabs(days, cur, act) {
  return dayButtons(days, cur, act);
}
function viewSchedule() {
  const days = [...new Set(schedule.map(e => e.day))];
  if (ui.addOpen) {
    const day = ui.addDay || days[0];
    const agreedIds = new Set(cache?.data.agreed.map(a => a.event_id));
    return `<div class="page-head"><h1>Add event</h1><button class="sm primary" data-act="addclose">Done</button></div>
      <p class="muted">Student and Premiere events only, through Thu Nov 5 at noon.</p>
      ${dayTabs(days, day, 'addday')}
      ${schedule.filter(e => e.day === day).map(e => `<div class="row">
        <div class="top"><div><div class="name">${esc(e.title)}</div><p class="muted">${eventLine(e)}</p></div>
        ${agreedIds.has(e.id) ? `<span class="badge live">Added</span>` : `<button class="sm" data-act="add" data-id="${esc(e.id)}">${ico('plus')}<span>Add</span></button>`}</div>
      </div>`).join('')}`;
  }
  const evs = agreedEvents();
  const byDay = days.map(d => [d, evs.filter(e => e.day === d)]).filter(([, l]) => l.length);
  return `<div class="page-head"><h1>Group plan</h1><button class="sm primary" data-act="addopen">${ico('plus')}<span>Add event</span></button></div>
    <p class="lead">The events the group agreed on. Your personal stars live in <a href="#guide">Guide</a> › My schedule.</p>
    ${byDay.length ? '' : emptyBox('No agreed events yet. Tap Add event to start the plan.')}
    ${byDay.map(([d, l]) => `<h2>${fmtDay(d)}</h2>` + l.map(e => {
      const going = goingTo(e.id);
      return `<div class="row">
        <div class="top"><div class="name">${esc(e.title)}</div>${isRunning(e) ? '<span class="badges"><span class="badge live">Now</span></span>' : ''}</div>
        <div class="meta"><span>${eventLine(e)}</span><span>Going: ${going.length ? going.map(personName).map(esc).join(', ') : 'No one yet'}</span></div>
        <div class="actions">${goingButton(e)}${roomForEvent(e) ? `<button class="sm" data-act="goto-room" data-id="${esc(roomForEvent(e))}">${ico('map')}<span>Map</span></button>` : ''}</div>
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
// Re-packs the schematic so each row of rooms is only as tall as its labels need.
function compactRooms(drawn) {
  const rows = [...new Set(drawn.map(r => r.y))].sort((a, b) => a - b);
  const list = [];
  let y = 6;
  for (const ry of rows) {
    const inRow = drawn.filter(r => r.y === ry).map(r => {
      const badge = peopleIn(r.id).length ? 20 : 0;
      return { ...r, lines: wrapLabel(r.short.replace(/, approx$/, ''), Math.max(6, Math.floor((r.w - 10 - badge) / 5.5))) };
    });
    const h = Math.max(28, ...inRow.map(r => 9 + r.lines.length * 12 + 2), ...inRow.map(r => peopleIn(r.id).some(s => s.meet_pin) && peopleIn(r.id).length ? 36 : 0));
    inRow.forEach(r => list.push({ ...r, y, h }));
    y += h + 5;
  }
  return { list, height: y + 1 };
}
function uniqCompanies(names) {
  const seen = new Set();
  return names.filter(c => {
    const k = c.replace(/\s*\(.*?\)\s*/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function tile(id, title, sub, n) {
  return `<button class="tile ${n ? 'has' : ''} ${ui.mapRoom === id ? 'sel' : ''}" data-act="room" data-id="${esc(id)}"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}${n ? `<em>${n}</em>` : ''}</button>`;
}
function viewMap() {
  const lv = ui.mapLevel;
  const levels = [['1', 'Level 1'], ['2', 'Level 2'], ['3', 'Level 3'], ['none', 'Off plan']];
  const drawn = rooms.filter(r => r.level === lv && r.x != null && r.y != null);
  let body;
  if (!drawn.length) {
    body = `<p class="muted">${lv === 'none' ? 'These names are not placed on a floor. Tap one to see who is there.' : 'No drawn rooms on this level.'}</p>`;
  } else {
    const { list, height } = compactRooms(drawn);
    body = `<div class="map-wrap"><svg viewBox="0 0 360 ${height}" role="img" aria-label="${lv === 'none' ? 'Off plan' : 'Level ' + lv} schematic">
      ${list.map(r => {
        const here = peopleIn(r.id);
        const n = here.length;
        const pin = here.some(s => s.meet_pin);
        const avail = r.w - 10 - (n || pin ? 20 : 0);
        return `<g>
          <rect class="room ${r.certainty === 'approximate' ? 'approx' : ''} ${n ? 'has' : ''} ${ui.mapRoom === r.id ? 'sel' : ''}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" data-act="room" data-id="${esc(r.id)}"><title>${esc(r.short)}</title></rect>
          ${r.lines.map((w, i) => `<text x="${r.x + 5}" y="${r.y + 14 + i * 12}"${w.length * 5.5 > avail ? ` textLength="${avail}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(w)}</text>`).join('')}
          ${n ? `<circle class="count" cx="${r.x + r.w - 11}" cy="${r.y + 11}" r="8"></circle>
            <text class="count-text" x="${r.x + r.w - 11}" y="${r.y + 14}" text-anchor="middle">${n}</text>` : ''}
          ${pin ? `<circle class="pin" cx="${r.x + r.w - 11}" cy="${r.y + (n ? 27 : 11)}" r="5"></circle>` : ''}
        </g>`;
      }).join('')}
    </svg>
    <div class="map-legend"><span><i></i>On GRB plan</span><span><i class="d"></i>Approximate</span><span><i class="c"></i>People here</span><span><i class="p"></i>Meet pin</span></div></div>
    <p class="muted">Tap a room to see who is there or drop a meet pin.</p>`;
  }
  const loose = (cache?.data?.status || []).filter(s => {
    if (String(s.room_id).startsWith('booth-')) return false;
    const r = roomById(s.room_id);
    if (r && r.x != null && r.level === lv) return false;
    const level = s.level && s.level !== 'off' ? s.level : (r && r.level !== 'none' ? r.level : 'none');
    return level === lv;
  });
  const boothList = lv === '1' ? `<h2>Booths</h2>
    <p class="muted">From recruiter and company posts. Booth spots are not on the GRB plan.</p>
    <div class="tiles">${booths.map(b => tile(b.roomId, b.num, uniqCompanies(b.companies).join(', '), peopleIn(b.roomId).length)).join('')}</div>` : '';
  const extraRooms = rooms.filter(r => r.level === lv && r.x == null && !String(r.id).startsWith('level-'));
  const extra = extraRooms.length ? `${drawn.length ? '<h2>Not drawn</h2>' : ''}<div class="tiles wide">${extraRooms.map(r => tile(r.id, r.short, '', peopleIn(r.id).length)).join('')}</div>` : '';
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
    const imHere = mine && mine.room_id === r.id;
    const anim = ui._sheet !== r.id ? '' : ' style="animation:none"';
    ui._sheet = r.id;
    panel = `<div class="sheet-backdrop" data-act="room-close"${anim}></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(r.label || r.short)}"${anim}>
      <div class="grab" aria-hidden="true"></div>
      <div class="top"><div class="name">${esc(r.label || r.short)}</div><button type="button" class="close" data-act="room-close" aria-label="Close">×</button></div>
      ${r.note ? `<p class="muted">${esc(r.note)}</p>` : ''}
      ${evs.length ? `<p class="desc"><strong>Group plan now:</strong> ${evs.map(e => esc(e.title)).join('; ')}</p>` : ''}
      <h2>Here now <span class="count-pill">${here.length}</span></h2>
      ${here.length ? here.map(s => `<div class="sub-row"><div class="top"><span class="name">${esc(personName(s.person_id))}</span>${badge(s)}</div><p class="muted">Updated ${esc(ago(Date.parse(s.updated_at)))}</p>${phoneLinks(cache.data.people.find(p => p.id === s.person_id))}</div>`).join('') : '<p class="muted">No one checked in here.</p>'}
      ${session ? `<div class="btn-row">
        <button data-act="checkin-room" data-id="${esc(r.id)}" class="${imHere ? 'on' : ''}" ${imHere ? 'disabled' : ''}>${ico('pin')}<span>${imHere ? 'You are here' : "I'm here"}</span></button>
        <button data-act="meet" data-id="${esc(r.id)}" data-on="${pinned ? 1 : 0}" class="${pinned ? '' : 'primary'}">${pinned ? 'Clear meet pin' : 'Meet me here'}</button>
      </div>` : '<p class="hint"><a href="#signin">Join</a> to check in or drop a meet pin.</p>'}
    </div>`;
  } else ui._sheet = null;
  const looseHtml = loose.length ? `<h2>Checked in, not inside a drawn room</h2>` + loose.map(s =>
    `<div class="row"><div class="top"><span class="name">${esc(personName(s.person_id))}</span>${badge(s)}</div><p>${esc(placeText(s))}</p><p class="muted">Updated ${esc(ago(Date.parse(s.updated_at)))}</p></div>`).join('') : '';
  const levelNote = lv === '1' ? 'Halls are drawn A to E in the order on the GRB plan. That is not a compass heading.'
    : lv === '2' ? 'Avenida is balcony C South. McKinney is C North. Walker is the balcony lettered B. Conference rooms 212–215 are also on this level and are not drawn.'
    : lv === '3' ? 'Halls, the ballroom, and meeting rooms are grouped by type. Adjacency on this drawing is not measured.' : '';
  return `<h1>Map</h1>
    <div class="seg">${levels.map(([k, l]) => `<button data-act="level" data-level="${k}" class="${k === lv ? 'on' : ''}">${l}</button>`).join('')}</div>
    <details class="about"><summary>About this map</summary>
      <p>George R. Brown Convention Center. Schematic, not to scale. Solid rooms are named on the GRB floor plan. Dashed rooms are AfroTech names and their position is approximate. <a href="https://www.grbhouston.com/planners/floor-plans/" target="_blank" rel="noopener noreferrer">Official plans</a>.</p>
      <p>${FLOOR_HONEST}</p>
      ${levelNote ? `<p>${levelNote}</p>` : ''}
    </details>
    ${body}${extra}${boothList}${looseHtml}${panel}`;
}

function roomChoices(selected) {
  const groups = [['1', 'Level 1'], ['2', 'Level 2'], ['3', 'Level 3'], ['none', 'Other']];
  return `<label class="field"><span>Room</span><select id="room" aria-label="Room"><option value="">Pick a room</option>${groups.map(([k, l]) =>
    `<optgroup label="${l}">${rooms.filter(r => r.level === k).map(r => {
      const tag = r.certainty === 'approximate' ? ' (approx.)' : r.certainty === 'unknown' ? ' (floor unknown)' : '';
      return `<option value="${esc(r.id)}" ${selected === r.id ? 'selected' : ''}>${esc(r.short)}${tag}</option>`;
    }).join('')}</optgroup>`).join('')}</select></label>`;
}
function altHint() {
  if (live.watchId === null && live.altitude == null) return '';
  if (live.altitude == null) return 'This phone did not share altitude. That is common indoors. Confirm the level yourself.';
  return `Phone altitude about ${Math.round(live.altitude)} m. Hint only, not a floor.`;
}
function statusCard() {
  const s = statusOf(session.person_id);
  const sharing = live.watchId !== null;
  return `<div class="card status-card">
    <div class="top"><span class="muted">My spot</span>${badge(s)}</div>
    <p class="place-big">${s ? esc(placeText(s)) : 'No check-in yet'}</p>
    <p class="muted">${s ? `Updated ${esc(ago(Date.parse(s.updated_at)))}` : 'Pick a level or room below.'}</p>
    <div class="btn-row">
      <button data-act="still" ${s ? '' : 'disabled'}>${ico('refresh')}<span>Still here</span></button>
      <button data-act="live" class="${sharing ? 'on' : ''}" aria-pressed="${sharing ? 'true' : 'false'}">${ico('live')}<span>${sharing ? 'Stop sharing' : 'Share live'}</span></button>
    </div>
    ${altHint() ? `<p class="muted">${esc(altHint())}</p>` : ''}
    ${live.error ? `<p class="err">${esc(live.error)}</p>` : ''}
  </div>`;
}
function checkinCard() {
  const s = statusOf(session.person_id);
  const curLevel = s?.level || roomById(s?.room_id)?.level || '';
  return `<div class="card">
    <div class="name">Check in</div>
    <p class="muted">Set your floor, then your room if you know it.</p>
    <div class="seg">
      ${['1', '2', '3'].map(l => `<button data-act="set-level" data-level="${l}" class="${curLevel === l ? 'on' : ''}">Level ${l}</button>`).join('')}
    </div>
    ${roomChoices(s?.room_id)}
    <form data-act="booth" class="inline-form">
      <label class="field"><span>Booth number</span>
        <input id="booth" inputmode="numeric" placeholder="e.g. 812" autocomplete="off" enterkeyhint="done">
      </label>
      <button>Check in</button>
    </form>
    <details class="about"><summary>Why can't GPS find my floor?</summary><p>${FLOOR_HONEST}</p><p>Live sharing works only while this page is open. The server stores “At GRB” or “Away from GRB”, not a coordinate.</p></details>
  </div>`;
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
  const locals = LOCAL_NAMES.map(name => {
    const n = localPhone(name);
    return n ? { label: name === 'David' ? 'David (Timeless)' : name, phone: n } : null;
  }).filter(Boolean);
  const wait = pendingPair();
  return `<h1>Crew</h1>
    <p class="lead">Pair with friends to see each other’s number and call or text from the app.</p>
    ${crewReady ? '' : '<p class="conflict">Pairing is not on this server yet. Run supabase/crew.sql in the Supabase SQL editor. The guide, map, and group tracker still work.</p>'}
    ${inviteLink() ? `<div class="card">
      <div class="name">Invite to the group</div>
      <p class="muted">This link fills in the group code, so friends only type their name.</p>
      <div class="actions"><button class="sm primary" data-act="share-invite">${ico('share')}<span>Share invite</span></button><button class="sm" data-act="copy-invite">${ico('copy')}<span>Copy</span></button></div>
    </div>` : ''}
    ${wait ? `<div class="card"><p><strong>A pair link is waiting.</strong></p><div class="btn-row"><button class="primary" data-act="accept-pending">Accept</button><button data-act="dismiss-pair">Not now</button></div></div>` : ''}
    <div class="card">
      <div class="name">Your pair code</div>
      ${code ? `<p class="codebig">${esc(code)}</p><p class="linkline">${esc(link)}</p>
        <div class="actions"><button class="sm primary" data-act="share-pair">${ico('share')}<span>Share</span></button><button class="sm" data-act="copy-pair">${ico('copy')}<span>Copy link</span></button><button class="sm ghost" data-act="make-pair">New code</button></div>`
        : '<p class="muted">Make a link and send it to a friend.</p><button class="primary block" data-act="make-pair">Create a pair link</button>'}
      <p class="muted">A new link turns the old one off. Anyone with the link can pair until it expires (7 days).</p>
    </div>
    <div class="card">
      <div class="name">Got a friend’s code?</div>
      <form data-act="pair" class="inline-form">
        <label class="field"><span class="muted">Their code</span>
          <input id="pair-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste code" enterkeyhint="done">
        </label>
        <button class="primary">Accept</button>
      </form>
    </div>
    <div class="card">
      <div class="name">My number</div>
      <form data-act="phone" class="inline-form">
        <label class="field"><span class="muted">Phone</span>
          <input id="phone" type="tel" autocomplete="tel" inputmode="tel" value="${esc(phoneShown)}" placeholder="+1 555 0100" enterkeyhint="done">
        </label>
        <button class="primary">Save</button>
      </form>
      <p class="muted">Only people you pair with can see it. Leave it blank and save to clear it.</p>
    </div>
    <h2>Paired <span class="count-pill">${paired.length}</span></h2>
    ${paired.length ? paired.map(p => personRow(p, `<div class="actions"><button class="sm ghost" data-act="unpair" data-id="${p.id}">Unpair</button></div>`)).join('') : emptyBox('No one paired yet.')}
    ${locals.length ? `<h2>Private list on this device</h2><p class="muted">From config.local.js. These numbers stay on this device. They are not uploaded.</p>${locals.map(row => {
      const href = telHref(row.phone);
      return `<div class="row"><div class="name">${esc(row.label)}</div>${callText(href)}</div>`;
    }).join('')}` : ''}
    ${selBar()}`;
}

function viewMe() {
  const today = chicagoDay(now());
  const todays = agreedEvents().filter(e => e.day === today);
  const notifyOk = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  const alertsOn = notifyOn && notifyOk;
  return `<div class="page-head"><h1>Me</h1><span class="muted">${esc(session.name)}${session.name === 'David' ? ' (Timeless)' : ''}</span></div>
    ${statusCard()}
    ${checkinCard()}
    <h2>My events today</h2>
    ${todays.length ? todays.map(e => `<div class="row"><div class="name">${esc(e.title)}</div><p class="muted">${eventLine(e)}</p><div class="actions">${goingButton(e)}</div></div>`).join('') : emptyBox('No agreed events today.')}
    <a class="list-link" href="#crew">${ico('users')}<span class="grow"><strong>Crew and pairing</strong><small>Share numbers to call and text</small></span><span class="chev" aria-hidden="true">›</span></a>
    <h2>Settings</h2>
    <div class="card">
      <div class="top"><div><strong>Check-in alerts</strong><p class="muted">Ping when someone updates their spot.</p></div>
        <button type="button" class="sm ${alertsOn ? 'on' : ''}" data-act="notify-toggle" aria-pressed="${alertsOn ? 'true' : 'false'}">${alertsOn ? 'On' : 'Turn on'}</button></div>
      ${isStandalone() ? '' : `<div class="top sub-row"><div><strong>Add to Home Screen</strong><p class="muted">Full screen and quicker check-ins.</p></div>
        <button type="button" class="sm" data-act="install-pwa">Install</button></div>`}
    </div>
    <div class="card">
      <p class="muted">Joined as <strong>${esc(session.name)}</strong>. Log out before handing your phone to someone else.</p>
      <button type="button" class="block" data-act="signout">Log out</button>
    </div>`;
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
    ? ['friends', 'guide', 'map', 'schedule', 'me']
    : ['guide', 'map', 'signin'];
  $tabs.hidden = false;
  const r = route();
  const active = { now: 'guide', crew: signed ? 'friends' : 'signin' }[r] || r;
  document.body.classList.toggle('no-hero', signed || !(r === 'guide' || r === 'signin' || r === 'now'));
  $tabs.querySelectorAll('a').forEach(a => {
    const id = a.getAttribute('href').slice(1);
    a.hidden = !show.includes(id);
    const on = id === active;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
function snapshotFields(active) {
  const q = document.getElementById('q');
  if (q) ui.q = q.value;
  const phone = document.getElementById('phone');
  if (phone) ui.phoneDraft = phone.value;
  const code = document.getElementById('code');
  if (code) ui.code = code.value;
  const name = document.getElementById('name');
  if (name) ui.signName = name.value;
  ui._drafts = {};
  ['booth', 'pair-in'].forEach(id => { const el = document.getElementById(id); if (el && el.value) ui._drafts[id] = el.value; });
  ui._chips = {};
  $view.querySelectorAll('.chips[data-chips]').forEach(el => { ui._chips[el.dataset.chips] = el.scrollLeft; });
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
  const sameRoute = ui._route === r;
  ui._route = r;
  $view.innerHTML = VIEWS[r]();
  for (const [id, v] of Object.entries(ui._drafts || {})) {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = v;
  }
  $view.querySelectorAll('.chips[data-chips]').forEach(el => {
    const saved = sameRoute ? ui._chips?.[el.dataset.chips] : undefined;
    const on = el.querySelector('.on');
    if (saved != null) el.scrollLeft = saved;
    if (on) {
      const l = on.offsetLeft - el.offsetLeft, rgt = l + on.offsetWidth;
      if (l < el.scrollLeft + 16 || rgt > el.scrollLeft + el.clientWidth - 16) el.scrollLeft = l - (el.clientWidth - on.offsetWidth) / 2;
    }
  });
  document.body.classList.toggle('sheet-open', !!$view.querySelector('.sheet'));
  document.body.classList.toggle('has-selbar', !!$view.querySelector('.selbar'));
  renderToast();
  renderRibbon();
  renderRingbar();
  syncHeadHeight();
  if (ui._keep) {
    const el = document.getElementById(ui._keep);
    if (el) {
      el.focus();
      if (ui._caret != null && el.setSelectionRange) {
        try { el.setSelectionRange(ui._caret, ui._caret); } catch {}
      }
    }
  }
  updateInstallBar();
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
  ui.note = extra.toast || `Checked in: ${label}`;
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
  ui.sel.clear(); ui.ring = null;
  ['wa_session', 'wa_state', 'wa_outbox', 'wa_ring_seen'].forEach(k => { try { localStorage.removeItem(k); } catch {} });
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
  if (act === 'pick') {
    const nameEl = document.getElementById('name');
    const cur = (nameEl?.value ?? ui.signName ?? '').trim();
    const next = cur === el.dataset.name ? '' : el.dataset.name;
    ui.signName = next;
    if (nameEl) nameEl.value = next;
    render();
    const code = document.getElementById('code');
    if (next && code && !code.value) code.focus();
  }
  else if (act === 'toggle-code') { ui.showCode = !ui.showCode; render(); document.getElementById('code')?.focus(); }
  else if (act === 'edit-code') { ui.editCode = true; ui.code = ''; render(); document.getElementById('code')?.focus(); }
  else if (act === 'sel') {
    const id = +el.dataset.id;
    if (ui.sel.has(id)) ui.sel.delete(id); else ui.sel.add(id);
    render();
  }
  else if (act === 'sel-all') { cache?.data.people.forEach(p => { if (p.id !== session.person_id) ui.sel.add(p.id); }); render(); }
  else if (act === 'sel-clear') { ui.sel.clear(); render(); }
  else if (act === 'ring') ringPeople([...ui.sel]);
  else if (act === 'ring-back') { const ids = ui.ring?.from || []; ui.ring = null; ringPeople(ids); }
  else if (act === 'ring-dismiss') { ui.ring = null; render(); }
  else if (act === 'ribbon-pause') { ui.ribbonPaused = !ui.ribbonPaused; save('wa_ribbon_paused', ui.ribbonPaused); render(); }
  else if (act === 'share-invite' || act === 'copy-invite') {
    const link = inviteLink();
    if (!link) return;
    const job = act === 'share-invite' && navigator.share
      ? navigator.share({ title: 'Where Are You · AfroTech crew', text: 'Join our AfroTech crew:', url: link }).then(() => 'Invite shared.')
      : (navigator.clipboard ? navigator.clipboard.writeText(link).then(() => 'Invite link copied.') : Promise.reject());
    job.then(m => { ui.note = m; render(); }).catch(() => { ui.note = link; render(); });
  }
  else if (act === 'toast-close') renderToast();
  else if (act === 'clear-q') { ui.q = ''; const q = document.getElementById('q'); if (q) q.value = ''; render(); document.getElementById('q')?.focus(); }
  else if (act === 'room-close') { ui.mapRoom = null; render(); }
  else if (act === 'checkin-room') setCheckin(el.dataset.id, { meet: false });
  else if (act === 'attend') queue('set_attendance', { p_event: el.dataset.id, p_attending: el.dataset.on !== '1' });
  else if (act === 'add') queue('add_agreed', { p_event: el.dataset.id });
  else if (act === 'addopen') { ui.addOpen = true; render(); scrollTo(0, 0); }
  else if (act === 'addclose') { ui.addOpen = false; render(); }
  else if (act === 'addday') { ui.addDay = el.dataset.day; render(); }
  else if (act === 'level') { ui.mapLevel = el.dataset.level; ui.mapRoom = null; render(); }
  else if (act === 'room') { ui.mapRoom = el.dataset.id; render(); }
  else if (act === 'still') {
    const s = statusOf(session.person_id);
    if (s) setCheckin(s.room_id, { meet: !!s.meet_pin, level: s.level, label: s.place_label, toast: 'Still here. Your time is updated.' });
  }
  else if (act === 'live') live.watchId !== null ? stopLive() : startLive();
  else if (act === 'signout') signOut(false);
  else if (act === 'install-pwa') installPwa();
  else if (act === 'dismiss-install') { save('wa_install_dismiss', true); updateInstallBar(); render(); }
  else if (act === 'dismiss-onboard') { save('wa_onboarded', true); render(); }
  else if (act === 'notify-toggle') { askNotify().then(() => render()); }
  else if (act === 'star') toggleStar(el.dataset.key);
  else if (act === 'seg') {
    ui.seg = el.dataset.seg; ui.showAll = false; ui.q = '';
    const q = document.getElementById('q'); if (q) q.value = '';
    render();
    const sb = document.querySelector('.searchbox');
    if (sb) {
      const top = sb.getBoundingClientRect().bottom + scrollY - document.querySelector('.appbar').offsetHeight - 8;
      if (scrollY > top) scrollTo(0, top);
    }
  }
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
    if (el.closest('#ringbar')) ui.ring = null;
    ui.mapRoom = el.dataset.id;
    ui.mapLevel = String(el.dataset.id).startsWith('booth-') ? '1' : room && room.level !== 'none' ? room.level : 'none';
    if (location.hash === '#map') render();
    else { ui._keepRoom = true; location.hash = '#map'; }
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
      toast: on ? 'Meet pin cleared.' : `Meet pin dropped at ${room?.short || roomName(id)}.`,
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
    const nameEl = document.getElementById('name');
    const name = (nameEl?.value || ui.signName || '').trim();
    const codeEl = document.getElementById('code');
    const code = codeEl ? codeEl.value : savedCode();
    ui.code = code;
    ui.signName = name;
    ui.msg = '';
    if (!name) { ui.msg = 'Enter your name.'; render(); return; }
    try {
      const r = await api('sign_in', { p_name: name, p_code: code, p_client_id: clientId() });
      session = { token: r.token, person_id: r.person_id, name: r.name || name };
      save('wa_session', session);
      save('wa_last_name', session.name);
      save('wa_group_code', code);
      ui.editCode = false;
      net.ok = true;
      if (notifyOn && 'Notification' in window) await askNotify();
      location.hash = pendingPair() ? '#crew' : '#friends';
      await sync();
    } catch (err) {
      if (err.message === 'wrong code') { save('wa_group_code', ''); ui.code = ''; ui.editCode = true; }
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
  if (!ui._keepRoom) ui.mapRoom = null;
  const nr = route();
  if (nr !== 'friends' && nr !== 'crew') ui.sel.clear();
  ui._keepRoom = false;
  render();
  scrollTo(0, 0);
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-act="sel"]')) { e.preventDefault(); e.target.click(); return; }
  if (e.key === 'Escape' && ui.mapRoom && route() === 'map') { ui.mapRoom = null; render(); }
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

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  updateInstallBar();
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  updateInstallBar();
});

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
  updateInstallBar();
  try { if (session && sessionStorage.getItem('wa_live')) startLive(); } catch {}
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
