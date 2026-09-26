-- ============================================================================
-- BJÄREHOVS PRESSEN — MIGRATION V2
-- ============================================================================
-- Kör HELA denna fil i Supabase SQL Editor EFTER att schema.sql redan körts.
-- Säkert att köra flera gånger (if not exists / drop policy if exists överallt).
--
-- Detta lägger till stöd för:
--   1. Nya kategorier: skolnytt, matsedel, handelser, intervjuer
--   2. Breaking news-flagga och "live"-artiklar med tidsstämplade uppdateringar
--   3. Nyhetstips-inkorg ("Skicka in ett tips")
--   4. Bildgalleri
--   5. Visningshändelser (view_events) för statistikdashboard/graf
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. NYA KATEGORIER
-- ----------------------------------------------------------------------------
alter table public.articles drop constraint if exists articles_category_check;
alter table public.articles add constraint articles_category_check
    check (category in
        ('lokalt','sverige','varlden','sport','kultur','tech','ekonomi','opinion','bus',
         'skolnytt','matsedel','handelser','intervjuer'));

-- ----------------------------------------------------------------------------
-- 2. BREAKING NEWS + LIVE-ARTIKLAR
-- ----------------------------------------------------------------------------
alter table public.articles add column if not exists is_breaking boolean not null default false;
alter table public.articles add column if not exists is_live boolean not null default false;

create index if not exists articles_breaking_idx on public.articles (is_breaking) where is_breaking;

create table if not exists public.live_updates (
    id uuid primary key default gen_random_uuid(),
    article_id uuid not null references public.articles(id) on delete cascade,
    body text not null check (char_length(body) between 1 and 500),
    created_by uuid references public.profiles(id) on delete set null,
    occurred_at timestamptz not null default now()
);

create index if not exists live_updates_article_idx on public.live_updates (article_id, occurred_at desc);

alter table public.live_updates enable row level security;

drop policy if exists "live_updates_select_public" on public.live_updates;
create policy "live_updates_select_public"
    on public.live_updates for select
    using (
        exists (select 1 from public.articles a where a.id = article_id and a.status = 'published')
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin'))
    );

drop policy if exists "live_updates_insert_author" on public.live_updates;
create policy "live_updates_insert_author"
    on public.live_updates for insert
    with check (
        exists (
            select 1 from public.articles a
            join public.profiles p on p.id = auth.uid()
            where a.id = article_id and (a.author_id = auth.uid() or p.role = 'admin')
        )
    );

drop policy if exists "live_updates_delete_author" on public.live_updates;
create policy "live_updates_delete_author"
    on public.live_updates for delete
    using (
        exists (
            select 1 from public.articles a
            join public.profiles p on p.id = auth.uid()
            where a.id = article_id and (a.author_id = auth.uid() or p.role = 'admin')
        )
    );

-- ----------------------------------------------------------------------------
-- 3. NYHETSTIPS ("Skicka in ett tips")
-- ----------------------------------------------------------------------------
create table if not exists public.news_tips (
    id uuid primary key default gen_random_uuid(),
    what text not null check (char_length(what) between 1 and 1000),
    where_text text not null default '' check (char_length(where_text) <= 200),
    anonymous boolean not null default false,
    reporter_id uuid references public.profiles(id) on delete set null,
    status text not null default 'new' check (status in ('new','read','archived')),
    created_at timestamptz not null default now()
);

alter table public.news_tips enable row level security;

-- Vem som helst som är inloggad får skicka in ett tips.
drop policy if exists "news_tips_insert_authenticated" on public.news_tips;
create policy "news_tips_insert_authenticated"
    on public.news_tips for insert
    with check (auth.uid() is not null and (reporter_id = auth.uid() or reporter_id is null));

-- Endast redaktionen (author/admin) får läsa/uppdatera tipsinkorgen.
drop policy if exists "news_tips_select_staff" on public.news_tips;
create policy "news_tips_select_staff"
    on public.news_tips for select
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')));

drop policy if exists "news_tips_update_staff" on public.news_tips;
create policy "news_tips_update_staff"
    on public.news_tips for update
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')))
    with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')));

-- ----------------------------------------------------------------------------
-- 4. BILDGALLERI
-- ----------------------------------------------------------------------------
create table if not exists public.galleries (
    id uuid primary key default gen_random_uuid(),
    title text not null check (char_length(title) between 1 and 200),
    description text not null default '',
    cover_image_url text,
    author_id uuid not null references public.profiles(id) on delete cascade,
    status text not null default 'published' check (status in ('draft','published')),
    created_at timestamptz not null default now()
);

create table if not exists public.gallery_images (
    id uuid primary key default gen_random_uuid(),
    gallery_id uuid not null references public.galleries(id) on delete cascade,
    image_url text not null,
    caption text not null default '',
    position integer not null default 0
);

create index if not exists gallery_images_gallery_idx on public.gallery_images (gallery_id, position);

alter table public.galleries enable row level security;
alter table public.gallery_images enable row level security;

drop policy if exists "galleries_select_public" on public.galleries;
create policy "galleries_select_public"
    on public.galleries for select
    using (status = 'published' or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')));

drop policy if exists "galleries_write_staff" on public.galleries;
create policy "galleries_write_staff"
    on public.galleries for all
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')))
    with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')));

drop policy if exists "gallery_images_select_public" on public.gallery_images;
create policy "gallery_images_select_public"
    on public.gallery_images for select
    using (
        exists (select 1 from public.galleries g where g.id = gallery_id and g.status = 'published')
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin'))
    );

drop policy if exists "gallery_images_write_staff" on public.gallery_images;
create policy "gallery_images_write_staff"
    on public.gallery_images for all
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')))
    with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')));

-- ----------------------------------------------------------------------------
-- 5. VISNINGSHÄNDELSER (för statistikdashboard: visningar per dag)
-- ----------------------------------------------------------------------------
create table if not exists public.view_events (
    id bigint generated always as identity primary key,
    article_id uuid references public.articles(id) on delete cascade,
    occurred_at timestamptz not null default now()
);

create index if not exists view_events_occurred_idx on public.view_events (occurred_at desc);

alter table public.view_events enable row level security;

-- Ingen direkt insert/select från klienten — allt går via RPC:er (security definer)
-- respektive statistik-RPC:n nedan, så vanliga läsare kan aldrig se rådata här.
drop policy if exists "view_events_select_staff" on public.view_events;
create policy "view_events_select_staff"
    on public.view_events for select
    using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin')));

-- Uppdaterad increment_article_views: räknar upp OCH loggar en händelse (för grafen).
create or replace function public.increment_article_views(p_article_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.articles
    set views = views + 1
    where id = p_article_id and status = 'published';

    insert into public.view_events (article_id) values (p_article_id);
end;
$$;

-- RPC: hämta visningar per dag de senaste 14 dagarna (endast author/admin).
create or replace function public.stats_views_per_day(p_days integer default 14)
returns table (day date, views bigint)
language sql
security definer
set search_path = public
as $$
    select d::date as day, coalesce(count(ve.id), 0) as views
    from generate_series(
        (current_date - (p_days - 1)),
        current_date,
        interval '1 day'
    ) as d
    left join public.view_events ve on ve.occurred_at::date = d::date
    where exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin'))
    group by d
    order by d;
$$;

-- RPC: sammanfattad statistik (endast author/admin).
create or replace function public.stats_summary()
returns table (total_views bigint, total_articles bigint, total_users bigint, total_comments bigint)
language sql
security definer
set search_path = public
as $$
    select
        (select coalesce(sum(views), 0) from public.articles where status = 'published'),
        (select count(*) from public.articles where status = 'published'),
        (select count(*) from public.profiles),
        (select count(*) from public.comments where status = 'published')
    where exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('author','admin'));
$$;

-- ============================================================================
-- KLART. Kör hela filen i SQL Editor. Ladda om sidan efteråt.
-- ============================================================================
