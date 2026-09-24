-- ============================================================================
-- BJÄREHOVS PRESSEN — SUPABASE SCHEMA
-- ============================================================================
-- Kör HELA denna fil i Supabase SQL Editor (Dashboard > SQL Editor > New query).
-- Säkert att köra flera gånger tack vare "if not exists" / "or replace" där det går.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. EXTENSIONS
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. TABELL: profiles
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    display_name text not null default 'Ny läsare',
    role text not null default 'reader' check (role in ('reader', 'author', 'admin')),
    created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Alla (inklusive anonyma) får läsa visningsnamn/roll — behövs för att visa
-- författarnamn och kommentatorers namn i UI:t.
drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all"
    on public.profiles for select
    using (true);

-- En användare får uppdatera sin egen profil, MEN får aldrig ändra sin egen roll
-- (kontrolleras av triggern nedan — detta skydd får inte bara ligga i frontend).
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
    on public.profiles for update
    using (auth.uid() = id)
    with check (auth.uid() = id);

-- Admins får uppdatera VILKEN profil som helst (t.ex. sätta roll via
-- admin-panelen i Artikelskaparen). Vad som faktiskt får ändras i role-kolumnen
-- kontrolleras ändå alltid av triggern prevent_role_self_escalation nedan.
drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin"
    on public.profiles for update
    using (exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
    ))
    with check (exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
    ));

-- Ingen får sätta in rader manuellt via API — det sköts av triggern vid signup.
drop policy if exists "profiles_no_direct_insert" on public.profiles;
create policy "profiles_no_direct_insert"
    on public.profiles for insert
    with check (false);

-- Spärra att role ändras av vanliga användare, även via update-policyn ovan.
create or replace function public.prevent_role_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    -- Om anroparen inte är service_role och roll försöker ändras -> blockera,
    -- om inte anroparen redan är admin.
    if new.role is distinct from old.role then
        if not exists (
            select 1 from public.profiles
            where id = auth.uid() and role = 'admin'
        ) then
            new.role := old.role;
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_prevent_role_self_escalation on public.profiles;
create trigger trg_prevent_role_self_escalation
    before update on public.profiles
    for each row
    execute function public.prevent_role_self_escalation();

-- Skapa automatiskt en profile-rad när en ny Auth-användare registreras.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, display_name, role)
    values (
        new.id,
        coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
        'reader'
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row
    execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2. TABELL: articles
-- ----------------------------------------------------------------------------
create table if not exists public.articles (
    id uuid primary key default gen_random_uuid(),
    author_id uuid not null references public.profiles(id) on delete cascade,
    title text not null check (char_length(title) between 1 and 200),
    slug text not null unique,
    excerpt text not null default '' check (char_length(excerpt) <= 400),
    content_html text not null default '',
    category text not null check (category in
        ('lokalt','sverige','varlden','sport','kultur','tech','ekonomi','opinion','bus')),
    image_url text,
    status text not null default 'draft' check (status in ('draft','published','archived')),
    published_at timestamptz,
    views integer not null default 0,
    like_count integer not null default 0,
    dislike_count integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Om articles-tabellen redan fanns sedan tidigare (innan kategorin "bus"
-- lades till), uppdatera check-constrainten så den tillåter den nya kategorin.
alter table public.articles drop constraint if exists articles_category_check;
alter table public.articles add constraint articles_category_check
    check (category in
        ('lokalt','sverige','varlden','sport','kultur','tech','ekonomi','opinion','bus'));

create index if not exists articles_status_published_idx
    on public.articles (status, published_at desc);
create index if not exists articles_category_idx on public.articles (category);
create index if not exists articles_author_idx on public.articles (author_id);
create index if not exists articles_views_idx on public.articles (views desc);

alter table public.articles enable row level security;

-- Publika/inloggade får läsa publicerade artiklar.
drop policy if exists "articles_select_published" on public.articles;
create policy "articles_select_published"
    on public.articles for select
    using (status = 'published');

-- Författare får läsa (och därmed redigera) sina egna artiklar oavsett status.
drop policy if exists "articles_select_own" on public.articles;
create policy "articles_select_own"
    on public.articles for select
    using (auth.uid() = author_id);

-- Admin får läsa alla artiklar oavsett status.
drop policy if exists "articles_select_admin" on public.articles;
create policy "articles_select_admin"
    on public.articles for select
    using (exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
    ));

-- Author/Admin får skapa artiklar, men bara i sitt eget namn.
drop policy if exists "articles_insert_author" on public.articles;
create policy "articles_insert_author"
    on public.articles for insert
    with check (
        auth.uid() = author_id
        and exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('author','admin')
        )
    );

-- Author får uppdatera sina egna artiklar. Admin får uppdatera alla.
drop policy if exists "articles_update_own" on public.articles;
create policy "articles_update_own"
    on public.articles for update
    using (
        auth.uid() = author_id
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    )
    with check (
        auth.uid() = author_id
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    );

-- Author får radera sina egna artiklar. Admin får radera alla.
drop policy if exists "articles_delete_own" on public.articles;
create policy "articles_delete_own"
    on public.articles for delete
    using (
        auth.uid() = author_id
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
    );

-- Håll updated_at aktuell automatiskt.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_articles_updated_at on public.articles;
create trigger trg_articles_updated_at
    before update on public.articles
    for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. TABELL: article_reactions (like/dislike)
-- ----------------------------------------------------------------------------
create table if not exists public.article_reactions (
    id uuid primary key default gen_random_uuid(),
    article_id uuid not null references public.articles(id) on delete cascade,
    user_id uuid not null references public.profiles(id) on delete cascade,
    reaction text not null check (reaction in ('like','dislike')),
    created_at timestamptz not null default now(),
    unique (article_id, user_id)
);

alter table public.article_reactions enable row level security;

drop policy if exists "reactions_select_all" on public.article_reactions;
create policy "reactions_select_all"
    on public.article_reactions for select
    using (true);

drop policy if exists "reactions_insert_own" on public.article_reactions;
create policy "reactions_insert_own"
    on public.article_reactions for insert
    with check (auth.uid() = user_id);

drop policy if exists "reactions_update_own" on public.article_reactions;
create policy "reactions_update_own"
    on public.article_reactions for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

drop policy if exists "reactions_delete_own" on public.article_reactions;
create policy "reactions_delete_own"
    on public.article_reactions for delete
    using (auth.uid() = user_id);

-- Håll like_count/dislike_count på articles synkade automatiskt.
create or replace function public.recalc_article_reaction_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    target_article uuid;
begin
    target_article := coalesce(new.article_id, old.article_id);

    update public.articles
    set like_count = (
            select count(*) from public.article_reactions
            where article_id = target_article and reaction = 'like'
        ),
        dislike_count = (
            select count(*) from public.article_reactions
            where article_id = target_article and reaction = 'dislike'
        )
    where id = target_article;

    return null;
end;
$$;

drop trigger if exists trg_reactions_after_change on public.article_reactions;
create trigger trg_reactions_after_change
    after insert or update or delete on public.article_reactions
    for each row execute function public.recalc_article_reaction_counts();

-- ----------------------------------------------------------------------------
-- 4. TABELL: comments
-- ----------------------------------------------------------------------------
create table if not exists public.comments (
    id uuid primary key default gen_random_uuid(),
    article_id uuid not null references public.articles(id) on delete cascade,
    user_id uuid not null references public.profiles(id) on delete cascade,
    body text not null check (char_length(trim(body)) between 1 and 2000),
    status text not null default 'published' check (status in ('published','hidden')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists comments_article_idx on public.comments (article_id, created_at desc);

alter table public.comments enable row level security;

drop policy if exists "comments_select_published" on public.comments;
create policy "comments_select_published"
    on public.comments for select
    using (status = 'published' or auth.uid() = user_id or exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
    ));

drop policy if exists "comments_insert_own" on public.comments;
create policy "comments_insert_own"
    on public.comments for insert
    with check (auth.uid() = user_id);

drop policy if exists "comments_update_own" on public.comments;
create policy "comments_update_own"
    on public.comments for update
    using (auth.uid() = user_id or exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
    ))
    with check (auth.uid() = user_id or exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
    ));

drop policy if exists "comments_delete_own" on public.comments;
create policy "comments_delete_own"
    on public.comments for delete
    using (auth.uid() = user_id or exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
    ));

drop trigger if exists trg_comments_updated_at on public.comments;
create trigger trg_comments_updated_at
    before update on public.comments
    for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 5. RPC: increment_article_views
-- ----------------------------------------------------------------------------
-- Frontend anropar denna funktion istället för att skriva direkt till
-- articles.views, så att räkningen sker kontrollerat server-side.
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
end;
$$;

grant execute on function public.increment_article_views(uuid) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. RPC: set_my_reaction (like/dislike/ta bort, växla säkert)
-- ----------------------------------------------------------------------------
create or replace function public.set_my_reaction(p_article_id uuid, p_reaction text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_reaction is null then
        delete from public.article_reactions
        where article_id = p_article_id and user_id = auth.uid();
        return;
    end if;

    if p_reaction not in ('like','dislike') then
        raise exception 'Ogiltig reaktion';
    end if;

    insert into public.article_reactions (article_id, user_id, reaction)
    values (p_article_id, auth.uid(), p_reaction)
    on conflict (article_id, user_id)
    do update set reaction = excluded.reaction, created_at = now();
end;
$$;

grant execute on function public.set_my_reaction(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. STORAGE: bucket "article-images"
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('article-images', 'article-images', true)
on conflict (id) do nothing;

-- Alla (även anonyma) får läsa bilder — bucketen är publik.
drop policy if exists "article_images_public_read" on storage.objects;
create policy "article_images_public_read"
    on storage.objects for select
    using (bucket_id = 'article-images');

-- Endast inloggade authors/admins får ladda upp bilder.
drop policy if exists "article_images_author_upload" on storage.objects;
create policy "article_images_author_upload"
    on storage.objects for insert
    with check (
        bucket_id = 'article-images'
        and auth.role() = 'authenticated'
        and exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('author','admin')
        )
    );

-- Endast ägaren av uppladdningen (eller admin) får uppdatera/radera bilder.
drop policy if exists "article_images_author_update" on storage.objects;
create policy "article_images_author_update"
    on storage.objects for update
    using (
        bucket_id = 'article-images'
        and (owner = auth.uid() or exists (
            select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
        ))
    );

drop policy if exists "article_images_author_delete" on storage.objects;
create policy "article_images_author_delete"
    on storage.objects for delete
    using (
        bucket_id = 'article-images'
        and (owner = auth.uid() or exists (
            select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
        ))
    );

-- ============================================================================
-- KLART! Nästa steg: se README.md för hur du registrerar ditt första konto
-- och gör det till "author" eller "admin".
-- ============================================================================
