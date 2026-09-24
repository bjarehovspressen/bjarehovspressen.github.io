# Bjärehovs Pressen

En komplett svensk nyhetsplattform byggd med statisk HTML/CSS/JavaScript (för **GitHub Pages**) och **Supabase** som backend (databas, autentisering och filbagring).

Projektet består av två delar:

1. **Bjärehovs Pressen** (`/index.html`) — den publika nyhetssidan, för alla läsare.
2. **Artikelskaparen** (`/creator/index.html`) — ett separat redaktionellt verktyg som endast `author`- och `admin`-konton kommer åt, för att skriva, redigera och publicera artiklar.

All data (användare, roller, artiklar, kommentarer, reaktioner, bilder) lagras i Supabase. GitHub Pages hostar bara de statiska filerna — det behövs ingen egen server.

---

## Innehåll

- [Steg 1 — Skapa ett Supabase-projekt](#steg-1--skapa-ett-supabase-projekt)
- [Steg 2 — Öppna SQL Editor](#steg-2--öppna-sql-editor)
- [Steg 3 — Kör schema.sql](#steg-3--kör-schemasql)
- [Steg 4 — Hämta API-nycklar](#steg-4--hämta-api-nycklar)
- [Steg 5 — Fyll i js/config.js](#steg-5--fyll-i-jsconfigjs)
- [Steg 6 — Konfigurera Supabase Auth](#steg-6--konfigurera-supabase-auth)
- [Steg 7 — Skapa ditt första artikelskaparkonto](#steg-7--skapa-ditt-första-artikelskaparkonto)
- [Steg 8 — Publicera på GitHub Pages](#steg-8--publicera-på-github-pages)
- [Projektstruktur](#projektstruktur)
- [Databasöversikt](#databasöversikt)
- [Säkerhet](#säkerhet)
- [Felsökning](#felsökning)

---

## Steg 1 — Skapa ett Supabase-projekt

1. Gå till [supabase.com](https://supabase.com) och logga in (eller skapa ett konto).
2. Klicka på **New Project**.
3. Välj organisation, ge projektet ett namn (t.ex. `bjarehovs-pressen`), välj ett databaslösenord (spara det säkert — det behövs inte i den här guiden men är bra att ha) och välj en region nära dina läsare (t.ex. Frankfurt/Stockholm-närmast tillgängliga).
4. Klicka **Create new project** och vänta tills projektet är klart (tar ~1–2 minuter).

---

## Steg 2 — Öppna SQL Editor

1. I ditt Supabase-projekt, klicka på **SQL Editor** i vänstermenyn.
2. Klicka på **New query**.

---

## Steg 3 — Kör schema.sql

1. Öppna filen [`supabase/schema.sql`](supabase/schema.sql) i det här projektet.
2. Kopiera **hela** innehållet.
3. Klistra in det i SQL Editor i Supabase.
4. Klicka **Run** (eller `Ctrl/Cmd + Enter`).

Detta skapar:

- Tabellerna `profiles`, `articles`, `article_reactions`, `comments`.
- En databastrigger som automatiskt skapar en `profiles`-rad när någon registrerar sig.
- Row Level Security (RLS) för alla tabeller.
- RPC-funktionerna `increment_article_views` (räknar visningar) och `set_my_reaction` (hanterar gilla/ogilla säkert).
- Storage-bucketen `article-images` med policyer för publik läsning och behörighetsstyrd uppladdning.

Det är säkert att köra filen flera gånger — den använder `if not exists` / `drop policy if exists` där det behövs.

---

## Steg 4 — Hämta API-nycklar

1. I Supabase, gå till **Project Settings** (kugghjulet) → **API**.
2. Notera:
   - **Project URL** — ser ut som `https://xxxxxxxxxxxx.supabase.co`
   - **anon / public key** (kallas ibland **publishable key**) — en lång textsträng.

> ⚠️ **Använd ALDRIG `service_role`-nyckeln i frontend-koden.** Den nyckeln har fulla rättigheter till hela databasen och får aldrig hamna i kod som laddas upp till GitHub. Använd bara `anon`/`public`-nyckeln, som är gjord för att vara publik och styrs av RLS-policyerna vi skapade i steg 3.

---

## Steg 5 — Fyll i js/config.js

Öppna filen [`js/config.js`](js/config.js) och ersätt platshållarna:

```javascript
window.BP_CONFIG = {
    supabaseUrl: "https://DITT-PROJEKT.supabase.co",
    supabasePublishableKey: "DIN-PUBLIC-PUBLISHABLE-KEY",
    imageBucket: "article-images"
};
```

med dina riktiga värden från steg 4, t.ex.:

```javascript
window.BP_CONFIG = {
    supabaseUrl: "https://abcdefghijkl.supabase.co",
    supabasePublishableKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    imageBucket: "article-images"
};
```

Spara filen. Denna fil laddas av **både** `index.html` och `creator/index.html` (via `../js/config.js`), så du behöver bara fylla i den på ett ställe.

**Återigen: lägg aldrig in `service_role`-nyckeln här.** Den här filen kommer att vara publikt synlig för alla som besöker din GitHub Pages-sida.

---

## Steg 6 — Konfigurera Supabase Auth

1. I Supabase, gå till **Authentication** → **Providers**, och kontrollera att **Email** är aktiverat (det är det som standard).
2. Gå till **Authentication** → **URL Configuration**:
   - **Site URL**: sätt till din kommande GitHub Pages-adress, t.ex.
     `https://ditt-anvandarnamn.github.io/bjarehovs-pressen/`
   - **Redirect URLs**: lägg till samma adress (och gärna även `http://localhost:5500/` eller liknande om du testar lokalt).
3. Om du vill slippa e-postverifiering under utveckling kan du under **Authentication → Providers → Email** tillfälligt stänga av "Confirm email" — kom ihåg att slå på det igen inför skarp drift om du vill kräva verifierade e-postadresser.

---

## Steg 7 — Skapa ditt första artikelskaparkonto

Artikelskaparen (`/creator/`) är bara tillgänglig för konton med rollen `author` eller `admin`. Nya konton får automatiskt rollen `reader`, så du behöver höja rollen manuellt första gången.

1. Öppna din sajt (lokalt eller på GitHub Pages) och klicka **Logga in → Skapa konto**. Registrera dig med din e-post, ett lösenord och ett visningsnamn.
2. Gå tillbaka till Supabase Dashboard → **Table Editor** → tabellen `profiles`.
3. Hitta din nya rad (matchar din e-post/id) och kopiera värdet i kolumnen `id` (ett UUID).
4. Gå till **SQL Editor** och kör:

```sql
update public.profiles
set role = 'author'
where id = 'KLISTRA-IN-DITT-UUID-HÄR';
```

5. Ladda om sajten och logga in igen (eller uppdatera sidan) — du bör nu se länken **"Öppna Artikelskaparen"** i din kontomeny, och `/creator/` bör fungera.

### Skapa en administratör

Adminrollen kan hantera **alla** artiklar (inte bara sina egna) och se alla artiklar i "Mina artiklar"-listan i Artikelskaparen:

```sql
update public.profiles
set role = 'admin'
where id = 'ANVÄNDARENS-UUID-HÄR';
```

> Observera: en vanlig `reader` kan **inte** ändra sin egen roll från frontend — det blockeras av en databastrigger (`prevent_role_self_escalation`) oavsett vad som skickas från webbläsaren. Rolländringar måste göras av en admin/i SQL Editor.

---

## Steg 8 — Publicera på GitHub Pages

1. Skapa ett nytt repository på GitHub, t.ex. `bjarehovs-pressen`.
2. Ladda upp **alla filer** i det här projektet till repot (behåll mappstrukturen):

```text
index.html
styles.css
.nojekyll
js/
  config.js
  site.js
creator/
  index.html
  creator.css
  creator.js
supabase/
  schema.sql
README.md
```

   Antingen via `git`:

   ```bash
   git init
   git add .
   git commit -m "Bjärehovs Pressen"
   git branch -M main
   git remote add origin https://github.com/DITT-ANVANDARNAMN/bjarehovs-pressen.git
   git push -u origin main
   ```

   eller genom att dra-och-släppa filerna i GitHubs webbgränssnitt.

3. I repot, gå till **Settings → Pages**.
4. Under **Build and deployment**, välj **Deploy from a branch**.
5. Välj branchen `main` och mappen `/ (root)`, klicka **Save**.
6. Vänta 1–2 minuter. Din sajt publiceras på:
   `https://ditt-anvandarnamn.github.io/bjarehovs-pressen/`
7. Gå tillbaka till Supabase → **Authentication → URL Configuration** och dubbelkolla att den adressen är satt som **Site URL** och finns med i **Redirect URLs** (se steg 6).

Filen `.nojekyll` i rotmappen är viktig — den säger åt GitHub Pages att inte köra Jekyll-bearbetning, vilket annars kan ignorera mappar som börjar med understreck eller skapa andra oväntade problem.

Klart! Din sajt är nu igång, kopplad till Supabase.

---

## Projektstruktur

```text
/
├── index.html            # Publika nyhetssidan (startsida, kategori, sök, artikelvy)
├── styles.css            # All styling för publika sajten (ljust + mörkt tema)
├── .nojekyll             # Krävs av GitHub Pages
├── js/
│   ├── config.js         # Dina Supabase-uppgifter (URL + public key)
│   └── site.js           # All logik för publika sajten
├── creator/
│   ├── index.html        # Artikelskaparen (endast author/admin)
│   ├── creator.css       # Styling för Artikelskaparen
│   └── creator.js        # Logik: rich text-editor, autosave, publicering, bilduppladdning
├── supabase/
│   └── schema.sql        # Komplett databasschema: tabeller, RLS, triggers, storage
└── README.md
```

---

## Databasöversikt

| Tabell               | Beskrivning                                                        |
|-----------------------|--------------------------------------------------------------------|
| `profiles`            | En rad per användare. Roll: `reader` / `author` / `admin`.        |
| `articles`             | Artiklar. Status: `draft` / `published` / `archived`.             |
| `article_reactions`    | Gilla/ogilla. En rad per (artikel, användare) — `UNIQUE`-begränsad.|
| `comments`             | Kommentarer på artiklar. Status: `published` / `hidden`.          |

**RPC-funktioner** (anropas från frontend istället för direkt tabellskrivning):

- `increment_article_views(p_article_id uuid)` — räknar upp visningar på en publicerad artikel.
- `set_my_reaction(p_article_id uuid, p_reaction text)` — sätter/byter/tar bort din egen like/dislike.

**Storage:** bucketen `article-images` (publik läsning, uppladdning kräver `author`/`admin`-roll).

**Kategorier:** Lokalt, Sverige, Världen, Sport, Kultur, Tech, Ekonomi, Opinion, samt **Bus** (för inlägg om Sven och Vilhelm). Om din databas redan fanns innan "Bus" lades till räcker det att köra `schema.sql` igen — den uppdaterar check-constrainten automatiskt.

**Header-länkar:** Längst upp till höger finns knapparna **Spel** (länkar till `https://anchors-arcade.github.io/XXX/`) och **AI** (länkar till `https://anchors-arcade.github.io/Ai-Assistant/`), samt en genväg till **Artikelskaparen** bredvid inloggningsknappen. Adresserna redigeras direkt i `index.html`.

---

## Säkerhet

- Frontend använder **bara** Supabase URL + `anon`/`public`-nyckeln. Ingen `service_role`- eller annan hemlig nyckel finns någonstans i koden.
- All åtkomstkontroll (vem får läsa/skriva/radera vad) sker via **Row Level Security**-policyer i Postgres — inte bara i JavaScript. Även om någon skulle manipulera frontend-koden stoppar databasen otillåtna anrop.
- Artikelskaparens sidor (`/creator/`) döljs visuellt för icke-behöriga i gränssnittet, **men** det är RLS-policyerna på `articles`-tabellen (endast `author`/`admin` får skapa/ändra) som utgör den faktiska säkerhetsspärren.
- En användares roll kan inte höjas av användaren själv, ens via ett direkt API-anrop — en databastrigger nollställer sådana försök om anroparen inte redan är admin.

---

## Felsökning

**"Supabase är inte konfigurerat än"**
Du har inte fyllt i `js/config.js` med din riktiga Project URL och public key (steg 4–5).

**Jag ser inte "Öppna Artikelskaparen" i kontomenyn**
Din profil har fortfarande rollen `reader`. Följ steg 7 för att höja rollen till `author` eller `admin`, och logga sedan ut och in igen.

**"Ingen åtkomst" på /creator/**
Samma som ovan — kontrollera din roll i `profiles`-tabellen i Supabase Table Editor.

**Bilder laddas inte upp**
Kontrollera att `schema.sql` har körts helt (så att bucketen `article-images` och dess policyer finns), och att du är inloggad som `author`/`admin`.

**Inloggning/registrering fungerar inte på GitHub Pages men fungerar lokalt**
Kontrollera **Site URL** och **Redirect URLs** i Supabase → Authentication → URL Configuration (steg 6) — de måste matcha din faktiska GitHub Pages-adress exakt, inklusive avslutande `/`.

**Artiklar visas inte på startsidan**
Kontrollera att artikeln har status `published` (inte `draft`) och att `published_at` är satt — det görs automatiskt när du klickar **Publicera** i Artikelskaparen.
