'use client'

import React, { useEffect } from 'react'
import { registerJobJamTools } from '@/webmcp/register'
import { AgentActivityPanel } from '@/webmcp/ui/AgentActivityPanel'
import { ApprovalDialog } from '@/webmcp/ui/ApprovalDialog'

/**
 * Mounts JobJam's WebMCP surface: tool registration plus the two pieces of UI
 * that make agent activity visible and consequential actions gated.
 *
 * Registration runs once per mount, not per navigation. Tools live for the
 * lifetime of the browsing context, and JobJam's app routes are client-side
 * transitions under one layout, so re-registering on every route change would
 * churn the tool list for no benefit. registerJobJamTools() unregisters
 * before registering anyway, so a remount is safe.
 *
 * On a browser with no WebMCP support this renders the two components (both
 * of which render null until something happens) and registers nothing.
 */
export function WebMcpProvider() {
  useEffect(() => {
    const cleanup = registerJobJamTools()
    return () => cleanup?.()
  }, [])

  return (
    <>
      <AgentActivityPanel />
      <ApprovalDialog />
    </>
  )
}

export default WebMcpProvider
