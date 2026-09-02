// Region → country code groupings used by the /jobs board's location filter.
// Kept inclusive: Europe covers EU + EFTA + UK + Western Balkans + non-EU
// Eastern Europe, since scanner-ingested rows surface companies from across
// the whole continent. North America groups US/CA/MX.
//
// Shared between server (`/api/jobs-feed/route.ts`) and client (`JobsFilterBar`).

export const REGION_COUNTRIES = {
  europe: [
    'AD',
    'AL',
    'AT',
    'BA',
    'BE',
    'BG',
    'CH',
    'CY',
    'CZ',
    'DE',
    'DK',
    'EE',
    'ES',
    'FI',
    'FR',
    'GB',
    'GR',
    'HR',
    'HU',
    'IE',
    'IS',
    'IT',
    'LI',
    'LT',
    'LU',
    'LV',
    'MC',
    'MD',
    'ME',
    'MK',
    'MT',
    'NL',
    'NO',
    'PL',
    'PT',
    'RO',
    'RS',
    'SE',
    'SI',
    'SK',
    'SM',
    'UA',
    'VA',
    'XK',
  ],
  north_america: ['CA', 'MX', 'US'],
} as const

export type RegionKey = keyof typeof REGION_COUNTRIES

export const REGION_LABELS: Record<RegionKey, string> = {
  europe: '🇪🇺 Europe',
  north_america: '🌎 North America',
}

// Free-text keywords to match against `jobs_feed.location` when
// `location_country` is NULL or doesn't resolve. Catches scanner rows like
// "Remote Europe FullTime" where the region is obvious from the location
// string but no single ISO2 country can be derived. ILIKE `*kw*` so prefixes
// and suffixes (european, europeans, europe-wide, EMEA Region) all match.
export const REGION_LOCATION_KEYWORDS: Record<RegionKey, string[]> = {
  europe: ['europe', 'emea'],
  north_america: [],
}

export const REGION_KEYS = Object.keys(REGION_COUNTRIES) as [
  RegionKey,
  ...RegionKey[],
]
