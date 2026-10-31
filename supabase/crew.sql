-- Crew pairing, phone numbers, and floor check-ins.
-- Run after schema.sql and events.sql.
-- Phone numbers are visible only to the person who saved them and to people they paired with.

alter table people add column if not exists phone text;

alter table status add column if not exists level text;
alter table status add column if not exists place_label text;
alter table status add column if not exists altitude_m double precision;
alter table status add column if not exists meet_pin boolean not null default false;

create table if not exists pair_codes (
  code text primary key,
  person_id int not null references people(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists pairs (
  a int not null references people(id) on delete cascade,
  b int not null references people(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (a < b),
  primary key (a, b)
);

alter table pair_codes enable row level security;
alter table pairs enable row level security;
revoke all on pair_codes, pairs from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on pair_codes, pairs from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on pair_codes, pairs from authenticated';
  end if;
end $$;

-- Same payload as get_state, plus floor fields and phones for paired people only.
create or replace function get_state(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare pid int;
begin
  pid := _me(p_token);
  return json_build_object(
    'me', pid,
    'server_time', now(),
    'people', (
      select coalesce(json_agg(json_build_object(
        'id', p.id,
        'name', p.name,
        'phone', case
          when p.id = pid then p.phone
          when exists (
            select 1 from pairs pr
            where pr.a = least(pid, p.id) and pr.b = greatest(pid, p.id)
          ) then p.phone
          else null
        end
      ) order by p.id), '[]'::json)
      from people p
    ),
    'status', (
      select coalesce(json_agg(json_build_object(
        'person_id', person_id, 'room_id', room_id, 'mode', mode,
        'live_note', live_note, 'updated_at', updated_at,
        'level', level, 'place_label', place_label,
        'altitude_m', altitude_m, 'meet_pin', meet_pin
      )), '[]'::json) from status
    ),
    'agreed', (select coalesce(json_agg(json_build_object('event_id', event_id, 'added_by', added_by)), '[]'::json) from agreed),
    'attendance', (select coalesce(json_agg(json_build_object('person_id', person_id, 'event_id', event_id)), '[]'::json) from attendance),
    'paired_ids', (
      select coalesce(json_agg(case when a = pid then b else a end), '[]'::json)
      from pairs where a = pid or b = pid
    ),
    'pair_code', (
      select code from pair_codes
      where person_id = pid and expires_at > now()
      order by created_at desc limit 1
    )
  );
end $$;

create or replace function set_phone(p_token uuid, p_phone text) returns void
language plpgsql security definer set search_path = public as $$
declare pid int; v text;
begin
  pid := _me(p_token);
  v := nullif(trim(coalesce(p_phone, '')), '');
  if v is not null and length(v) > 20 then
    raise exception 'phone too long';
  end if;
  if v is not null and v !~ '^[0-9+(). -]+$' then
    raise exception 'bad phone';
  end if;
  update people set phone = v where id = pid;
end $$;

-- One active link per person. Creating a new code replaces the old one.
create or replace function create_pair_code(p_token uuid) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare pid int; c text; exp timestamptz;
begin
  pid := _me(p_token);
  exp := now() + interval '7 days';
  c := encode(gen_random_bytes(4), 'hex');
  delete from pair_codes where person_id = pid;
  insert into pair_codes (code, person_id, expires_at) values (c, pid, exp);
  return json_build_object('code', c, 'expires_at', exp);
end $$;

create or replace function accept_pair(p_token uuid, p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare pid int; owner int; exp timestamptz; nm text;
begin
  pid := _me(p_token);
  select person_id, expires_at into owner, exp from pair_codes where code = lower(trim(p_code));
  if owner is null then raise exception 'unknown code' using errcode = '22023'; end if;
  if exp < now() then raise exception 'code expired' using errcode = '22023'; end if;
  if owner = pid then raise exception 'that is your own code' using errcode = '22023'; end if;
  insert into pairs (a, b) values (least(owner, pid), greatest(owner, pid)) on conflict do nothing;
  select name into nm from people where id = owner;
  return json_build_object('paired_with', nm);
end $$;

create or replace function unpair(p_token uuid, p_other int) returns void
language plpgsql security definer set search_path = public as $$
declare pid int;
begin
  pid := _me(p_token);
  delete from pairs where a = least(pid, p_other) and b = greatest(pid, p_other);
end $$;

-- Caller's own check-in: room, confirmed level, label, optional altitude hint, meet pin.
create or replace function set_checkin(
  p_token uuid, p_room text, p_mode text, p_note text,
  p_level text, p_label text, p_alt double precision, p_meet boolean, p_client_ts timestamptz
) returns void
language plpgsql security definer set search_path = public as $$
declare pid int; ts timestamptz; lvl text; lbl text;
begin
  pid := _me(p_token);
  if p_room is null or length(p_room) > 40 then raise exception 'bad room'; end if;
  if p_mode not in ('manual', 'live') then raise exception 'bad mode'; end if;
  lvl := nullif(trim(coalesce(p_level, '')), '');
  if lvl is not null and lvl not in ('1', '2', '3', 'off') then raise exception 'bad level'; end if;
  lbl := nullif(trim(coalesce(p_label, '')), '');
  if lbl is not null and length(lbl) > 80 then raise exception 'label too long'; end if;
  if p_alt is not null and (p_alt < -500 or p_alt > 9000) then raise exception 'bad altitude'; end if;
  ts := least(coalesce(p_client_ts, now()), now());
  insert into status (person_id, room_id, mode, live_note, updated_at, level, place_label, altitude_m, meet_pin)
  values (pid, p_room, p_mode, case when p_mode = 'live' then p_note end, ts, lvl, lbl, p_alt, coalesce(p_meet, false))
  on conflict (person_id) do update
    set room_id = excluded.room_id, mode = excluded.mode, live_note = excluded.live_note,
        updated_at = excluded.updated_at, level = excluded.level, place_label = excluded.place_label,
        altitude_m = excluded.altitude_m, meet_pin = excluded.meet_pin
    where status.updated_at <= excluded.updated_at;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function get_state(uuid), set_phone(uuid, text), create_pair_code(uuid), accept_pair(uuid, text), unpair(uuid, int), set_checkin(uuid, text, text, text, text, text, double precision, boolean, timestamptz) to anon';
  end if;
end $$;
