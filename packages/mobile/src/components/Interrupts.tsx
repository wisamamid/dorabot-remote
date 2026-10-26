import type {
  AskUserQuestion,
  ElicitationField,
  PendingApproval,
  PendingElicitation,
  PendingQuestion,
  RiskAssessment,
} from '@dorabot-remote/protocol'
import { assessRisk } from '@dorabot-remote/protocol'
import { useEffect, useState, type ReactNode } from 'react'
import { requireApprovalAuth, requireFreshAuth } from '../lib/approval-auth.js'
import { alwaysAllowOffer, ruleParams } from '../lib/always-allow.js'
import { useConnection } from '../lib/connection.js'
import { QUESTION_TIMEOUT_MS } from '../lib/inbox.js'
import { haptic } from '../lib/platform.js'
import { AlwaysAllowSheet } from './AlwaysAllowSheet.js'
import { RiskBadge, ToolInputPreview } from './ApprovalPreview.js'
import { Button, Card, cx } from './ui.js'

/**
 * The three things that block a run until a human answers. This is the reason
 * the app exists, so each one is a full-width card pinned above the composer,
 * never a toast that can be missed.
 *
 * Their deadlines differ sharply, which shapes the design:
 *
 *  - A tool approval has NO timeout at all. The agent waits forever. Calm, no
 *    countdown, but it must be impossible to overlook.
 *  - A question times out after 5 minutes and then fails the whole turn, so it
 *    gets a visible countdown.
 *  - An elicitation has no server-side timeout either.
 */

// ---------------------------------------------------------------------------
// Tool approval
// ---------------------------------------------------------------------------

/**
 * Whether this approval is risky, per the shared classifier (packages/protocol/src/risk.ts)
 * so the phone and bridge agree. Decides the badge, the second tap and the fresh Face ID.
 */
export function assessApproval(approval: PendingApproval): RiskAssessment {
  return assessRisk(approval.toolName, approval.input, approval.blockedPath ? { blockedPath: approval.blockedPath } : {})
}

export function looksDestructive(approval: PendingApproval): boolean {
  return assessApproval(approval).risky
}

/** The editable text for an approval: the command itself, or the input as JSON. */
function editableInput(approval: PendingApproval): { text: string; kind: 'command' | 'json' } {
  const input = approval.input ?? {}
  if (typeof input.command === 'string') return { text: input.command, kind: 'command' }
  return { text: JSON.stringify(input, null, 2), kind: 'json' }
}

export function ApprovalCard({
  approval,
  session,
  onApprove,
  onDeny,
  compact,
}: {
  approval: PendingApproval
  /** Session name, shown when the card is not already inside that session. */
  session?: string
  onApprove: (modifiedInput?: Record<string, unknown>) => Promise<void>
  onDeny: (reason?: string) => Promise<void>
  compact?: boolean
}): ReactNode {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const [editing, setEditing] = useState(false)
  const initial = editableInput(approval)
  const [draft, setDraft] = useState(initial.text)
  const [error, setError] = useState<string | null>(null)
  const assessment = assessApproval(approval)
  const risky = assessment.risky
  const conn = useConnection()
  // Never for risky inputs, never tool-wide for Bash (the offer is the exact command only).
  const offer = conn.can('remote.rules.add') ? alwaysAllowOffer(approval.toolName, approval.input, approval.blockedPath ? { blockedPath: approval.blockedPath } : {}) : null
  const [ruleSheet, setRuleSheet] = useState(false)
  const [ruleBusy, setRuleBusy] = useState(false)
  const [ruleError, setRuleError] = useState<string | null>(null)

  /** Sheet confirmed: Face ID, save the rule on the Mac, then approve this request too. */
  async function confirmAlways(): Promise<void> {
    if (!offer) return
    setRuleBusy(true)
    setRuleError(null)
    try {
      const { nonce } = await conn.rpc<{ nonce: string }>('remote.rules.challenge')
      const refused = await requireFreshAuth('Always allow this on your Mac')
      if (refused) {
        setRuleError(refused)
        return
      }
      await conn.rpc('remote.rules.add', ruleParams(offer.spec, nonce))
      await haptic('success')
      setRuleSheet(false)
      await onApprove()
    } catch (err) {
      setRuleError((err as Error).message)
    } finally {
      setRuleBusy(false)
    }
  }

  /** What will actually run: the edited input if the person changed it. */
  function modified(): Record<string, unknown> | undefined | null {
    if (!editing || draft === initial.text) return undefined
    if (initial.kind === 'command') return { ...approval.input, command: draft }
    try {
      const parsed = JSON.parse(draft) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }

  async function approve(): Promise<void> {
    const mod = modified()
    if (mod === null) {
      setError('That is not valid JSON, so it cannot be sent.')
      return
    }
    setError(null)
    // An edit changes what runs, so a destructive-looking edited command still
    // gets the second tap, judged on the edited text rather than the original.
    const effective = mod ? ({ ...approval, input: mod } as PendingApproval) : approval
    if (looksDestructive(effective) && !confirming) {
      setConfirming(true)
      await haptic('warning')
      return
    }
    setBusy('approve')
    try {
      // Risky: Face ID / passcode right now, every time. Routine: straight through.
      const refused = await requireApprovalAuth(approval.toolName, effective.input, approval.blockedPath ? { blockedPath: approval.blockedPath } : {})
      if (refused) {
        setError(refused)
        setConfirming(false)
        return
      }
      await haptic('medium')
      await onApprove(mod)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
      setConfirming(false)
    }
  }

  async function deny(): Promise<void> {
    setBusy('deny')
    await haptic('light')
    try {
      await onDeny(reason.trim() || undefined)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card tone={risky ? 'danger' : 'warn'} className="slide-up space-y-3">
      <div className="flex items-center gap-2">
        <span className={cx('size-2 shrink-0 rounded-full breathe', risky ? 'bg-rose-glow' : 'bg-amber-glow')} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold uppercase tracking-wider text-ink-200">
          {session ?? (risky ? 'Needs a careful look' : 'Waiting on you')}
        </span>
        <span className="shrink-0 font-mono text-[13px] text-ink-300">{approval.toolName}</span>
      </div>

      {session && risky && <div className="text-[13px] font-semibold uppercase tracking-wider text-rose-glow">Needs a careful look</div>}

      <RiskBadge risk={assessment} />

      {approval.title && <div className="text-[15px] leading-snug">{approval.title}</div>}

      {editing ? (
        <div className="space-y-1.5">
          <div className="font-mono text-[13px] uppercase tracking-wide text-ink-400">
            {initial.kind === 'command' ? 'Command (edited before running)' : 'Input (JSON)'}
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(10, Math.max(3, draft.split('\n').length))}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="selectable w-full rounded-lg border border-ink-600 bg-ink-950 p-3 font-mono text-[14px] leading-relaxed text-ink-100"
          />
        </div>
      ) : (
        <ToolInputPreview toolName={approval.toolName} input={approval.input ?? {}} compact={compact} />
      )}

      {approval.decisionReason && <div className="text-[13px] leading-relaxed text-ink-400">{approval.decisionReason}</div>}
      {approval.blockedPath && (
        <div className="font-mono text-[13px] text-rose-glow">outside allowed paths: {approval.blockedPath}</div>
      )}

      {denying && (
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why? (optional, the agent sees this)"
          className="selectable min-h-11 w-full rounded-xl border border-ink-600 bg-ink-900 px-3.5 py-2.5"
        />
      )}

      {error && <div className="text-[14px] text-rose-glow">{error}</div>}

      {confirming ? (
        <div className="space-y-2">
          <div className="text-[14px] font-medium text-rose-glow">This looks destructive. Run it anyway?</div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)} className="flex-1">
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void approve()} disabled={busy !== null} className="flex-1">
              Yes, run it
            </Button>
          </div>
        </div>
      ) : denying ? (
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setDenying(false)} disabled={busy !== null} className="flex-1">
            Back
          </Button>
          <Button variant="danger" onClick={() => void deny()} disabled={busy !== null} className="flex-1">
            {busy === 'deny' ? 'Denying…' : 'Send denial'}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <Button variant="default" onClick={() => setDenying(true)} disabled={busy !== null} className="flex-1">
              Deny
            </Button>
            <Button variant="primary" onClick={() => void approve()} disabled={busy !== null} className="flex-1">
              {busy === 'approve' ? 'Approving…' : editing ? 'Approve edited' : 'Approve'}
            </Button>
          </div>
          {offer && !editing && (
            <button
              onClick={() => {
                setRuleError(null)
                setRuleSheet(true)
              }}
              disabled={busy !== null}
              className="tap w-full text-center text-[14px] font-medium text-ink-300 active:text-ink-100 disabled:opacity-40"
            >
              {offer.label}
            </button>
          )}
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                setEditing((e) => !e)
                setDraft(initial.text)
                setError(null)
              }}
              className="tap -ml-1 px-1 text-[14px] font-medium text-ink-300 active:text-ink-100"
            >
              {editing ? 'Discard edits' : 'Edit before approving'}
            </button>
            <button
              onClick={() => void deny()}
              disabled={busy !== null}
              className="tap -mr-1 px-1 text-[14px] text-ink-400 active:text-ink-100 disabled:opacity-40"
            >
              {busy === 'deny' ? 'Denying…' : 'Quick deny'}
            </button>
          </div>
        </>
      )}

      {!compact && <p className="text-center text-[13px] text-ink-500">The run is paused until you answer.</p>}

      {ruleSheet && offer && (
        <AlwaysAllowSheet
          offer={offer}
          command={offer.spec.kind === 'exact' ? offer.spec.command : undefined}
          busy={ruleBusy}
          error={ruleError}
          onConfirm={() => void confirmAlways()}
          onCancel={() => setRuleSheet(false)}
        />
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

export function QuestionCard({
  question,
  session,
  startedAt,
  timedOut,
  onAnswer,
  onDismiss,
}: {
  question: PendingQuestion
  session?: string
  /** When the phone first saw it. Falls back to the gateway's timestamp. */
  startedAt?: number
  /** Set by the Inbox once the deadline has passed or the gateway said so. */
  timedOut?: boolean
  onAnswer: (answers: Record<string, string>) => Promise<void>
  onDismiss?: () => void
}): ReactNode {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, force] = useState(0)

  // A countdown, because this one really does expire and take the turn with it.
  useEffect(() => {
    if (timedOut) return
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [timedOut])

  const from = startedAt ?? question.timestamp
  const remaining = timedOut ? 0 : Math.max(0, QUESTION_TIMEOUT_MS - (Date.now() - from))
  const expired = timedOut || remaining === 0
  const mins = Math.floor(remaining / 60_000)
  const secs = Math.floor((remaining % 60_000) / 1000)
  const urgent = remaining < 60_000

  const questions = question.questions ?? []
  const complete = questions.every((q) => answers[q.question] || other[q.question]?.trim())

  function pick(q: AskUserQuestion, label: string): void {
    setOther((o) => ({ ...o, [q.question]: '' }))
    setAnswers((a) => {
      if (!q.multiSelect) return { ...a, [q.question]: label }
      // Multi-select answers travel as one comma-joined string, the way the
      // desktop client sends them.
      const labels = a[q.question] ? a[q.question]!.split(', ') : []
      const i = labels.indexOf(label)
      if (i >= 0) labels.splice(i, 1)
      else labels.push(label)
      return { ...a, [q.question]: labels.join(', ') }
    })
    void haptic('light')
  }

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)
    await haptic('medium')
    try {
      const payload: Record<string, string> = {}
      for (const q of questions) {
        payload[q.question] = other[q.question]?.trim() || answers[q.question] || ''
      }
      await onAnswer(payload)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (expired) {
    return (
      <Card className="space-y-3 opacity-90">
        <div className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-full bg-ink-500" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold uppercase tracking-wider text-ink-300">
            {session ?? 'dorabot asked'}
          </span>
          <span className="shrink-0 rounded-md bg-rose-dim px-2 py-0.5 text-[13px] font-medium text-rose-glow">Timed out</span>
        </div>
        {questions.map((q) => (
          <div key={q.question} className="text-[15px] leading-snug text-ink-300">
            {q.question}
          </div>
        ))}
        <p className="text-[14px] leading-relaxed text-ink-400">
          Nobody answered in five minutes, so the run gave up on this question. Send a new message in the session to carry on.
        </p>
        {onDismiss && (
          <Button variant="default" onClick={onDismiss} className="w-full">
            Dismiss
          </Button>
        )}
      </Card>
    )
  }

  return (
    <Card tone="warn" className="slide-up space-y-4">
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-amber-glow breathe" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold uppercase tracking-wider text-ink-200">
          {session ?? 'dorabot is asking'}
        </span>
        <span
          className={cx('shrink-0 font-mono text-[14px] tabular-nums', urgent ? 'text-rose-glow' : 'text-ink-300')}
          aria-label="time left to answer"
        >
          {mins}:{String(secs).padStart(2, '0')}
        </span>
      </div>

      {questions.map((q) => {
        const chosen = (answers[q.question] ?? '').split(', ')
        return (
          <div key={q.question} className="space-y-2">
            {q.header && <div className="text-[13px] font-medium uppercase tracking-wide text-ink-400">{q.header}</div>}
            <div className="text-[15px] leading-snug">{q.question}</div>
            {q.multiSelect && <div className="text-[13px] text-ink-400">Choose any that apply</div>}
            <div className="space-y-1.5">
              {(q.options ?? []).map((opt) => {
                const selected = chosen.includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    onClick={() => pick(q, opt.label)}
                    aria-pressed={selected}
                    className={cx(
                      'tap w-full rounded-xl border px-3.5 py-3 text-left transition-colors',
                      selected ? 'border-mint-500 bg-mint-900' : 'border-ink-600 bg-ink-900 active:bg-ink-800',
                    )}
                  >
                    <div className={cx('text-[15px]', selected ? 'text-mint-500' : 'text-ink-100')}>{opt.label}</div>
                    {opt.description && <div className="mt-0.5 text-[13px] leading-snug text-ink-400">{opt.description}</div>}
                  </button>
                )
              })}
              <input
                value={other[q.question] ?? ''}
                onChange={(e) => {
                  setOther((o) => ({ ...o, [q.question]: e.target.value }))
                  setAnswers((a) => ({ ...a, [q.question]: '' }))
                }}
                placeholder="Or type your own answer"
                className="selectable min-h-11 w-full rounded-xl border border-ink-600 bg-ink-900 px-3.5 py-3"
              />
            </div>
          </div>
        )
      })}

      {error && <div className="text-[14px] text-rose-glow">{error}</div>}

      <Button variant="primary" onClick={() => void submit()} disabled={!complete || busy} className="w-full">
        {busy ? 'Sending…' : 'Answer'}
      </Button>
      <p className="text-center text-[13px] text-ink-500">If nobody answers in five minutes the run fails.</p>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Elicitation (structured form from an MCP server)
// ---------------------------------------------------------------------------

export function ElicitationCard({
  elicitation,
  session,
  onSubmit,
  onDismiss,
}: {
  elicitation: PendingElicitation
  session?: string
  onSubmit: (values: Record<string, unknown>) => Promise<void>
  onDismiss: () => Promise<void>
}): ReactNode {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {}
    for (const f of elicitation.fields ?? []) {
      if (f.default_value !== undefined) initial[f.name] = f.default_value
    }
    return initial
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fields = elicitation.fields ?? []
  const complete = fields.every((f) => !f.required || values[f.name] !== undefined)

  return (
    <Card tone="warn" className="slide-up space-y-4">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-amber-glow breathe" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold uppercase tracking-wider text-ink-200">
          {session ?? 'Needs details'}
        </span>
      </div>
      <div className="text-[15px] leading-snug">{elicitation.message}</div>

      {fields.map((f) => (
        <FieldInput key={f.name} field={f} value={values[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
      ))}

      {error && <div className="text-[14px] text-rose-glow">{error}</div>}

      <div className="flex gap-2">
        <Button
          variant="default"
          onClick={() => {
            setBusy(true)
            setError(null)
            onDismiss()
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(false))
          }}
          disabled={busy}
          className="flex-1"
        >
          Dismiss
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            setBusy(true)
            void haptic('medium')
            onSubmit(values)
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(false))
          }}
          disabled={!complete || busy}
          className="flex-1"
        >
          Submit
        </Button>
      </div>
    </Card>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ElicitationField
  value: unknown
  onChange: (v: unknown) => void
}): ReactNode {
  return (
    <div className="space-y-1.5">
      <label className="block text-[13px] font-medium text-ink-200">
        {field.label}
        {field.required && <span className="ml-1 text-rose-glow">*</span>}
      </label>
      {field.description && <div className="text-[13px] leading-snug text-ink-400">{field.description}</div>}

      {field.type === 'boolean' ? (
        <button
          onClick={() => onChange(!value)}
          className={cx(
            'tap flex w-full items-center justify-between rounded-xl border px-3.5',
            value ? 'border-mint-500 bg-mint-900' : 'border-ink-600 bg-ink-900',
          )}
        >
          <span className="text-[15px]">{value ? 'Yes' : 'No'}</span>
          <span className={cx('h-6 w-10 rounded-full p-0.5 transition-colors', value ? 'bg-mint-500' : 'bg-ink-600')}>
            <span
              className={cx('block size-5 rounded-full bg-ink-950 transition-transform', Boolean(value) && 'translate-x-4')}
            />
          </span>
        </button>
      ) : field.type === 'select' ? (
        <div className="space-y-1.5">
          {(field.options ?? []).map((opt) => (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={cx(
                'tap w-full rounded-xl border px-3.5 text-left text-[15px]',
                value === opt.value ? 'border-mint-500 bg-mint-900 text-mint-500' : 'border-ink-600 bg-ink-900',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)}
          className="selectable min-h-11 w-full rounded-xl border border-ink-600 bg-ink-900 px-3.5 py-3"
        />
      )}
    </div>
  )
}
