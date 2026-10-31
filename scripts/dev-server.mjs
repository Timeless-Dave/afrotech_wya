// Local stand-in for Supabase: serves the site and answers /rest/v1/rpc/<fn>
// using an in-memory Postgres (PGlite) loaded with supabase/schema.sql + events.sql.
// Usage: node scripts/dev-server.mjs [port]   Group code: test
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const root = process.cwd();
const port = +process.argv[2] || 8080;
const db = new PGlite({ extensions: { pgcrypto } });
// Same default grants a new Supabase project gives the anon role.
await db.exec(`create role anon; create role authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;`);
await db.exec(readFileSync('supabase/schema.sql', 'utf8').replace("'CHANGE-ME'", "'test'"));
await db.exec(readFileSync('supabase/events.sql', 'utf8'));
await db.exec(readFileSync('supabase/crew.sql', 'utf8'));

const FNS = ['sign_in', 'sign_out', 'get_state', 'set_status', 'set_attendance', 'add_agreed',
  'set_phone', 'create_pair_code', 'accept_pair', 'unpair', 'set_checkin'];
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp'
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  if (rpc) {
    if (!FNS.includes(rpc[1])) { res.statusCode = 404; return res.end('{}'); }
    let body = ''; for await (const c of req) body += c;
    const args = JSON.parse(body || '{}');
    const keys = Object.keys(args).filter(k => /^p_\w+$/.test(k));
    try {
      const r = await db.query(`select ${rpc[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map(k => args[k]));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(r.rows[0].r ?? null));
    } catch (e) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ message: e.message, code: e.code }));
    }
  }
  let p = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!p.startsWith(root)) { res.statusCode = 403; return res.end(); }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[extname(p)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(readFileSync(p));
}).listen(port, () => console.log(`http://localhost:${port}  (group code: test)`));
