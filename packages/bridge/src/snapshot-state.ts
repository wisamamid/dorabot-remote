import type { SessionSnapshot } from '@dorabot-remote/protocol'

/**
 * Keep the cached `session.snapshot` current as live events arrive.
 *
 * The bridge replays the cached snapshot on every device `sessions.subscribe`.
 * If it were only refreshed when the gateway pushes a new one, a phone
 * subscribing later would see an approval that was already resolved, or lose
 * one that is still pending. Snapshots are replaced, never mutated: a copy may
 * already be queued for sending.
 */
export function applyEventToSnapshots(
  snapshots: Map<string, SessionSnapshot>,
  name: string,
  d: Record<string, unknown>,
): void {
  const sk = typeof d.sessionKey === 'string' ? d.sessionKey : null
  const set = (key: string, patch: Partial<SessionSnapshot>): void => {
    const cur = snapshots.get(key)
    if (cur) snapshots.set(key, { ...cur, ...patch, updatedAt: Date.now() })
  }
  const clearWhere = (match: (s: SessionSnapshot) => boolean, patch: Partial<SessionSnapshot>): void => {
    for (const [key, s] of snapshots) if (match(s)) set(key, patch)
  }

  switch (name) {
    case 'agent.status': {
      if (sk && typeof d.status === 'string') set(sk, { status: d.status as SessionSnapshot['status'] })
      return
    }
    case 'agent.result': {
      if (sk) set(sk, { status: 'idle' })
      return
    }
    case 'agent.tool_approval': {
      if (sk) set(sk, { pendingApproval: d as unknown as SessionSnapshot['pendingApproval'] })
      return
    }
    case 'agent.tool_approval_resolved': {
      const id = d.requestId
      clearWhere((s) => s.pendingApproval?.requestId === id, { pendingApproval: null })
      return
    }
    case 'agent.ask_user': {
      if (sk) {
        set(sk, {
          pendingQuestion: d as unknown as SessionSnapshot['pendingQuestion'],
          pendingQuestionStatus: 'pending',
        })
      }
      return
    }
    case 'agent.question_state': {
      const id = d.requestId
      if (d.status === 'pending') return
      clearWhere((s) => s.pendingQuestion?.requestId === id, {
        pendingQuestion: null,
        pendingQuestionStatus: null,
      })
      return
    }
    case 'agent.question_dismissed': {
      const id = d.requestId
      clearWhere((s) => s.pendingQuestion?.requestId === id, {
        pendingQuestion: null,
        pendingQuestionStatus: null,
      })
      return
    }
    case 'agent.elicitation': {
      if (sk) set(sk, { pendingElicitation: d as unknown as SessionSnapshot['pendingElicitation'] })
      return
    }
    case 'agent.elicitation_result': {
      if (sk) set(sk, { pendingElicitation: null })
      return
    }
  }
}
