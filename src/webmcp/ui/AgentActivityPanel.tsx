'use client'

import React, { useState, useSyncExternalStore } from 'react'
import {
  Ban,
  Check,
  ChevronDown,
  Loader2,
  Radio,
  X,
} from 'lucide-react'
import {
  activity,
  clearActivity,
  type ActivityEntry,
} from '@/webmcp/store'
import { cn } from '@/lib/utils'

const EMPTY: ActivityEntry[] = []

function renderValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ')
  // String(v) on an object yields "[object Object]", which is exactly the
  // wrong thing to show in a panel whose whole job is making the agent's
  // real arguments legible.
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v)
    } catch {
      return '(unserialisable)'
    }
  }
  return String(v)
}

function argSummary(args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${renderValue(v)}`)
  if (parts.length === 0) return 'no arguments'
  const joined = parts.join('  |  ')
  return joined.length > 120 ? `${joined.slice(0, 117)}...` : joined
}

function StatusIcon({ status }: { status: ActivityEntry['status'] }) {
  if (status === 'running') {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
  }
  if (status === 'ok') {
    return <Check className="h-3.5 w-3.5 text-emerald-600" />
  }
  if (status === 'denied') {
    return <Ban className="h-3.5 w-3.5 text-amber-600" />
  }
  return <X className="h-3.5 w-3.5 text-destructive" />
}

/**
 * Live log of what the agent asked the page to do.
 *
 * This is the difference between a demo people believe and one they do not:
 * the tool calls, their real arguments, and their outcomes are visible in the
 * page rather than narrated by a model. It renders nothing until the first
 * tool call, so an ordinary browser session never sees it.
 *
 * Kept deliberately cheap: no blur, no blend modes, no continuous animation.
 * See the frontend performance guardrails in CLAUDE.md.
 */
export function AgentActivityPanel() {
  const entries = useSyncExternalStore(
    activity.subscribe,
    activity.get,
    () => EMPTY
  )
  const [collapsed, setCollapsed] = useState(false)

  if (entries.length === 0) return null

  const running = entries.some(e => e.status === 'running')

  return (
    <aside
      aria-label="Agent activity"
      className="fixed bottom-4 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-lg border bg-background shadow-lg"
    >
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 rounded-t-lg px-3 py-2 text-left hover:bg-accent"
      >
        <Radio
          className={cn(
            'h-3.5 w-3.5',
            running ? 'text-primary' : 'text-muted-foreground'
          )}
        />
        <span className="text-xs font-semibold">Agent activity</span>
        <span className="text-xs text-muted-foreground">
          {entries.length} {entries.length === 1 ? 'call' : 'calls'}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto h-4 w-4 text-muted-foreground transition-transform',
            collapsed && '-rotate-90'
          )}
        />
      </button>

      {!collapsed && (
        <>
          <ol className="max-h-72 overflow-y-auto border-t">
            {entries.map(e => (
              <li key={e.id} className="border-b px-3 py-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <StatusIcon status={e.status} />
                  <code className="text-xs font-semibold">{e.tool}</code>
                  {e.endedAt && (
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {((e.endedAt - e.startedAt) / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                <p className="mt-1 break-words text-[11px] text-muted-foreground">
                  {argSummary(e.args)}
                </p>
                {e.summary && (
                  <p
                    className={cn(
                      'mt-1 text-[11px] font-medium',
                      e.status === 'error' && 'text-destructive',
                      e.status === 'denied' && 'text-amber-600'
                    )}
                  >
                    {e.summary}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <div className="flex justify-end border-t px-3 py-1.5">
            <button
              type="button"
              onClick={clearActivity}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
