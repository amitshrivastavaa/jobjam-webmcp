// Shape of the WebMCP browser API we target.
//
// The spec is a W3C Web Machine Learning CG draft and is not in lib.dom yet,
// so we declare the slice we use rather than depending on ambient types that
// do not exist. Two names matter:
//
//   document.modelContext   current, and what ChatGPT's in-app browser reads
//   navigator.modelContext  the original getter, deprecated in Chromium 150
//
// We read document first and fall back to navigator, so the same build works
// on a browser that shipped either one. See resolveModelContext().

export interface ToolAnnotations {
  /** No side effects. Safe for an agent to call unprompted. */
  readOnlyHint?: boolean
  /** Spends money, writes user data, or asserts a real-world fact. */
  destructiveHint?: boolean
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties: false
}

export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: JsonSchema
  annotations?: ToolAnnotations
  execute: (params: Record<string, unknown>) => Promise<unknown>
}

export interface ModelContext {
  registerTool: (tool: ToolDescriptor) => void
  unregisterTool?: (name: string) => void
  provideContext?: (context: { tools: ToolDescriptor[] }) => void
}

/**
 * The browser's ModelContext, or null when the page is not running under a
 * WebMCP-capable agent. Every caller must handle null: on an ordinary browser
 * this returns null and JobJam has to behave exactly as it always did.
 */
export function resolveModelContext(): ModelContext | null {
  if (typeof window === 'undefined') return null

  const fromDocument = (
    document as unknown as { modelContext?: ModelContext }
  ).modelContext
  if (fromDocument?.registerTool) return fromDocument

  const fromNavigator = (
    navigator as unknown as { modelContext?: ModelContext }
  ).modelContext
  if (fromNavigator?.registerTool) return fromNavigator

  return null
}

// ─── Result envelope ─────────────────────────────────────────────────────────

/**
 * Every tool resolves to a plain object. We wrap results in a consistent
 * envelope so the agent can distinguish "the tool ran and the answer is no"
 * from "the tool failed", which a bare throw cannot express.
 *
 * `ok: false` is a normal outcome, not an exception: an agent that gets
 * `{ ok: false, error: 'NOT_SIGNED_IN' }` can tell the user what to do, while
 * a thrown Error usually surfaces as an opaque tool failure.
 */
export type ToolResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string; message: string }

export function fail(error: string, message: string): ToolResult<never> {
  return { ok: false, error, message }
}

/**
 * Wraps fetch for tool handlers. Same-origin and credentials: 'include' are
 * the whole security story here: the browser attaches JobJam's HttpOnly
 * Supabase cookie, the handler runs under that session's RLS identity, and
 * the agent never sees a token. Never add an Authorization header to this.
 */
export async function toolFetch(
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: any }> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  })

  let body: any = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

/** Maps an HTTP status from a JobJam API route onto a tool-level failure. */
export function failFromStatus(
  status: number,
  body: any
): ToolResult<never> | null {
  if (status === 401) {
    return fail(
      'NOT_SIGNED_IN',
      'This action needs a signed-in JobJam session. Ask the user to sign in at /login, then try again.'
    )
  }
  if (status === 402 || body?.code === 'INSUFFICIENT_CREDITS') {
    return fail(
      'INSUFFICIENT_CREDITS',
      'The user is out of credits for this action. They can top up at /account/billing.'
    )
  }
  if (status === 429) {
    return fail(
      'RATE_LIMITED',
      'The demo rate limit for this endpoint has been reached.'
    )
  }
  if (status >= 400) {
    return fail(
      'REQUEST_FAILED',
      typeof body?.error === 'string'
        ? body.error
        : `The request failed with status ${status}.`
    )
  }
  return null
}
