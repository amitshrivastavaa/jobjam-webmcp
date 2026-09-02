// Registers JobJam's tools with the browser's WebMCP implementation.
//
// Every tool is wrapped once, here, so that logging, argument echoing and
// error shaping cannot drift between individual tool files. A tool author
// writes the handler; the wrapper guarantees the contract.

import { logEnd, logStart } from '@/webmcp/store'
import { READ_TOOLS } from '@/webmcp/tools/read'
import { WRITE_TOOLS } from '@/webmcp/tools/write'
import { resolveModelContext, type ToolDescriptor } from '@/webmcp/types'

/** One-line summary for the activity panel. Never throws. */
function summarise(name: string, result: any): string {
  if (result?.ok === false) return result.message ?? result.error ?? 'Failed'
  switch (name) {
    case 'search_jobs':
      return `${result?.returned ?? 0} of ${result?.total ?? 0} jobs`
    case 'get_job_details':
      return result?.job?.title ?? 'Job loaded'
    case 'rank_jobs_for_me':
      return `Ranked ${result?.ranked?.length ?? 0} jobs`
    case 'get_my_profile':
      return result?.hasResume ? 'Profile and resume loaded' : 'No resume yet'
    case 'save_job':
      return 'Saved'
    case 'unsave_job':
      return 'Removed from saved'
    case 'list_saved_jobs':
      return `${result?.total ?? 0} saved`
    case 'create_profile_from_resume':
      return `Profile created: ${result?.profileName ?? 'ready'}`
    case 'evaluate_job_fit':
      return `ATS score ${result?.atsScore ?? '?'}/100`
    case 'prepare_application':
      return `ATS ${result?.atsScore ?? '?'}/100, application prepared`
    case 'mark_job_applied':
      return 'Marked as applied'
    case 'get_credit_balance':
      return `${result?.credits?.evaluations ?? 0} evaluations left`
    case 'get_apply_instructions':
      return 'JobJam does not submit, link returned'
    default:
      return 'Done'
  }
}

function wrap(tool: ToolDescriptor): ToolDescriptor {
  return {
    ...tool,
    execute: async params => {
      const args = (params ?? {}) as Record<string, unknown>
      const entryId = logStart(tool.name, args)
      try {
        const result: any = await tool.execute(args)

        if (result?.ok === false) {
          // A declined approval is not an error: the gate worked. Showing it
          // as a failure in the panel would read as a bug during a demo.
          logEnd(
            entryId,
            result.error === 'DENIED_BY_USER' ? 'denied' : 'error',
            summarise(tool.name, result)
          )
          return result
        }

        logEnd(entryId, 'ok', summarise(tool.name, result))
        return result
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unexpected tool failure'
        logEnd(entryId, 'error', message)
        // Resolve rather than throw: a thrown Error usually reaches the agent
        // as an opaque tool failure, while this tells it what went wrong and
        // whether retrying is sensible.
        return {
          ok: false,
          error: 'TOOL_ERROR',
          message,
        }
      }
    },
  }
}

/**
 * Registers every tool. Returns a cleanup function, and is safe to call more
 * than once: a second call unregisters first, because registerTool throws
 * InvalidStateError on a duplicate name and one throw would abort the whole
 * batch, leaving the page with a partial tool set.
 *
 * Returns null when the browser has no WebMCP support, which is the common
 * case. JobJam must behave identically there.
 */
export function registerJobJamTools(options?: {
  includeWriteTools?: boolean
}): (() => void) | null {
  const ctx = resolveModelContext()
  if (!ctx) return null

  const tools = [
    ...READ_TOOLS,
    ...(options?.includeWriteTools === false ? [] : WRITE_TOOLS),
  ].map(wrap)

  for (const tool of tools) {
    try {
      ctx.unregisterTool?.(tool.name)
    } catch {
      // Not registered yet. Expected on a first run.
    }
    try {
      ctx.registerTool(tool)
    } catch (err) {
      console.warn(`[webmcp] could not register ${tool.name}`, err)
    }
  }

  return () => {
    for (const tool of tools) {
      try {
        ctx.unregisterTool?.(tool.name)
      } catch {
        // Nothing to undo.
      }
    }
  }
}

/** True when this browser exposes a WebMCP ModelContext. */
export function isWebMcpAvailable(): boolean {
  return resolveModelContext() !== null
}
