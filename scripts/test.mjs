// Checks the server rules and the schedule filter against an in-memory Postgres.
// Usage: npm test
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
// Same default grants a new Supabase project gives the anon role.
await db.exec(`create role anon; create role authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;`);
await db.exec(readFileSync('supabase/schema.sql', 'utf8').replace("'CHANGE-ME'", "'test'"));
await db.exec(readFileSync('supabase/events.sql', 'utf8'));
await db.exec(readFileSync('supabase/crew.sql', 'utf8'));
const call = async (fn, args) => {
  const keys = Object.keys(args);
  const r = await db.query(`select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, Object.values(args));
  return r.rows[0].r;
};
const rejects = (p, re) => assert.rejects(p, re);
let n = 0; const ok = m => console.log(`ok ${++n} ${m}`);

// Schedule filter
const schedule = JSON.parse(readFileSync('data/schedule.json', 'utf8'));
const lo = Date.parse('2026-11-02T00:00:00-06:00'), hi = Date.parse('2026-11-05T12:00:00-06:00');
for (const e of schedule) {
  assert.ok(Date.parse(e.start) >= lo && Date.parse(e.end) <= hi, `outside window: ${e.title}`);
  assert.ok(e.levels.some(l => l === 'Student' || l === 'Premiere'), `wrong level: ${e.title}`);
  for (const f of ['id', 'title', 'day', 'start', 'end', 'room']) assert.ok(e[f], `missing ${f}: ${e.title}`);
}
ok(`all ${schedule.length} events are Student or Premiere, Mon Nov 2 to Thu Nov 5 12:00 PM`);
const rooms = JSON.parse(readFileSync('data/rooms.json', 'utf8'));
for (const e of schedule) assert.ok(rooms.some(r => r.label === e.room), `room not mapped: ${e.room}`);
ok('every event room is on the map list');

const sessionsFull = JSON.parse(readFileSync('data/sessions-full.json', 'utf8'));
assert.equal(sessionsFull.length, 256);
const roomIds = new Set(rooms.map(r => r.id));
for (const s of sessionsFull) {
  assert.ok(roomIds.has(s.roomId), `session room not mapped: ${s.room}`);
  assert.ok(s.day >= '2026-11-02' && s.day <= '2026-11-06', s.title);
  assert.ok(Date.parse(s.end) > Date.parse(s.start), s.title);
  for (const f of ['title', 'start', 'end', 'room', 'track']) assert.ok(s[f] !== undefined, `missing ${f}`);
}
assert.ok(sessionsFull.some(s => s.speakers.length), 'expected speakers on the official cards');
assert.ok(sessionsFull.some(s => s.day === '2026-11-06'), 'expected a Friday session');
ok(`all ${sessionsFull.length} official sessions have a mapped room`);

assert.equal(rooms.find(r => r.id === 'hall-e').level, '1');
assert.equal(rooms.find(r => r.id === 'hall-e').certainty, 'verified');
assert.equal(rooms.find(r => r.id === 'grand-lobby').level, '1');
assert.equal(rooms.find(r => r.id === 'balcony-c').level, '2');
assert.equal(rooms.find(r => r.id === 'balcony-c').certainty, 'verified');
assert.equal(rooms.find(r => r.id === 'mckinney').level, '2');
assert.equal(rooms.find(r => r.id === 'ballroom-a').level, '3');
assert.equal(rooms.find(r => r.id === 'room-310').level, '3');
assert.equal(rooms.find(r => r.id === 'room-320').level, '3');
assert.equal(rooms.find(r => r.id === 'room-350d').level, '3');
assert.equal(rooms.find(r => r.id === 'room-350d').certainty, 'verified');
assert.equal(rooms.find(r => r.id === 'expo-yard').certainty, 'approximate');
assert.equal(rooms.find(r => r.id === 'expo-book').level, '1');
assert.equal(rooms.find(r => r.id === 'coca-cola').certainty, 'unknown');
ok('floor tags match the GRB plan, and expo names stay approximate');

const partner = JSON.parse(readFileSync('data/partner-events.json', 'utf8'));
const days = new Set(partner.map(e => e.day));
assert.ok(days.has('2026-11-01') && days.has('2026-11-07'));
assert.ok(partner.length >= 120);
const food = JSON.parse(readFileSync('data/freefood.json', 'utf8'));
assert.ok(food.length >= 20);
assert.ok(food.some(f => (f.offerings || []).some(o => o.certainty === 'complimentary' || o.certainty === 'included')));
const rec = JSON.parse(readFileSync('data/recruiters.json', 'utf8'));
assert.ok(rec.length >= 20 && rec.every(r => r.person && r.company && r.link));
const booths = JSON.parse(readFileSync('data/booths.json', 'utf8'));
assert.ok(booths.length >= 8 && booths.every(b => b.certainty === 'approximate' && b.level === '1'));
ok(`guide files: ${partner.length} side events, ${food.length} food listings, ${rec.length} recruiter posts, ${booths.length} booths`);

for (const f of ['assets/icon-192.png', 'assets/icon-512.png', 'assets/hero-640.webp', 'assets/og.jpg']) {
  assert.ok(statSync(f).size > 500, `missing or tiny asset: ${f}`);
}
ok('PWA assets (icons, hero, og) are present');

function walk(dir, hit) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '_ui-check.mjs') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, hit);
    else if (/\.(js|mjs|json|md|sql|html|css)$/.test(name) && !p.endsWith('scripts/test.mjs')) hit.push(p);
  }
}
const files = [];
walk('.', files);
for (const p of files) {
  const text = readFileSync(p, 'utf8');
  assert.ok(!/\+1\d{10}/.test(text), `phone-like number in ${p}`);
  assert.ok(!/\b\d{3}-\d{3}-\d{4}\b/.test(text), `phone-like number in ${p}`);
}
ok('no phone numbers are committed outside the test file');

// Server refuses events outside the filter
await rejects(db.query(`insert into events values ('x','Late','2026-11-05 11:30-06','2026-11-05 12:30-06','R',array['Student'])`), /check/);
await rejects(db.query(`insert into events values ('y','Exec','2026-11-03 10:00-06','2026-11-03 11:00-06','R',array['Executive'])`), /check/);
await rejects(db.query(`insert into events values ('z','Fri','2026-11-06 09:00-06','2026-11-06 10:00-06','R',array['Student'])`), /check/);
ok('database rejects events past Thu noon, on Friday, or without Student/Premiere');

// Sign in
await rejects(call('sign_in', { p_name: 'Angel', p_code: 'nope' }), /wrong code/);
await rejects(call('sign_in', { p_name: 'Stranger', p_code: 'test' }), /not on roster/);
const angel = await call('sign_in', { p_name: 'Angel', p_code: 'test' });
const david = await call('sign_in', { p_name: 'David', p_code: 'test' });
ok('sign in needs roster name and group code');

// Own status only
const t0 = new Date(Date.now() - 60000).toISOString();
await call('set_status', { p_token: david.token, p_room: 'room-310', p_mode: 'live', p_note: 'At GRB', p_client_ts: t0 });
await call('set_status', { p_token: angel.token, p_room: 'hall-e', p_mode: 'manual', p_note: 'ignored', p_client_ts: t0 });
let st = (await call('get_state', { p_token: angel.token })).status;
const byId = id => st.find(s => s.person_id === id);
assert.equal(byId(angel.person_id).room_id, 'hall-e');
assert.equal(byId(angel.person_id).mode, 'manual');
assert.equal(byId(angel.person_id).live_note, null);
assert.equal(byId(david.person_id).room_id, 'room-310');
assert.equal(byId(david.person_id).mode, 'live');
ok('Angel and David each set only their own status; Manual and Live are stored separately');
const fns = (await db.query(`select p.proname, pg_get_function_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('set_status','set_attendance','add_agreed')`)).rows;
for (const f of fns) assert.ok(!/person/.test(f.a), `${f.proname} takes a person argument`);
ok('no write function accepts a person id, so nobody can target someone else');
await rejects(call('set_status', { p_token: '00000000-0000-0000-0000-000000000000', p_room: 'hall-e', p_mode: 'manual', p_note: null, p_client_ts: t0 }), /not signed in/);
ok('a made up token cannot write');
for (const t of ['people', 'status', 'sessions', 'settings']) {
  const g = (await db.query(`select has_table_privilege('anon', '${t}', 'select') s, has_table_privilege('anon', '${t}', 'update') u`)).rows[0];
  assert.ok(!g.s && !g.u, `anon can touch ${t}`);
}
await db.exec('set role anon');
await call('get_state', { p_token: angel.token });
await rejects(db.query('select * from status'), /permission denied/);
await rejects(db.query(`update status set room_id = 'x'`), /permission denied/);
await rejects(call('_me', { p_token: angel.token }), /permission denied/);
await db.exec('reset role');
ok('anon role can call the app functions but cannot read or write tables directly');

// Queued (older) change does not overwrite a newer one
await call('set_status', { p_token: angel.token, p_room: 'room-320', p_mode: 'manual', p_note: null, p_client_ts: new Date(Date.now() - 600000).toISOString() });
st = (await call('get_state', { p_token: angel.token })).status;
assert.equal(byId(angel.person_id).room_id, 'hall-e');
ok('an older queued status does not replace a newer one');

// Agreed list and attendance
await rejects(call('add_agreed', { p_token: angel.token, p_event: 'not-a-real-event' }), /foreign key/);
ok('only filtered events can be added to the agreed list');
const [e1] = schedule;
await rejects(call('set_attendance', { p_token: angel.token, p_event: e1.id, p_attending: true }), /foreign key/);
await call('add_agreed', { p_token: david.token, p_event: e1.id });
await call('set_attendance', { p_token: angel.token, p_event: e1.id, p_attending: true });
const s = await call('get_state', { p_token: david.token });
assert.deepEqual(s.attendance, [{ person_id: angel.person_id, event_id: e1.id }]);
ok('attendance only for agreed events, recorded for the caller');

// Right now logic (same rule as app.js isRunning)
const isRunning = (e, t) => Date.parse(e.start) <= t && t < Date.parse(e.end);
const overlap = schedule.find(a => schedule.some(b => b !== a && b.start < a.end && a.start < b.end && b.start > a.start));
const other = schedule.find(b => b !== overlap && b.start < overlap.end && overlap.start < b.end && b.start > overlap.start);
const t = Date.parse(other.start);
const agreed = [overlap, other, schedule.find(x => x.day === '2026-11-05')];
const running = agreed.filter(e => isRunning(e, t));
assert.deepEqual(running.map(e => e.id), [overlap.id, other.id]);
assert.equal(agreed.filter(e => isRunning(e, Date.parse(overlap.end))).some(e => e.id === overlap.id), false);
ok(`Right now shows both overlapping events (${overlap.title} / ${other.title}) and drops one at its end time`);

const FAKE = '+15555550100';
await call('set_phone', { p_token: david.token, p_phone: FAKE });
let hidden = await call('get_state', { p_token: angel.token });
assert.equal(hidden.people.find(p => p.id === david.person_id).phone, null);
assert.equal(hidden.people.find(p => p.id === angel.person_id).phone, null);
let mine = await call('get_state', { p_token: david.token });
assert.equal(mine.people.find(p => p.id === david.person_id).phone, FAKE);
ok('a phone is visible to its owner and hidden from everyone else');

await rejects(call('set_phone', { p_token: david.token, p_phone: 'call me maybe' }), /bad phone/);
ok('a phone with letters is rejected');

const code = await call('create_pair_code', { p_token: david.token });
await rejects(call('accept_pair', { p_token: david.token, p_code: code.code }), /own code/);
const accepted = await call('accept_pair', { p_token: angel.token, p_code: code.code });
assert.equal(accepted.paired_with, 'David');
let seen = await call('get_state', { p_token: angel.token });
assert.equal(seen.people.find(p => p.id === david.person_id).phone, FAKE);
assert.ok(seen.paired_ids.includes(david.person_id));
const aziz = await call('sign_in', { p_name: 'Aziz', p_code: 'test' });
const az = await call('get_state', { p_token: aziz.token });
assert.equal(az.people.find(p => p.id === david.person_id).phone, null);
ok('accepting a pair code shares the number, and a third person still cannot see it');

await call('set_checkin', {
  p_token: david.token, p_room: 'room-320', p_mode: 'manual', p_note: null,
  p_level: '3', p_label: 'Room 320', p_alt: 12.4, p_meet: true, p_client_ts: new Date().toISOString()
});
seen = await call('get_state', { p_token: angel.token });
const ds = seen.status.find(s => s.person_id === david.person_id);
assert.equal(ds.room_id, 'room-320');
assert.equal(ds.level, '3');
assert.equal(ds.place_label, 'Room 320');
assert.equal(ds.meet_pin, true);
assert.equal(Number(ds.altitude_m), 12.4);
ok('a check-in stores the confirmed level, label, altitude hint, and meet pin');

await call('unpair', { p_token: angel.token, p_other: david.person_id });
seen = await call('get_state', { p_token: angel.token });
assert.equal(seen.people.find(p => p.id === david.person_id).phone, null);
ok('unpair hides the number again');

await db.exec('set role anon');
await rejects(db.query('select * from pairs'), /permission denied/);
await rejects(db.query('select phone from people'), /permission denied/);
await db.exec('reset role');
ok('anon cannot read pair rows or phone numbers directly');

console.log(`\nall ${n} checks passed`);
