// The demo talks straight to JobJam's public, anon-granted Postgres functions,
// so it needs no JobJam backend and no login.
//
// Both values below are publishable by design: the anon key is RLS-scoped and
// already ships in the JavaScript bundle of every page on jobjam.io. To fill
// them in, open https://www.jobjam.io, view source, and copy the two
// NEXT_PUBLIC_SUPABASE_* values, or substitute your own Supabase project.
window.JOBJAM_DEMO_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'YOUR-PUBLISHABLE-ANON-KEY',
}
