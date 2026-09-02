// The bridge between tool handlers (plain async functions, called by the
// browser's agent) and React (the activity panel and the approval dialog).
//
// Tools are not React. They are invoked by the browser, outside any render,
// and they must be able to (a) report what they did and (b) block on a human
// decision. Both are modelled here as tiny external stores that components
// read with useSyncExternalStore. No state library: React has the primitive.

// ─── Shared subscribe/notify plumbing ────────────────────────────────────────

function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()

  return {
    get: () => value,
    set(next: T) {
      value = next
      listeners.forEach(l => l())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

// ─── Activity log ────────────────────────────────────────────────────────────

export type ActivityStatus = 'running' | 'ok' | 'error' | 'denied'

export interface ActivityEntry {
  id: string
  tool: string
  args: Record<string, unknown>
  status: ActivityStatus
  summary?: string
  startedAt: number
  endedAt?: number
}

// Bounded: an agent left running should not grow this without limit.
const MAX_ENTRIES = 50

const activityStore = createStore<ActivityEntry[]>([])

export const activity = {
  subscribe: activityStore.subscribe,
  get: activityStore.get,
}

export function logStart(
  tool: string,
  args: Record<string, unknown>
): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const entry: ActivityEntry = {
    id,
    tool,
    args,
    status: 'running',
    startedAt: Date.now(),
  }
  activityStore.set([entry, ...activityStore.get()].slice(0, MAX_ENTRIES))
  return id
}

export function logEnd(
  id: string,
  status: Exclude<ActivityStatus, 'running'>,
  summary?: string
): void {
  activityStore.set(
    activityStore.get().map(e =>
      e.id === id ? { ...e, status, summary, endedAt: Date.now() } : e
    )
  )
}

export function clearActivity(): void {
  activityStore.set([])
}

// ─── Approval gate ───────────────────────────────────────────────────────────

export interface PendingApproval {
  id: string
  tool: string
  title: string
  /** Plain-language consequences. One line each, shown as a list. */
  consequences: string[]
  /** True when the action spends credits or cannot be undone. */
  destructive: boolean
}

const approvalStore = createStore<PendingApproval | null>(null)

// Resolver for the approval currently on screen. Held outside the store
// because a function is not renderable state and putting it there would make
// every subscriber re-render on identity change alone.
let resolveCurrent: ((approved: boolean) => void) | null = null

export const approval = {
  subscribe: approvalStore.subscribe,
  get: approvalStore.get,
}

/**
 * Blocks until a human approves or rejects. Called from inside a tool
 * handler, so the agent's tool call stays pending until the user decides.
 *
 * Serialised by design: a second request while one is on screen is rejected
 * rather than queued. An agent that fires three consequential actions at once
 * should be stopped, not helped along, and a queue would let a user approve
 * one dialog and silently authorise the next.
 */
export function requestApproval(
  req: Omit<PendingApproval, 'id'>
): Promise<boolean> {
  if (approvalStore.get() !== null) return Promise.resolve(false)

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  approvalStore.set({ ...req, id })

  return new Promise<boolean>(resolve => {
    resolveCurrent = resolve
  })
}

/** Called by the dialog. Settles the pending promise and clears the store. */
export function settleApproval(approved: boolean): void {
  const resolve = resolveCurrent
  resolveCurrent = null
  approvalStore.set(null)
  resolve?.(approved)
}

// ─── Jobs board bridge ───────────────────────────────────────────────────────

/**
 * Lets search_jobs drive the visible board instead of only returning JSON.
 *
 * This is the difference between an agent-operable website and a chatbot with
 * extra steps: when the agent searches, the filter chips change and the list
 * re-renders, because the tool goes through the very same state path a human
 * click does (JobsBoardClient's commitFilters). The board registers its
 * handlers on mount and clears them on unmount, so a tool called from any
 * other page simply skips the UI update and still returns data.
 */
export interface BoardHandlers {
  applyFilters: (filters: Record<string, unknown>) => void
  selectJob: (id: string) => void
  setJobSaved?: (id: string, saved: boolean) => void
}

let boardHandlers: BoardHandlers | null = null

export function connectBoard(handlers: BoardHandlers): () => void {
  boardHandlers = handlers
  return () => {
    if (boardHandlers === handlers) boardHandlers = null
  }
}

export function getBoard(): BoardHandlers | null {
  return boardHandlers
}
