import type { SeniorityLevel } from '@/webmcp/matching/job-match-hint'

export function seniorityBandFromText(text: string | null | undefined): SeniorityLevel[] {
  if (!text) return ['mid', 'senior']
  const t = text.toLowerCase()
  if (/\b(principal|architect)\b/.test(t)) return ['principal', 'staff']
  if (/\b(staff)\b/.test(t)) return ['staff', 'senior']
  if (/\b(senior|sr\.?|lead)\b/.test(t)) return ['senior']
  if (/\b(junior|jr\.?|entry|intern)\b/.test(t)) return ['junior']
  if (/\b(mid[- ]?level)\b/.test(t)) return ['mid']
  return ['mid', 'senior']
}

export function extractStackFromJsonResume(resume: unknown): string[] {
  if (!resume || typeof resume !== 'object') return []
  const r = resume as { skills?: unknown }
  const groups = Array.isArray(r.skills) ? r.skills : []
  const out: string[] = []
  for (const g of groups) {
    const kws = Array.isArray((g as { keywords?: unknown })?.keywords)
      ? ((g as { keywords: unknown[] }).keywords)
      : []
    for (const k of kws) if (typeof k === 'string') out.push(k.toLowerCase())
  }
  return out
}

// Words that show up in job_focus strings ("Senior Backend Engineer") but
// aren't real stack tags: we drop them so they can't accidentally match
// a scanner-emitted tag with the same string. The match is one-way (job
// tag → user set), so false positives only happen when a stopword equals
// an actual scraped tag; this list covers the obvious overlap.
const STACK_TOKEN_STOPWORDS = new Set([
  'senior', 'sr', 'junior', 'jr', 'staff', 'principal', 'lead', 'mid',
  'entry', 'intern', 'manager',
  'engineer', 'developer', 'dev', 'programmer', 'architect',
  'software', 'fullstack', 'full',
  'and', 'or', 'the', 'a', 'an', 'of', 'with', 'in', 'at', 'to', 'for',
])

// Tokenize a free-text role string ("Senior React/TypeScript Developer")
// into stack-tag candidates. Splits on whitespace and the punctuation that
// usually separates tech names; preserves intra-token characters like
// dots, hyphens, plus signs, and hash signs (so "next.js", "c++", "c#"
// survive). Strips edge punctuation, lowercases, dedupes, drops stopwords.
export function extractStackFromText(text: string | null | undefined): string[] {
  if (!text) return []
  const tokens = text
    .toLowerCase()
    .split(/[\s,/()|&]+/)
    .map(t => t.replace(/^[^a-z0-9]+|[^a-z0-9.+#-]+$/g, ''))
    .filter(t => t.length >= 2 && !STACK_TOKEN_STOPWORDS.has(t))
  return Array.from(new Set(tokens))
}

// JSON Resume's basics.location is a structured object: { address?, city?,
// region?, countryCode?, postalCode? }. Pull a raw string (most specific
// first) for fuzzy match-against-job-location, and pass through countryCode
// directly when present, falling back to the raw string for toCountryCode
// resolution.
export function extractLocationFromJsonResume(resume: unknown): {
  raw: string | null
  countryCode: string | null
} {
  if (!resume || typeof resume !== 'object') {
    return { raw: null, countryCode: null }
  }
  const r = resume as { basics?: unknown }
  const basics = r.basics as
    | {
        location?: {
          address?: unknown
          city?: unknown
          region?: unknown
          countryCode?: unknown
        }
      }
    | undefined
  const loc = basics?.location
  if (!loc || typeof loc !== 'object') {
    return { raw: null, countryCode: null }
  }
  const pieces = [loc.address, loc.city, loc.region]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(s => s.trim())
  const raw = pieces.length > 0 ? pieces.join(', ') : null
  const countryCode =
    typeof loc.countryCode === 'string' && loc.countryCode.trim().length > 0
      ? loc.countryCode.trim().toUpperCase()
      : null
  return { raw, countryCode }
}

// Minimal map: enough for v1. Expand based on empty-search telemetry.
const COUNTRY_BY_NAME: Record<string, string> = {
  germany: 'DE', deutschland: 'DE',
  'united states': 'US', usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US',
  'united kingdom': 'GB', uk: 'GB', england: 'GB', britain: 'GB',
  netherlands: 'NL', holland: 'NL',
  france: 'FR', spain: 'ES', italy: 'IT', portugal: 'PT',
  sweden: 'SE', norway: 'NO', denmark: 'DK', finland: 'FI',
  poland: 'PL', ireland: 'IE', austria: 'AT', switzerland: 'CH',
  belgium: 'BE', canada: 'CA', australia: 'AU', 'new zealand': 'NZ',
  india: 'IN', singapore: 'SG', japan: 'JP',
}

export function toCountryCode(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  for (const key of Object.keys(COUNTRY_BY_NAME)) {
    if (s.includes(key)) return COUNTRY_BY_NAME[key]
  }
  return null
}
