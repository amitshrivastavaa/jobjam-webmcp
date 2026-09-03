// WebMCP tools that change state.
//
// Two tiers, and the split is the point of this file:
//
//   Reversible   save_job / unsave_job. Logged in the activity panel, undoable
//                in one click, no money spent. No modal: a confirmation on
//                every bookmark trains people to click through confirmations.
//
//   Consequential  evaluate_job_fit / prepare_application / mark_job_applied.
//                These spend the user's purchased credits or assert a
//                real-world fact. Each one blocks on requestApproval() before
//                any network call, and carries destructiveHint: true so the
//                agent knows it before calling.
//
// JobJam deliberately exposes no tool that submits an application to an
// employer. The product does not do it, so neither does the tool surface.

import { getBoard, getNavigation, requestApproval } from '@/webmcp/store'
import { resolveActiveProfile } from '@/webmcp/tools/read'
import {
  fail,
  failFromStatus,
  toolFetch,
  type ToolDescriptor,
} from '@/webmcp/types'

const DENIED = fail(
  'DENIED_BY_USER',
  'The user declined this action. Do not retry it. Ask what they would ' +
    'prefer instead.'
)

// Idempotency keys make an agent retry free rather than double-charged. The
// server claims the key before deducting a credit, so a replayed call returns
// the stored result instead of spending again (lib/idempotency.ts).
function idempotencyKey(scope: string): string {
  return `webmcp-${scope}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
}

async function jobLabel(jobId: string): Promise<string> {
  const { body } = await toolFetch(`/api/jobs-feed/${jobId}`)
  const job = body?.job
  return job ? `${job.title} at ${job.company}` : `job ${jobId}`
}

/**
 * Where an evaluation result actually renders.
 *
 * Not the tracker. /applications/[id] is a filing record — status, dates,
 * empty document slots — and it does not show the score at all. The
 * conversation view is what the credit bought: the ATS ring, matched and
 * missing skills, the recommendations, and after prepare_application the
 * rewritten resume and the cover letter. The tracker is only a fallback for
 * the case where an evaluation was never linked to a conversation.
 */
function resultUrl(
  conversationId?: string | null,
  applicationId?: string | null
): string | null {
  if (conversationId) return `/apply/ai-assistant/c/${conversationId}`
  if (applicationId) return `/applications/${applicationId}`
  return null
}

// ─── save_job / unsave_job ───────────────────────────────────────────────────

const saveJob: ToolDescriptor = {
  name: 'save_job',
  description:
    "Bookmark a job to the signed-in user's saved list. The bookmark " +
    'appears immediately in the page. Reversible with unsave_job, spends no ' +
    'credits, and is safe to call repeatedly: saving an already-saved job ' +
    'succeeds without creating a duplicate.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id from search_jobs.' },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  annotations: { destructiveHint: false },
  execute: async params => {
    const { jobId } = params as { jobId: string }
    if (!jobId) return fail('BAD_ARGUMENT', 'jobId is required.')

    const { status, body } = await toolFetch(
      `/api/jobs-feed/${jobId}/save`,
      { method: 'POST' }
    )
    const failure = failFromStatus(status, body)
    if (failure) return failure

    getBoard()?.setJobSaved?.(jobId, true)
    return { ok: true, jobId, saved: true }
  },
}

const unsaveJob: ToolDescriptor = {
  name: 'unsave_job',
  description:
    "Remove a job from the signed-in user's saved list. Reversible with " +
    'save_job. Does not delete any evaluation or application already made ' +
    'for that job.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id to unsave.' },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  annotations: { destructiveHint: false },
  execute: async params => {
    const { jobId } = params as { jobId: string }
    if (!jobId) return fail('BAD_ARGUMENT', 'jobId is required.')

    const { status, body } = await toolFetch(
      `/api/jobs-feed/${jobId}/save`,
      { method: 'DELETE' }
    )
    const failure = failFromStatus(status, body)
    if (failure) return failure

    getBoard()?.setJobSaved?.(jobId, false)
    return { ok: true, jobId, saved: false }
  },
}

const listSavedJobs: ToolDescriptor = {
  name: 'list_saved_jobs',
  description:
    "List the signed-in user's saved jobs, with any evaluation score and " +
    'application status already recorded for each.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  execute: async () => {
    const { status, body } = await toolFetch('/api/jobs-feed/saved')
    const failure = failFromStatus(status, body)
    if (failure) return failure

    const items = (body?.items ?? []) as Array<{
      saved_at: string
      job: {
        id: string
        title: string
        company: string
        location: string | null
        application_status?: string | null
      }
      evaluation: { score: number; application_id: string } | null
    }>

    return {
      ok: true,
      saved: items.map(i => ({
        jobId: i.job.id,
        title: i.job.title,
        company: i.job.company,
        location: i.job.location,
        savedAt: i.saved_at,
        atsScore: i.evaluation?.score ?? null,
        applicationId: i.evaluation?.application_id ?? null,
        applicationStatus: i.job.application_status ?? null,
      })),
      total: items.length,
      unevaluated: body?.unevaluated_count ?? 0,
    }
  },
}

// ─── create_profile_from_resume ──────────────────────────────────────────────

const createProfileFromResume: ToolDescriptor = {
  name: 'create_profile_from_resume',
  description:
    'Create the user\'s JobJam profile from their resume text and set that ' +
    'resume as their base resume. Call this when get_my_profile reports ' +
    'hasResume: false, or when any tool fails with NO_RESUME. Ask the user ' +
    'to paste their resume as plain text first. Spends no credits, but ' +
    'requires approval because it creates their profile, and the free plan ' +
    'allows only one.',
  inputSchema: {
    type: 'object',
    properties: {
      resumeText: {
        type: 'string',
        description:
          'The full plain text of the resume, as the user pasted it. At ' +
          'least a few hundred characters: a name and a job title alone ' +
          'will not parse into anything useful.',
      },
      jobFocus: {
        type: 'string',
        description:
          'The kind of role they are targeting, e.g. "Senior Frontend ' +
          'Engineer". Drives seniority inference for ranking. Required.',
      },
      profileName: {
        type: 'string',
        description:
          'Label for this profile, e.g. "Frontend roles". Defaults to the ' +
          'job focus.',
      },
    },
    required: ['resumeText', 'jobFocus'],
    additionalProperties: false,
  },
  annotations: { destructiveHint: false },
  execute: async params => {
    const { resumeText, jobFocus, profileName } = params as {
      resumeText: string
      jobFocus: string
      profileName?: string
    }
    // Matches MIN_PASTED_RESUME_CHARS on the public try-it flow: below this
    // the text cannot plausibly be a resume and the parse is wasted.
    if (!resumeText || resumeText.trim().length < 200) {
      return fail(
        'RESUME_TOO_SHORT',
        'That is too short to parse as a resume. Ask the user to paste the ' +
          'full text, including their experience and skills.'
      )
    }
    if (!jobFocus?.trim()) {
      return fail('BAD_ARGUMENT', 'jobFocus is required.')
    }

    const name = (profileName?.trim() || jobFocus.trim()).slice(0, 100)

    const approved = await requestApproval({
      tool: 'create_profile_from_resume',
      title: `Create a JobJam profile for "${jobFocus.trim()}"?`,
      consequences: [
        'Creates a profile and saves the pasted resume to your account',
        'Spends no credits',
        'The free plan allows one profile, so this uses that slot',
      ],
      destructive: false,
    })
    if (!approved) return DENIED

    const created = await toolFetch('/api/profiles', {
      method: 'POST',
      body: JSON.stringify({ name, jobFocus: jobFocus.trim().slice(0, 100) }),
    })
    if (created.status === 403) {
      return fail(
        'PROFILE_LIMIT_REACHED',
        created.body?.error ??
          'This account has reached its profile limit. Use the existing ' +
            'profile instead of creating another.'
      )
    }
    const createFailure = failFromStatus(created.status, created.body)
    if (createFailure) return createFailure

    const profileId = created.body?.profile?.id ?? created.body?.id
    if (!profileId) {
      return fail('REQUEST_FAILED', 'The profile was created without an id.')
    }

    // The parser takes a file, so wrap the pasted text the same way the
    // public try-it flow does. text/plain is an accepted upload type.
    const form = new FormData()
    form.append(
      'file',
      new File([resumeText.trim()], 'resume.txt', { type: 'text/plain' })
    )
    form.append('type', 'resume')

    const parsed = await toolFetch('/api/documents/parse', {
      method: 'POST',
      body: form,
    })
    if (parsed.status !== 200 || !parsed.body?.content) {
      return fail(
        'PARSE_FAILED',
        'The profile was created, but the resume text could not be parsed. ' +
          `Ask the user to add it at /profiles. Profile id: ${profileId}.`
      )
    }

    // setAsBase links the document through profile_documents, which is what
    // every downstream tool reads. Creating the document without it leaves a
    // profile that still reports NO_RESUME.
    const saved = await toolFetch('/api/documents', {
      method: 'POST',
      body: JSON.stringify({
        type: 'resume',
        title: `${name} resume`,
        content: parsed.body.content,
        profileId,
        setAsBase: true,
      }),
    })
    const saveFailure = failFromStatus(saved.status, saved.body)
    if (saveFailure) return saveFailure

    const basics = (parsed.body.content as { basics?: any })?.basics ?? {}
    return {
      ok: true,
      profileId,
      profileName: name,
      jobFocus: jobFocus.trim(),
      parsedName: basics.name ?? null,
      parsedLocation: basics.location?.address ?? null,
      note:
        'The profile is ready. rank_jobs_for_me and evaluate_job_fit will ' +
        'now work for this user.',
    }
  },
}

// ─── evaluate_job_fit ────────────────────────────────────────────────────────

interface EvaluationPayload {
  atsScore: number
  conversationId: string | null
  applicationId: string | null
  resumeId: string | null
  evaluation: {
    skillsMatch?: { matched?: string[]; missing?: string[] }
    recommendations?: Array<{ action: string; why: string; how: string }>
    overallAssessment?: string
  }
}

/**
 * Runs the real evaluation. Shared by evaluate_job_fit and
 * prepare_application so the credit accounting and the approval contract
 * cannot drift between them.
 *
 * Approval is the caller's responsibility: prepare_application asks once for
 * the whole chain rather than three times in a row.
 */
async function runEvaluation(
  jobId: string
): Promise<{ error: ReturnType<typeof fail> } | { data: EvaluationPayload }> {
  const resolved = await resolveActiveProfile()
  if ('error' in resolved) return { error: resolved.error }
  if (!resolved.profileId || !resolved.resumeId) {
    return {
      error: fail(
        'NO_RESUME',
        'Evaluation needs a profile with a base resume. Ask the user to ' +
          'paste their resume text, then call create_profile_from_resume ' +
          'first. That costs nothing.'
      ),
    }
  }

  const detail = await toolFetch(`/api/jobs-feed/${jobId}`)
  const job = detail.body?.job
  if (!job) return { error: fail('NOT_FOUND', `No job with id ${jobId}.`) }

  const desc = await toolFetch(`/api/jobs-feed/${jobId}/description`)
  const jobDescription = desc.body?.description
  if (!jobDescription) {
    return {
      error: fail(
        'NO_DESCRIPTION',
        'The full job description could not be retrieved, and evaluating ' +
          'against the title alone would produce a misleading score. No ' +
          'credit was spent.'
      ),
    }
  }

  // The route takes multipart/form-data, not JSON.
  const form = new FormData()
  form.append('jobDescription', jobDescription)
  form.append('profileId', resolved.profileId)
  form.append('resumeId', resolved.resumeId)
  form.append('jobFeedId', jobId)
  form.append('company', job.company ?? '')
  form.append('jobTitle', job.title ?? '')
  if (job.apply_url) form.append('applicationUrl', job.apply_url)

  const { status, body } = await toolFetch('/api/ai/evaluate-profile-fit', {
    method: 'POST',
    body: form,
    headers: { 'Idempotency-Key': idempotencyKey('eval') },
  })
  const failure = failFromStatus(status, body)
  if (failure) return { error: failure }

  return { data: body as EvaluationPayload }
}

const evaluateJobFit: ToolDescriptor = {
  name: 'evaluate_job_fit',
  description:
    "Run JobJam's full AI evaluation of the user's resume against one job. " +
    'Returns an ATS score out of 100, matched and missing skills, and ' +
    'concrete recommendations, and files the result as a draft application ' +
    'in their tracker. SPENDS ONE EVALUATION CREDIT and requires the user ' +
    'to approve a dialog in the page. Shortlist with rank_jobs_for_me ' +
    'first: it is free, and this should be reserved for jobs the user is ' +
    'seriously considering.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id to evaluate.' },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  annotations: { destructiveHint: true },
  execute: async params => {
    const { jobId } = params as { jobId: string }
    if (!jobId) return fail('BAD_ARGUMENT', 'jobId is required.')

    const approved = await requestApproval({
      tool: 'evaluate_job_fit',
      title: `Evaluate your fit for ${await jobLabel(jobId)}?`,
      consequences: [
        'Spends 1 evaluation credit',
        'Creates a draft application in your tracker',
        'Sends your anonymised resume and the job description to the AI model',
        'Opens the result in this page when it finishes',
      ],
      destructive: true,
    })
    if (!approved) return DENIED

    const result = await runEvaluation(jobId)
    if ('error' in result) return result.error

    const d = result.data
    // Show the result. The user approved a credit being spent; leaving them
    // on the job board with the score visible only inside the agent's chat
    // pane makes the page a bystander to its own work.
    const shown = resultUrl(d.conversationId, d.applicationId)
    if (shown) getNavigation()?.(shown)

    return {
      ok: true,
      atsScore: d.atsScore,
      matchedSkills: d.evaluation?.skillsMatch?.matched ?? [],
      missingSkills: d.evaluation?.skillsMatch?.missing ?? [],
      recommendations: d.evaluation?.recommendations ?? [],
      assessment: d.evaluation?.overallAssessment ?? null,
      applicationId: d.applicationId,
      conversationId: d.conversationId,
      reviewUrl: shown,
      shownOnScreen: Boolean(shown),
      // The evaluation produces exactly one score, and the same value is
      // written to the tracker row and drawn in the Profile Fit ring. Said
      // out loud because an agent that also reads the page has been seen
      // inventing a second "detailed" score and then narrating a conflict
      // between the two, which reads to a user as a bug in JobJam.
      note:
        'atsScore is the single authoritative score for this evaluation. ' +
        'The application in the tracker and the Profile Fit panel on screen ' +
        'both show this same number. There is no second or more detailed ' +
        'ATS score to reconcile it against. The 0-10 figure from ' +
        'rank_jobs_for_me is a free shortlisting heuristic and is not ' +
        'comparable. When shownOnScreen is true the page is already ' +
        'displaying this result, so summarise it rather than telling the ' +
        'user where to find it.',
    }
  },
}

// ─── prepare_application ─────────────────────────────────────────────────────

const prepareApplication: ToolDescriptor = {
  name: 'prepare_application',
  description:
    'Prepare a complete application for one job: evaluate fit, rewrite the ' +
    "user's resume against the posting, and draft a tailored cover letter. " +
    'Everything is saved to their tracker for review. SPENDS THREE CREDITS ' +
    '(one evaluation, one optimization, one cover letter) and requires the ' +
    'user to approve a dialog in the page. Takes up to two minutes. This ' +
    'does NOT submit anything to the employer.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id to prepare for.' },
      tone: {
        type: 'string',
        enum: ['professional', 'conversational', 'enthusiastic'],
        description: 'Cover letter tone. Defaults to professional.',
      },
      length: {
        type: 'string',
        enum: ['short', 'medium', 'long'],
        description: 'Cover letter length. Defaults to medium.',
      },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  annotations: { destructiveHint: true },
  execute: async params => {
    const { jobId, tone, length } = params as {
      jobId: string
      tone?: string
      length?: string
    }
    if (!jobId) return fail('BAD_ARGUMENT', 'jobId is required.')

    // One approval for the whole chain. Three consecutive dialogs would be
    // approval fatigue, and the user cannot meaningfully consent to step two
    // without knowing step one already ran.
    const approved = await requestApproval({
      tool: 'prepare_application',
      title: `Prepare a full application for ${await jobLabel(jobId)}?`,
      consequences: [
        'Spends 3 credits: 1 evaluation, 1 optimization, 1 cover letter',
        'Creates an application with a tailored resume and cover letter',
        'Takes up to 2 minutes',
        'Opens the result in this page when it finishes',
        'Does not submit anything to the employer',
      ],
      destructive: true,
    })
    if (!approved) return DENIED

    const evaluated = await runEvaluation(jobId)
    if ('error' in evaluated) return evaluated.error
    const { atsScore, conversationId, applicationId, resumeId } = evaluated.data

    if (!conversationId || !resumeId) {
      return fail(
        'PARTIAL',
        `Evaluation succeeded with an ATS score of ${atsScore}, but the ` +
          'result was not linked to a conversation, so the resume and cover ' +
          'letter steps cannot run. The evaluation is saved in the tracker.'
      )
    }

    const steps: Record<string, string> = { evaluation: 'done' }

    const optimized = await toolFetch('/api/ai/optimize-resume', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey('optimize') },
      body: JSON.stringify({ resumeId, conversationId, applicationId }),
    })
    // A later step failing must not discard the earlier one: the credit is
    // already spent and the evaluation is already useful. Report per step.
    steps.resume = optimized.status === 200 ? 'done' : 'failed'
    // The route's payload key is `optimizedResumeId`. Reading only
    // documentId/resumeId always missed it, so the cover letter was written
    // against the ORIGINAL resume while reporting the optimized one.
    const optimizedResumeId =
      optimized.body?.optimizedResumeId ??
      optimized.body?.documentId ??
      optimized.body?.resumeId ??
      null
    // Optimization re-scores the rewritten resume, so this chain legitimately
    // produces two numbers and the page shows both. Return them together;
    // left to infer, an agent narrates the pair as a contradiction.
    const atsScoreAfterOptimization =
      optimized.body?.atsScoreImprovement?.after ?? null

    const letter = await toolFetch('/api/ai/generate-cover-letter', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey('letter') },
      body: JSON.stringify({
        conversationId,
        resumeId: optimizedResumeId ?? resumeId,
        options: {
          tone: tone ?? 'professional',
          length: length ?? 'medium',
          focus: 'experience',
        },
      }),
    })
    steps.coverLetter = letter.status === 200 ? 'done' : 'failed'

    // Two minutes and three credits have gone by. Land the user on what they
    // paid for, even if a later step failed: the evaluation is there either
    // way, and a partial result is still worth reading.
    const shown = resultUrl(conversationId, applicationId)
    if (shown) getNavigation()?.(shown)

    return {
      ok: true,
      atsScore,
      atsScoreAfterOptimization,
      applicationId,
      steps,
      reviewUrl: shown,
      shownOnScreen: Boolean(shown),
      note:
        'Nothing was sent to the employer. The user should review the ' +
        'application before applying. atsScore is the original resume ' +
        'against this job; atsScoreAfterOptimization is the rewritten one. ' +
        'Report them as a before and after, not as conflicting scores. When ' +
        'shownOnScreen is true the page is already displaying this ' +
        'application, so summarise it rather than linking to it.',
    }
  },
}

// ─── mark_job_applied ────────────────────────────────────────────────────────

const markJobApplied: ToolDescriptor = {
  name: 'mark_job_applied',
  description:
    'Record that the user has applied for a job on the employer site. This ' +
    'only updates JobJam\'s tracker: it asserts a real-world fact and does ' +
    'NOT send anything to the employer. Requires approval. Only call this ' +
    'when the user has told you they actually applied.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id the user applied to.' },
    },
    required: ['jobId'],
    additionalProperties: false,
  },
  annotations: { destructiveHint: true },
  execute: async params => {
    const { jobId } = params as { jobId: string }
    if (!jobId) return fail('BAD_ARGUMENT', 'jobId is required.')

    const approved = await requestApproval({
      tool: 'mark_job_applied',
      title: `Mark ${await jobLabel(jobId)} as applied?`,
      consequences: [
        'Records in your tracker that you applied',
        'Nothing is sent to the employer',
      ],
      destructive: true,
    })
    if (!approved) return DENIED

    const { status, body } = await toolFetch(
      `/api/jobs-feed/${jobId}/mark-applied`,
      { method: 'POST', body: JSON.stringify({}) }
    )
    const failure = failFromStatus(status, body)
    if (failure) return failure

    return { ok: true, jobId, status: 'applied' }
  },
}

export const WRITE_TOOLS: ToolDescriptor[] = [
  saveJob,
  unsaveJob,
  listSavedJobs,
  createProfileFromResume,
  evaluateJobFit,
  prepareApplication,
  markJobApplied,
]
