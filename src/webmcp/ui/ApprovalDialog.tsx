'use client'

import React, { useSyncExternalStore } from 'react'
import { AlertTriangle } from 'lucide-react'
import { approval, settleApproval } from '@/webmcp/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * The human gate. A consequential tool call is suspended inside
 * requestApproval() until a person clicks here, so the agent's tool call
 * stays pending and cannot proceed on its own.
 *
 * Deliberately not dismissible by clicking outside or pressing Escape
 * without a decision: onOpenChange treats any close as a rejection, so a
 * stray click can never read as consent.
 */
export function ApprovalDialog() {
  const pending = useSyncExternalStore(
    approval.subscribe,
    approval.get,
    () => null
  )

  if (!pending) return null

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) settleApproval(false)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-500 mb-1">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <span className="text-xs font-semibold uppercase tracking-wide">
              The assistant is asking to act
            </span>
          </div>
          <DialogTitle className="text-base leading-snug">
            {pending.title}
          </DialogTitle>
          <DialogDescription>
            Requested by the <code className="text-xs">{pending.tool}</code>{' '}
            tool. Nothing happens until you approve.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 text-sm">
          {pending.consequences.map(line => (
            <li key={line} className="flex gap-2">
              <span
                aria-hidden="true"
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground"
              />
              <span>{line}</span>
            </li>
          ))}
        </ul>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => settleApproval(false)}>
            Not now
          </Button>
          <Button
            variant={pending.destructive ? 'destructive' : 'default'}
            onClick={() => settleApproval(true)}
            autoFocus
          >
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
