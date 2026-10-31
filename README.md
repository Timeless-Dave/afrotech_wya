# Where Are You: AfroTech 2026

A phone-first guide and crew finder for AfroTech at the George R. Brown Convention Center in Houston, Nov 2–6 2026 (partner events Nov 1–7). It also keeps the original group tracker: Friends, an agreed schedule, and “At GRB / Away from GRB”.

Times are America/Chicago.

## What you can do

- **Guide.** Official agenda by day (time, room, floor, track, ticket level, speakers), side events for the week, a free food and drinks filter, recruiters (company, name, booth, post link), and companies. Search covers sessions, events, and companies. Star anything into **My schedule** on this phone. Overlapping stars are flagged.
- **Now / Next.** What is on at the current Chicago time, and the next official start. Add `?now=2026-11-04T10:30` to preview a moment during the week.
- **Map.** Level 1 exhibit halls and Grand Lobby, Level 2 balconies, Level 3 ballrooms and meeting rooms. Solid shapes are rooms on the GRB plan. Dashed shapes are AfroTech names whose spot is approximate. Booth numbers are listed, not plotted.
- **Crew.** Share a link or code, the other person accepts, then you can see each other’s check-in. Each person sets their own level and room or booth. Live location is opt-in, only while the page is open, and stops with one button. **Call** and **Text** use `tel:` and `sms:`.
- **Friends, Schedule, Me.** Anyone with the link and group code can **Join** with their name (saved on the device until log out). A random device id is stored on the session so duplicate names show as `Name (#id)`. Check-in alerts optional. Phone numbers show only for paired people, plus any numbers in your private `config.local.js`.

## Phone numbers stay out of git

The repo is public. Do not commit anyone’s number.

1. Each person types their own number on **Crew** after they sign in. It is stored in Supabase and returned only to people they have paired with.
2. Optional: copy `config.crew.example.js` to `config.local.js` and fill in numbers on your own machine. `config.local.js` is gitignored. The app loads it when it is present and shows those **Call** / **Text** buttons only on that device. They are not uploaded.
3. On the roster, Timeless is **David**. Put his number on `Timeless` or `David` in the private file.
4. If you deploy `config.local.js` to a public host, anyone can download it. Use it on your own computer, or only on a private deploy.

The example file lists names and empty strings. That is the only phone file that belongs in git.

## Setup

1. Create a free project at https://supabase.com.
2. Open `supabase/schema.sql`, replace `CHANGE-ME` with your group code, and run the whole file in the Supabase SQL editor.
3. Run `supabase/events.sql` the same way. This is the agreed-list filter (Student or Premiere, Mon Nov 2 through Thu Nov 5 12:00 PM).
4. Run `supabase/crew.sql` the same way. This adds pairing, phone numbers, floor check-ins, and meet pins. The guide and the old tracker still load if you skip it; Crew will say the SQL is missing.
5. Run `supabase/easy.sql` once. This enables **open join** (any display name), device ids on sessions, and duplicate-name hints in the app. Skip only if you already ran it.
6. In Supabase, open Project Settings → API. Copy the project URL and the publishable (anon) key into `config.js`. Leave `SUPABASE_URL` empty to use the local stand-in from `npm run dev`.
7. Optionally copy `config.crew.example.js` to `config.local.js` and fill in numbers for your own device.
8. Push to GitHub and turn on Pages: Settings → Pages → Deploy from branch `main`, folder `/ (root)`.

To change the group code later:

```sql
update settings set code_hash = crypt('NEW-CODE', gen_salt('bf')) where id = 1;
```

No secret belongs in the repo. The publishable key is the public anon key Supabase expects in the browser. Service-role keys do not go in `config.js`.

## How the data is kept

The site reads static JSON, so the guide works without calling an API on each visit.

| File | What it is |
| --- | --- |
| `data/sessions-full.json` | 256 official sessions from [afrotechconference.com/schedule](https://afrotechconference.com/schedule), pulled Oct 31, 2026. Track, ticket level, room, and speakers come from the session cards. |
| `data/partner-events.json` | 127 partner and community events, Nov 1–7, from the Afrotech.guide list. |
| `data/freefood.json` | Free food and drinks list from [afrotech.guide/freefood?day=all](https://afrotech.guide/freefood?day=all) (`/data/freefood-events.json`). |
| `data/recruiters.json`, `data/companies.json`, `data/booths.json` | Recruiter posts and company booths. Booth numbers are what those posts said. |
| `data/guide-meta.json` | Counts and source links. |
| `data/schedule.json` | The smaller Student/Premiere list used by the group’s agreed schedule. `SKIPPED.md` says what that filter left out. |
| `data/rooms.json` | Rooms, levels, and whether each placement is verified or approximate. |

The community tracker sheet `1PLDLOdFCuwDAy4fe5y09hb4KgYlX3bsgX60U2z2KE_0` was exported as CSV. Its 123 event rows were already in the 127-event list, so nothing extra was added. Afrotech.guide’s read-only API is documented at https://afrotech.guide/openapi.json (v1.4.0). The public API’s session search returned the guide’s shorter tracked set, not the full 256, so the official schedule page is the agenda source.

Refresh after you save a new schedule page:

```bash
npm run build:guide -- --schedule page.html \
  --events events.json --companies companies.json \
  --recruiters recruiter_posts.json --food freefood-events.json \
  --sheet tracker.csv
```

`--live` refetches the official schedule, the free-food file, and guide events when you do not pass those files. Then bump `CACHE` in `sw.js` so phones pick up the new files.

## Map: what is verified

Sources: [GRB floor plans](https://www.grbhouston.com/planners/floor-plans/) and [dimensions](https://www.grbhouston.com/planners/dimensions-capacities/), plus the agenda when it names a floor. Every box is a schematic. Nothing is to scale.

| Place | Level | Confidence |
| --- | --- | --- |
| Exhibit Halls A–E, including Hall E (Main Stage) and Halls C and D (Product & Innovation Stage) | 1 | Verified. The agenda says 1st floor, and these halls are Level 1 on the GRB plan. The stage spot inside the hall is not marked, so the box is the hall. |
| Grand Lobby (registration) | 1 | Verified name and level. The plan labels GRAND LOBBY beside the concourse and entrances. The box is not a measured footprint. |
| Expo Hall, The Yard, Book Nook, Authors / Founders / Smart Cities / HealthStack pavilions | 1 | Approximate. These are AfroTech names. They are not on the GRB plan. They are drawn dashed on Level 1 because the expo uses the exhibit halls. The spot inside the halls is not known. |
| Rusk, Walker, McKinney, Avenida, Lamar, Polk balconies | 2 | Verified. GRB lists Avenida as balcony C South and McKinney as C North. Walker is the balcony lettered B. The agenda name “Balconies C - Avenida Balcony” matches Avenida. |
| Grand Ballroom A, B, and C; Meeting Rooms 310, 320, and 350 section D; Halls A3 and B3 | 3 | Verified that they are on Level 3. Drawn in groups, not as a measured layout. Room 350D is the Axon recruiting room from their posts. |
| Coca-Cola Lounge, Executive Lounge, Insider Lounge | not set | Unknown. Named on the agenda, not on the GRB plan. |
| Discovery Green, Marriott HealthStack rooms, The Grove, Blavity, “Private”, partner-event placeholders | not set | Not GRB rooms, or the floor was not published. |
| Booth numbers | 1 | Approximate. A number from a post, with no coordinate. |

Halls are drawn A to E in plan order. That is not a claim about north.

## Location, honestly

- GPS only answers “At GRB” or “Away from GRB” (about 450 m from the building). Coordinates are not stored.
- The floor is whatever that person last confirmed: Level 1, 2, or 3, plus a room or booth such as “Level 3, Meeting Room 320” or “Booth 812”.
- Altitude from the phone, if the device provides it, is shown as a hint. It is not turned into a floor. Many phones send nothing indoors.
- Live sharing runs only while the page is open and the switch is on. **Stop sharing location** turns it off.
- A manual check-in is marked stale after 45 minutes, a live one after 5 minutes. **Still here** refreshes yours.
- **Meet me here** drops a pin on the room you picked. Friends see it on that floor until you clear it or move.
- The app polls every 20 seconds on Guide and Schedule, and every **12 seconds** on **Friends**, **Crew**, and **Map** while the tab is open. Offline edits wait in a queue. The guide JSON and hero images are cached by the service worker (`wa-v7`). Optional **check-in alerts** use the browser Notification API (works best with Add to Home Screen).

Check-ins for the group are visible to everyone who signed in with the group code, same as before. Pairing is the extra step that reveals phone numbers.

## Assets

Hero photo and share image come from Wikimedia (CC0 GRB exterior). See `assets/CREDITS.md`. App icons are project artwork, not AfroTech branding.

Regenerate after changing `assets/icon.svg`:

```bash
npm run build:assets
```

Then bump `CACHE` in `sw.js` if you already deployed.

Link previews (iMessage, Slack) use the absolute `og:image` in `index.html` (`https://timeless-dave.github.io/afrotech_wya/assets/og.jpg`). Change that URL if you deploy under a different host.

## School group: staying in sync

Paste **`CREW_ONBOARDING.md`** into your group chat (link + code + 30-second ritual).

1. **Same link and code** — share `https://timeless-dave.github.io/afrotech_wya/?code=YOURCODE` if you want the code pre-filled.
2. **Join** — type your name once; it stays on the phone until **Log out** on **Me**.
3. **Home screen** — tap **Add to Home Screen** (banner or **Me** tab). On iPhone: Share → Add to Home Screen.
4. **Alerts** — **Me → Turn on alerts** when a friend updates their check-in (install the PWA for best results on iOS).
5. **Check in often** — **Me** or **Map**: pick level + room, tap **Still here** when you move.
6. **Crew pairs** — pair with classmates you call/text; save your number once on **Crew**.
7. **Keep Friends or Crew open** — polling is faster there (12s).

## Local testing

```bash
npm install
npm run build:assets   # optional; committed sizes are in assets/
npm test          # schedule filter, guide files, and crew rules
npm run dev       # site + local stand-in at http://localhost:8080, group code "test"
```

Sign in with any name and group code `test`. Open two browsers, create a pair link in one, and accept it in the other. Put `?now=2026-11-04T10:30` on the URL to see Now / Next during the conference.

## Deploy

GitHub Pages serves this folder as a static site. Run the three SQL files on Supabase first, then set `config.js`. After a data change, update `CACHE` in `sw.js` and push. Phones keep the previous cache until that name changes.
