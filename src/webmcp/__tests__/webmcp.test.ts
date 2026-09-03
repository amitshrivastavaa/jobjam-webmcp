import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { maxSalaryIn } from '@/webmcp/tools/read'
import { WRITE_TOOLS } from '@/webmcp/tools/write'
import {
  activity,
  approval,
  clearActivity,
  connectBoard,
  connectNavigation,
  getBoard,
  getNavigation,
  logEnd,
  logStart,
  requestApproval,
  settleApproval,
} from '@/webmcp/store'

describe('maxSalaryIn', () => {
  it('reads the top of a formatted range', () => {
    expect(maxSalaryIn('€90,000 - €120,000')).toBe(120000)
    expect(maxSalaryIn('$90.000 to $120.000')).toBe(120000)
  })

  it('expands a k suffix', () => {
    expect(maxSalaryIn('90k-120k')).toBe(120000)
    expect(maxSalaryIn('$150K USD')).toBe(150000)
  })

  it('ignores text with no usable figure', () => {
    expect(maxSalaryIn(null)).toBeNull()
    expect(maxSalaryIn('')).toBeNull()
    expect(maxSalaryIn('Competitive')).toBeNull()
    // Equity percentages and headcounts are below the floor.
    expect(maxSalaryIn('0.5% equity, team of 12')).toBeNull()
  })

  it('does not mistake a year for a salary', () => {
    expect(maxSalaryIn('Posted 2026')).toBeNull()
    expect(maxSalaryIn('Founded 1998, salary 110k')).toBe(110000)
  })
})

describe('approval gate', () => {
  const req = {
    tool: 'evaluate_job_fit',
    title: 'Evaluate?',
    consequences: ['Spends 1 credit'],
    destructive: true,
  }

  beforeEach(() => {
    // Leave no pending approval behind between tests.
    if (approval.get()) settleApproval(false)
  })

  it('blocks until a human settles it, and reports the answer', async () => {
    const approved = requestApproval(req)
    expect(approval.get()?.tool).toBe('evaluate_job_fit')

    settleApproval(true)
    await expect(approved).resolves.toBe(true)
    expect(approval.get()).toBeNull()
  })

  it('treats a rejection as a normal outcome', async () => {
    const approved = requestApproval(req)
    settleApproval(false)
    await expect(approved).resolves.toBe(false)
  })

  // The security-relevant case: a second consequential action must not be
  // silently authorised by the dialog the user is already looking at.
  it('refuses a second request while one is on screen', async () => {
    const first = requestApproval(req)
    const second = requestApproval({ ...req, tool: 'prepare_application' })

    await expect(second).resolves.toBe(false)
    expect(approval.get()?.tool).toBe('evaluate_job_fit')

    settleApproval(true)
    await expect(first).resolves.toBe(true)
  })
})

describe('activity log', () => {
  beforeEach(() => clearActivity())

  it('records a call and its outcome', () => {
    const id = logStart('search_jobs', { query: 'frontend' })
    expect(activity.get()[0].status).toBe('running')

    logEnd(id, 'ok', '12 of 300 jobs')
    const entry = activity.get()[0]
    expect(entry.status).toBe('ok')
    expect(entry.summary).toBe('12 of 300 jobs')
    expect(entry.endedAt).toBeGreaterThanOrEqual(entry.startedAt)
  })

  it('keeps newest first and stays bounded', () => {
    for (let i = 0; i < 60; i++) logStart('save_job', { jobId: String(i) })
    const entries = activity.get()
    expect(entries).toHaveLength(50)
    expect(entries[0].args.jobId).toBe('59')
  })
})

describe('board bridge', () => {
  it('is absent until a board mounts, and cleared on unmount', () => {
    expect(getBoard()).toBeNull()

    const disconnect = connectBoard({
      applyFilters: () => {},
      selectJob: () => {},
    })
    expect(getBoard()).not.toBeNull()

    disconnect()
    expect(getBoard()).toBeNull()
  })
})

describe('navigation bridge', () => {
  it('is absent until a provider mounts, and cleared on unmount', () => {
    expect(getNavigation()).toBeNull()

    const disconnect = connectNavigation(() => {})
    expect(getNavigation()).not.toBeNull()

    disconnect()
    expect(getNavigation()).toBeNull()
  })
})

// An evaluation the user paid for has to end up on screen. Before this, the
// score came back to the agent and the page it was called from did not move,
// so a user who had just approved a credit saw nothing change.
describe('evaluate_job_fit shows its result', () => {
  const evaluate = WRITE_TOOLS.find(t => t.name === 'evaluate_job_fit')!

  function stubApi(evaluation: Record<string, unknown> = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        const body = path.includes('/api/profiles/')
          ? { baseResume: { id: 'resume-1', content: {} } }
          : path.includes('/api/profiles')
            ? { profiles: [{ id: 'profile-1', name: 'Default' }] }
            : path.includes('/description')
              ? { description: 'A long job description.' }
              : path.includes('/api/jobs-feed/')
                ? { job: { title: 'React Developer', company: 'urbansportsclub' } }
                : {
                    atsScore: 74,
                    applicationId: 'app-9',
                    conversationId: 'c-1',
                    ...evaluation,
                  }

        return {
          status: 200,
          ok: true,
          url: `http://localhost:3000${path}`,
          redirected: false,
          headers: { get: () => 'application/json' },
          json: async () => body,
        } as unknown as Response
      })
    )
  }

  // The approval dialog only appears after jobLabel's fetch resolves.
  async function pendingApproval() {
    for (let i = 0; i < 50 && !approval.get(); i++) {
      await new Promise(r => setTimeout(r, 0))
    }
    return approval.get()
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    if (approval.get()) settleApproval(false)
  })

  it('navigates to the application it created', async () => {
    stubApi()
    const navigate = vi.fn()
    const disconnect = connectNavigation(navigate)

    const running = evaluate.execute({ jobId: 'job-1' })
    expect(await pendingApproval()).not.toBeNull()
    settleApproval(true)

    const result = (await running) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.shownOnScreen).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/apply/ai-assistant/c/c-1')

    disconnect()
  })

  // Only the conversation view renders the score, the skills and the
  // recommendations. The tracker row is a filing record and shows none of
  // them, so it is a fallback for an evaluation with no conversation, never
  // the destination.
  it('falls back to the tracker when there is no conversation', async () => {
    stubApi({ conversationId: null })
    const navigate = vi.fn()
    const disconnect = connectNavigation(navigate)

    const running = evaluate.execute({ jobId: 'job-1' })
    expect(await pendingApproval()).not.toBeNull()
    settleApproval(true)

    await running
    expect(navigate).toHaveBeenCalledWith('/applications/app-9')

    disconnect()
  })

  it('goes nowhere when the user declines', async () => {
    stubApi()
    const navigate = vi.fn()
    const disconnect = connectNavigation(navigate)

    const running = evaluate.execute({ jobId: 'job-1' })
    expect(await pendingApproval()).not.toBeNull()
    settleApproval(false)

    await running
    expect(navigate).not.toHaveBeenCalled()

    disconnect()
  })
})
