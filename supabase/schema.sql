-- AfroTech group tracker. Run once in the Supabase SQL editor, then run events.sql.
-- Before running: replace CHANGE-ME below with your group code.

create extension if not exists pgcrypto;

create table if not exists people (
  id serial primary key,
  name text not null
);

create table if not exists settings (
  id int primary key default 1 check (id = 1),
  code_hash text not null
);

create table if not exists sessions (
  token uuid primary key default gen_random_uuid(),
  person_id int not null references people(id) on delete cascade,
  client_id text,
  created_at timestamptz not null default now()
);

-- Only Student or Premiere events, Mon Nov 2 2026 through Thu Nov 5 2026 12:00 PM Houston time.
create table if not exists events (
  id text primary key,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  room text not null,
  levels text[] not null,
  check (ends_at > starts_at),
  check (starts_at >= '2026-11-02 00:00:00-06'),
  check (ends_at <= '2026-11-05 12:00:00-06'),
  check (levels && array['Student', 'Premiere'])
);

create table if not exists agreed (
  event_id text primary key references events(id) on delete cascade,
  added_by int not null references people(id),
  added_at timestamptz not null default now()
);

create table if not exists attendance (
  person_id int not null references people(id) on delete cascade,
  event_id text not null references agreed(event_id) on delete cascade,
  primary key (person_id, event_id)
);

create table if not exists status (
  person_id int primary key references people(id) on delete cascade,
  room_id text not null check (length(room_id) <= 40),
  mode text not null check (mode in ('manual', 'live')),
  live_note text check (length(live_note) <= 40),
  updated_at timestamptz not null
);

-- No direct table access. Everything goes through the functions below.
alter table people enable row level security;
alter table settings enable row level security;
alter table sessions enable row level security;
alter table events enable row level security;
alter table agreed enable row level security;
alter table attendance enable row level security;
alter table status enable row level security;
revoke all on people, settings, sessions, events, agreed, attendance, status from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on people, settings, sessions, events, agreed, attendance, status from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on people, settings, sessions, events, agreed, attendance, status from authenticated';
  end if;
end $$;

insert into people (name)
select x from unnest(array[
  'Angel', 'David', 'Aziz', 'Raphael', 'Yannick', 'Grace',
  'Aldine', 'Peter', 'Nicholas', 'Kudzi', 'Kenny', 'Ms. Yussif'
]::text[]) as x
where not exists (select 1 from people p where p.name = x);

insert into settings (id, code_hash) values (1, crypt('CHANGE-ME', gen_salt('bf')))
on conflict (id) do update set code_hash = excluded.code_hash;

-- Resolve a token to a person, or fail.
create or replace function _me(p_token uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare pid int;
begin
  select person_id into pid from sessions where token = p_token;
  if pid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  return pid;
end $$;

create or replace function sign_in(p_name text, p_code text, p_client_id text default null) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare pid int; h text; t uuid; n text;
begin
  n := trim(p_name);
  if char_length(n) < 2 or char_length(n) > 40 then
    raise exception 'name must be 2–40 characters' using errcode = '22023';
  end if;
  select code_hash into h from settings where id = 1;
  if h is null or crypt(p_code, h) <> h then
    raise exception 'wrong code' using errcode = '28P01';
  end if;
  insert into people (name) values (n) returning id into pid;
  insert into sessions (person_id, client_id)
    values (pid, nullif(left(trim(coalesce(p_client_id, '')), 64), ''))
    returning token into t;
  return json_build_object('token', t, 'person_id', pid, 'name', n);
end $$;

create or replace function sign_out(p_token uuid) returns void
language sql security definer set search_path = public as $$
  delete from sessions where token = p_token;
$$;

create or replace function get_state(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare pid int;
begin
  pid := _me(p_token);
  return json_build_object(
    'me', pid,
    'server_time', now(),
    'people', (select coalesce(json_agg(json_build_object('id', id, 'name', name) order by id), '[]') from people),
    'status', (select coalesce(json_agg(json_build_object(
                 'person_id', person_id, 'room_id', room_id, 'mode', mode,
                 'live_note', live_note, 'updated_at', updated_at)), '[]') from status),
    'agreed', (select coalesce(json_agg(json_build_object('event_id', event_id, 'added_by', added_by)), '[]') from agreed),
    'attendance', (select coalesce(json_agg(json_build_object('person_id', person_id, 'event_id', event_id)), '[]') from attendance)
  );
end $$;

-- Sets the caller's own status. There is no person parameter on purpose.
-- p_client_ts is when the person made the change (it may arrive late from the offline queue).
create or replace function set_status(p_token uuid, p_room text, p_mode text, p_note text, p_client_ts timestamptz)
returns void
language plpgsql security definer set search_path = public as $$
declare pid int; ts timestamptz;
begin
  pid := _me(p_token);
  ts := least(coalesce(p_client_ts, now()), now());
  insert into status (person_id, room_id, mode, live_note, updated_at)
  values (pid, p_room, p_mode, case when p_mode = 'live' then p_note end, ts)
  on conflict (person_id) do update
    set room_id = excluded.room_id, mode = excluded.mode,
        live_note = excluded.live_note, updated_at = excluded.updated_at
    where status.updated_at <= excluded.updated_at;
end $$;

-- Marks the caller's own attendance at an agreed event.
create or replace function set_attendance(p_token uuid, p_event text, p_attending boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare pid int;
begin
  pid := _me(p_token);
  if p_attending then
    insert into attendance (person_id, event_id) values (pid, p_event) on conflict do nothing;
  else
    delete from attendance where person_id = pid and event_id = p_event;
  end if;
end $$;

-- Any member may add a filtered event to the agreed list.
create or replace function add_agreed(p_token uuid, p_event text) returns void
language plpgsql security definer set search_path = public as $$
declare pid int;
begin
  pid := _me(p_token);
  insert into agreed (event_id, added_by) values (p_event, pid) on conflict do nothing;
end $$;

revoke execute on function _me(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function _me(uuid) from anon, authenticated';
    execute 'grant execute on function sign_in(text, text, text), sign_out(uuid), get_state(uuid),
      set_status(uuid, text, text, text, timestamptz), set_attendance(uuid, text, boolean),
      add_agreed(uuid, text) to anon';
  end if;
end $$;
