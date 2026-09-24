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
    supabaseUrl: "https://cprexesfqcomjqzqzjew.supabase.co",
    supabasePublishableKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNwcmV4ZXNmcWNvbWpxenF6amV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNTc2ODQsImV4cCI6MjEwNTgzMzY4NH0.xf8l1RP4kiU6VG7OJ7nkQihtgYUsUWO3CpG3XNp_Rzk",

    // Namn på Storage-bucketen för artikelbilder (skapas av schema.sql).
    imageBucket: "article-images"
};
