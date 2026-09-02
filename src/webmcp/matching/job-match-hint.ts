export type SeniorityLevel = 'junior' | 'mid' | 'senior' | 'staff' | 'principal'
export type RemotePolicy = 'remote' | 'hybrid' | 'onsite'

export interface MatchJob {
  stack_tags: string[]
  seniority: SeniorityLevel | null | undefined
  remote: RemotePolicy | null | undefined
  location: string | null | undefined
  location_country: string | null | undefined
}

export interface MatchInput {
  userStack: string[]
  userSeniorityBand: SeniorityLevel[]
  userLocationCountry: string | null | undefined
  userLocationRaw: string | null | undefined
  job: MatchJob
}

export interface MatchSignals {
  stack: {
    hits: number
    total: number
    matched: string[]
  }
  seniority: {
    jobLevel: SeniorityLevel | null
    status: 'match' | 'stretch' | 'unknown'
  }
  location: {
    jobLocation: string | null
    jobCountry: string | null
    jobRemote: RemotePolicy | null
    userCountry: string | null
    status: 'remote' | 'country-match' | 'mismatch' | 'unknown'
  }
}

export interface MatchResult {
  score: number
  band: 'high' | 'medium' | 'low'
  why: string
  signals?: MatchSignals
}

const STACK_WEIGHT = 5
const SENIORITY_WEIGHT = 2
const LOCATION_WEIGHT = 3
const TOTAL = STACK_WEIGHT + SENIORITY_WEIGHT + LOCATION_WEIGHT

function stackHits(userStack: string[], jobTags: string[]): number {
  if (userStack.length === 0) return 0
  const u = new Set(userStack.map(s => s.toLowerCase()))
  let hit = 0
  for (const t of jobTags) if (u.has(t.toLowerCase())) hit++
  return hit
}

function stackOverlap(userStack: string[], jobTags: string[]): number {
  // Stack overlap = "how much of what the job needs does the user have".
  // Using job tags as the denominator means a user with a broad resume
  // isn't penalized: matching all of a job's stack tags scores 1.0
  // regardless of how many other skills the user has.
  if (userStack.length === 0 || jobTags.length === 0) return 0
  const ratio = stackHits(userStack, jobTags) / jobTags.length
  return Math.min(1, ratio)
}

function locationMatch(
  userCountry: string | null | undefined,
  userRaw: string | null | undefined,
  job: MatchJob
): boolean {
  if (job.remote === 'remote') return true
  if (userCountry && job.location_country && userCountry === job.location_country) return true
  if (userRaw && job.location) {
    const a = userRaw.toLowerCase()
    const b = job.location.toLowerCase()
    return a.includes(b) || b.includes(a)
  }
  return false
}

function bandOf(score: number): MatchResult['band'] {
  if (score >= 7) return 'high'
  if (score >= 4) return 'medium'
  return 'low'
}

function hasScorableSignal(input: MatchInput): boolean {
  // Every weighted dimension needs at least one input from the user side to be
  // informative. Stack overlap collapses to 0 with no userStack; seniority
  // needs userSeniorityBand; location needs either a country or a raw string
  // (remote jobs still benefit from at least one of these so the signal isn't
  // purely derived from the job's own metadata).
  const { userStack, userSeniorityBand, userLocationCountry, userLocationRaw } = input
  return (
    userStack.length > 0 ||
    userSeniorityBand.length > 0 ||
    Boolean(userLocationCountry) ||
    Boolean(userLocationRaw)
  )
}

function buildWhy(input: MatchInput): string {
  const { userStack, userSeniorityBand, job } = input
  const parts: string[] = []

  // Stack fragment
  if (userStack.length > 0 && job.stack_tags && job.stack_tags.length > 0) {
    const hits = stackHits(userStack, job.stack_tags)
    parts.push(`${hits} of ${job.stack_tags.length} stack matches`)
  }

  // Seniority fragment
  if (job.seniority && userSeniorityBand.length > 0) {
    if (userSeniorityBand.includes(job.seniority)) {
      parts.push(`${job.seniority} level`)
    } else {
      parts.push(`seniority stretch`)
    }
  }

  // Location fragment
  if (job.remote === 'remote') {
    parts.push('remote-friendly')
  } else if (
    input.userLocationCountry &&
    job.location_country &&
    input.userLocationCountry !== job.location_country
  ) {
    parts.push('location mismatch')
  }

  // Cap at 80 chars (the spec's contract)
  let why = parts.join(' · ')
  if (why.length > 80) why = why.slice(0, 77) + '...'
  return why
}

function buildSignals(input: MatchInput): MatchSignals {
  const { userStack, userSeniorityBand, userLocationCountry, job } = input
  const lowerSet = new Set(userStack.map(s => s.toLowerCase()))
  const matched = (job.stack_tags ?? []).filter(t => lowerSet.has(t.toLowerCase()))

  let seniorityStatus: 'match' | 'stretch' | 'unknown' = 'unknown'
  if (job.seniority && userSeniorityBand.length > 0) {
    seniorityStatus = userSeniorityBand.includes(job.seniority) ? 'match' : 'stretch'
  }

  let locationStatus: MatchSignals['location']['status'] = 'unknown'
  if (job.remote === 'remote') {
    locationStatus = 'remote'
  } else if (userLocationCountry && job.location_country) {
    locationStatus =
      userLocationCountry === job.location_country ? 'country-match' : 'mismatch'
  }

  return {
    stack: {
      hits: matched.length,
      total: (job.stack_tags ?? []).length,
      matched,
    },
    seniority: {
      jobLevel: job.seniority ?? null,
      status: seniorityStatus,
    },
    location: {
      jobLocation: job.location ?? null,
      jobCountry: job.location_country ?? null,
      jobRemote: job.remote ?? null,
      userCountry: userLocationCountry ?? null,
      status: locationStatus,
    },
  }
}

function computeMatchHintImpl(input: MatchInput): MatchResult | null {
  // When we have no profile signal at all, scoring collapses to 0 on every row
  // and the UI turns into a sea of red "0/10" badges that look broken. Return
  // null so the frontend can simply omit the badge.
  if (!hasScorableSignal(input)) return null

  const { userStack, userSeniorityBand, userLocationCountry, userLocationRaw, job } = input

  const stackFactor = stackOverlap(userStack, job.stack_tags ?? [])
  const stackPts = stackFactor * STACK_WEIGHT

  const seniorityPts = job.seniority && userSeniorityBand.includes(job.seniority)
    ? SENIORITY_WEIGHT
    : 0

  const locationPts = locationMatch(userLocationCountry, userLocationRaw, job)
    ? LOCATION_WEIGHT
    : 0

  const score = Math.round(((stackPts + seniorityPts + locationPts) / TOTAL) * 10)
  return {
    score,
    band: bandOf(score),
    why: buildWhy(input),
    signals: buildSignals(input),
  }
}

type MatchHintFn = typeof computeMatchHintImpl & {
  band: (score: number) => MatchResult['band']
}

export const computeMatchHint: MatchHintFn = Object.assign(computeMatchHintImpl, {
  band: bandOf,
})
