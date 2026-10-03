-- Migración Centenario v2: Suplentes, Árbitro, Capitanes, Chat y Apuestas

-- 1. Ampliar posiciones en tabla players para incluir Suplentes (pos 11 a 15) y Árbitro (team 2, pos 0)
alter table public.players drop constraint if exists players_pos_check;
alter table public.players add constraint players_pos_check check (pos between 0 and 15);

alter table public.players drop constraint if exists players_team_check;
alter table public.players add constraint players_team_check check (team in (0, 1, 2));

-- Columna para marcar capitán
alter table public.players add column if not exists is_captain boolean default false;

-- Insertar slots de suplentes (pos 11 a 15) para Equipo 1 y 2, y slot de árbitro (team 2, pos 0)
insert into public.players (team, pos)
select t, p from generate_series(0,1) t, generate_series(11,15) p
on conflict do nothing;

insert into public.players (team, pos)
values (2, 0)
on conflict do nothing;

-- 2. Tabla de Mensajes de Chat / Notitas
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  author text not null check (char_length(author) <= 30),
  team int check (team in (0, 1, 2)),
  photo text,
  text text not null check (char_length(text) <= 280),
  created_at timestamptz default now(),
  owner text
);

alter table public.chat_messages enable row level security;
drop policy if exists "chat leer" on public.chat_messages;
create policy "chat leer" on public.chat_messages for select to anon using (true);
drop policy if exists "chat insertar" on public.chat_messages;
create policy "chat insertar" on public.chat_messages for insert to anon with check (true);
drop policy if exists "chat borrar propio" on public.chat_messages;
create policy "chat borrar propio" on public.chat_messages for delete to anon using (true);
grant select, insert, delete on public.chat_messages to anon;

create or replace function public.admin_delete_chat_message(msg_id uuid, admin_pass text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if admin_pass <> 'centenarioutn412' then
    raise exception 'Contraseña de administrador incorrecta';
  end if;
  if msg_id is null then
    delete from public.chat_messages;
  else
    delete from public.chat_messages where id = msg_id;
  end if;
  return true;
end $$;
revoke all on function public.admin_delete_chat_message(uuid, text) from public;
grant execute on function public.admin_delete_chat_message(uuid, text) to anon;

-- 3. Tabla de Apuestas / Prode
create table if not exists public.bets (
  id uuid primary key default gen_random_uuid(),
  user_name text not null check (char_length(user_name) <= 30),
  team_pick text not null,
  total_goals text,
  scorer text,
  yellow_card text,
  amount int default 500,
  created_at timestamptz default now(),
  owner text
);

alter table public.bets enable row level security;
drop policy if exists "apuestas leer" on public.bets;
create policy "apuestas leer" on public.bets for select to anon using (true);
drop policy if exists "apuestas insertar" on public.bets;
create policy "apuestas insertar" on public.bets for insert to anon with check (true);
drop policy if exists "apuestas borrar" on public.bets;
create policy "apuestas borrar" on public.bets for delete to anon using (true);
grant select, insert, delete on public.bets to anon;

-- 4. Habilitar realtime para las nuevas tablas
alter publication supabase_realtime add table public.chat_messages;
alter publication supabase_realtime add table public.bets;
