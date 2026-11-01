-- Ring: nudge one or more crew members ("come find me"). Run once in Supabase after easy.sql.
-- Rings are stored for 15 minutes worth of reads; the app polls get_rings with the time it last saw.

create table if not exists rings (
  id bigserial primary key,
  from_id int not null references people(id) on delete cascade,
  to_id int not null references people(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists rings_to_idx on rings (to_id, created_at);

revoke all on rings from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on rings from anon, authenticated';
    execute 'revoke all on sequence rings_id_seq from anon, authenticated';
  end if;
end $$;

-- Sends a ring to each listed person. Skips yourself, unknown ids, and anyone you rang in the last 20 seconds.
create or replace function send_ring(p_token uuid, p_to int[]) returns int
language plpgsql security definer set search_path = public as $$
declare pid int; n int;
begin
  pid := _me(p_token);
  if p_to is null or cardinality(p_to) = 0 then return 0; end if;
  if cardinality(p_to) > 30 then raise exception 'too many people'; end if;
  delete from rings where created_at < now() - interval '1 day';
  insert into rings (from_id, to_id)
  select pid, t from (select distinct unnest(p_to) t) x
  where t <> pid
    and exists (select 1 from people where id = t)
    and not exists (select 1 from rings r where r.from_id = pid and r.to_id = t and r.created_at > now() - interval '20 seconds');
  get diagnostics n = row_count;
  return n;
end $$;

-- Rings sent to the caller after p_since (at most 15 minutes back).
create or replace function get_rings(p_token uuid, p_since timestamptz default null) returns json
language plpgsql security definer set search_path = public as $$
declare pid int;
begin
  pid := _me(p_token);
  return (
    select coalesce(json_agg(json_build_object('id', id, 'from_id', from_id, 'created_at', created_at) order by created_at), '[]'::json)
    from rings
    where to_id = pid
      and created_at > greatest(coalesce(p_since, now() - interval '15 minutes'), now() - interval '15 minutes')
  );
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function send_ring(uuid, int[]), get_rings(uuid, timestamptz) to anon';
  end if;
end $$;
