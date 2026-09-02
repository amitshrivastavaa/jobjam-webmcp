import { describe, expect, it, beforeEach } from 'vitest'
import { maxSalaryIn } from '@/webmcp/tools/read'
import {
  activity,
  approval,
  clearActivity,
  connectBoard,
  getBoard,
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
