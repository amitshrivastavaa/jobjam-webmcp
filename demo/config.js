// The demo talks straight to JobJam's public, anon-granted Postgres functions,
// so it needs no JobJam backend and no login.
//
// Both values below are publishable by design: the key is RLS-scoped, carries
// no more authority than an anonymous visitor has, and already ships in the
// JavaScript bundle of every page on jobjam.io. They are checked in so the
// demo runs with no setup. Substitute your own Supabase project if you
// would rather point this somewhere else.
window.JOBJAM_DEMO_CONFIG = {
  supabaseUrl: 'https://xencqtdruksmuszcyfzs.supabase.co',
  anonKey: 'sb_publishable_GrAgPbM3qHTsIKziHVoM0Q_ajbQ5YWt',
}
