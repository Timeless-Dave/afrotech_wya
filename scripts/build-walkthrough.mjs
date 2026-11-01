// Builds the "How it works" screenshots (annotated) and the captioned tour video.
// Needs a FRESH local dev server (npm run dev) so names have no #ids, Chrome, and ffmpeg.
// Usage: CHROME="/path/to/chrome" node scripts/build-walkthrough.mjs
// Output: assets/walkthrough/*.webp, tour.mp4, tour-poster.webp
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:8080/';
const OUT = 'assets/walkthrough';
const TMP = `${OUT}/.tmp`;
mkdirSync(TMP, { recursive: true });
const CHROME = process.env.CHROME || '/usr/bin/google-chrome-stable';
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- seed a believable crew through the same RPCs the app uses ----------
async function rpc(fn, args) {
  const r = await fetch(`${BASE}rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${t}`);
  return t ? JSON.parse(t) : null;
}
const crew = {};
for (const n of ['Jordan', 'Maya', 'Tobi', 'Sam', 'Ms. Lee', 'Nia']) crew[n] = await rpc('sign_in', { p_name: n, p_code: 'test', p_client_id: `tour-${n}` });
const at = (who, room, level, label, meet = false, mode = 'manual') => rpc('set_checkin', {
  p_token: crew[who].token, p_room: room, p_mode: mode, p_note: mode === 'live' ? 'At GRB' : null,
  p_level: level, p_label: label, p_alt: null, p_meet: meet, p_client_ts: new Date().toISOString()
});
await at('Jordan', 'booth-812', '1', 'Booth 812', false, 'live');
await at('Maya', 'hall-e', '1', 'Hall E, Main Stage', true);
await at('Tobi', 'hall-e', '1', 'Hall E, Main Stage');
await at('Sam', 'room-320', '3', 'Room 320');
await at('Ms. Lee', 'grand-lobby', '1', 'Grand Lobby');
const sched = await (await fetch(`${BASE}data/schedule.json`)).json();
for (const e of sched.slice(0, 3)) await rpc('add_agreed', { p_token: crew['Ms. Lee'].token, p_event: e.id });
await rpc('set_attendance', { p_token: crew.Maya.token, p_event: sched[0].id, p_attending: true });
await rpc('set_phone', { p_token: crew.Jordan.token, p_phone: '+1 555 0100' });

// ---------- browser ----------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const ctx = await browser.createBrowserContext();
await ctx.overridePermissions(new URL(BASE).origin, ['notifications']);
const page = await ctx.newPage();
await page.setBypassServiceWorker(true);
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('wa_install_dismiss', 'true'); localStorage.setItem('wa_onboarded', 'true'); } catch {}
});
await page.setRequestInterception(true);
page.on('request', r => {
  // Always use the local stand-in, never the production Supabase in config.js.
  if (r.url().includes('supabase.co')) return r.abort();
  if (new URL(r.url()).pathname.endsWith('/config.js')) return r.respond({ status: 200, contentType: 'text/javascript', body: "window.CONFIG={SUPABASE_URL:'',SUPABASE_ANON_KEY:'local'};" });
  r.continue();
});
page.on('pageerror', e => console.log('pageerror', e.message));

// Screenshot-only styles: freeze the ticker, hide toasts, and style the annotation layer.
const SHOT_CSS = `
  .rib-track { animation: none !important; }
  .toast { display: none !important; }
  .ring-ico, .ringbar { animation: none !important; }
  #ann { position: fixed; inset: 0; z-index: 99999; pointer-events: none; }
  #ann .box { position: fixed; border: 2.5px solid #ff4f12; background: rgba(255,79,18,.07); }
  #ann .n { position: fixed; width: 26px; height: 26px; background: #ff4f12; color: #fff; font: 800 15px/26px system-ui, sans-serif; text-align: center; box-shadow: 0 0 0 2px #fff; }
`;
async function shotMode(on) {
  await page.evaluate((css, on) => {
    let s = document.getElementById('shot-css');
    if (on && !s) { s = document.createElement('style'); s.id = 'shot-css'; s.textContent = css; document.head.append(s); }
    if (!on && s) s.remove();
    document.getElementById('ann')?.remove();
  }, SHOT_CSS, on);
}
// marks: [selector | {sel, nth, pad}] -> numbered boxes in order.
async function annotate(marks) {
  await page.evaluate(marks => {
    document.getElementById('ann')?.remove();
    const root = document.createElement('div');
    root.id = 'ann';
    marks.forEach((m, i) => {
      const spec = typeof m === 'string' ? { sel: m } : m;
      const el = [...document.querySelectorAll(spec.sel)][spec.nth || 0];
      if (!el) { console.log('missing mark ' + spec.sel); return; }
      const r = el.getBoundingClientRect();
      const pad = spec.pad ?? 4;
      const box = document.createElement('div');
      box.className = 'box';
      Object.assign(box.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      const n = document.createElement('div');
      n.className = 'n';
      n.textContent = i + 1;
      const x = Math.min(Math.max(r.left - pad - 12, 2), innerWidth - 28);
      const y = Math.min(Math.max(r.top - pad - 12, 2), innerHeight - 28);
      Object.assign(n.style, { left: `${spec.right ? Math.min(r.right + pad - 14, innerWidth - 28) : x}px`, top: `${y}px` });
      root.append(box, n);
    });
    document.body.append(root);
  }, marks);
}
async function shot(name, marks, { scrollTo } = {}) {
  await shotMode(true);
  if (scrollTo === 'BOTTOM') await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  else if (scrollTo) await page.evaluate(sel => { const el = document.querySelector(sel); if (el) { el.scrollIntoView({ block: 'start' }); scrollBy(0, -(document.querySelector('.appbar').offsetHeight + 12)); } }, scrollTo);
  await wait(250);
  await annotate(marks);
  await wait(80);
  const png = `${TMP}/${name}.png`;
  await page.screenshot({ path: png });
  await sharp(png).resize({ width: 720 }).webp({ quality: 74 }).toFile(`${OUT}/${name}.webp`);
  await shotMode(false);
  console.log('shot', name);
}
const go = async hash => { await page.evaluate(h => { location.hash = h; }, hash); await wait(500); };
const click = sel => page.evaluate(s => document.querySelector(s)?.click(), sel);
const syncNow = () => page.evaluate(() => sync());

// ---------- 1. Join ----------
await page.goto(`${BASE}?code=test#signin`, { waitUntil: 'networkidle0' });
await page.evaluate(() => { const n = document.getElementById('name'); n.value = ''; });
await page.type('#name', 'Jasmine');
await shot('01-join', ['#name', '.code-ok', 'button[type="submit"]', '.roster'], { scrollTo: 'h1' });
await click('button[type="submit"]');
await page.waitForFunction(() => location.hash === '#friends');
await wait(800);
// Pair Jasmine with Jordan so Call and Text show up like they would for paired friends.
const angelToken = await page.evaluate(() => JSON.parse(localStorage.getItem('wa_session')).token);
const pc = await rpc('create_pair_code', { p_token: crew.Jordan.token });
await rpc('accept_pair', { p_token: angelToken, p_code: pc.code });
await syncNow(); await wait(400);

// ---------- 2. Set your spot ----------
await go('#me');
await click('button[data-act="set-level"][data-level="1"]');
await wait(400);
await page.select('#room', 'hall-e');
await wait(900);
await syncNow(); await wait(400);
await page.evaluate(() => scrollTo(0, 0));
await shot('02-me', ['.status-card .place-big', '.status-card [data-act="still"]', '.status-card [data-act="live"]', '.seg', '#room', 'form[data-act="booth"]']);

// ---------- 3. Friends + ribbon ----------
await go('#friends');
await syncNow(); await wait(500);
await page.evaluate(() => scrollTo(0, 0));
await shot('03-friends', ['.rib-label', { sel: '.rib-item', nth: 0 }, '.row.me .person', { sel: '.row:not(.me) .person', nth: 0 }, { sel: '.row:not(.me) .badges', nth: 0 }, 'a.btn[href="#crew"]']);

// ---------- 4. Select + ring ----------
const pick = name => page.evaluate(n => [...document.querySelectorAll('div.person[data-act="sel"]')].find(e => e.querySelector('.name').textContent.trim() === n)?.click(), name);
await pick('Maya'); await wait(150);
await pick('Jordan'); await wait(250);
await page.evaluate(() => { const r = document.querySelector('.row.selected'); r.scrollIntoView({ block: 'start' }); scrollBy(0, -(document.querySelector('.appbar').offsetHeight + 12)); });
await shot('04-select', [{ sel: '.row.selected .person', nth: 0 }, '.selbar-top strong', '.selbar [data-act="ring"]', '.selbar-actions > :nth-child(2)', '.selbar [data-act="sel-clear"]']);
await click('.selbar [data-act="sel-clear"]'); await wait(200);

// ---------- 5. Someone rings you ----------
await rpc('send_ring', { p_token: crew.Jordan.token, p_to: [await page.evaluate(() => JSON.parse(localStorage.getItem('wa_session')).person_id)] });
await syncNow(); await wait(700);
await page.evaluate(() => scrollTo(0, 0));
await shot('05-ring', ['#ringbar .ringbar-in', '#ringbar [data-act="goto-room"]', '#ringbar a[href^="tel:"]', '#ringbar [data-act="ring-back"]']);
await click('#ringbar [data-act="ring-dismiss"]'); await wait(200);

// ---------- 6. Map ----------
await go('#map');
await page.evaluate(() => scrollTo(0, 0));
await shot('06-map', ['.seg', 'rect[data-id="hall-e"]', 'rect[data-id="grand-lobby"]', 'details.about summary']);
await page.evaluate(() => document.querySelector('rect[data-id="hall-e"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
await wait(500);
await shot('07-room', ['.sheet .top .name', '.sheet h2', '.sheet [data-act="checkin-room"]', '.sheet [data-act="meet"]', '.sheet .close']);
await click('.sheet .close'); await wait(200);
await shot('08-booths', [{ sel: '.tiles .tile', nth: 0 }, '.tiles .tile.has'], { scrollTo: '.tiles' });

// ---------- 7. Guide ----------
await go('#guide');
await click('button[data-seg="agenda"]'); await wait(300);
await click('.star-btn'); await wait(200);
await page.evaluate(() => scrollTo(0, 0));
await shot('09-guide', ['.searchbox', '.chips.sticky', { sel: '.chips[data-chips="day"]' }, '.star-btn.on', { sel: '.row [data-act="goto-room"]', nth: 0 }]);

// ---------- 8. Group plan ----------
await go('#schedule'); await syncNow(); await wait(400);
await page.evaluate(() => scrollTo(0, 0));
await shot('10-plan', ['[data-act="addopen"]', { sel: '.row .meta', nth: 0 }, { sel: '[data-act="attend"]', nth: 0 }]);

// ---------- 9. Crew ----------
await go('#crew');
await click('[data-act="make-pair"]'); await wait(900);
await shot('11-crew', ['[data-act="share-invite"]', '.codebig', '#pair-in', '#phone'], { scrollTo: '[data-act="share-invite"]' });

// ---------- 10. Settings ----------
await go('#me');
await shot('12-settings', ['[data-act="notify-toggle"]', '[data-act="install-pwa"]', '[data-act="signout"]'], { scrollTo: 'BOTTOM' });

// ---------- Tour video ----------
// Fresh viewer so the video starts at the invite link.
const vctx = await browser.createBrowserContext();
await vctx.overridePermissions(new URL(BASE).origin, ['notifications']);
const v = await vctx.newPage();
await v.setBypassServiceWorker(true);
await v.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
await v.evaluateOnNewDocument(() => { try { localStorage.setItem('wa_install_dismiss', 'true'); localStorage.setItem('wa_onboarded', 'true'); } catch {} });
await v.setRequestInterception(true);
v.on('request', r => {
  if (r.url().includes('supabase.co')) return r.abort();
  if (new URL(r.url()).pathname.endsWith('/config.js')) return r.respond({ status: 200, contentType: 'text/javascript', body: "window.CONFIG={SUPABASE_URL:'',SUPABASE_ANON_KEY:'local'};" });
  r.continue();
});
const TOUR_CSS = `
  #cap { position: fixed; left: 12px; right: 12px; top: calc(var(--head-h, 56px) + 10px); z-index: 99998; background: #ff4f12; color: #fff;
    font: 700 15px/1.3 system-ui, sans-serif; padding: 10px 14px; pointer-events: none; transition: opacity .2s; }
  #cap small { display: block; font-weight: 500; font-size: 13px; opacity: .9; margin-top: 2px; }
  .tap { position: fixed; z-index: 99999; width: 36px; height: 36px; margin: -18px 0 0 -18px; border: 3px solid #ff4f12; border-radius: 50%;
    background: rgba(255,79,18,.25); pointer-events: none; animation: tap .6s ease-out forwards; }
  @keyframes tap { from { transform: scale(.4); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
  .toast { display: none !important; }`;
const caption = (t, s = '') => v.evaluate((t, s, css) => {
  if (!document.getElementById('tour-css')) { const st = document.createElement('style'); st.id = 'tour-css'; st.textContent = css; document.head.append(st); }
  let c = document.getElementById('cap');
  if (!c) { c = document.createElement('div'); c.id = 'cap'; document.body.append(c); }
  c.innerHTML = t ? `${t}${s ? `<small>${s}</small>` : ''}` : '';
  c.style.opacity = t ? 1 : 0;
}, t, s, TOUR_CSS);
// Tap with a visible ripple, like a finger.
async function tap(target, { svg = false } = {}) {
  const pt = await v.evaluate((sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : null;
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2 };
  }, target);
  if (!pt) { console.log('tour: missing', target); return; }
  await wait(350);
  await v.evaluate(({ x, y }) => { const d = document.createElement('div'); d.className = 'tap'; d.style.left = x + 'px'; d.style.top = y + 'px'; document.body.append(d); setTimeout(() => d.remove(), 700); }, pt);
  await wait(150);
  if (svg) await v.evaluate(sel => document.querySelector(sel).dispatchEvent(new MouseEvent('click', { bubbles: true })), target);
  else await v.evaluate(sel => document.querySelector(sel).click(), target);
  await wait(500);
}
async function type(sel, text) { await v.focus(sel); for (const ch of text) { await v.keyboard.type(ch); await wait(90); } }
await v.goto(`${BASE}?code=test#signin`, { waitUntil: 'networkidle0' });
await v.evaluate(() => { document.getElementById('name').value = ''; });
// Record with real frame timestamps (Chrome only sends frames when something changes).
const cdp = await v.createCDPSession();
const frames = [];
cdp.on('Page.screencastFrame', f => {
  frames.push({ data: f.data, t: f.metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
const rec = { stop: async () => { await cdp.send('Page.stopScreencast'); } };
await caption('1 · Open the invite link', 'The group code is already filled in. Just type your name.');
await wait(1800);
await type('#name', 'Chris');
await wait(500);
await tap('button[type="submit"]');
await v.waitForFunction(() => location.hash === '#friends');
await caption('2 · See where everyone is', 'The live ribbon up top and the list update about every 12 seconds.');
await wait(3200);
await caption('3 · Set your spot', 'Tap Me, pick your floor, then your room.');
await tap('.tabs a[href="#me"]');
await wait(600);
await tap('button[data-act="set-level"][data-level="1"]');
await wait(500);
await v.select('#room', 'hall-e');
await wait(1400);
await caption('Tap "Still here" when you stay put', 'It keeps your spot fresh for friends.');
await tap('.status-card [data-act="still"]');
await wait(1400);
await caption('4 · Find a friend on the map', 'Rooms with people show a green count. Tap a room.');
await tap('.tabs a[href="#map"]');
await v.evaluate(() => scrollTo(0, 0));
await wait(1200);
await tap('rect[data-id="hall-e"]', { svg: true });
await wait(1000);
await caption('Tap "Meet me here" to drop a meet pin', 'Everyone sees it first in the ribbon.');
await tap('.sheet [data-act="meet"]');
await wait(1600);
await tap('.sheet .close');
await caption('5 · Ring your friends', 'On Friends, tap people to select them. Tap again to unselect.');
await tap('.tabs a[href="#friends"]');
await v.evaluate(() => scrollTo(0, 0));
await wait(900);
const vpick = n => v.evaluate(n => { const el = [...document.querySelectorAll('div.person[data-act="sel"]')].find(e => e.querySelector('.name').textContent.trim() === n); el?.scrollIntoView({ block: 'center' }); return !!el; }, n);
for (const n of ['Sam', 'Nia']) {
  if (await vpick(n)) {
    await v.evaluate(n => { const el = [...document.querySelectorAll('div.person[data-act="sel"]')].find(e => e.querySelector('.name').textContent.trim() === n); el.setAttribute('data-tour', n); }, n);
    await tap(`[data-tour="${n}"]`);
  }
}
await wait(800);
await caption('Tap Ring', 'Their phones buzz with an alert and a "Go to" button.');
await tap('.selbar [data-act="ring"]');
await wait(1500);
await caption('6 · When someone rings you', 'Tap "Go to …" to open their room on the map.');
const me = await v.evaluate(() => JSON.parse(localStorage.getItem('wa_session')).person_id);
await rpc('send_ring', { p_token: crew.Maya.token, p_to: [me] });
await v.evaluate(() => sync());
await wait(2600);
await tap('#ringbar [data-act="goto-room"]');
await wait(2200);
await caption('7 · Plan your day in Guide', 'Search, filter by day, and tap the star to save sessions.');
await tap('.tabs a[href="#guide"]');
await v.evaluate(() => scrollTo(0, 0));
await wait(800);
await tap('button[data-seg="agenda"]');
await wait(800);
await tap('.star-btn');
await wait(1600);
await caption("That's it. Open How it works anytime from the ? in the header.");
await wait(2400);
await rec.stop();
await wait(500);
await vctx.close();
await browser.close();

// Frames -> mp4 (H.264 plays everywhere, including iPhone), holding each frame for its real duration.
const endT = frames[frames.length - 1].t + 1.5;
let list = 'ffconcat version 1.0\n';
frames.forEach((f, i) => {
  const file = `f${String(i).padStart(5, '0')}.jpg`;
  writeFileSync(`${TMP}/${file}`, Buffer.from(f.data, 'base64'));
  const next = i + 1 < frames.length ? frames[i + 1].t : endT;
  list += `file '${file}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}\n`;
});
list += `file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'\n`;
writeFileSync(`${TMP}/frames.txt`, list);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${TMP}/frames.txt`, '-vf', 'scale=390:-2,fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '28',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', `${OUT}/tour.mp4`]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '4', '-i', `${OUT}/tour.mp4`, '-frames:v', '1', `${TMP}/poster.png`]);
await sharp(`${TMP}/poster.png`).webp({ quality: 72 }).toFile(`${OUT}/tour-poster.webp`);
rmSync(TMP, { recursive: true, force: true });
console.log('tour.mp4', Math.round(statSync(`${OUT}/tour.mp4`).size / 1024), 'KB');
