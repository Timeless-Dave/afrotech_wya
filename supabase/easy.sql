-- Open join for AfroTech week: any display name, optional device id on the session.
-- Run once in Supabase after schema.sql, events.sql, and crew.sql.

alter table people drop constraint if exists people_name_key;

alter table sessions add column if not exists client_id text;

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

-- get_state from crew.sql plus duplicate-name hints (re-run safe).
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
    ),
    'same_names', (
      select coalesce(json_agg(name order by name), '[]'::json)
      from (select name from people group by name having count(*) > 1) d
    ),
    'my_client_id', (select client_id from sessions where token = p_token)
  );
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function sign_in(text, text, text) to anon';
  end if;
end $$;
