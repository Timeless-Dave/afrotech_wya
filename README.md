# Where Are You: AfroTech 2026 group tracker

A small group tracker for our AfroTech trip (GRB, Houston, Mon Nov 2 to Thu Nov 5 12:00 PM). It has six screens: sign in, Friends, Now, Map, Schedule and Me.

## Setup (about 5 minutes)

1. **Create a Supabase project.** Go to https://supabase.com and create a free project.
2. **Create the database.**
   - Open `supabase/schema.sql` and replace `CHANGE-ME` with your group code.
   - In the Supabase dashboard, open SQL Editor, paste the whole file and run it.
   - Then paste and run `supabase/events.sql` the same way.
3. **Connect the site.**
   - In Supabase, go to Project Settings > API.
   - Copy the Project URL and the `anon` public key into `config.js`.
4. **Push** this repo to GitHub.
5. **Turn on GitHub Pages.**
   - In the repo, go to Settings > Pages.
   - Set it to Deploy from branch, `main`, folder `/ (root)`.
   - The site will be at `https://angelic-coder19.github.io/afrotech_whereareyou/`.

To change the group code later, run this in the SQL Editor:
```sql
update settings set code_hash = crypt('NEW-CODE', gen_salt('bf')) where id = 1;
```

## How it works
- **Data access:** every read and write goes through Postgres functions in `schema.sql`. Tables have no direct access. Write functions take your session token and never a person, so you can only change your own status and attendance.
- **Allowed events:** the `events` table only accepts Student or Premiere events between Mon Nov 2 and Thu Nov 5 12:00 PM.
- **Sync:** the app checks for updates every 20 seconds while it is open. Changes made offline wait in a queue and are sent once the connection comes back. The schedule, the map and the last known state are all cached, so the app still opens offline.
- **Live location:** it is only on while you switch it on and the page is open. The app sends "At GRB" or "Away from GRB". It never stores coordinates.
- **Stale status:** a Manual status counts as stale after 45 minutes and a Live one after 5 minutes without an update. Tap "Still here" to refresh yours.

## Schedule data
- `data/schedule.json` and `supabase/events.sql` were generated from https://afrotechconference.com/schedule on Oct 31, 2026 by `scripts/extract-schedule.mjs`.
- `SKIPPED.md` lists the events that were left out and why.
- To refresh the data:
  1. Save the schedule page HTML.
  2. Run `node scripts/extract-schedule.mjs page.html`.
  3. Re-run `events.sql`.
  4. Change `CACHE` in `sw.js` so phones pick up the new files.

## Map
The map is a schematic based on the ExpoFP GRB floor plan. It is not to scale and positions are approximate. Schedule rooms that are not on that plan, such as the Expo Hall pavilions, the lounges and offsite venues, are under "Not on plan" with no position.

## Local testing
```
npm install
npm test          # server rules and schedule filter checks
npm run dev       # site + local stand-in backend at http://localhost:8080, group code "test"
```
Add `?now=2026-11-03T10:00` to the URL to see the app at a chosen time.
