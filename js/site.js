// ============================================================================
// BJÄREHOVS PRESSEN — site.js
// Publik nyhetssida: auth, routing (hash-baserad), datahämtning, rendering.
// ============================================================================
(function () {
    "use strict";

    // ------------------------------------------------------------------
    // 0. SUPABASE CLIENT
    // ------------------------------------------------------------------
    const cfg = window.BP_CONFIG || {};
    const CONFIG_OK = cfg.supabaseUrl && !cfg.supabaseUrl.includes("DITT-PROJEKT")
        && cfg.supabasePublishableKey && !cfg.supabasePublishableKey.includes("DIN-PUBLIC");

    let supabase = null;
    if (CONFIG_OK) {
        if (window.supabase && typeof window.supabase.createClient === "function") {
            try {
                supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
            } catch (e) {
                console.error("Kunde inte skapa Supabase-klienten:", e);
            }
        } else {
            console.error("Supabase-biblioteket laddades inte (window.supabase saknas). Kontrollera nätverk/CDN.");
        }
    }

    const IMAGE_BUCKET = cfg.imageBucket || "article-images";

    const CATEGORY_LABELS = {
        lokalt: "Lokalt", sverige: "Sverige", varlden: "Världen", sport: "Sport",
        kultur: "Kultur", tech: "Tech", ekonomi: "Ekonomi", opinion: "Opinion", bus: "Bus",
        skolnytt: "Skolnytt", matsedel: "Matsedel", handelser: "Händelser", intervjuer: "Intervjuer"
    };
    const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

    // Reaktionstyper: nyckel = kolumn-/RPC-värde, emoji = visas i UI.
    const REACTIONS = [
        { key: "love", emoji: "❤️", field: "love_count" },
        { key: "laugh", emoji: "😂", field: "laugh_count" },
        { key: "wow", emoji: "😮", field: "wow_count" },
        { key: "like", emoji: "👍", field: "like_count" },
        { key: "dislike", emoji: "👎", field: "dislike_count" }
    ];

    // ------------------------------------------------------------------
    // 1. STATE
    // ------------------------------------------------------------------
    const state = {
        session: null,
        profile: null,           // { id, display_name, role }
        theme: localStorage.getItem("bp_theme") || null,
        latestOffset: 0,
        latestPageSize: 9,
        categoryOffset: 0,
        currentCategory: null,
        currentArticle: null,
        myReaction: null
    };

    // ------------------------------------------------------------------
    // 2. DOM HELPERS
    // ------------------------------------------------------------------
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    function escapeHtml(str) {
        const d = document.createElement("div");
        d.textContent = str == null ? "" : String(str);
        return d.innerHTML;
    }

    function formatDate(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        return d.toLocaleDateString("sv-SE", { year: "numeric", month: "long", day: "numeric" }) +
            " " + d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
    }

    function timeAgo(iso) {
        if (!iso) return "";
        const diffMs = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(diffMs / 60000);
        if (mins < 1) return "just nu";
        if (mins < 60) return mins + " min sedan";
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + " tim sedan";
        const days = Math.floor(hrs / 24);
        if (days < 7) return days + " dygn sedan";
        return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
    }

    function toast(msg, type) {
        const stack = $("#toastStack");
        const el = document.createElement("div");
        el.className = "toast" + (type ? " " + type : "");
        el.textContent = msg;
        stack.appendChild(el);
        setTimeout(() => el.remove(), 4200);
    }

    function placeholderImg(seed) {
        // Genererad platshållarbild (SVG data-URI) om artikeln saknar bild.
        const colors = ["#2c4c56", "#a8382b", "#b8892f", "#6a4c9c", "#2f7a4f"];
        const c = colors[Math.abs(hashCode(seed || "bp")) % colors.length];
        return "data:image/svg+xml," + encodeURIComponent(
            `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'><rect width='400' height='300' fill='${c}'/><text x='200' y='160' font-family='Georgia,serif' font-size='34' fill='rgba(255,255,255,0.85)' text-anchor='middle'>BP</text></svg>`
        );
    }
    function hashCode(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
        return h;
    }

    // ------------------------------------------------------------------
    // 3. THEME
    // ------------------------------------------------------------------
    function applyTheme() {
        if (state.theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
        else if (state.theme === "light") document.documentElement.setAttribute("data-theme", "light");
        else document.documentElement.removeAttribute("data-theme");
    }
    applyTheme();

    $("#themeToggleBtn").addEventListener("click", () => {
        const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        const currentlyDark = state.theme ? state.theme === "dark" : prefersDark;
        state.theme = currentlyDark ? "light" : "dark";
        localStorage.setItem("bp_theme", state.theme);
        applyTheme();
    });

    // ------------------------------------------------------------------
    // 4. MOBILE NAV
    // ------------------------------------------------------------------
    $("#navToggleBtn").addEventListener("click", () => {
        const nav = $("#siteNav");
        const open = nav.classList.toggle("open");
        $("#navToggleBtn").setAttribute("aria-expanded", String(open));
    });
    $all(".nav-list a").forEach(a => a.addEventListener("click", () => {
        $("#siteNav").classList.remove("open");
    }));

    // ------------------------------------------------------------------
    // 5. AUTH
    // ------------------------------------------------------------------
    async function refreshSession() {
        if (!supabase) return;
        const { data: { session } } = await supabase.auth.getSession();
        state.session = session;
        if (session) {
            const { data: profile } = await supabase
                .from("profiles").select("id, display_name, role").eq("id", session.user.id).single();
            state.profile = profile || null;
        } else {
            state.profile = null;
        }
        renderAuthUI();
    }

    function renderAuthUI() {
        const loggedIn = !!state.session;
        $("#loggedOutActions").classList.toggle("hidden", loggedIn);
        $("#loggedInActions").classList.toggle("hidden", !loggedIn);
        if (loggedIn && state.profile) {
            $("#accountName").textContent = state.profile.display_name;
            $("#accountInitial").textContent = (state.profile.display_name || "?").charAt(0).toUpperCase();
            $("#menuName").textContent = state.profile.display_name;
            $("#menuRole").textContent = state.profile.role;
            $("#creatorLink").classList.toggle("hidden", !["author", "admin"].includes(state.profile.role));
        }
        renderCommentAuthState();
    }

    if (supabase) {
        supabase.auth.onAuthStateChange((_event, session) => {
            state.session = session;
            refreshSession().then(() => {
                if (state.currentArticle) renderReactionState();
            });
        });
    }

    // Auth modal wiring
    const authModal = $("#authModal");
    function openAuth() { if (!supabase) { toast("Konfigurera Supabase i js/config.js först.", "error"); return; } authModal.classList.add("open"); $("#authError").classList.remove("show"); }
    function closeAuth() { authModal.classList.remove("open"); }
    $("#loginOpenBtn").addEventListener("click", openAuth);
    $("#authCloseBtn").addEventListener("click", closeAuth);
    authModal.addEventListener("click", e => { if (e.target === authModal) closeAuth(); });
    $("#commentLoginBtn") && $("#commentLoginBtn").addEventListener("click", openAuth);

    $all(".auth-tab").forEach(tab => tab.addEventListener("click", () => {
        $all(".auth-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        const isLogin = tab.dataset.tab === "login";
        $("#loginFormEl").classList.toggle("hidden", !isLogin);
        $("#signupFormEl").classList.toggle("hidden", isLogin);
        $("#authError").classList.remove("show");
    }));

    function showAuthError(msg) {
        const el = $("#authError");
        el.textContent = msg;
        el.classList.add("show");
    }

    $("#loginFormEl").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = $("#loginSubmitBtn");
        btn.disabled = true;
        const email = $("#loginEmail").value.trim();
        const password = $("#loginPassword").value;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        btn.disabled = false;
        if (error) { showAuthError(översättAuthFel(error.message)); return; }
        closeAuth();
        toast("Inloggad!", "success");
    });

    $("#signupFormEl").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = $("#signupSubmitBtn");
        btn.disabled = true;
        const displayName = $("#signupName").value.trim();
        const email = $("#signupEmail").value.trim();
        const password = $("#signupPassword").value;
        const { error } = await supabase.auth.signUp({
            email, password,
            options: { data: { display_name: displayName } }
        });
        btn.disabled = false;
        if (error) { showAuthError(översättAuthFel(error.message)); return; }
        closeAuth();
        toast("Konto skapat! Du är nu inloggad.", "success");
    });

    function översättAuthFel(msg) {
        if (/already registered/i.test(msg)) return "Det finns redan ett konto med den e-postadressen.";
        if (/invalid login/i.test(msg)) return "Fel e-post eller lösenord.";
        if (/password/i.test(msg) && /6/i.test(msg)) return "Lösenordet måste vara minst 6 tecken.";
        return "Något gick fel: " + msg;
    }

    $("#accountMenuBtn").addEventListener("click", () => $("#accountMenu").classList.toggle("open"));
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".account-wrap")) $("#accountMenu").classList.remove("open");
    });
    $("#logoutBtn").addEventListener("click", async () => {
        await supabase.auth.signOut();
        $("#accountMenu").classList.remove("open");
        toast("Utloggad.");
        route();
    });

    // ------------------------------------------------------------------
    // 6. DATA LAYER
    // ------------------------------------------------------------------
    const ARTICLE_FIELDS = "id, title, slug, excerpt, category, image_url, status, published_at, updated_at, views, like_count, dislike_count, love_count, laugh_count, wow_count, is_breaking, is_live, author_id, profiles!articles_author_id_fkey(display_name)";

    async function fetchPublished({ category, limit = 9, offset = 0, order = "published_at" } = {}) {
        if (!supabase) return { data: [], count: 0 };
        let q = supabase.from("articles")
            .select(ARTICLE_FIELDS, { count: "exact" })
            .eq("status", "published")
            .order(order, { ascending: false })
            .range(offset, offset + limit - 1);
        if (category) q = q.eq("category", category);
        const { data, error, count } = await q;
        if (error) { console.error(error); return { data: [], count: 0 }; }
        return { data, count };
    }

    async function fetchArticleBySlug(slug) {
        if (!supabase) return null;
        const { data, error } = await supabase
            .from("articles")
            .select("*, profiles!articles_author_id_fkey(display_name)")
            .eq("slug", slug)
            .eq("status", "published")
            .maybeSingle();
        if (error) { console.error(error); return null; }
        return data;
    }

    async function searchArticles(term) {
        if (!supabase || !term || term.trim().length < 2) return [];
        const t = `%${term.trim()}%`;
        const { data, error } = await supabase
            .from("articles")
            .select(ARTICLE_FIELDS)
            .eq("status", "published")
            .or(`title.ilike.${t},excerpt.ilike.${t},category.ilike.${t},content_html.ilike.${t}`)
            .order("published_at", { ascending: false })
            .limit(24);
        if (error) { console.error(error); return []; }
        return data;
    }

    async function fetchComments(articleId) {
        if (!supabase) return [];
        const { data, error } = await supabase
            .from("comments")
            .select("id, body, created_at, user_id, profiles!comments_user_id_fkey(display_name)")
            .eq("article_id", articleId)
            .eq("status", "published")
            .order("created_at", { ascending: false });
        if (error) { console.error(error); return []; }
        return data;
    }

    // ------------------------------------------------------------------
    // 7. CARD / LIST RENDERING
    // ------------------------------------------------------------------
    function categoryTag(cat) {
        return `<span class="cat-tag" style="--cat-color:var(--cat-${cat})">${CATEGORY_LABELS[cat] || cat}</span>`;
    }

    function cardReactionsHtml(a) {
        const withCounts = REACTIONS
            .map(r => ({ emoji: r.emoji, count: a[r.field] || 0 }))
            .filter(r => r.count > 0)
            .sort((x, y) => y.count - x.count)
            .slice(0, 3);
        if (!withCounts.length) return "";
        return `<div class="card-reactions">${withCounts.map(r =>
            `<span>${r.emoji} ${r.count}</span>`).join("")}</div>`;
    }

    function breakingBadgeHtml(a) {
        return a && a.is_breaking ? `<span class="breaking-badge">🔴 BREAKING</span>` : "";
    }

    function articleCardHtml(a) {
        const img = a.image_url || placeholderImg(a.slug);
        const authorName = a.profiles ? a.profiles.display_name : "";
        return `
        <a class="article-card" href="#/artikel/${a.slug}" data-link>
            <div class="img-wrap"><img src="${escapeHtml(img)}" alt="" loading="lazy">${breakingBadgeHtml(a)}</div>
            ${categoryTag(a.category)}
            <h3>${escapeHtml(a.title)}</h3>
            <p class="excerpt">${escapeHtml(a.excerpt || "")}</p>
            <div class="card-stats">
                <span title="Visningar">👁 ${a.views || 0}</span>
                ${cardReactionsHtml(a)}
            </div>
        </a>`;
    }

    function skeletonCards(n) {
        return Array.from({ length: n }).map(() => `
            <div class="skel-card">
                <div class="skel skel-img"></div>
                <div class="skel skel-line w60"></div>
                <div class="skel skel-line w80"></div>
            </div>`).join("");
    }

    function emptyState(title, msg) {
        return `<div class="state-block"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(msg)}</p></div>`;
    }

    // Category filter chips
    function renderCategoryFilters() {
        const el = $("#categoryFilters");
        el.innerHTML = `<button class="chip active" data-cat="">Alla</button>` +
            CATEGORY_ORDER.map(c => `<button class="chip" data-cat="${c}">${CATEGORY_LABELS[c]}</button>`).join("");
        $all(".chip", el).forEach(chip => chip.addEventListener("click", () => {
            const cat = chip.dataset.cat;
            location.hash = cat ? `#/kategori/${cat}` : "#/";
        }));
    }

    // ------------------------------------------------------------------
    // 8. HOME VIEW
    // ------------------------------------------------------------------
    async function renderHome() {
        showOnly("viewHome");
        $("#heroGrid").innerHTML = `<div class="skel-card"><div class="skel skel-img"></div></div>` +
            `<div class="top-list">${skeletonCards(4)}</div>`;
        $("#latestGrid").innerHTML = skeletonCards(6);
        $("#mostReadGrid").innerHTML = skeletonCards(3);

        const { data: topStories } = await fetchPublished({ limit: 6 });
        renderHero(topStories);

        state.latestOffset = 0;
        const { data: latest, count } = await fetchPublished({ limit: state.latestPageSize, offset: 0 });
        renderGridInto("#latestGrid", latest, "Inga artiklar publicerade ännu.");
        $("#loadMoreBtn").classList.toggle("hidden", !(count > state.latestPageSize));
        state.latestOffset = latest.length;

        const { data: mostRead } = await fetchPublished({ limit: 3, order: "views" });
        renderGridInto("#mostReadGrid", mostRead, "Ingen statistik ännu.");
    }

    function renderHero(items) {
        const grid = $("#heroGrid");
        if (!items || !items.length) {
            grid.innerHTML = emptyState("Inga artiklar ännu", "Publicera din första artikel i Artikelskaparen.");
            return;
        }
        const main = items[0];
        const rest = items.slice(1, 5);
        const img = main.image_url || placeholderImg(main.slug);
        grid.innerHTML = `
            <a class="hero-main" href="#/artikel/${main.slug}" data-link>
                <div class="hero-img-wrap"><img src="${escapeHtml(img)}" alt=""></div>
                ${categoryTag(main.category)}
                <h2>${escapeHtml(main.title)}</h2>
                <p class="excerpt">${escapeHtml(main.excerpt || "")}</p>
                <div class="meta-row"><span>${formatDate(main.published_at)}</span></div>
            </a>
            <div class="top-list">
                <div class="top-list-heading">Fler toppnyheter</div>
                ${rest.map(a => `
                    <a class="top-item" href="#/artikel/${a.slug}" data-link>
                        <img class="thumb" src="${escapeHtml(a.image_url || placeholderImg(a.slug))}" alt="">
                        <div>
                            ${categoryTag(a.category)}
                            <h3>${escapeHtml(a.title)}</h3>
                        </div>
                    </a>`).join("") || `<p style="color:var(--bp-ink-faint);font-size:0.9rem;">Fler nyheter dyker upp här snart.</p>`}
            </div>`;
        bindLinks(grid);
    }

    function renderGridInto(sel, items, emptyMsg) {
        const el = $(sel);
        if (!items || !items.length) { el.innerHTML = emptyState("Inget att visa", emptyMsg); return; }
        el.innerHTML = items.map(articleCardHtml).join("");
        bindLinks(el);
    }

    $("#loadMoreBtn").addEventListener("click", async () => {
        const btn = $("#loadMoreBtn");
        btn.disabled = true; btn.textContent = "Laddar…";
        const { data, count } = await fetchPublished({ limit: state.latestPageSize, offset: state.latestOffset });
        const el = $("#latestGrid");
        el.insertAdjacentHTML("beforeend", data.map(articleCardHtml).join(""));
        bindLinks(el);
        state.latestOffset += data.length;
        btn.disabled = false; btn.textContent = "Visa fler artiklar";
        if (state.latestOffset >= count) btn.classList.add("hidden");
    });

    // ------------------------------------------------------------------
    // 9. CATEGORY / "SENASTE" VIEW
    // ------------------------------------------------------------------
    async function renderCategory(cat) {
        showOnly("viewCategory");
        state.currentCategory = cat;
        state.categoryOffset = 0;
        $("#categoryTitle").textContent = cat ? CATEGORY_LABELS[cat] || cat : "Senaste nytt";
        $("#categoryGrid").innerHTML = skeletonCards(9);
        const { data, count } = await fetchPublished({ category: cat || undefined, limit: 12, offset: 0 });
        renderGridInto("#categoryGrid", data, "Inga artiklar i den här kategorin ännu.");
        state.categoryOffset = data.length;
        $("#categoryLoadMoreBtn").classList.toggle("hidden", !(count > data.length));
    }

    $("#categoryLoadMoreBtn").addEventListener("click", async () => {
        const btn = $("#categoryLoadMoreBtn");
        btn.disabled = true; btn.textContent = "Laddar…";
        const { data, count } = await fetchPublished({ category: state.currentCategory || undefined, limit: 12, offset: state.categoryOffset });
        const el = $("#categoryGrid");
        el.insertAdjacentHTML("beforeend", data.map(articleCardHtml).join(""));
        bindLinks(el);
        state.categoryOffset += data.length;
        btn.disabled = false; btn.textContent = "Visa fler artiklar";
        if (state.categoryOffset >= count) btn.classList.add("hidden");
    });

    // ------------------------------------------------------------------
    // 10. SÖKNING (overlay + fullsida)
    // ------------------------------------------------------------------
    let searchDebounce;
    const searchPanel = $("#searchPanel");
    $("#searchOpenBtn").addEventListener("click", () => {
        searchPanel.classList.add("open");
        $("#searchInput").value = "";
        $("#searchOverlayResults").innerHTML = `<div class="search-empty">Börja skriva för att söka bland alla artiklar.</div>`;
        setTimeout(() => $("#searchInput").focus(), 50);
    });
    $("#searchCloseBtn").addEventListener("click", () => searchPanel.classList.remove("open"));
    searchPanel.addEventListener("click", e => { if (e.target === searchPanel) searchPanel.classList.remove("open"); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") searchPanel.classList.remove("open"); });

    $("#searchInput").addEventListener("input", (e) => {
        clearTimeout(searchDebounce);
        const term = e.target.value;
        searchDebounce = setTimeout(async () => {
            if (term.trim().length < 2) {
                $("#searchOverlayResults").innerHTML = `<div class="search-empty">Skriv minst 2 tecken.</div>`;
                return;
            }
            const results = await searchArticles(term);
            renderSearchOverlay(results);
        }, 280);
    });

    function renderSearchOverlay(results) {
        const el = $("#searchOverlayResults");
        if (!results.length) { el.innerHTML = `<div class="search-empty">Inga träffar.</div>`; return; }
        el.innerHTML = results.map(a => `
            <a class="search-result-item" href="#/artikel/${a.slug}" data-link>
                <img src="${escapeHtml(a.image_url || placeholderImg(a.slug))}" alt="">
                <div>
                    <div class="srt">${escapeHtml(a.title)}</div>
                    <div class="src">${CATEGORY_LABELS[a.category] || a.category} · ${formatDate(a.published_at)}</div>
                </div>
            </a>`).join("");
        bindLinks(el);
        $all(".search-result-item", el).forEach(a => a.addEventListener("click", () => searchPanel.classList.remove("open")));
    }

    async function renderSearchPage(term) {
        showOnly("viewSearch");
        $("#searchTitle").textContent = `Sökresultat för "${term}"`;
        $("#searchGrid").innerHTML = skeletonCards(6);
        const results = await searchArticles(term);
        renderGridInto("#searchGrid", results, "Inga artiklar matchade din sökning.");
    }

    // ------------------------------------------------------------------
    // 11. BREAKING NEWS BAR
    // ------------------------------------------------------------------
    async function renderBreaking() {
        if (!supabase) return;
        let { data } = await supabase.from("articles").select(ARTICLE_FIELDS)
            .eq("status", "published").eq("is_breaking", true)
            .order("published_at", { ascending: false }).limit(6);
        let isBreaking = true;
        if (!data || !data.length) {
            isBreaking = false;
            const res = await fetchPublished({ limit: 6 });
            data = res.data;
        }
        if (!data || !data.length) return;
        $("#breakingBar").hidden = false;
        $(".breaking-tag", $("#breakingBar")).textContent = isBreaking ? "🔴 BREAKING" : "Senaste";
        $("#breakingBar").classList.toggle("is-live-breaking", isBreaking);
        const list = $("#breakingList");
        const items = data.map(a => `<li><a href="#/artikel/${a.slug}" data-link>${a.is_breaking ? "🔴 " : ""}${escapeHtml(a.title)}</a></li>`).join("");
        list.innerHTML = items + items; // dubblera för sömlös scroll-loop
        bindLinks(list);
    }

    // ------------------------------------------------------------------
    // 12. ARTIKELVY
    // ------------------------------------------------------------------
    async function renderArticle(slug) {
        showOnly("viewArticle");
        window.scrollTo({ top: 0 });
        const article = await fetchArticleBySlug(slug);
        if (!article) { showOnly("viewNotFound"); return; }

        state.currentArticle = article;
        document.title = article.title + " — Bjärehovs Pressen";

        const catEl = document.createElement("div");
        catEl.innerHTML = categoryTag(article.category);
        const newCatSpan = catEl.firstElementChild;
        newCatSpan.id = "artCat";
        $("#artCat").replaceWith(newCatSpan);
        $("#artBreakingBadge").innerHTML = breakingBadgeHtml(article);
        $("#artTitle").textContent = article.title;
        $("#artExcerpt").textContent = article.excerpt || "";
        $("#artAuthor").textContent = article.profiles ? article.profiles.display_name : "Bjärehovs Pressen";
        $("#artDates").textContent = "Publicerad " + formatDate(article.published_at) +
            (article.updated_at && article.updated_at !== article.created_at ? " · Uppdaterad " + formatDate(article.updated_at) : "");

        const coverWrap = $("#artCoverWrap");
        if (article.image_url) {
            coverWrap.hidden = false;
            $("#artCoverImg").src = article.image_url;
            $("#artCoverImg").alt = article.title;
        } else {
            coverWrap.hidden = true;
        }

        $("#artBody").innerHTML = article.content_html || "";

        REACTIONS.forEach(r => {
            const el = document.getElementById(r.key + "Count");
            if (el) el.textContent = article[r.field] || 0;
        });
        $("#viewsHint").textContent = (article.views || 0) + " visningar";

        state.myReaction = null;
        renderReactionState();
        loadMyReaction(article.id);

        $("#copyLinkBtn").onclick = () => {
            const url = location.origin + location.pathname + "#/artikel/" + article.slug;
            navigator.clipboard.writeText(url).then(() => toast("Länk kopierad!", "success"))
                .catch(() => toast("Kunde inte kopiera länken.", "error"));
        };

        // Öka visningsräknaren (server-side via RPC), men bara en gång per
        // flik/session och artikel så att en siduppdatering inte spammar
        // räknaren. Uppdatera texten på sidan så man faktiskt SER att den ökar.
        const viewedKey = "bp_viewed_" + article.id;
        if (supabase && !sessionStorage.getItem(viewedKey)) {
            supabase.rpc("increment_article_views", { p_article_id: article.id })
                .then(({ error }) => {
                    if (error) { console.error("increment_article_views misslyckades:", error); return; }
                    sessionStorage.setItem(viewedKey, "1");
                    const newViews = (article.views || 0) + 1;
                    article.views = newViews;
                    $("#viewsHint").textContent = newViews + " visningar";
                })
                .catch(err => console.error("increment_article_views misslyckades:", err));
        }

        loadComments(article.id);
        renderCommentAuthState();
        loadRelated(article);
        renderLiveUpdates(article);
    }

    // ------------------------------------------------------------------
    // 12b. LIVE-ARTIKLAR (tidsstämplade uppdateringar)
    // ------------------------------------------------------------------
    let liveUpdatesTimer = null;
    async function renderLiveUpdates(article) {
        const wrap = $("#liveUpdatesBlock");
        if (liveUpdatesTimer) { clearInterval(liveUpdatesTimer); liveUpdatesTimer = null; }
        if (!article.is_live || !supabase) { wrap.classList.add("hidden"); return; }
        wrap.classList.remove("hidden");

        async function load() {
            const { data } = await supabase.from("live_updates")
                .select("id, body, occurred_at")
                .eq("article_id", article.id)
                .order("occurred_at", { ascending: false });
            const list = $("#liveUpdatesList");
            if (!data || !data.length) {
                list.innerHTML = `<p style="color:var(--bp-ink-faint);">Inga uppdateringar ännu.</p>`;
                return;
            }
            list.innerHTML = data.map(u => `
                <div class="live-update-item">
                    <span class="live-update-time">${formatTime(u.occurred_at)}</span>
                    <span class="live-update-body">${escapeHtml(u.body)}</span>
                </div>`).join("");
        }
        await load();
        // Poll för nya uppdateringar var 20:e sekund medan sidan är öppen.
        liveUpdatesTimer = setInterval(load, 20000);
    }

    function formatTime(iso) {
        const d = new Date(iso);
        return d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
    }

    function renderReactionState() {
        $all("#reactionBar .reaction-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.reaction === state.myReaction);
        });
    }

    async function loadMyReaction(articleId) {
        if (!supabase || !state.session) { state.myReaction = null; renderReactionState(); return; }
        const { data } = await supabase.from("article_reactions")
            .select("reaction").eq("article_id", articleId).eq("user_id", state.session.user.id).maybeSingle();
        state.myReaction = data ? data.reaction : null;
        renderReactionState();
    }

    function bumpCount(reactionKey, delta) {
        if (!reactionKey) return;
        const el = document.getElementById(reactionKey + "Count");
        if (!el) return;
        el.textContent = Math.max(0, (parseInt(el.textContent) || 0) + delta);
    }

    async function setReaction(reaction) {
        if (!supabase || !state.session) { openAuth(); return; }
        const article = state.currentArticle;
        if (!article) return;
        const prev = state.myReaction;
        const next = prev === reaction ? null : reaction;

        // Optimistisk uppdatering — bara den gamla och den nya reaktionens
        // räknare ändras, resten lämnas orörda.
        bumpCount(prev, -1);
        bumpCount(next, 1);
        state.myReaction = next;
        renderReactionState();

        const { error } = await supabase.rpc("set_my_reaction", { p_article_id: article.id, p_reaction: next });
        if (error) { toast("Kunde inte spara din reaktion.", "error"); console.error(error); }
    }
    $("#reactionBar").addEventListener("click", (e) => {
        const btn = e.target.closest(".reaction-btn");
        if (btn) setReaction(btn.dataset.reaction);
    });

    async function loadRelated(article) {
        const { data } = await fetchPublished({ category: article.category, limit: 4 });
        const related = data.filter(a => a.id !== article.id).slice(0, 3);
        const block = $("#relatedBlock");
        if (!related.length) { block.classList.add("hidden"); return; }
        block.classList.remove("hidden");
        $("#relatedGrid").innerHTML = related.map(articleCardHtml).join("");
        bindLinks($("#relatedGrid"));
    }

    // ---- Kommentarer ----
    function renderCommentAuthState() {
        const loggedIn = !!state.session;
        $("#loginToComment").classList.toggle("hidden", loggedIn);
        $("#commentForm").classList.toggle("hidden", !loggedIn);
    }

    $("#commentInput").addEventListener("input", (e) => {
        const len = e.target.value.length;
        const counter = $("#commentCharCount");
        counter.textContent = `${len} / 2000`;
        counter.classList.toggle("warn", len > 1900);
    });

    $("#commentForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!supabase || !state.session || !state.currentArticle) return;
        const input = $("#commentInput");
        const body = input.value.trim();
        if (!body) { toast("Kommentaren kan inte vara tom.", "error"); return; }
        if (body.length > 2000) { toast("Kommentaren är för lång (max 2000 tecken).", "error"); return; }

        const btn = $("#commentSubmitBtn");
        btn.disabled = true;
        const { error } = await supabase.from("comments").insert({
            article_id: state.currentArticle.id,
            user_id: state.session.user.id,
            body
        });
        btn.disabled = false;
        if (error) { toast("Kunde inte publicera kommentaren.", "error"); console.error(error); return; }
        input.value = "";
        $("#commentCharCount").textContent = "0 / 2000";
        toast("Kommentar publicerad!", "success");
        loadComments(state.currentArticle.id);
    });

    async function loadComments(articleId) {
        const list = $("#commentsList");
        list.innerHTML = `<div class="skel skel-line w60" style="margin:14px 0;"></div>`;
        const comments = await fetchComments(articleId);
        $("#commentsHeading").textContent = `Kommentarer (${comments.length})`;
        if (!comments.length) {
            list.innerHTML = `<p style="color:var(--bp-ink-faint);padding:16px 0;">Inga kommentarer ännu. Var första att kommentera.</p>`;
            return;
        }
        list.innerHTML = comments.map(c => {
            const name = c.profiles ? c.profiles.display_name : "Anonym";
            const mine = state.session && state.session.user.id === c.user_id;
            const isAdmin = state.profile && state.profile.role === "admin";
            return `
            <div class="comment-item" data-id="${c.id}">
                <div class="comment-avatar">${escapeHtml(name.charAt(0).toUpperCase())}</div>
                <div style="flex:1;">
                    <div class="comment-head">
                        <span class="comment-author">${escapeHtml(name)}</span>
                        <span class="comment-date">${timeAgo(c.created_at)}</span>
                    </div>
                    <div class="comment-body">${escapeHtml(c.body)}</div>
                    ${(mine || isAdmin) ? `<button class="comment-delete" data-del="${c.id}">Ta bort</button>` : ""}
                </div>
            </div>`;
        }).join("");

        $all("[data-del]", list).forEach(btn => btn.addEventListener("click", async () => {
            if (!confirm("Vill du ta bort kommentaren?")) return;
            const { error } = await supabase.from("comments").delete().eq("id", btn.dataset.del);
            if (error) { toast("Kunde inte ta bort kommentaren.", "error"); return; }
            loadComments(articleId);
        }));
    }

    // ------------------------------------------------------------------
    // 12c. "VAD DU MISSADE" — nya artiklar sedan senaste besöket (localStorage)
    // ------------------------------------------------------------------
    async function renderMissedBanner() {
        if (!supabase) return;
        const key = "bp_last_visit";
        const last = localStorage.getItem(key);
        const now = new Date().toISOString();
        const banner = $("#missedBanner");
        if (last) {
            const { count } = await supabase.from("articles").select("id", { count: "exact", head: true })
                .eq("status", "published").gt("published_at", last);
            if (count && count > 0) {
                banner.classList.remove("hidden");
                banner.innerHTML = `📰 <strong>${count}</strong> ${count === 1 ? "ny artikel" : "nya artiklar"} sedan ditt senaste besök. <a href="#/senaste" data-link>Visa dem</a>`;
                bindLinks(banner);
            } else {
                banner.classList.add("hidden");
            }
        }
        localStorage.setItem(key, now);
    }

    // ------------------------------------------------------------------
    // 12d. NYHETSTIPS ("Skicka in ett tips")
    // ------------------------------------------------------------------
    const tipModal = $("#tipModal");
    function openTipModal() {
        if (!supabase) { toast("Konfigurera Supabase i js/config.js först.", "error"); return; }
        if (!state.session) { toast("Logga in för att skicka in ett tips.", "error"); openAuth(); return; }
        tipModal.classList.add("open");
    }
    function closeTipModal() { tipModal.classList.remove("open"); }
    $("#tipOpenBtn") && $("#tipOpenBtn").addEventListener("click", openTipModal);
    $("#tipCloseBtn") && $("#tipCloseBtn").addEventListener("click", closeTipModal);
    tipModal && tipModal.addEventListener("click", (e) => { if (e.target === tipModal) closeTipModal(); });

    $("#tipFormEl") && $("#tipFormEl").addEventListener("submit", async (e) => {
        e.preventDefault();
        const what = $("#tipWhat").value.trim();
        const whereText = $("#tipWhere").value.trim();
        const anonymous = $("#tipAnonymous").checked;
        if (!what) return;
        const btn = $("#tipSubmitBtn");
        btn.disabled = true;
        const { error } = await supabase.from("news_tips").insert({
            what, where_text: whereText, anonymous,
            reporter_id: anonymous ? null : state.session.user.id
        });
        btn.disabled = false;
        if (error) { toast("Kunde inte skicka in tipset.", "error"); console.error(error); return; }
        toast("Tack! Ditt tips har skickats till redaktionen.", "success");
        $("#tipFormEl").reset();
        closeTipModal();
    });

    // ------------------------------------------------------------------
    // 12e. BILDGALLERI
    // ------------------------------------------------------------------
    async function renderGalleryList() {
        showOnly("viewGallery");
        $("#galleryListView").classList.remove("hidden");
        $("#galleryDetailView").classList.add("hidden");
        $("#galleryListGrid").innerHTML = skeletonCards(6);
        const { data, error } = await supabase.from("galleries")
            .select("id, title, description, cover_image_url, created_at")
            .eq("status", "published").order("created_at", { ascending: false });
        if (error) { console.error(error); return; }
        const el = $("#galleryListGrid");
        if (!data || !data.length) { el.innerHTML = emptyState("Inga bildgallerier ännu", "Redaktionen har inte publicerat några bildgallerier ännu."); return; }
        el.innerHTML = data.map(g => `
            <a class="article-card" href="#/galleri/${g.id}" data-link>
                <div class="img-wrap"><img src="${escapeHtml(g.cover_image_url || placeholderImg(g.id))}" alt="" loading="lazy"></div>
                <h3>📸 ${escapeHtml(g.title)}</h3>
                <p class="excerpt">${escapeHtml(g.description || "")}</p>
            </a>`).join("");
        bindLinks(el);
    }

    async function renderGalleryDetail(id) {
        showOnly("viewGallery");
        $("#galleryListView").classList.add("hidden");
        $("#galleryDetailView").classList.remove("hidden");
        $("#galleryDetailGrid").innerHTML = skeletonCards(6);
        const { data: gallery } = await supabase.from("galleries")
            .select("id, title, description").eq("id", id).maybeSingle();
        if (!gallery) { showOnly("viewNotFound"); return; }
        $("#galleryDetailTitle").textContent = "📸 " + gallery.title;
        $("#galleryDetailDesc").textContent = gallery.description || "";
        const { data: images } = await supabase.from("gallery_images")
            .select("id, image_url, caption").eq("gallery_id", id).order("position", { ascending: true });
        const el = $("#galleryDetailGrid");
        el.innerHTML = (images || []).map(img => `
            <figure class="gallery-photo">
                <img src="${escapeHtml(img.image_url)}" alt="${escapeHtml(img.caption || "")}" loading="lazy">
                ${img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : ""}
            </figure>`).join("") || "<p>Inga bilder i det här galleriet ännu.</p>";
    }

    // ------------------------------------------------------------------
    // 13. ROUTER (hash-baserad — funkar utan serverkonfiguration på GitHub Pages)
    // ------------------------------------------------------------------
    function showOnly(id) {
        ["viewHome", "viewCategory", "viewSearch", "viewArticle", "viewGallery", "viewNotFound"].forEach(v => {
            $("#" + v).classList.toggle("hidden", v !== id);
        });
    }

    function bindLinks(root) {
        $all("[data-link]", root).forEach(a => {
            a.addEventListener("click", (e) => {
                // Låt vanlig navigation ske via hashchange, men markera aktiv kategori
            });
        });
    }

    function highlightActiveNav(cat) {
        $all(".nav-list a").forEach(a => a.classList.toggle("active", a.dataset.cat === (cat || "")));
    }

    async function route() {
        const hash = location.hash || "#/";
        document.title = "Bjärehovs Pressen — Nyheter från Bjärehov och världen";
        $("#searchPanel").classList.remove("open");

        if (hash === "#/" || hash === "") {
            highlightActiveNav("");
            await renderHome();
        } else if (hash === "#/senaste") {
            highlightActiveNav("senaste");
            await renderCategory(null);
        } else if (hash.startsWith("#/kategori/")) {
            const cat = decodeURIComponent(hash.split("/")[2] || "");
            highlightActiveNav(cat);
            await renderCategory(cat);
        } else if (hash.startsWith("#/artikel/")) {
            highlightActiveNav("");
            const slug = decodeURIComponent(hash.split("/")[2] || "");
            await renderArticle(slug);
        } else if (hash.startsWith("#/sok/")) {
            highlightActiveNav("");
            const term = decodeURIComponent(hash.split("/")[2] || "");
            await renderSearchPage(term);
        } else if (hash === "#/galleri") {
            highlightActiveNav("galleri");
            await renderGalleryList();
        } else if (hash.startsWith("#/galleri/")) {
            highlightActiveNav("galleri");
            const id = decodeURIComponent(hash.split("/")[2] || "");
            await renderGalleryDetail(id);
        } else {
            showOnly("viewNotFound");
        }
    }

    window.addEventListener("hashchange", route);

    // ------------------------------------------------------------------
    // 14. INIT
    // ------------------------------------------------------------------
    $("#footerYear").textContent = new Date().getFullYear();
    renderCategoryFilters();

    if (!CONFIG_OK) {
        toast("Supabase är inte konfigurerat än — fyll i js/config.js. Se README.md.", "error");
    } else if (!supabase) {
        toast("Supabase-biblioteket kunde inte laddas. Kontrollera din internetanslutning eller ladda om sidan.", "error");
    }

    (async function init() {
        await refreshSession();
        await renderBreaking();
        await renderMissedBanner();
        await route();
    })();

})();
