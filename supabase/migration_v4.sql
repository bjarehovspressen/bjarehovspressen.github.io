-- ============================================================================
-- BJÄREHOVS PRESSEN — MIGRATION V4
-- ============================================================================
-- Kör HELA denna fil i Supabase SQL Editor EFTER att schema.sql,
-- migration_v2.sql och migration_v3.sql redan körts. Säkert att köra flera
-- gånger.
--
-- Detta lägger till stöd för:
--   Automatisk radering av artiklar vid en vald tidpunkt ("Radera efter
--   X min" / "Radera vid datum + klockslag" i Artikelskaparen).
--
-- OBS — ETT MANUELLT STEG KRÄVS FÖRST:
--   Gå till Supabase Dashboard > Database > Extensions och slå på
--   tillägget "pg_cron" (sök på "cron"). Utan det körs aldrig den
--   schemalagda raderingen automatiskt — artiklarna kan fortfarande
--   raderas manuellt via knapparna i Artikelskaparen, men den
--   tidsstyrda auto-raderingen kräver pg_cron.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. KOLUMN: articles.delete_at
-- ----------------------------------------------------------------------------
alter table public.articles add column if not exists delete_at timestamptz;

create index if not exists articles_delete_at_idx on public.articles (delete_at)
    where delete_at is not null;

-- ----------------------------------------------------------------------------
-- 2. FUNKTION: radera artiklar vars delete_at har passerat
-- ----------------------------------------------------------------------------
-- security definer så att funktionen får radera artiklar oavsett vem (eller
-- vilket schemalagt jobb) som anropar den — RLS på articles gäller annars
-- bara den inloggade användaren som utför anropet.
create or replace function public.delete_expired_articles()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    delete from public.articles
    where delete_at is not null
      and delete_at <= now();
end;
$$;

-- Author/admin (via klienten) ska också kunna trigga en direkt "städning" om
-- de vill, t.ex. för test. Inte strikt nödvändigt men skadar inte.
grant execute on function public.delete_expired_articles() to authenticated;

-- ----------------------------------------------------------------------------
-- 3. SCHEMALÄGGNING: kör funktionen varje minut via pg_cron
-- ----------------------------------------------------------------------------
-- Kräver att tillägget "pg_cron" är påslaget (se OBS högst upp i filen).
-- Om pg_cron inte är påslaget misslyckas blocket nedan tyst med ett
-- varningsmeddelande i SQL Editor — resten av migreringen (kolumnen och
-- funktionen ovan) har då ändå sparats korrekt.
do $$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.unschedule(jobid)
        from cron.job
        where jobname = 'bp-delete-expired-articles';

        perform cron.schedule(
            'bp-delete-expired-articles',
            '* * * * *',
            $cron$ select public.delete_expired_articles(); $cron$
        );
    else
        raise notice 'pg_cron är inte påslaget — slå på tillägget "pg_cron" under Database > Extensions i Supabase och kör sedan om avsnitt 3 i denna fil (eller hela filen igen).';
    end if;
end;
$$;

-- ============================================================================
-- KLART! I Artikelskaparen finns nu fältet "Radera automatiskt vid" (samt en
-- genväg "Radera om X min") på varje artikel, plus en "Radera artikel"-knapp
-- och en "Radera"-knapp per rad i "Mina artiklar". Schemalagda raderingar
-- körs varje minut av pg_cron-jobbet "bp-delete-expired-articles".
-- ============================================================================
