// Read-only WebMCP tools. Every one is annotated readOnlyHint: true, spends
// no credits, and writes nothing. An agent may call these unprompted.
//
// All network access goes through toolFetch, which is same-origin with
// credentials. That is deliberate: the agent supplies arguments, the browser
// supplies the session, and no token ever crosses the boundary.

import {
  computeMatchHint,
  type MatchJob,
  type SeniorityLevel,
} from '@/webmcp/matching/job-match-hint'
import {
  seniorityBandFromText,
  extractStackFromJsonResume,
  extractStackFromText,
  extractLocationFromJsonResume,
  toCountryCode,
} from '@/webmcp/matching/job-match-profile'
import { REGION_KEYS } from '@/webmcp/matching/job-regions'
import { getBoard } from '@/webmcp/store'
import {
  fail,
  failFromStatus,
  toolFetch,
  type ToolDescriptor,
} from '@/webmcp/types'

// jobs_feed.salary_range is free text and frequently absent, so there is no
// server-side salary filter to call. We parse it best-effort in the tool and
// say so in the schema, rather than silently pretending to filter.
const SALARY_NUMBER = /(\d[\d.,]*)\s*(k\b)?/gi

/**
 * Largest plausible salary figure in a free-text range, or null when the text
 * carries no usable number. Exported for its test: this is a heuristic over
 * unstructured strings, so its edge cases are the whole story.
 *
 * We take the maximum rather than the minimum because postings state ranges
 * and a candidate filtering on "at least X" cares about the top of the band.
 */
export function maxSalaryIn(range: string | null | undefined): number | null {
  if (!range) return null
  let best: number | null = null
  for (const m of range.matchAll(SALARY_NUMBER)) {
    const digits = Number(m[1].replace(/[.,]/g, ''))
    if (!Number.isFinite(digits)) continue
    const suffixed = Boolean(m[2])
    const value = suffixed ? digits * 1000 : digits
    // Below 1000 a bare number is a headcount, an equity percentage or a
    // street number far more often than a salary.
    if (value < 1000) continue
    // A bare four-digit number in the year range is almost always a date
    // ("Posted 2026", "Founded 1998"). With a k suffix it is a real figure.
    if (!suffixed && digits >= 1900 && digits <= 2100) continue
    if (best === null || value > best) best = value
  }
  return best
}

interface FeedRow {
  id: string
  company: string
  title: string
  apply_url: string
  location: string | null
  location_country: string | null
  remote: string | null
  seniority: string | null
  stack_tags: string[]
  salary_range: string | null
  posted_at: string | null
  is_saved?: boolean
  application_status?: string | null
}

function slim(job: FeedRow) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    country: job.location_country,
    remote: job.remote,
    seniority: job.seniority,
    stack: job.stack_tags ?? [],
    salary: job.salary_range,
    postedAt: job.posted_at,
    saved: job.is_saved ?? false,
    applicationStatus: job.application_status ?? null,
  }
}

// ─── search_jobs ─────────────────────────────────────────────────────────────

const searchJobs: ToolDescriptor = {
  name: 'search_jobs',
  description:
    'Search live job postings on JobJam. Filters the visible job board in ' +
    'the page as it runs, so the user sees the same results. Returns ' +
    'matching roles with company, location, remote policy, seniority and ' +
    'tech stack. Use this before any tool that needs a jobId.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Free-text role keywords, e.g. "senior frontend" or "platform engineer".',
      },
      country: {
        type: 'string',
        description: 'ISO 3166-1 alpha-2 country code, e.g. DE, GB, NL.',
      },
      region: {
        type: 'string',
        enum: [...REGION_KEYS],
        description: 'Multi-country region. Use instead of country, not with it.',
      },
      remote: {
        type: 'string',
        enum: ['remote', 'hybrid', 'onsite'],
        description:
          'Work model. Postings whose model is unclassified are included.',
      },
      seniority: {
        type: 'string',
        enum: ['junior', 'mid', 'senior', 'staff', 'principal'],
        description:
          'Seniority band. Postings with unclassified seniority are included.',
      },
      stack: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Technologies that must ALL appear on the posting, e.g. ["react","typescript"].',
      },
      company: { type: 'string', description: 'Filter by company name.' },
      postedSince: {
        type: 'string',
        enum: ['24h', '7d', '30d'],
        description:
          'Only postings with a real source-side posting date in this window.',
      },
      minSalary: {
        type: 'number',
        description:
          'Best-effort only. Salary is unstructured free text on most ' +
          'postings and absent on many, so this filters the returned page ' +
          'by parsing that text. Postings with no stated salary are kept ' +
          'and flagged salaryKnown: false rather than dropped. Never ' +
          'present this as a reliable filter to the user.',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return, 1 to 50. Defaults to 20.',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute: async params => {
    const p = params as {
      query?: string
      country?: string
      region?: string
      remote?: string
      seniority?: string
      stack?: string[]
      company?: string
      postedSince?: string
      minSalary?: number
      limit?: number
    }

    const qs = new URLSearchParams()
    if (p.query) qs.set('q', p.query)
    if (p.country) qs.set('country', p.country.toUpperCase())
    else if (p.region) qs.set('region', p.region)
    if (p.remote) qs.set('remote', p.remote)
    if (p.seniority) qs.set('seniority', p.seniority)
    if (p.company) qs.set('company', p.company)
    if (p.postedSince) qs.set('posted_since', p.postedSince)
    for (const s of p.stack ?? []) qs.append('stack', s)
    const limit = Math.min(50, Math.max(1, Math.round(p.limit ?? 20)))
    qs.set('limit', String(limit))

    const { status, body } = await toolFetch(`/api/jobs-feed?${qs}`)
    const failure = failFromStatus(status, body)
    if (failure) return failure

    const rows = (body?.jobs ?? []) as FeedRow[]

    // Drive the visible board through the same path a human click uses, so
    // the page reflects what the agent just did. No-op off the board.
    getBoard()?.applyFilters({
      q: p.query,
      country: p.country?.toUpperCase(),
      region: p.region,
      remote: p.remote,
      seniority: p.seniority,
      stack: p.stack,
      company: p.company,
      posted_since: p.postedSince,
      limit,
    })

    let jobs = rows.map(r => ({
      ...slim(r),
      salaryKnown: Boolean(r.salary_range),
      salaryUpper: maxSalaryIn(r.salary_range),
    }))

    let salaryNote: string | undefined
    if (typeof p.minSalary === 'number') {
      const before = jobs.length
      jobs = jobs.filter(
        j => j.salaryUpper === null || j.salaryUpper >= p.minSalary!
      )
      salaryNote =
        `Salary filtering is best effort. ${before - jobs.length} of ` +
        `${before} results were excluded because a stated figure fell ` +
        'below the threshold. Postings with no stated salary were kept ' +
        'and are marked salaryKnown: false.'
    }

    return {
      ok: true,
      jobs,
      total: body?.total ?? jobs.length,
      returned: jobs.length,
      ...(salaryNote ? { salaryNote } : {}),
    }
  },
}

// ─── get_job_details ─────────────────────────────────────────────────────────

const getJobDetails: ToolDescriptor = {
  name: 'get_job_details',
  description:
    'Get the full posting for one job, including the complete job ' +
    'description text. Selects that job in the visible board. Call this ' +
    'before evaluating fit, so the evaluation sees the real requirements.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
        description: 'The job id returned by search_jobs.',
      },
      includeDescription: {
        type: 'boolean',
        description:
          'Fetch the full description body. Defaults to true. Set false ' +
          'for a cheap metadata-only lookup.',
      },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute: async params => {
    const { jobId, includeDescription = true } = params as {
      jobId: string
      includeDescription?: boolean
    }
    if (!jobId) return fail('BAD_ARGUMENT', 'jobId is required.')

    const { status, body } = await toolFetch(`/api/jobs-feed/${jobId}`)
    const failure = failFromStatus(status, body)
    if (failure) return failure
    if (!body?.job) return fail('NOT_FOUND', `No job with id ${jobId}.`)

    getBoard()?.selectJob(jobId)

    let description: string | null = null
    let descriptionError: string | undefined
    if (includeDescription) {
      // Descriptions live on the scanner service, not in jobs_feed (they were
      // dropped in migration 049). A scanner outage must degrade to metadata,
      // not fail the whole tool call.
      const d = await toolFetch(`/api/jobs-feed/${jobId}/description`)
      if (d.status === 200 && typeof d.body?.description === 'string') {
        description = d.body.description
      } else {
        descriptionError =
          'The full description could not be retrieved right now. The ' +
          'metadata below is still accurate.'
      }
    }

    return {
      ok: true,
      job: slim(body.job as FeedRow),
      applyUrl: (body.job as FeedRow).apply_url,
      description,
      ...(descriptionError ? { descriptionError } : {}),
    }
  },
}

// ─── get_my_profile ──────────────────────────────────────────────────────────

interface ResolvedProfile {
  profileId: string | null
  profileName: string | null
  jobFocus: string | null
  resumeId: string | null
  resume: unknown
}

/**
 * Resolves the user's active professional profile and its base resume.
 *
 * There is no single endpoint for this: profiles, the base-document link and
 * the document body are three separate routes. Composing them here rather
 * than adding a server route keeps the whole WebMCP layer additive.
 */
export async function resolveActiveProfile(): Promise<
  ResolvedProfile | { error: ReturnType<typeof fail> }
> {
  const list = await toolFetch('/api/profiles')
  const listFailure = failFromStatus(list.status, list.body)
  if (listFailure) return { error: listFailure }

  const profiles = (list.body?.profiles ?? []) as Array<{
    id: string
    name: string
    job_focus?: string
    jobFocus?: string
  }>
  if (profiles.length === 0) {
    return {
      profileId: null,
      profileName: null,
      jobFocus: null,
      resumeId: null,
      resume: null,
    }
  }

  const active = profiles[0]
  const docs = await toolFetch(
    `/api/profiles/${active.id}/base-documents`
  )
  const baseResume = docs.body?.baseResume ?? null

  return {
    profileId: active.id,
    profileName: active.name ?? null,
    jobFocus: active.job_focus ?? active.jobFocus ?? null,
    resumeId: baseResume?.id ?? null,
    resume: baseResume?.content ?? null,
  }
}

const getMyProfile: ToolDescriptor = {
  name: 'get_my_profile',
  description:
    "Get the signed-in user's JobJam profile and the skills, seniority and " +
    'location derived from their resume. Call this first when the user asks ' +
    'for roles that fit them, so later tools can rank against real data ' +
    'rather than guesses. Returns no resume document text, only the derived ' +
    'signals and basic contact fields.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute: async () => {
    const account = await toolFetch('/api/profile')
    const failure = failFromStatus(account.status, account.body)
    if (failure) return failure

    const resolved = await resolveActiveProfile()
    if ('error' in resolved) return resolved.error

    const resumeStack = extractStackFromJsonResume(resolved.resume)
    const stack =
      resumeStack.length > 0
        ? resumeStack
        : extractStackFromText(resolved.jobFocus)
    const { raw, countryCode } = extractLocationFromJsonResume(resolved.resume)

    const p = account.body?.profile ?? {}
    return {
      ok: true,
      name: [p.firstName, p.lastName].filter(Boolean).join(' ') || null,
      headline: p.title || null,
      location: p.location || raw || null,
      country: countryCode ?? toCountryCode(raw) ?? null,
      profileId: resolved.profileId,
      profileName: resolved.profileName,
      jobFocus: resolved.jobFocus,
      hasResume: Boolean(resolved.resume),
      resumeId: resolved.resumeId,
      derivedSkills: stack,
      derivedSeniority: seniorityBandFromText(resolved.jobFocus ?? ''),
    }
  },
}

// ─── rank_jobs_for_me ────────────────────────────────────────────────────────

const rankJobsForMe: ToolDescriptor = {
  name: 'rank_jobs_for_me',
  description:
    "Rank jobs against the signed-in user's resume and return them best " +
    'first, with a per-job explanation of why. This is JobJam\'s fast ' +
    'deterministic matcher: it scores stack overlap, seniority band and ' +
    'location, costs nothing, and is instant. Use it to shortlist. For a ' +
    'deep AI evaluation of one job with an ATS score, use evaluate_job_fit ' +
    'instead, which spends a credit and needs approval.',
  inputSchema: {
    type: 'object',
    properties: {
      jobIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Job ids from search_jobs. Between 2 and 25. Ranking one job is ' +
          'not useful; use get_job_details for that.',
      },
    },
    required: ['jobIds'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute: async params => {
    const { jobIds } = params as { jobIds: string[] }
    if (!Array.isArray(jobIds) || jobIds.length < 2) {
      return fail('BAD_ARGUMENT', 'Provide at least 2 jobIds to rank.')
    }
    const ids = jobIds.slice(0, 25)

    const resolved = await resolveActiveProfile()
    if ('error' in resolved) return resolved.error
    if (!resolved.resume) {
      return fail(
        'NO_RESUME',
        'This user has no base resume yet, so there is nothing to rank ' +
          'against. Ask them to paste their resume text, then call ' +
          'create_profile_from_resume. That costs nothing.'
      )
    }

    const resumeStack = extractStackFromJsonResume(resolved.resume)
    const userStack =
      resumeStack.length > 0
        ? resumeStack
        : extractStackFromText(resolved.jobFocus)
    const { raw, countryCode } = extractLocationFromJsonResume(resolved.resume)
    const userLocationCountry = countryCode ?? toCountryCode(raw)
    const userSeniorityBand = seniorityBandFromText(
      resolved.jobFocus ?? ''
    ) as SeniorityLevel[]

    const fetched = await Promise.all(
      ids.map(id => toolFetch(`/api/jobs-feed/${id}`))
    )

    const ranked = fetched
      .map(({ body }) => body?.job as FeedRow | undefined)
      .filter((j): j is FeedRow => Boolean(j))
      .map(job => {
        const matchJob: MatchJob = {
          stack_tags: job.stack_tags ?? [],
          seniority: job.seniority as MatchJob['seniority'],
          remote: job.remote as MatchJob['remote'],
          location: job.location,
          location_country: job.location_country,
        }
        // Returns null when the posting carries no scorable signal at all
        // (no stack tags, no seniority, no resolvable location). Rank those
        // last rather than dropping them: the job is still real, we just
        // cannot say anything about fit.
        const hint = computeMatchHint({
          userStack,
          userSeniorityBand,
          userLocationCountry,
          userLocationRaw: raw,
          job: matchJob,
        })
        return {
          ...slim(job),
          score: hint?.score ?? 0,
          band: hint?.band ?? 'unknown',
          why:
            hint?.why ??
            'This posting has no stack, seniority or location we could ' +
              'score against.',
          matchedSkills: hint?.signals?.stack.matched ?? [],
        }
      })
      .sort((a, b) => b.score - a.score)

    return {
      ok: true,
      ranked,
      scoredAgainst: {
        skills: userStack,
        seniority: userSeniorityBand,
        country: userLocationCountry,
      },
      note:
        'Scores are 0 to 10 from stack overlap, seniority band and ' +
        'location. They are a shortlisting heuristic, not an ATS score.',
    }
  },
}

// ─── get_credit_balance ──────────────────────────────────────────────────────

const getCreditBalance: ToolDescriptor = {
  name: 'get_credit_balance',
  description:
    "Check how many credits the signed-in user has left. Call this before " +
    'proposing evaluate_job_fit (needs 1 evaluation credit) or ' +
    'prepare_application (needs 1 evaluation, 1 optimization and 1 cover ' +
    'letter), so you can tell them they are short instead of letting the ' +
    'action fail after they approve it.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  execute: async () => {
    const { status, body } = await toolFetch('/api/credits/balance')
    const failure = failFromStatus(status, body)
    if (failure) return failure

    const credits = {
      evaluations: body?.evaluations ?? 0,
      optimizations: body?.optimizations ?? 0,
      coverLetters: body?.cover_letters ?? 0,
      aiAssists: body?.ai_assists ?? 0,
    }
    return {
      ok: true,
      plan: body?.plan_id ?? 'free',
      credits,
      canEvaluate: credits.evaluations >= 1,
      canPrepareApplication:
        credits.evaluations >= 1 &&
        credits.optimizations >= 1 &&
        credits.coverLetters >= 1,
      topUpUrl: '/account/billing',
    }
  },
}

// ─── get_apply_instructions ──────────────────────────────────────────────────

const getApplyInstructions: ToolDescriptor = {
  name: 'get_apply_instructions',
  description:
    'Explain how the user applies for a job, and return the employer\'s ' +
    'official application URL. Call this whenever the user asks you to ' +
    'apply, submit or send an application. JobJam does not submit ' +
    'applications on anyone\'s behalf, so no tool can do that; this returns ' +
    'the link for the user to complete themselves, and mark_job_applied ' +
    'records it afterwards.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id to apply for.' },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute: async params => {
    const { jobId } = params as { jobId: string }
    if (!jobId) return fail('BAD_ARGUMENT', 'jobId is required.')

    const { status, body } = await toolFetch(`/api/jobs-feed/${jobId}`)
    const failure = failFromStatus(status, body)
    if (failure) return failure
    if (!body?.job) return fail('NOT_FOUND', `No job with id ${jobId}.`)

    const job = body.job as FeedRow
    return {
      ok: true,
      canSubmitOnUserBehalf: false,
      // Stated rather than implied. An agent told only "there is no submit
      // tool" tends to hunt for a workaround; told why, it relays the
      // boundary to the user instead.
      why:
        'JobJam never submits applications to employers. Applications go ' +
        'through the company\'s own system, where the user may need to ' +
        'answer questions only they can answer, and where a submission ' +
        'cannot be taken back.',
      steps: [
        `Open the employer's application page: ${job.apply_url}`,
        'Complete and submit it there.',
        'Come back and call mark_job_applied so JobJam tracks it.',
      ],
      applyUrl: job.apply_url,
      job: slim(job),
    }
  },
}

export const READ_TOOLS: ToolDescriptor[] = [
  searchJobs,
  getJobDetails,
  getMyProfile,
  rankJobsForMe,
  getCreditBalance,
  getApplyInstructions,
]
