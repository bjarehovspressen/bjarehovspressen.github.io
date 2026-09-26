-- ============================================================================
-- BJÄREHOVS PRESSEN — MIGRATION V3
-- ============================================================================
-- Kör HELA denna fil i Supabase SQL Editor EFTER att schema.sql och
-- migration_v2.sql redan körts. Säkert att köra flera gånger.
--
-- Detta lägger till stöd för:
--   1. Bjärehov-kartan — latitude/longitude på artiklar + karta med markörer
--   2. Veckans omröstning — omröstningar med alternativ, röstning och resultat
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. BJÄREHOV-KARTA: PLATS PÅ ARTIKLAR
-- ----------------------------------------------------------------------------
alter table public.articles add column if not exists latitude double precision;
alter table public.articles add column if not exists longitude double precision;

alter table public.articles drop constraint if exists articles_latitude_range;
alter table public.articles add constraint articles_latitude_range
    check (latitude is null or (latitude between -90 and 90));

alter table public.articles drop constraint if exists articles_longitude_range;
alter table public.articles add constraint articles_longitude_range
    check (longitude is null or (longitude between -180 and 180));

create index if not exists articles_map_idx on public.articles (latitude, longitude)
    where latitude is not null and longitude is not null;

-- ----------------------------------------------------------------------------
-- 2. OMRÖSTNINGAR: TABELLER
-- ----------------------------------------------------------------------------
create table if not exists public.polls (
    id uuid primary key default gen_random_uuid(),
    question text not null check (char_length(question) between 1 and 200),
    description text not null default '' check (char_length(description) <= 500),
    status text not null default 'draft' check (status in ('draft','published','closed')),
    is_featured boolean not null default false,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    closes_at timestamptz
);

create index if not exists polls_status_idx on public.polls (status, created_at desc);
create index if not exists polls_featured_idx on public.polls (is_featured) where is_featured;

create table if not exists public.poll_options (
    id uuid primary key default gen_random_uuid(),
    poll_id uuid not null references public.polls(id) on delete cascade,
    label text not null check (char_length(label) between 1 and 120),
    position integer not null default 0
);

create index if not exists poll_options_poll_idx on public.poll_options (poll_id, position);

-- En rad per "röstare" (identifierad via en slumpad nyckel i webbläsarens
-- localStorage, oavsett om man är inloggad eller inte) och omröstning.
-- Detta är en enkel spärr mot dubbelröstning från samma enhet/webbläsare —
-- inte ett vattentätt identitetssystem.
create table if not exists public.poll_votes (
    id uuid primary key default gen_random_uuid(),
    poll_id uuid not null references public.polls(id) on delete cascade,
    option_id uuid not null references public.poll_options(id) on delete cascade,
    voter_key text not null check (char_length(voter_key) between 8 and 100),
    user_id uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (poll_id, voter_key)
);

create index if not exists poll_votes_poll_idx on public.poll_votes (poll_id);

alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;

-- Vem som helst (inkl. anonyma) får läsa publicerade/stängda omröstningar.
-- Redaktionen (author/admin) får även se sina utkast.
drop policy if exists "polls_select_public" on public.polls;
create policy "polls_select_public"
    on public.polls for select
    using (
        status in ('published','closed')
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin'))
    );

drop policy if exists "polls_write_staff" on public.polls;
create policy "polls_write_staff"
    on public.polls for all
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')))
    with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')));

drop policy if exists "poll_options_select_public" on public.poll_options;
create policy "poll_options_select_public"
    on public.poll_options for select
    using (
        exists (select 1 from public.polls pl where pl.id = poll_id and pl.status in ('published','closed'))
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin'))
    );

drop policy if exists "poll_options_write_staff" on public.poll_options;
create policy "poll_options_write_staff"
    on public.poll_options for all
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')))
    with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')));

-- Rådata i poll_votes är endast läsbar för redaktionen — publika resultat
-- hämtas alltid via RPC:n poll_results nedan (sammanräknat, aldrig per person).
drop policy if exists "poll_votes_select_staff" on public.poll_votes;
create policy "poll_votes_select_staff"
    on public.poll_votes for select
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')));

-- Ingen direkt insert/update från klienten — allt går via RPC:n cast_poll_vote
-- nedan, så vi kan kontrollera att omröstningen faktiskt är öppen.
drop policy if exists "poll_votes_no_direct_write" on public.poll_votes;
create policy "poll_votes_no_direct_write"
    on public.poll_votes for insert
    with check (false);

-- ----------------------------------------------------------------------------
-- 3. RPC: cast_poll_vote — rösta (eller ändra sin röst) i en öppen omröstning
-- ----------------------------------------------------------------------------
create or replace function public.cast_poll_vote(p_poll_id uuid, p_option_id uuid, p_voter_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_voter_key is null or char_length(p_voter_key) < 8 then
        raise exception 'Ogiltig röstnyckel';
    end if;

    if not exists (select 1 from public.polls where id = p_poll_id and status = 'published') then
        raise exception 'Omröstningen är inte öppen för röstning';
    end if;

    if not exists (select 1 from public.poll_options where id = p_option_id and poll_id = p_poll_id) then
        raise exception 'Ogiltigt alternativ';
    end if;

    insert into public.poll_votes (poll_id, option_id, voter_key, user_id)
    values (p_poll_id, p_option_id, p_voter_key, auth.uid())
    on conflict (poll_id, voter_key)
    do update set option_id = excluded.option_id, created_at = now();
end;
$$;

grant execute on function public.cast_poll_vote(uuid, uuid, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. RPC: poll_results — sammanräknade resultat (publikt, aldrig per person)
-- ----------------------------------------------------------------------------
create or replace function public.poll_results(p_poll_id uuid)
returns table (option_id uuid, label text, position integer, votes bigint)
language sql
security definer
set search_path = public
as $$
    select
        po.id as option_id,
        po.label,
        po.position,
        count(pv.id) as votes
    from public.poll_options po
    left join public.poll_votes pv on pv.option_id = po.id
    where po.poll_id = p_poll_id
    group by po.id, po.label, po.position
    order by po.position;
$$;

grant execute on function public.poll_results(uuid) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. RPC: my_poll_vote — vilket alternativ har den här enheten redan röstat på?
-- ----------------------------------------------------------------------------
create or replace function public.my_poll_vote(p_poll_id uuid, p_voter_key text)
returns uuid
language sql
security definer
set search_path = public
as $$
    select option_id from public.poll_votes
    where poll_id = p_poll_id and voter_key = p_voter_key
    limit 1;
$$;

grant execute on function public.my_poll_vote(uuid, text) to anon, authenticated;

-- ============================================================================
-- KLART. Kör hela filen i SQL Editor. Ladda om sidan efteråt.
-- ============================================================================
