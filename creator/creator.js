// ============================================================================
// ARTIKELSKAPAREN — creator.js
// Endast för author/admin. Behörighet kontrolleras även av Supabase RLS,
// detta är bara UI-lagret.
// ============================================================================
(function () {
    "use strict";

    const cfg = window.BP_CONFIG || {};
    const CONFIG_OK = cfg.supabaseUrl && !cfg.supabaseUrl.includes("DITT-PROJEKT")
        && cfg.supabasePublishableKey && !cfg.supabasePublishableKey.includes("DIN-PUBLIC");
    const supabase = CONFIG_OK ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey) : null;
    const IMAGE_BUCKET = cfg.imageBucket || "article-images";

    const CATEGORY_LABELS = {
        lokalt: "Lokalt", sverige: "Sverige", varlden: "Världen", sport: "Sport",
        kultur: "Kultur", tech: "Tech", ekonomi: "Ekonomi", opinion: "Opinion", bus: "Bus"
    };
    const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    function toast(msg, type) {
        const stack = $("#toastStack");
        const el = document.createElement("div");
        el.className = "toast" + (type ? " " + type : "");
        el.textContent = msg;
        stack.appendChild(el);
        setTimeout(() => el.remove(), 4200);
    }

    function slugify(str) {
        const map = { å: "a", ä: "a", ö: "o", Å: "a", Ä: "a", Ö: "o", é: "e", è: "e" };
        return (str || "")
            .split("").map(ch => map[ch] || ch).join("")
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 90);
    }

    // ------------------------------------------------------------------
    // STATE
    // ------------------------------------------------------------------
    const state = {
        session: null,
        profile: null,
        currentId: null,       // uuid av artikeln som redigeras, eller null om ny
        coverUrl: null,
        category: "lokalt",
        dirty: false,
        saving: false,
        quill: null,
        myArticles: []
    };

    // ------------------------------------------------------------------
    // GATE / ACCESS CONTROL
    // ------------------------------------------------------------------
    function showGate(which) {
        ["gateLoading", "gateDenied", "gateLoggedOut"].forEach(id => $("#" + id).classList.add("hidden"));
        $("#editorShell").classList.add("hidden");
        $("#listShell").classList.add("hidden");
        $("#topbarActions").style.visibility = "hidden";
        if (which) $("#" + which).classList.remove("hidden");
    }

    async function boot() {
        if (!CONFIG_OK) {
            showGate("gateLoggedOut");
            toast("Supabase är inte konfigurerat i js/config.js.", "error");
            return;
        }
        showGate("gateLoading");
        const { data: { session } } = await supabase.auth.getSession();
        state.session = session;
        if (!session) { showGate("gateLoggedOut"); return; }

        const { data: profile, error } = await supabase.from("profiles")
            .select("id, display_name, role").eq("id", session.user.id).single();
        if (error || !profile) { showGate("gateDenied"); return; }
        state.profile = profile;

        if (!["author", "admin"].includes(profile.role)) { showGate("gateDenied"); return; }

        $("#topbarActions").style.visibility = "visible";
        initEditorUI();
        $("#editorShell").classList.remove("hidden");

        const params = new URLSearchParams(location.search);
        const id = params.get("id");
        if (id) {
            await loadArticleIntoEditor(id);
        } else {
            resetEditor();
        }
    }

    supabase && supabase.auth.onAuthStateChange((_e, session) => {
        state.session = session;
        if (!session) showGate("gateLoggedOut");
    });

    $("#gateLoginForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errEl = $("#gateAuthError");
        errEl.classList.remove("show");
        const email = $("#gateEmail").value.trim();
        const password = $("#gatePassword").value;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            errEl.textContent = "Fel e-post eller lösenord.";
            errEl.classList.add("show");
            return;
        }
        boot();
    });

    $("#logoutBtn").addEventListener("click", async () => {
        await supabase.auth.signOut();
        showGate("gateLoggedOut");
    });

    // ------------------------------------------------------------------
    // EDITOR INIT (körs en gång när gaten öppnas)
    // ------------------------------------------------------------------
    let editorInitialized = false;
    function initEditorUI() {
        if (editorInitialized) return;
        editorInitialized = true;

        // Quill rich text editor
        state.quill = new Quill("#quillEditor", {
            theme: "snow",
            placeholder: "Skriv din artikel här…",
            modules: {
                toolbar: {
                    container: [
                        [{ header: [1, 2, 3, false] }],
                        [{ font: [] }, { size: ["small", false, "large", "huge"] }],
                        ["bold", "italic", "underline", "strike"],
                        [{ color: [] }, { background: [] }],
                        [{ align: [] }],
                        [{ list: "ordered" }, { list: "bullet" }, { indent: "-1" }, { indent: "+1" }],
                        ["blockquote", "code-block", "link", "image"],
                        ["clean"]
                    ],
                    handlers: { image: handleEditorImageInsert }
                },
                history: { delay: 800, maxStack: 200, userOnly: true }
            }
        });

        state.quill.on("text-change", () => { markDirty(); updateWordCount(); });
        updateWordCount();

        // Category grid
        $("#categoryGrid").innerHTML = CATEGORY_ORDER.map(c => `
            <label class="cat-radio" data-cat="${c}">
                <input type="radio" name="cat" value="${c}" ${c === state.category ? "checked" : ""}>
                ${CATEGORY_LABELS[c]}
            </label>`).join("");
        $all(".cat-radio").forEach(l => {
            l.classList.toggle("checked", l.dataset.cat === state.category);
            l.addEventListener("click", () => {
                state.category = l.dataset.cat;
                $all(".cat-radio").forEach(x => x.classList.toggle("checked", x.dataset.cat === state.category));
                markDirty();
            });
        });

        // Title -> slug auto-generate (only if user hasn't manually edited slug for this session)
        let slugManuallyEdited = false;
        $("#titleInput").addEventListener("input", () => {
            if (!slugManuallyEdited) {
                $("#slugInput").value = slugify($("#titleInput").value);
                $("#slugPreview").textContent = $("#slugInput").value || "…";
            }
            markDirty();
        });
        $("#slugInput").addEventListener("input", () => {
            slugManuallyEdited = true;
            $("#slugInput").value = slugify($("#slugInput").value);
            $("#slugPreview").textContent = $("#slugInput").value || "…";
            markDirty();
        });
        $("#regenSlugBtn").addEventListener("click", () => {
            slugManuallyEdited = false;
            $("#slugInput").value = slugify($("#titleInput").value);
            $("#slugPreview").textContent = $("#slugInput").value || "…";
            markDirty();
        });
        $("#excerptInput").addEventListener("input", markDirty);
        $("#publishAtInput").addEventListener("input", markDirty);

        // Cover image
        $("#coverDrop").addEventListener("click", (e) => { /* label triggers input automatically */ });
        $("#coverInput").addEventListener("change", handleCoverUpload);
        $("#removeCoverBtn").addEventListener("click", (e) => {
            e.preventDefault();
            state.coverUrl = null;
            $("#coverPreviewWrap").classList.add("hidden");
            $("#coverDrop").classList.remove("hidden");
            markDirty();
        });

        // Buttons
        $("#newArticleBtn").addEventListener("click", () => {
            history.replaceState(null, "", "index.html");
            resetEditor();
            showEditorView();
        });
        $("#saveDraftBtn").addEventListener("click", () => saveArticle("draft"));
        $("#publishBtn").addEventListener("click", () => saveArticle("published"));
        $("#previewBtn").addEventListener("click", openPreview);
        $("#closePreviewBtn").addEventListener("click", () => $("#previewModal").classList.remove("open"));
        $("#previewModal").addEventListener("click", (e) => { if (e.target.id === "previewModal") $("#previewModal").classList.remove("open"); });
        $("#myArticlesBtn").addEventListener("click", () => {
            const showingList = !$("#listShell").classList.contains("hidden");
            if (showingList) { showEditorView(); }
            else { showListView(); }
        });

        // Autosave loop (lokal + Supabase-draft var 15:e sekund om ändrat)
        setInterval(autosaveTick, 15000);
        window.addEventListener("beforeunload", (e) => {
            if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
        });
    }

    function showEditorView() {
        $("#listShell").classList.add("hidden");
        $("#editorShell").classList.remove("hidden");
        $("#myArticlesBtn").textContent = "Mina artiklar";
    }
    function showListView() {
        $("#editorShell").classList.add("hidden");
        $("#listShell").classList.remove("hidden");
        $("#myArticlesBtn").textContent = "Tillbaka till editorn";
        loadMyArticles();
    }

    // ------------------------------------------------------------------
    // DIRTY / STATUS PILL
    // ------------------------------------------------------------------
    function markDirty() {
        state.dirty = true;
        setStatusPill("dirty", "Osparade ändringar");
        saveLocalDraft();
    }
    function setStatusPill(cls, text) {
        const pill = $("#statusPill");
        pill.className = "status-pill" + (cls ? " " + cls : "");
        $("#statusText").textContent = text;
    }

    function updateWordCount() {
        const text = state.quill.getText().trim();
        const words = text ? text.split(/\s+/).length : 0;
        $("#wordCount").textContent = `${words} ord · ${text.length} tecken`;
    }

    // ------------------------------------------------------------------
    // LOKAL AUTOSAVE (localStorage) — säkerhetskopia ifall Supabase-sparning missas
    // ------------------------------------------------------------------
    function localDraftKey() { return "bp_draft_" + (state.currentId || "new"); }
    function saveLocalDraft() {
        try {
            const payload = collectFormData();
            localStorage.setItem(localDraftKey(), JSON.stringify(payload));
        } catch (e) { /* localStorage kan vara full/otillgänglig — ignorera tyst */ }
    }
    function loadLocalDraft() {
        try {
            const raw = localStorage.getItem(localDraftKey());
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    async function autosaveTick() {
        if (!state.dirty || state.saving) return;
        // Autosave endast om artikeln redan är ett utkast (aldrig auto-publicera).
        if (state.currentId && $("#articleStatusLine").dataset.status === "published") return;
        await saveArticle("draft", true);
    }

    // ------------------------------------------------------------------
    // FORM DATA
    // ------------------------------------------------------------------
    function collectFormData() {
        return {
            title: $("#titleInput").value.trim(),
            excerpt: $("#excerptInput").value.trim(),
            slug: $("#slugInput").value.trim(),
            category: state.category,
            image_url: state.coverUrl,
            content_html: state.quill ? state.quill.root.innerHTML : "",
            publish_at: $("#publishAtInput").value || null
        };
    }

    function resetEditor() {
        state.currentId = null;
        state.coverUrl = null;
        state.category = "lokalt";
        state.dirty = false;
        $("#titleInput").value = "";
        $("#excerptInput").value = "";
        $("#slugInput").value = "";
        $("#slugPreview").textContent = "…";
        $("#publishAtInput").value = "";
        $("#coverPreviewWrap").classList.add("hidden");
        $("#coverDrop").classList.remove("hidden");
        if (state.quill) state.quill.setContents([]);
        $all(".cat-radio").forEach(x => x.classList.toggle("checked", x.dataset.cat === "lokalt"));
        $all('input[name="cat"]').forEach(r => r.checked = r.value === "lokalt");
        $("#articleStatusLine").textContent = "Nytt utkast — inte sparat än.";
        $("#articleStatusLine").dataset.status = "";
        setStatusPill("", "Ej ändrat");
        updateWordCount();

        const local = loadLocalDraft();
        if (local && (local.title || local.content_html)) {
            $("#titleInput").value = local.title || "";
            $("#excerptInput").value = local.excerpt || "";
            $("#slugInput").value = local.slug || "";
            $("#slugPreview").textContent = local.slug || "…";
            if (local.content_html) state.quill.root.innerHTML = local.content_html;
            toast("En lokal, osparad version återställdes.", "success");
            updateWordCount();
        }
    }

    // ------------------------------------------------------------------
    // COVER IMAGE UPLOAD
    // ------------------------------------------------------------------
    async function uploadImage(file, folder) {
        if (!file) return null;
        if (file.size > 5 * 1024 * 1024) { toast("Bilden är för stor (max 5 MB).", "error"); return null; }
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const path = `${folder}/${state.session.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, file, { upsert: false });
        if (error) { toast("Bilduppladdning misslyckades: " + error.message, "error"); return null; }
        const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
        return data.publicUrl;
    }

    async function handleCoverUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        $("#coverDropLabel").textContent = "Laddar upp…";
        const url = await uploadImage(file, "covers");
        $("#coverDropLabel").textContent = "Klicka för att ladda upp omslagsbild (JPG/PNG, max 5 MB)";
        if (!url) return;
        state.coverUrl = url;
        $("#coverPreviewImg").src = url;
        $("#coverPreviewWrap").classList.remove("hidden");
        $("#coverDrop").classList.add("hidden");
        markDirty();
        toast("Omslagsbild uppladdad.", "success");
    }

    function handleEditorImageInsert() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = async () => {
            const file = input.files[0];
            if (!file) return;
            const range = state.quill.getSelection(true);
            state.quill.insertText(range.index, "Laddar upp bild…", { italic: true });
            const url = await uploadImage(file, "content");
            state.quill.deleteText(range.index, "Laddar upp bild…".length);
            if (url) {
                state.quill.insertEmbed(range.index, "image", url, "user");
                state.quill.setSelection(range.index + 1);
            } else {
                toast("Bilden kunde inte infogas.", "error");
            }
        };
        input.click();
    }

    // ------------------------------------------------------------------
    // SPARA / PUBLICERA
    // ------------------------------------------------------------------
    function validate(status) {
        const d = collectFormData();
        if (!d.title) { toast("Rubrik krävs.", "error"); return false; }
        if (!d.slug) { toast("Slug krävs.", "error"); return false; }
        if (status === "published") {
            if (!d.excerpt) { toast("Ingress krävs innan publicering.", "error"); return false; }
            if (!state.quill.getText().trim()) { toast("Artikeltexten är tom.", "error"); return false; }
        }
        return true;
    }

    async function saveArticle(status, isAutosave) {
        if (!isAutosave && !validate(status)) return;
        if (isAutosave && !$("#titleInput").value.trim()) return;
        if (state.saving) return;
        state.saving = true;
        if (!isAutosave) {
            const btn = status === "published" ? $("#publishBtn") : $("#saveDraftBtn");
            btn.disabled = true;
        }
        setStatusPill("saving", "Sparar…");

        const d = collectFormData();
        const payload = {
            title: d.title,
            excerpt: d.excerpt,
            slug: d.slug,
            category: d.category,
            image_url: d.image_url,
            content_html: d.content_html,
            status: status,
            author_id: state.session.user.id
        };
        if (status === "published") {
            payload.published_at = d.publish_at ? new Date(d.publish_at).toISOString() : new Date().toISOString();
        }

        let result;
        if (state.currentId) {
            result = await supabase.from("articles").update(payload).eq("id", state.currentId).select().single();
        } else {
            result = await supabase.from("articles").insert(payload).select().single();
        }

        state.saving = false;
        if (!isAutosave) {
            $("#publishBtn").disabled = false;
            $("#saveDraftBtn").disabled = false;
        }

        if (result.error) {
            setStatusPill("dirty", "Kunde inte spara");
            if (result.error.code === "23505") {
                toast("Sluggen används redan av en annan artikel. Välj en annan.", "error");
            } else {
                toast("Fel vid sparning: " + result.error.message, "error");
            }
            return;
        }

        state.currentId = result.data.id;
        state.dirty = false;
        history.replaceState(null, "", "index.html?id=" + state.currentId);
        $("#articleStatusLine").dataset.status = status;
        $("#articleStatusLine").textContent = status === "published"
            ? "Publicerad " + new Date(result.data.published_at).toLocaleString("sv-SE")
            : "Utkast — senast sparat " + new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
        setStatusPill("saved", "Sparat " + new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }));

        try { localStorage.removeItem(localDraftKey()); } catch (e) {}

        if (!isAutosave) {
            toast(status === "published" ? "Artikeln är publicerad!" : "Utkast sparat.", "success");
        }
    }

    // ------------------------------------------------------------------
    // LADDA BEFINTLIG ARTIKEL
    // ------------------------------------------------------------------
    async function loadArticleIntoEditor(id) {
        setStatusPill("saving", "Laddar artikel…");
        const { data, error } = await supabase.from("articles").select("*").eq("id", id).single();
        if (error || !data) {
            toast("Kunde inte hitta artikeln, eller så saknar du behörighet.", "error");
            resetEditor();
            return;
        }
        state.currentId = data.id;
        state.coverUrl = data.image_url || null;
        state.category = data.category;
        $("#titleInput").value = data.title;
        $("#excerptInput").value = data.excerpt || "";
        $("#slugInput").value = data.slug;
        $("#slugPreview").textContent = data.slug;
        $("#publishAtInput").value = data.published_at ? toLocalDatetimeValue(data.published_at) : "";
        if (state.quill) state.quill.root.innerHTML = data.content_html || "";
        $all(".cat-radio").forEach(x => x.classList.toggle("checked", x.dataset.cat === data.category));
        $all('input[name="cat"]').forEach(r => r.checked = r.value === data.category);

        if (data.image_url) {
            $("#coverPreviewImg").src = data.image_url;
            $("#coverPreviewWrap").classList.remove("hidden");
            $("#coverDrop").classList.add("hidden");
        } else {
            $("#coverPreviewWrap").classList.add("hidden");
            $("#coverDrop").classList.remove("hidden");
        }

        $("#articleStatusLine").dataset.status = data.status;
        const statusLabels = { draft: "Utkast", published: "Publicerad", archived: "Arkiverad" };
        $("#articleStatusLine").textContent = `${statusLabels[data.status] || data.status} — senast uppdaterad ${new Date(data.updated_at).toLocaleString("sv-SE")}`;

        state.dirty = false;
        setStatusPill("saved", "Inläst");
        updateWordCount();
        showEditorView();
    }

    function toLocalDatetimeValue(iso) {
        const d = new Date(iso);
        const pad = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    // ------------------------------------------------------------------
    // MINA ARTIKLAR
    // ------------------------------------------------------------------
    async function loadMyArticles() {
        $("#myArticlesHeading").textContent = state.profile.role === "admin" ? "Alla artiklar" : "Mina artiklar";
        $("#myArticlesList").innerHTML = `<p style="color:var(--cr-ink-faint);">Laddar…</p>`;
        let q = supabase.from("articles")
            .select("id, title, category, status, published_at, updated_at, author_id, profiles!articles_author_id_fkey(display_name)")
            .order("updated_at", { ascending: false });
        if (state.profile.role !== "admin") q = q.eq("author_id", state.session.user.id);
        const { data, error } = await q;
        if (error) { $("#myArticlesList").innerHTML = `<p>Kunde inte hämta artiklar.</p>`; return; }
        if (!data.length) { $("#myArticlesList").innerHTML = `<p style="color:var(--cr-ink-faint);">Inga artiklar än. Klicka på "Ny artikel" för att börja skriva.</p>`; return; }

        const statusLabels = { draft: "Utkast", published: "Publicerad", archived: "Arkiverad" };
        $("#myArticlesList").innerHTML = data.map(a => `
            <div class="article-list-item">
                <div>
                    <div class="ali-title">${escapeHtml(a.title)}</div>
                    <div class="ali-meta">
                        ${CATEGORY_LABELS[a.category] || a.category}
                        ${state.profile.role === "admin" && a.profiles ? " · " + escapeHtml(a.profiles.display_name) : ""}
                        · Uppdaterad ${new Date(a.updated_at).toLocaleDateString("sv-SE")}
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                    <span class="status-badge ${a.status}">${statusLabels[a.status] || a.status}</span>
                    <button class="btn btn-outline btn-sm" data-open="${a.id}">Redigera</button>
                </div>
            </div>`).join("");

        $all("[data-open]").forEach(btn => btn.addEventListener("click", () => {
            history.replaceState(null, "", "index.html?id=" + btn.dataset.open);
            loadArticleIntoEditor(btn.dataset.open);
        }));
    }

    function escapeHtml(str) {
        const d = document.createElement("div");
        d.textContent = str == null ? "" : String(str);
        return d.innerHTML;
    }

    // ------------------------------------------------------------------
    // FÖRHANDSGRANSKNING
    // ------------------------------------------------------------------
    function openPreview() {
        const d = collectFormData();
        $("#pvTitle").textContent = d.title || "(Ingen rubrik än)";
        $("#pvExcerpt").textContent = d.excerpt || "";
        $("#pvCat").querySelector("span") || null;
        $("#pvCat").innerHTML = "";
        $("#pvCat").textContent = CATEGORY_LABELS[d.category] || d.category;
        if (d.image_url) {
            $("#pvCoverWrap").classList.remove("hidden");
            $("#pvCoverImg").src = d.image_url;
        } else {
            $("#pvCoverWrap").classList.add("hidden");
        }
        $("#pvBody").innerHTML = d.content_html;
        $("#previewModal").classList.add("open");
    }

    boot();
})();
