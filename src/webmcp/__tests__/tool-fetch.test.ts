import { describe, expect, it, vi, afterEach } from 'vitest'
import { failFromStatus, toolFetch } from '@/webmcp/types'

function response(init: {
  status?: number
  url?: string
  redirected?: boolean
  contentType?: string
  body?: unknown
}) {
  return {
    status: init.status ?? 200,
    ok: (init.status ?? 200) < 400,
    url: init.url ?? 'http://localhost:3000/api/jobs-feed',
    redirected: init.redirected ?? false,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-type'
          ? (init.contentType ?? 'application/json')
          : null,
    },
    json: async () => {
      if (init.body === undefined) throw new Error('not json')
      return init.body
    },
  } as unknown as Response
}

afterEach(() => vi.unstubAllGlobals())

describe('toolFetch', () => {
  // The regression this exists for. Unauthenticated API calls are not 401:
  // middleware redirects them to /login, fetch follows, and the call lands as
  // 200 text/html. Parsing that to null made search_jobs answer a logged-out
  // agent with an empty result set, so it reported "no jobs found" rather than
  // "sign in". Observed in Chrome 152 before the fix.
  it('reports a login redirect as unauthenticated, not as no results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          status: 200,
          redirected: true,
          url: 'http://localhost:3000/login',
          contentType: 'text/html',
        })
      )
    )

    const { status, body } = await toolFetch('/api/jobs-feed?q=frontend')
    expect(status).toBe(401)

    const failure = failFromStatus(status, body)
    expect(failure?.error).toBe('NOT_SIGNED_IN')
  })

  it('refuses to treat a non-JSON body as an empty result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ status: 200, contentType: 'text/html' }))
    )

    const { status, body } = await toolFetch('/api/jobs-feed')
    expect(status).toBe(502)
    expect(failFromStatus(status, body)?.error).toBe('REQUEST_FAILED')
  })

  it('passes a normal JSON response straight through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ status: 200, body: { jobs: [1, 2] } }))
    )

    const { status, body } = await toolFetch('/api/jobs-feed')
    expect(status).toBe(200)
    expect(body.jobs).toHaveLength(2)
    expect(failFromStatus(status, body)).toBeNull()
  })

  // Never send an Authorization header from a tool: the cookie is the whole
  // security model, and a token here would be one the agent could have seen.
  it('sends same-origin credentials and no bearer token', async () => {
    const spy = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        response({ status: 200, body: {} })
    )
    vi.stubGlobal('fetch', spy)

    await toolFetch('/api/profile')

    const init = spy.mock.calls[0]?.[1]
    expect(init?.credentials).toBe('same-origin')
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization/i)
  })
})

describe('failFromStatus', () => {
  it('maps a spent-out account to a recoverable failure', () => {
    const f = failFromStatus(402, { code: 'INSUFFICIENT_CREDITS' })
    expect(f?.error).toBe('INSUFFICIENT_CREDITS')
    expect(f?.message).toContain('/account/billing')
  })
})
