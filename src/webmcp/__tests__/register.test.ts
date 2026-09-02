import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { isWebMcpAvailable, registerJobJamTools } from '@/webmcp/register'
import type { ToolDescriptor } from '@/webmcp/types'

// A stand-in for the browser's ModelContext. Registering against a fake is the
// only way to assert the contract without a WebMCP-capable browser, and it
// catches the failures that actually bite at runtime: a duplicate tool name
// (registerTool throws InvalidStateError), a malformed inputSchema, or a
// required field that names a property the schema never declares.
function fakeContext() {
  const tools = new Map<string, ToolDescriptor>()
  return {
    tools,
    registerTool(tool: ToolDescriptor) {
      if (tools.has(tool.name)) {
        throw new Error(`InvalidStateError: ${tool.name} already registered`)
      }
      if (!tool.name || !tool.description) {
        throw new Error('InvalidStateError: empty name or description')
      }
      tools.set(tool.name, tool)
    },
    unregisterTool(name: string) {
      tools.delete(name)
    },
  }
}

function install(ctx: ReturnType<typeof fakeContext> | null) {
  Object.defineProperty(document, 'modelContext', {
    value: ctx ?? undefined,
    configurable: true,
    writable: true,
  })
}

describe('registerJobJamTools', () => {
  afterEach(() => install(null))

  it('registers nothing and returns null without WebMCP support', () => {
    install(null)
    expect(isWebMcpAvailable()).toBe(false)
    expect(registerJobJamTools()).toBeNull()
  })

  it('registers the full tool set', () => {
    const ctx = fakeContext()
    install(ctx)

    const cleanup = registerJobJamTools()
    expect(cleanup).not.toBeNull()
    expect(ctx.tools.size).toBeGreaterThanOrEqual(13)

    cleanup!()
    expect(ctx.tools.size).toBe(0)
  })

  // registerTool throws on a duplicate name, and one throw mid-batch would
  // leave the page with a partial tool set. Registering twice must be safe.
  it('is idempotent across repeated registration', () => {
    const ctx = fakeContext()
    install(ctx)

    registerJobJamTools()
    const size = ctx.tools.size
    registerJobJamTools()

    expect(ctx.tools.size).toBe(size)
  })

  it('declares a well-formed schema for every tool', () => {
    const ctx = fakeContext()
    install(ctx)
    registerJobJamTools()

    for (const [name, tool] of ctx.tools) {
      expect(tool.inputSchema.type, name).toBe('object')
      // Without this an agent can smuggle unvalidated extra arguments.
      expect(tool.inputSchema.additionalProperties, name).toBe(false)
      expect(tool.description.length, name).toBeGreaterThan(40)

      for (const key of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties), name).toContain(key)
      }
    }
  })

  // The annotation is what tells the agent, before it calls, that an action
  // spends the user's money. A missing one silently downgrades a paid action
  // to an apparently free one.
  it('annotates every credit-spending tool as destructive', () => {
    const ctx = fakeContext()
    install(ctx)
    registerJobJamTools()

    for (const name of [
      'evaluate_job_fit',
      'prepare_application',
      'mark_job_applied',
    ]) {
      expect(ctx.tools.get(name)?.annotations?.destructiveHint, name).toBe(true)
    }
    for (const name of ['search_jobs', 'get_job_details', 'rank_jobs_for_me']) {
      expect(ctx.tools.get(name)?.annotations?.readOnlyHint, name).toBe(true)
    }
  })

  // Chrome 152 normalises annotations to readOnlyHint + untrustedContentHint
  // and drops destructiveHint, so through getTools() a three-credit
  // prepare_application looks identical to a free save_job. Verified against a
  // real browser. The description is therefore the only channel that reliably
  // reaches the agent, so the cost has to be stated there.
  it('states the cost in the description of every destructive tool', () => {
    const ctx = fakeContext()
    install(ctx)
    registerJobJamTools()

    const destructive = [...ctx.tools.values()].filter(
      t => t.annotations?.destructiveHint
    )
    expect(destructive.length).toBeGreaterThan(0)

    for (const tool of destructive) {
      expect(tool.description.toLowerCase(), tool.name).toMatch(
        /approv|credit/
      )
    }
  })

  // A signed-in user with no profile yet must be reachable from zero: without
  // this tool every ranking and evaluation dead-ends at NO_RESUME and the
  // agent can only tell them to go and use the website by hand.
  it('can onboard a user who has no profile yet', () => {
    const ctx = fakeContext()
    install(ctx)
    registerJobJamTools()

    const onboard = ctx.tools.get('create_profile_from_resume')
    expect(onboard).toBeDefined()
    expect(onboard!.inputSchema.required).toEqual(['resumeText', 'jobFocus'])
    // It writes a profile but spends nothing, so it must not be advertised
    // as destructive.
    expect(onboard!.annotations?.destructiveHint).toBe(false)
  })

  it('exposes no tool that submits an application to an employer', () => {
    const ctx = fakeContext()
    install(ctx)
    registerJobJamTools()

    for (const name of ctx.tools.keys()) {
      expect(name).not.toMatch(/submit|send_application|apply_to/)
    }
  })

  // The absence of a submit tool is not self-explanatory. Asked to apply, an
  // agent that finds no matching tool tends to hunt for a workaround; one
  // handed an explicit tool relays the boundary and the link instead.
  it('answers a request to apply with an explicit boundary, not silence', () => {
    const ctx = fakeContext()
    install(ctx)
    registerJobJamTools()

    const tool = ctx.tools.get('get_apply_instructions')
    expect(tool).toBeDefined()
    expect(tool!.annotations?.readOnlyHint).toBe(true)
    expect(tool!.description.toLowerCase()).toContain('apply')
  })

  // Without this the agent proposes a paid action, the user approves it, and
  // only then does it fail with a 402.
  it('lets the agent check credits before proposing a paid action', () => {
    const ctx = fakeContext()
    install(ctx)
    registerJobJamTools()

    const tool = ctx.tools.get('get_credit_balance')
    expect(tool).toBeDefined()
    expect(tool!.annotations?.readOnlyHint).toBe(true)
  })
})

describe('tool wrapper', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    install(null)
  })

  // A thrown Error usually reaches the agent as an opaque tool failure. The
  // wrapper turns it into a result the agent can reason about instead.
  it('resolves rather than throws when a handler fails', async () => {
    const ctx = fakeContext()
    install(ctx)
    registerJobJamTools()

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down')))
    )

    const result: any = await ctx.tools
      .get('search_jobs')!
      .execute({ query: 'frontend' })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('network down')
    vi.unstubAllGlobals()
  })
})
