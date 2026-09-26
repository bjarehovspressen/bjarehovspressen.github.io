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

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    // Bjärehovskolan, Lingvägen 17, 237 34 Bjärred — kartans mittpunkt (samma som i js/site.js).
    const BJAREHOV_CENTER = [55.72061, 13.02144];

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
        if (!supabase) {
            showGate("gateLoggedOut");
            toast("Supabase-biblioteket kunde inte laddas. Kontrollera din internetanslutning eller ladda om sidan.", "error");
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

        // Viktigt: dölj gate-skärmen (annars ligger "Laddar Artikelskaparen…"
        // kvar ovanför editorn i flödet och man måste scrolla förbi den).
        ["gateLoading", "gateDenied", "gateLoggedOut"].forEach(id => $("#" + id).classList.add("hidden"));

        $("#topbarActions").style.visibility = "visible";
        if (profile.role === "admin") $("#adminUsersBtn").classList.remove("hidden");
        initEditorUI();
        $("#editorShell").classList.remove("hidden");
        initLocationMap();

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
        if (!supabase) { toast("Supabase är inte tillgängligt just nu.", "error"); return; }
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
        $("#deleteAtInput").addEventListener("input", markDirty);
        $("#setDeleteAfterMinBtn").addEventListener("click", () => {
            const mins = parseInt($("#deleteAfterMinInput").value, 10);
            if (!Number.isFinite(mins) || mins <= 0) {
                toast("Ange ett antal minuter (t.ex. 30).", "error");
                return;
            }
            const target = new Date(Date.now() + mins * 60000);
            $("#deleteAtInput").value = toLocalDatetimeValue(target.toISOString());
            markDirty();
            toast(`Artikeln raderas om ${mins} min, om du sparar.`, "success");
        });
        $("#clearDeleteAtBtn").addEventListener("click", () => {
            $("#deleteAtInput").value = "";
            $("#deleteAfterMinInput").value = "";
            markDirty();
        });
        $("#deleteArticleBtn").addEventListener("click", () => {
            if (!state.currentId) return;
            deleteArticle(state.currentId, $("#titleInput").value.trim(), { fromEditor: true });
        });

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
        $("#tipsInboxBtn").addEventListener("click", () => {
            const showing = !$("#tipsShell").classList.contains("hidden");
            if (showing) { showEditorView(); } else { showTipsView(); }
        });
        $("#galleryManagerBtn").addEventListener("click", () => {
            const showing = !$("#galleryShell").classList.contains("hidden");
            if (showing) { showEditorView(); } else { showGalleryManagerView(); }
        });
        $("#statsBtn").addEventListener("click", () => {
            const showing = !$("#statsShell").classList.contains("hidden");
            if (showing) { showEditorView(); } else { showStatsView(); }
        });
        $("#isBreakingInput").addEventListener("change", markDirty);
        $("#isLiveInput").addEventListener("change", () => {
            $("#liveComposerPanel").classList.toggle("hidden", !$("#isLiveInput").checked);
            markDirty();
        });
        $("#liveUpdateForm").addEventListener("submit", addLiveUpdate);
        $("#newGalleryForm").addEventListener("submit", createGallery);
        $("#useSchoolCoordsBtn").addEventListener("click", () => {
            $("#latInput").value = "55.72061";
            $("#lngInput").value = "13.02144";
            markDirty();
            syncLocationMapFromInputs(true);
        });
        $("#clearCoordsBtn").addEventListener("click", () => {
            $("#latInput").value = "";
            $("#lngInput").value = "";
            markDirty();
            clearLocationMarker();
        });
        $("#latInput").addEventListener("input", markDirty);
        $("#lngInput").addEventListener("input", markDirty);
        $("#latInput").addEventListener("change", () => syncLocationMapFromInputs(true));
        $("#lngInput").addEventListener("change", () => syncLocationMapFromInputs(true));
        $("#useMapLinkBtn").addEventListener("click", () => {
            const raw = $("#mapLinkInput").value;
            const parsed = parseMapLink(raw);
            if (!parsed) {
                if (/goo\.gl/i.test(raw)) {
                    toast("Den förkortade länken går inte att läsa av direkt. Öppna den i webbläsaren och klistra in den fullständiga adressen (med @lat,long i URL:en) istället.", "error");
                } else {
                    toast("Hittade inga koordinater i länken. Klistra in en Google Maps/Earth-länk, eller klicka direkt på kartan.", "error");
                }
                return;
            }
            if (Math.abs(parsed.lat) > 90 || Math.abs(parsed.lng) > 180) {
                toast("Koordinaterna i länken ser inte rimliga ut.", "error");
                return;
            }
            initLocationMap();
            placeLocationMarker(parsed.lat, parsed.lng, { pan: true, updateInputs: true });
            locationMap.setView([parsed.lat, parsed.lng], 16);
            toast("Plats hämtad från länken.", "success");
        });
        $("#pollsManagerBtn").addEventListener("click", () => {
            const showing = !$("#pollsShell").classList.contains("hidden");
            if (showing) { showEditorView(); } else { showPollsManagerView(); }
        });
        $("#addPollOptionBtn").addEventListener("click", () => {
            const row = document.createElement("div");
            row.className = "poll-option-row";
            row.innerHTML = `<input type="text" class="poll-option-input" placeholder="Alternativ" maxlength="120">`;
            $("#pollOptionsList").appendChild(row);
        });
        $("#createPollBtn").addEventListener("click", createPoll);
        if (state.profile.role === "admin") {
            $("#adminUsersBtn").addEventListener("click", () => {
                const showingAdmin = !$("#adminShell").classList.contains("hidden");
                if (showingAdmin) { showEditorView(); }
                else { showAdminView(); }
            });
            $("#userSearchInput").addEventListener("input", () => renderUsersList());
        }

        // Autosave loop (lokal + Supabase-draft var 15:e sekund om ändrat)
        setInterval(autosaveTick, 15000);
        window.addEventListener("beforeunload", (e) => {
            if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
        });
    }

    const ALL_SHELLS = ["editorShell", "listShell", "adminShell", "tipsShell", "galleryShell", "pollsShell", "statsShell"];
    function showShell(id) {
        ALL_SHELLS.forEach(s => $("#" + s).classList.toggle("hidden", s !== id));
    }
    function showEditorView() {
        showShell("editorShell");
        $("#myArticlesBtn").textContent = "Mina artiklar";
        if ($("#adminUsersBtn")) $("#adminUsersBtn").textContent = "Användare";
        if (locationMap) setTimeout(() => locationMap.invalidateSize(), 50);
    }
    function showListView() {
        showShell("listShell");
        $("#myArticlesBtn").textContent = "Tillbaka till editorn";
        if ($("#adminUsersBtn")) $("#adminUsersBtn").textContent = "Användare";
        loadMyArticles();
    }
    function showAdminView() {
        showShell("adminShell");
        $("#myArticlesBtn").textContent = "Mina artiklar";
        $("#adminUsersBtn").textContent = "Tillbaka till editorn";
        loadUsers();
    }
    function showTipsView() {
        showShell("tipsShell");
        loadTipsInbox();
    }
    function showGalleryManagerView() {
        showShell("galleryShell");
        loadGalleryManager();
    }
    function showStatsView() {
        showShell("statsShell");
        loadStatsDashboard();
    }
    function showPollsManagerView() {
        showShell("pollsShell");
        loadPollsManager();
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
            publish_at: $("#publishAtInput").value || null,
            delete_at: $("#deleteAtInput").value || null,
            is_breaking: $("#isBreakingInput").checked,
            is_live: $("#isLiveInput").checked,
            latitude: parseCoord($("#latInput").value),
            longitude: parseCoord($("#lngInput").value)
        };
    }

    function parseCoord(raw) {
        const v = (raw || "").trim().replace(",", ".");
        if (!v) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    // ------------------------------------------------------------------
    // PLUS CODES (Open Location Code) — decode + recoverNearest, så att en
    // kort kod (t.ex. "P2CC+6G") kan tolkas mot Bjärehovsområdet som
    // referenspunkt, precis som en full kod.
    // ------------------------------------------------------------------
    const OLC_ALPHABET = "23456789CFGHJMPQRVWX";
    const OLC_BASE = 20;
    const OLC_LAT_MAX = 90, OLC_LNG_MAX = 180;
    const OLC_PAIR_LEN = 10;
    const OLC_SEP = "+";
    const OLC_SEP_POS = 8;
    const OLC_PAD = "0";
    const OLC_GRID_COLS = 4, OLC_GRID_ROWS = 5;
    const OLC_PAIR_RES = [20.0, 1.0, 0.05, 0.0025, 0.000125];
    const OLC_GRID_SIZE_DEG = 0.000125;

    function olcClipLat(lat) { return Math.min(OLC_LAT_MAX, Math.max(-OLC_LAT_MAX, lat)); }
    function olcNormLng(lng) {
        lng = lng % 360;
        if (lng < -180) lng += 360;
        if (lng >= 180) lng -= 360;
        return lng;
    }
    function olcEncodePairs(lat, lng, codeLength) {
        let code = "", aLat = lat + OLC_LAT_MAX, aLng = lng + OLC_LNG_MAX, n = 0;
        while (n < codeLength) {
            const place = OLC_PAIR_RES[Math.floor(n / 2)];
            const dLat = Math.floor(aLat / place + 1e-9);
            aLat -= dLat * place; code += OLC_ALPHABET.charAt(dLat); n++;
            const dLng = Math.floor(aLng / place + 1e-9);
            aLng -= dLng * place; code += OLC_ALPHABET.charAt(dLng); n++;
            if (n === OLC_SEP_POS && n < codeLength) code += OLC_SEP;
        }
        if (code.length < OLC_SEP_POS) code += OLC_PAD.repeat(OLC_SEP_POS - code.length);
        if (code.length === OLC_SEP_POS) code += OLC_SEP;
        return code;
    }
    function olcEncode(lat, lng, codeLength) {
        codeLength = codeLength || OLC_PAIR_LEN;
        lat = olcClipLat(lat); lng = olcNormLng(lng);
        return olcEncodePairs(lat, lng, Math.min(codeLength, OLC_PAIR_LEN));
    }
    function olcDecodePairsSeq(code, offset) {
        let i = 0, value = 0;
        while (i * 2 + offset < code.length) {
            value += OLC_ALPHABET.indexOf(code.charAt(i * 2 + offset)) * OLC_PAIR_RES[i];
            i++;
        }
        return [value, value + OLC_PAIR_RES[i - 1]];
    }
    function olcDecode(codeRaw) {
        const code = codeRaw.replace(new RegExp("[" + "\\" + OLC_SEP + OLC_PAD + "]", "g"), "").toUpperCase();
        const lat = olcDecodePairsSeq(code, 0), lng = olcDecodePairsSeq(code, 1);
        let latLo = lat[0] - OLC_LAT_MAX, lngLo = lng[0] - OLC_LNG_MAX;
        let latHi = lat[1] - OLC_LAT_MAX, lngHi = lng[1] - OLC_LNG_MAX;
        if (code.length > OLC_PAIR_LEN) {
            let latPlace = OLC_GRID_SIZE_DEG, lngPlace = OLC_GRID_SIZE_DEG;
            let gLatLo = 0, gLngLo = 0;
            const gridCode = code.substring(OLC_PAIR_LEN);
            for (let i = 0; i < gridCode.length; i++) {
                const idx = OLC_ALPHABET.indexOf(gridCode.charAt(i));
                const row = Math.floor(idx / OLC_GRID_COLS), col = idx % OLC_GRID_COLS;
                latPlace /= OLC_GRID_ROWS; lngPlace /= OLC_GRID_COLS;
                gLatLo += row * latPlace; gLngLo += col * lngPlace;
            }
            latLo += gLatLo; lngLo += gLngLo;
            latHi = (lat[0] - OLC_LAT_MAX) + gLatLo + latPlace;
            lngHi = (lng[0] - OLC_LNG_MAX) + gLngLo + lngPlace;
        }
        return { latCenter: (latLo + latHi) / 2, lngCenter: (lngLo + lngHi) / 2 };
    }
    function olcIsShort(code) {
        const sep = code.indexOf(OLC_SEP);
        return sep >= 0 && sep < OLC_SEP_POS;
    }
    // Slår ihop en kort Plus Code med en referenspunkt (Bjärehovsområdet) till
    // en full kod, enligt Open Location Code-specifikationens "recover nearest".
    function olcRecoverNearest(codeRaw, refLat, refLng) {
        const code = codeRaw.toUpperCase();
        if (!olcIsShort(code)) return code;
        refLng = olcNormLng(refLng);
        const digitsToRecover = OLC_SEP_POS - code.indexOf(OLC_SEP);
        const prefixPrecision = Math.pow(OLC_BASE, 2 - digitsToRecover / 2);
        const prefix = olcEncode(refLat, refLng).substring(0, digitsToRecover);
        const recoveredCode = prefix + code;
        const area = olcDecode(recoveredCode);
        let recLat = area.latCenter, recLng = area.lngCenter;
        const latDiff = recLat - refLat;
        if (latDiff > prefixPrecision / 2 && recLat - prefixPrecision > -OLC_LAT_MAX) recLat -= prefixPrecision;
        else if (latDiff < -prefixPrecision / 2 && recLat + prefixPrecision < OLC_LAT_MAX) recLat += prefixPrecision;
        const lngDiff = recLng - refLng;
        if (lngDiff > prefixPrecision / 2) recLng -= prefixPrecision;
        else if (lngDiff < -prefixPrecision / 2) recLng += prefixPrecision;
        return olcEncode(recLat, recLng, recoveredCode.replace(OLC_SEP, "").length);
    }
    // Hittar och tolkar en Plus Code i en fritextsträng (t.ex. "P2CC+6G Bjärred"),
    // med Bjärehovsområdet som referens för korta koder.
    function parsePlusCode(raw) {
        const s = (raw || "").toUpperCase();
        const m = s.match(/\b([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,7})\b/);
        if (!m) return null;
        try {
            const full = olcRecoverNearest(m[1], BJAREHOV_CENTER[0], BJAREHOV_CENTER[1]);
            const area = olcDecode(full);
            if (!Number.isFinite(area.latCenter) || !Number.isFinite(area.lngCenter)) return null;
            return { lat: area.latCenter, lng: area.lngCenter };
        } catch (e) {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // PLATSVÄLJARE (Leaflet-karta + Google Maps/Earth-länk)
    // ------------------------------------------------------------------
    let locationMap = null;
    let locationMarker = null;

    function initLocationMap() {
        if (locationMap || typeof window.L === "undefined") return;
        const startLat = parseCoord($("#latInput").value);
        const startLng = parseCoord($("#lngInput").value);
        const hasStart = startLat != null && startLng != null;
        locationMap = L.map("locationPickerMap").setView(hasStart ? [startLat, startLng] : BJAREHOV_CENTER, hasStart ? 16 : 14);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: "&copy; OpenStreetMap-bidragsgivare"
        }).addTo(locationMap);
        if (hasStart) placeLocationMarker(startLat, startLng, { pan: false, updateInputs: false });
        locationMap.on("click", (e) => placeLocationMarker(e.latlng.lat, e.latlng.lng, { pan: false, updateInputs: true }));
        setTimeout(() => locationMap.invalidateSize(), 80);
    }

    // Ritar/flyttar pin:en på kartan. updateInputs styr om lat/lng-fälten ska skrivas över
    // (annars antas fälten redan vara källan, t.ex. vid initiering från sparad artikel).
    function placeLocationMarker(lat, lng, opts) {
        opts = opts || {};
        if (!locationMap) return;
        const rlat = Math.round(lat * 100000) / 100000;
        const rlng = Math.round(lng * 100000) / 100000;
        if (locationMarker) {
            locationMarker.setLatLng([rlat, rlng]);
        } else {
            locationMarker = L.marker([rlat, rlng], { draggable: true }).addTo(locationMap);
            locationMarker.on("dragend", () => {
                const p = locationMarker.getLatLng();
                placeLocationMarker(p.lat, p.lng, { pan: false, updateInputs: true });
            });
        }
        if (opts.updateInputs !== false) {
            $("#latInput").value = rlat;
            $("#lngInput").value = rlng;
            markDirty();
        }
        if (opts.pan) locationMap.panTo([rlat, rlng]);
    }

    function clearLocationMarker() {
        if (locationMarker && locationMap) {
            locationMap.removeLayer(locationMarker);
            locationMarker = null;
        }
    }

    // Läser av lat/lng-fälten och synkar kartans pin därefter (kallas efter att
    // fälten satts programmatiskt, t.ex. "Använd Bjärehovskolan" eller vid inläsning
    // av en befintlig artikel).
    function syncLocationMapFromInputs(recenter) {
        if (!locationMap) return;
        const lat = parseCoord($("#latInput").value);
        const lng = parseCoord($("#lngInput").value);
        if (lat != null && lng != null) {
            placeLocationMarker(lat, lng, { pan: false, updateInputs: false });
            if (recenter) locationMap.setView([lat, lng], Math.max(locationMap.getZoom(), 15));
        } else {
            clearLocationMarker();
        }
    }

    // Försöker tolka koordinater ur en Google Maps- eller Google Earth-länk (eller
    // rått "lat, lng"-textformat). Fungerar inte för förkortade länkar (maps.app.goo.gl)
    // eftersom vi inte kan följa omdirigeringar i webbläsaren — användaren får då
    // öppna länken och klistra in den fullständiga adressen istället.
    function parseMapLink(raw) {
        const s = (raw || "").trim();
        if (!s) return null;
        let m;
        m = s.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
        if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
        m = s.match(/@(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/);
        if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
        m = s.match(/[?&]q=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/);
        if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
        m = s.match(/[?&]ll=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/);
        if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
        m = s.match(/^(-?\d{1,3}\.\d+)\s*[,;]\s*(-?\d{1,3}\.\d+)$/);
        if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
        const plusCode = parsePlusCode(s);
        if (plusCode) return plusCode;
        return null;
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
        $("#deleteAtInput").value = "";
        $("#deleteAfterMinInput").value = "";
        $("#deleteArticleBtn").classList.add("hidden");
        $("#coverPreviewWrap").classList.add("hidden");
        $("#coverDrop").classList.remove("hidden");
        $("#isBreakingInput").checked = false;
        $("#isLiveInput").checked = false;
        $("#latInput").value = "";
        $("#lngInput").value = "";
        $("#mapLinkInput").value = "";
        clearLocationMarker();
        if (locationMap) locationMap.setView(BJAREHOV_CENTER, 14);
        $("#liveComposerPanel").classList.add("hidden");
        $("#liveUpdateList").innerHTML = "";
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
            author_id: state.session.user.id,
            is_breaking: d.is_breaking,
            is_live: d.is_live,
            latitude: d.latitude,
            longitude: d.longitude,
            delete_at: d.delete_at ? new Date(d.delete_at).toISOString() : null
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
        $("#deleteArticleBtn").classList.remove("hidden");
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
        $("#deleteAtInput").value = data.delete_at ? toLocalDatetimeValue(data.delete_at) : "";
        $("#deleteAfterMinInput").value = "";
        $("#deleteArticleBtn").classList.remove("hidden");
        if (state.quill) state.quill.root.innerHTML = data.content_html || "";
        $all(".cat-radio").forEach(x => x.classList.toggle("checked", x.dataset.cat === data.category));
        $all('input[name="cat"]').forEach(r => r.checked = r.value === data.category);
        $("#isBreakingInput").checked = !!data.is_breaking;
        $("#isLiveInput").checked = !!data.is_live;
        $("#latInput").value = data.latitude != null ? data.latitude : "";
        $("#lngInput").value = data.longitude != null ? data.longitude : "";
        $("#mapLinkInput").value = "";
        initLocationMap();
        syncLocationMapFromInputs(true);
        $("#liveComposerPanel").classList.toggle("hidden", !data.is_live);
        if (data.is_live) loadLiveUpdatesIntoEditor(data.id);

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
    // RADERA ARTIKEL (direkt, från editorn eller från listan)
    // ------------------------------------------------------------------
    async function deleteArticle(id, title, opts) {
        opts = opts || {};
        if (!id) return;
        const ok = confirm(`Radera artikeln${title ? " \"" + title + "\"" : ""} permanent? Detta går inte att ångra.`);
        if (!ok) return;

        const { error } = await supabase.from("articles").delete().eq("id", id);
        if (error) {
            toast("Kunde inte radera artikeln: " + error.message, "error");
            return;
        }
        try { localStorage.removeItem("bp_draft_" + id); } catch (e) {}
        toast("Artikeln är raderad.", "success");

        if (opts.fromEditor) {
            history.replaceState(null, "", "index.html");
            resetEditor();
            showEditorView();
        } else {
            loadMyArticles();
        }
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
                    <button class="btn btn-danger btn-sm" data-delete="${a.id}" data-title="${escapeHtml(a.title)}">Radera</button>
                </div>
            </div>`).join("");

        $all("[data-open]").forEach(btn => btn.addEventListener("click", () => {
            history.replaceState(null, "", "index.html?id=" + btn.dataset.open);
            loadArticleIntoEditor(btn.dataset.open);
        }));
        $all("[data-delete]", $("#myArticlesList")).forEach(btn => btn.addEventListener("click", () => {
            deleteArticle(btn.dataset.delete, btn.dataset.title, { fromEditor: state.currentId === btn.dataset.delete });
        }));
    }

    // ------------------------------------------------------------------
    // ANVÄNDARE (endast admin)
    // ------------------------------------------------------------------
    const ROLE_LABELS = { reader: "Läsare", author: "Artikelskapare", admin: "Admin" };
    let allUsers = [];

    async function loadUsers() {
        $("#usersList").innerHTML = `<p style="color:var(--cr-ink-faint);">Laddar…</p>`;
        const { data, error } = await supabase.from("profiles")
            .select("id, display_name, role, created_at")
            .order("created_at", { ascending: true });
        if (error) { $("#usersList").innerHTML = `<p>Kunde inte hämta användare.</p>`; return; }
        allUsers = data || [];
        renderUsersList();
    }

    function renderUsersList() {
        const query = ($("#userSearchInput").value || "").trim().toLowerCase();
        const users = query
            ? allUsers.filter(u => (u.display_name || "").toLowerCase().includes(query))
            : allUsers;

        if (!users.length) {
            $("#usersList").innerHTML = `<p style="color:var(--cr-ink-faint);">Inga användare matchade sökningen.</p>`;
            return;
        }

        $("#usersList").innerHTML = users.map(u => {
            const isSelf = u.id === state.session.user.id;
            const options = Object.keys(ROLE_LABELS).map(r =>
                `<option value="${r}" ${r === u.role ? "selected" : ""}>${ROLE_LABELS[r]}</option>`
            ).join("");
            return `
            <div class="article-list-item" data-user-row="${u.id}">
                <div>
                    <div class="ali-title">${escapeHtml(u.display_name)}${isSelf ? " (du)" : ""}</div>
                    <div class="ali-meta">Registrerad ${new Date(u.created_at).toLocaleDateString("sv-SE")}</div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                    <select class="role-select" data-role-for="${u.id}" ${isSelf ? "disabled" : ""} style="padding:6px 8px;border:1px solid var(--cr-line-strong);border-radius:var(--cr-radius);background:var(--cr-panel);">
                        ${options}
                    </select>
                    <button class="btn btn-outline btn-sm" data-save-role="${u.id}" ${isSelf ? "disabled" : ""}>Spara</button>
                </div>
            </div>`;
        }).join("");

        $all("[data-save-role]").forEach(btn => btn.addEventListener("click", async () => {
            const userId = btn.dataset.saveRole;
            const select = $(`[data-role-for="${userId}"]`);
            const newRole = select.value;
            const user = allUsers.find(u => u.id === userId);
            if (user && user.role === newRole) { toast("Ingen ändring att spara."); return; }

            btn.disabled = true;
            btn.textContent = "Sparar…";
            const { data, error } = await supabase.from("profiles")
                .update({ role: newRole })
                .eq("id", userId)
                .select("id, role")
                .single();

            if (error) {
                toast("Kunde inte ändra roll: " + error.message, "error");
                btn.disabled = false;
                btn.textContent = "Spara";
                return;
            }
            if (!data || data.role !== newRole) {
                toast("Rollen ändrades inte. Har SQL-policyn profiles_update_admin körts i Supabase?", "error");
                btn.disabled = false;
                btn.textContent = "Spara";
                return;
            }

            if (user) user.role = data.role;
            toast(`${user ? user.display_name : "Användaren"} är nu ${ROLE_LABELS[data.role].toLowerCase()}.`, "success");
            btn.disabled = false;
            btn.textContent = "Spara";
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

    // ------------------------------------------------------------------
    // LIVE-UPPDATERINGAR
    // ------------------------------------------------------------------
    async function loadLiveUpdatesIntoEditor(articleId) {
        const { data, error } = await supabase.from("live_updates")
            .select("id, body, occurred_at").eq("article_id", articleId).order("occurred_at", { ascending: false });
        if (error) { console.error(error); return; }
        renderLiveUpdateList(data || []);
    }

    function renderLiveUpdateList(items) {
        const el = $("#liveUpdateList");
        if (!items.length) { el.innerHTML = `<p class="field-hint">Inga uppdateringar ännu.</p>`; return; }
        el.innerHTML = items.map(u => `
            <div class="tip-item" data-id="${u.id}">
                <strong>${new Date(u.occurred_at).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}</strong>
                — ${escapeHtml(u.body)}
                <button type="button" class="btn btn-ghost btn-sm remove-live-update" data-id="${u.id}" style="float:right;">Ta bort</button>
            </div>`).join("");
        $all(".remove-live-update", el).forEach(btn => btn.addEventListener("click", async () => {
            const { error } = await supabase.from("live_updates").delete().eq("id", btn.dataset.id);
            if (error) { toast("Kunde inte ta bort uppdateringen.", "error"); return; }
            loadLiveUpdatesIntoEditor(state.currentId);
        }));
    }

    async function addLiveUpdate(e) {
        e.preventDefault();
        if (!state.currentId) { toast("Spara artikeln innan du lägger till en live-uppdatering.", "error"); return; }
        const body = $("#liveUpdateInput").value.trim();
        if (!body) return;
        const btn = $("#liveUpdateSubmitBtn");
        btn.disabled = true;
        const { error } = await supabase.from("live_updates").insert({
            article_id: state.currentId, body, created_by: state.session.user.id
        });
        btn.disabled = false;
        if (error) { toast("Kunde inte spara uppdateringen: " + error.message, "error"); return; }
        $("#liveUpdateInput").value = "";
        toast("Live-uppdatering tillagd.", "success");
        loadLiveUpdatesIntoEditor(state.currentId);
    }

    // ------------------------------------------------------------------
    // NYHETSTIPS-INKORG
    // ------------------------------------------------------------------
    async function loadTipsInbox() {
        const el = $("#tipsList");
        el.innerHTML = "<p>Laddar…</p>";
        const { data, error } = await supabase.from("news_tips")
            .select("id, what, where_text, anonymous, status, created_at, reporter_id, profiles!news_tips_reporter_id_fkey(display_name)")
            .order("created_at", { ascending: false });
        if (error) { el.innerHTML = `<p class="field-hint">Kunde inte hämta tips: ${escapeHtml(error.message)}</p>`; return; }
        if (!data || !data.length) { el.innerHTML = "<p>Inga tips inskickade ännu.</p>"; return; }
        el.innerHTML = data.map(t => `
            <div class="tip-item ${t.status !== "new" ? "is-read" : ""}" data-id="${t.id}">
                <div>${escapeHtml(t.what)}</div>
                ${t.where_text ? `<div style="font-size:0.85rem;color:var(--bp-ink-faint);">📍 ${escapeHtml(t.where_text)}</div>` : ""}
                <div class="tip-meta">
                    <span>${new Date(t.created_at).toLocaleString("sv-SE")}</span>
                    <span>${t.anonymous ? "Anonymt tips" : "Från: " + escapeHtml(t.profiles ? t.profiles.display_name : "Okänd")}</span>
                    <select class="tip-status-select" data-id="${t.id}">
                        <option value="new" ${t.status === "new" ? "selected" : ""}>Nytt</option>
                        <option value="read" ${t.status === "read" ? "selected" : ""}>Läst</option>
                        <option value="archived" ${t.status === "archived" ? "selected" : ""}>Arkiverat</option>
                    </select>
                </div>
            </div>`).join("");
        $all(".tip-status-select", el).forEach(sel => sel.addEventListener("change", async () => {
            const { error } = await supabase.from("news_tips").update({ status: sel.value }).eq("id", sel.dataset.id);
            if (error) { toast("Kunde inte uppdatera status.", "error"); return; }
            sel.closest(".tip-item").classList.toggle("is-read", sel.value !== "new");
        }));
    }

    // ------------------------------------------------------------------
    // BILDGALLERI-HANTERING
    // ------------------------------------------------------------------
    async function createGallery(e) {
        e.preventDefault();
        const title = $("#galleryTitleInput").value.trim();
        const description = $("#galleryDescInput").value.trim();
        if (!title) return;
        const { error } = await supabase.from("galleries").insert({
            title, description, author_id: state.session.user.id, status: "published"
        });
        if (error) { toast("Kunde inte skapa galleriet: " + error.message, "error"); return; }
        $("#galleryTitleInput").value = "";
        $("#galleryDescInput").value = "";
        toast("Galleri skapat!", "success");
        loadGalleryManager();
    }

    async function loadGalleryManager() {
        const el = $("#galleryManagerList");
        el.innerHTML = "<p>Laddar…</p>";
        const { data, error } = await supabase.from("galleries")
            .select("id, title, description, cover_image_url").order("created_at", { ascending: false });
        if (error) { el.innerHTML = `<p class="field-hint">Fel: ${escapeHtml(error.message)}</p>`; return; }
        if (!data || !data.length) { el.innerHTML = "<p>Inga gallerier ännu. Skapa ett ovan.</p>"; return; }

        el.innerHTML = data.map(g => `
            <div class="tip-item" data-gallery="${g.id}">
                <strong>📸 ${escapeHtml(g.title)}</strong>
                <div style="margin:8px 0;" id="galleryPhotos-${g.id}"></div>
                <label class="btn btn-outline btn-sm" style="cursor:pointer;">
                    + Ladda upp bild
                    <input type="file" accept="image/*" class="hidden gallery-upload-input" data-gallery="${g.id}">
                </label>
                <button type="button" class="btn btn-ghost btn-sm delete-gallery-btn" data-gallery="${g.id}">Ta bort galleri</button>
            </div>`).join("");

        data.forEach(g => loadGalleryPhotos(g.id));

        $all(".gallery-upload-input", el).forEach(input => input.addEventListener("change", async () => {
            const file = input.files[0];
            if (!file) return;
            const galleryId = input.dataset.gallery;
            const url = await uploadImage(file, "galleries");
            if (!url) return;
            const { data: existing } = await supabase.from("gallery_images").select("position").eq("gallery_id", galleryId).order("position", { ascending: false }).limit(1);
            const nextPos = existing && existing.length ? existing[0].position + 1 : 0;
            const { error } = await supabase.from("gallery_images").insert({ gallery_id: galleryId, image_url: url, position: nextPos });
            if (error) { toast("Kunde inte lägga till bilden: " + error.message, "error"); return; }
            // Sätt som omslagsbild om galleriet saknar en.
            await supabase.from("galleries").update({ cover_image_url: url }).eq("id", galleryId).is("cover_image_url", null);
            toast("Bild uppladdad!", "success");
            loadGalleryPhotos(galleryId);
        }));

        $all(".delete-gallery-btn", el).forEach(btn => btn.addEventListener("click", async () => {
            if (!confirm("Ta bort hela galleriet och alla dess bilder?")) return;
            const { error } = await supabase.from("galleries").delete().eq("id", btn.dataset.gallery);
            if (error) { toast("Kunde inte ta bort galleriet.", "error"); return; }
            loadGalleryManager();
        }));
    }

    async function loadGalleryPhotos(galleryId) {
        const el = $("#galleryPhotos-" + galleryId);
        if (!el) return;
        const { data } = await supabase.from("gallery_images").select("id, image_url").eq("gallery_id", galleryId).order("position");
        el.innerHTML = (data || []).map(img => `
            <span style="display:inline-block;position:relative;margin:0 6px 6px 0;">
                <img src="${escapeHtml(img.image_url)}" style="width:70px;height:70px;object-fit:cover;border-radius:6px;">
                <button type="button" class="remove-gallery-photo" data-id="${img.id}" title="Ta bort" style="position:absolute;top:-6px;right:-6px;background:var(--bp-red);color:#fff;border:none;border-radius:50%;width:18px;height:18px;font-size:11px;cursor:pointer;">✕</button>
            </span>`).join("") || `<span class="field-hint">Inga bilder än.</span>`;
        $all(".remove-gallery-photo", el).forEach(btn => btn.addEventListener("click", async () => {
            await supabase.from("gallery_images").delete().eq("id", btn.dataset.id);
            loadGalleryPhotos(galleryId);
        }));
    }

    // ------------------------------------------------------------------
    // OMRÖSTNINGAR ("Veckans omröstning")
    // ------------------------------------------------------------------
    async function createPoll() {
        const question = $("#pollQuestionInput").value.trim();
        const description = $("#pollDescInput").value.trim();
        const isFeatured = $("#pollFeaturedInput").checked;
        const options = $all(".poll-option-input")
            .map(i => i.value.trim())
            .filter(Boolean);

        if (!question) { toast("Skriv en fråga för omröstningen.", "error"); return; }
        if (options.length < 2) { toast("Lägg till minst två svarsalternativ.", "error"); return; }

        const btn = $("#createPollBtn");
        btn.disabled = true;

        if (isFeatured) {
            // Endast en omröstning kan vara "Veckans omröstning" i taget.
            await supabase.from("polls").update({ is_featured: false }).eq("is_featured", true);
        }

        const { data: poll, error } = await supabase.from("polls").insert({
            question, description,
            status: "published",
            is_featured: isFeatured,
            created_by: state.session.user.id
        }).select().single();

        if (error) { toast("Kunde inte skapa omröstningen: " + error.message, "error"); btn.disabled = false; return; }

        const optionRows = options.map((label, i) => ({ poll_id: poll.id, label, position: i }));
        const { error: optErr } = await supabase.from("poll_options").insert(optionRows);
        btn.disabled = false;
        if (optErr) { toast("Omröstningen skapades men alternativen kunde inte sparas: " + optErr.message, "error"); return; }

        $("#pollQuestionInput").value = "";
        $("#pollDescInput").value = "";
        $("#pollFeaturedInput").checked = false;
        $("#pollOptionsList").innerHTML = `
            <div class="poll-option-row"><input type="text" class="poll-option-input" placeholder="Alternativ 1" maxlength="120"></div>
            <div class="poll-option-row"><input type="text" class="poll-option-input" placeholder="Alternativ 2" maxlength="120"></div>`;
        toast("Omröstningen är publicerad!", "success");
        loadPollsManager();
    }

    async function loadPollsManager() {
        const el = $("#pollsManagerList");
        el.innerHTML = "<p>Laddar…</p>";
        const { data, error } = await supabase.from("polls")
            .select("id, question, status, is_featured, created_at")
            .order("created_at", { ascending: false });
        if (error) { el.innerHTML = `<p class="field-hint">Fel: ${escapeHtml(error.message)}</p>`; return; }
        if (!data || !data.length) { el.innerHTML = "<p>Inga omröstningar ännu. Skapa en ovan.</p>"; return; }

        el.innerHTML = data.map(p => `
            <div class="tip-item" data-poll="${p.id}">
                <strong>${p.is_featured ? "⭐ " : ""}${escapeHtml(p.question)}</strong>
                <div class="tip-meta">
                    <span>${p.status === "published" ? "Publicerad" : p.status === "closed" ? "Avslutad" : "Utkast"}</span>
                    <button type="button" class="btn btn-ghost btn-sm feature-poll-btn" data-id="${p.id}" data-featured="${p.is_featured}">
                        ${p.is_featured ? "Ta bort som Veckans omröstning" : "Gör till Veckans omröstning"}
                    </button>
                    ${p.status === "published"
                        ? `<button type="button" class="btn btn-ghost btn-sm close-poll-btn" data-id="${p.id}">Avsluta</button>`
                        : p.status === "closed"
                            ? `<button type="button" class="btn btn-ghost btn-sm reopen-poll-btn" data-id="${p.id}">Öppna igen</button>`
                            : ""}
                    <button type="button" class="btn btn-ghost btn-sm delete-poll-btn" data-id="${p.id}">Ta bort</button>
                </div>
            </div>`).join("");

        $all(".feature-poll-btn", el).forEach(btn => btn.addEventListener("click", async () => {
            const makeFeatured = btn.dataset.featured !== "true";
            if (makeFeatured) await supabase.from("polls").update({ is_featured: false }).eq("is_featured", true);
            const { error: e } = await supabase.from("polls").update({ is_featured: makeFeatured }).eq("id", btn.dataset.id);
            if (e) { toast("Kunde inte uppdatera omröstningen.", "error"); return; }
            loadPollsManager();
        }));
        $all(".close-poll-btn", el).forEach(btn => btn.addEventListener("click", async () => {
            await supabase.from("polls").update({ status: "closed" }).eq("id", btn.dataset.id);
            loadPollsManager();
        }));
        $all(".reopen-poll-btn", el).forEach(btn => btn.addEventListener("click", async () => {
            await supabase.from("polls").update({ status: "published" }).eq("id", btn.dataset.id);
            loadPollsManager();
        }));
        $all(".delete-poll-btn", el).forEach(btn => btn.addEventListener("click", async () => {
            if (!confirm("Ta bort omröstningen och alla dess röster?")) return;
            const { error: e } = await supabase.from("polls").delete().eq("id", btn.dataset.id);
            if (e) { toast("Kunde inte ta bort omröstningen.", "error"); return; }
            loadPollsManager();
        }));
    }

    // ------------------------------------------------------------------
    // STATISTIKDASHBOARD
    // ------------------------------------------------------------------
    async function loadStatsDashboard() {
        $("#statsSummaryGrid").innerHTML = "<p>Laddar…</p>";
        $("#statsBarChart").innerHTML = "";
        $("#statsTopList").innerHTML = "";

        const { data: summaryRows, error: sErr } = await supabase.rpc("stats_summary");
        if (sErr) {
            $("#statsSummaryGrid").innerHTML = `<p class="field-hint">Kunde inte hämta statistik: ${escapeHtml(sErr.message)}. Har migration_v2.sql körts i Supabase?</p>`;
        } else {
            const s = (summaryRows && summaryRows[0]) || { total_views: 0, total_articles: 0, total_users: 0, total_comments: 0 };
            $("#statsSummaryGrid").innerHTML = `
                <div class="stats-card"><span class="num">👁️ ${s.total_views || 0}</span><span class="label">Visningar</span></div>
                <div class="stats-card"><span class="num">📰 ${s.total_articles || 0}</span><span class="label">Artiklar</span></div>
                <div class="stats-card"><span class="num">👤 ${s.total_users || 0}</span><span class="label">Användare</span></div>
                <div class="stats-card"><span class="num">💬 ${s.total_comments || 0}</span><span class="label">Kommentarer</span></div>`;
        }

        const { data: dayRows, error: dErr } = await supabase.rpc("stats_views_per_day", { p_days: 14 });
        if (!dErr && dayRows && dayRows.length) {
            const max = Math.max(1, ...dayRows.map(r => r.views));
            $("#statsBarChart").innerHTML = dayRows.map(r => `
                <div class="bar-col">
                    <div class="bar" style="height:${Math.round((r.views / max) * 100)}%" title="${r.views} visningar"></div>
                    <div class="bar-label">${new Date(r.day).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}</div>
                </div>`).join("");
        } else {
            $("#statsBarChart").innerHTML = `<p class="field-hint">Ingen visningsdata ännu.</p>`;
        }

        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: topArticles } = await supabase.from("articles")
            .select("title, slug, views, published_at")
            .eq("status", "published").gt("published_at", weekAgo)
            .order("views", { ascending: false }).limit(5);
        $("#statsTopList").innerHTML = (topArticles && topArticles.length)
            ? topArticles.map((a, i) => `<div class="tip-item">${i + 1}. <strong>${escapeHtml(a.title)}</strong> — ${a.views || 0} visningar</div>`).join("")
            : "<p>Inga artiklar publicerade den senaste veckan.</p>";
    }

    boot();
})();
