-- weddingSync :: 002 triggers
-- Server-owned timestamps + the audit trail.
-- Requires 001. Run before 003 (RLS), so the SECURITY DEFINER functions
-- below can write to activity_log before the policies lock it down.

-- ─── server-owned updated_at ─────────────────────────────────────────
-- Clients must NEVER set updated_at. The client delta-pull is
-- `updated_at > cursor`; if a device clock is two hours fast, its writes
-- would be invisible to every other device indefinitely. Assigning the
-- timestamp here makes device clock skew irrelevant.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists guests_touch on public.guests;

create trigger guests_touch before update on public.guests
  for each row execute function public.touch_updated_at();

drop trigger if exists guest_events_touch on public.guest_events;

create trigger guest_events_touch before update on public.guest_events
  for each row execute function public.touch_updated_at();

drop trigger if exists todos_touch on public.todos;

create trigger todos_touch before update on public.todos
  for each row execute function public.touch_updated_at();

-- ─── audit: guests ───────────────────────────────────────────────────
create or replace function public.log_guest_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_name    text;
  v_action  text;
  v_changes jsonb := '{}'::jsonb;
begin
  select display_name into v_name
    from public.profiles where id = v_actor;

  if tg_op = 'INSERT' then
    v_action := 'created';
    v_changes := jsonb_build_object(
      'name', new.name, 'phone', new.phone,
      'male_count', new.male_count, 'female_count', new.female_count);
  else
    -- field-level before/after diff, ignoring server timestamp churn
    v_changes := (
      select coalesce(jsonb_object_agg(
               n.key, jsonb_build_object('from', o.value, 'to', n.value)),
               '{}'::jsonb)
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o on o.key = n.key
      where n.value is distinct from o.value
        and n.key <> 'updated_at'
    );

    if new.deleted_at is not null and old.deleted_at is null then
      v_action := 'deleted';
    elsif v_changes = '{}'::jsonb then
      -- Re-upsert produced no real change. Returning early keeps the
      -- Activity tab clean; without this, every sync pull would append a
      -- meaningless "updated" row per guest.
      return new;
    else
      v_action := 'updated';
    end if;
  end if;

  insert into public.activity_log
    (entity_type, entity_id, action, actor_id, actor_name, changes)
  values
    ('guest', new.id, v_action, v_actor, v_name, v_changes);

  return new;
end $$;

drop trigger if exists guests_audit on public.guests;

create trigger guests_audit after insert or update on public.guests
  for each row execute function public.log_guest_activity();

-- ─── audit: guest_events ─────────────────────────────────────────────
-- entity_id is new.guest_id (not the join row's id) so that "this
-- family's history" is a single indexed filter on one column.
create or replace function public.log_guest_event_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_name    text;
  v_guest   text;
  v_event   text;
  v_action  text;
  v_changes jsonb;
begin
  select display_name into v_name
    from public.profiles where id = v_actor;
  select g.name into v_guest
    from public.guests g where g.id = new.guest_id;
  select e.name into v_event
    from public.events e where e.id = new.event_id;

  if tg_op = 'INSERT' then
    v_action  := 'added_to_event';
    v_changes := jsonb_build_object('event', v_event);
  elsif new.deleted_at is not null and old.deleted_at is null then
    v_action  := 'removed_from_event';
    v_changes := jsonb_build_object('event', v_event);
  elsif new.card_sent is distinct from old.card_sent then
    v_action  := case when new.card_sent then 'card_sent' else 'card_uncheck' end;
    v_changes := jsonb_build_object('event', v_event);
  elsif new.male_count is distinct from old.male_count
     or new.female_count is distinct from old.female_count then
    -- Per-event headcount change. from/to are stored per side and may be
    -- null on either end ("was the family's number, now set" and back).
    v_action  := 'counts_updated';
    v_changes := jsonb_build_object(
      'event', v_event,
      'men',   jsonb_build_object('from', old.male_count,   'to', new.male_count),
      'women', jsonb_build_object('from', old.female_count, 'to', new.female_count));
  else
    return new;
  end if;

  insert into public.activity_log
    (entity_type, entity_id, action, actor_id, actor_name, changes)
  values
    ('guest_event', new.guest_id, v_action, v_actor, v_name,
      v_changes || jsonb_build_object('guest', v_guest));

  return new;
end $$;

drop trigger if exists guest_events_audit on public.guest_events;

create trigger guest_events_audit after insert or update on public.guest_events
  for each row execute function public.log_guest_event_activity();

-- ─── audit: todos ────────────────────────────────────────────────────
create or replace function public.log_todo_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_name    text;
  v_action  text;
  v_changes jsonb := '{}'::jsonb;
begin
  select display_name into v_name
    from public.profiles where id = v_actor;

  if tg_op = 'INSERT' then
    v_action := 'created';
    v_changes := jsonb_build_object(
      'title', new.title, 'category', new.category,
      'assigned_to', new.assigned_to, 'due_date', new.due_date);
  else
    v_changes := (
      select coalesce(jsonb_object_agg(
               n.key, jsonb_build_object('from', o.value, 'to', n.value)),
               '{}'::jsonb)
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o on o.key = n.key
      where n.value is distinct from o.value
        and n.key not in ('updated_at', 'updated_by', 'completed_by')
    );

    if new.deleted_at is not null and old.deleted_at is null then
      v_action := 'deleted';
    elsif new.status is distinct from old.status then
      v_action := case when new.status = 'done' then 'completed' else 'reopened' end;
    elsif new.assigned_to is distinct from old.assigned_to then
      v_action := 'assigned';
    elsif v_changes = '{}'::jsonb then
      return new;
    else
      v_action := 'updated';
    end if;
  end if;

  insert into public.activity_log
    (entity_type, entity_id, action, actor_id, actor_name, changes)
  values
    ('todo', new.id, v_action, v_actor, v_name, v_changes);

  return new;
end $$;

drop trigger if exists todos_audit on public.todos;

create trigger todos_audit after insert or update on public.todos
  for each row execute function public.log_todo_activity();