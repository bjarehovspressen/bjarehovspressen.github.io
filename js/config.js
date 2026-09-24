// ============================================================================
// BJÄREHOVS PRESSEN — KONFIGURATION
// ============================================================================
// Fyll i dina EGNA värden från Supabase (Project Settings > API).
//
// ANVÄND ENDAST:
//   - Project URL
//   - "anon" / "public" (publishable) key
//
// LÄGG ALDRIG IN:
//   - service_role key
//   - andra hemliga nycklar
//
// Dessa värden är avsedda att vara publika och exponeras i frontend-koden.
// All riktig säkerhet sköts av Supabase Auth + Row Level Security (RLS),
// se supabase/schema.sql.
// ============================================================================

window.BP_CONFIG = {
    supabaseUrl: "https://DITT-PROJEKT.supabase.co",
    supabasePublishableKey: "DIN-PUBLIC-PUBLISHABLE-KEY",

    // Namn på Storage-bucketen för artikelbilder (skapas av schema.sql).
    imageBucket: "article-images"
};
