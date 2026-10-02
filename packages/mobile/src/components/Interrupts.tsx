import type { ElicitationField, PendingApproval, PendingElicitation, PendingQuestion } from '@dorabot-remote/protocol'
import { useEffect, useState, type ReactNode } from 'react'
import { haptic } from '../lib/platform.js'
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

/** Pull out the bit of the input a person actually needs to judge. */
function approvalDetail(approval: PendingApproval): { label: string; body: string } | null {
  const input = approval.input ?? {}
  if (typeof input.command === 'string') return { label: 'Command', body: input.command }
  if (typeof input.file_path === 'string') {
    const content = (input.content ?? input.new_string) as string | undefined
    return { label: String(input.file_path), body: content ? String(content).slice(0, 4000) : '' }
  }
  if (typeof input.url === 'string') return { label: 'URL', body: input.url }
  if (typeof input.prompt === 'string') return { label: 'Prompt', body: input.prompt }
  const json = JSON.stringify(input, null, 2)
  return json === '{}' ? null : { label: 'Input', body: json.slice(0, 4000) }
}

/**
 * Rough read of how much damage this could do, used only to decide whether
 * approving takes one tap or two. The patterns mirror the ones the gateway uses
 * to decide an approval was needed in the first place.
 */
function looksDestructive(approval: PendingApproval): boolean {
  const cmd = typeof approval.input?.command === 'string' ? approval.input.command : ''
  return /\b(rm|sudo|mkfs|dd\s+if=|shutdown|reboot|killall|pkill)\b|git\s+push|reset\s+--hard|--force/.test(cmd)
}

export function ApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  approval: PendingApproval
  onApprove: () => Promise<void>
  onDeny: (reason?: string) => Promise<void>
}): ReactNode {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const detail = approvalDetail(approval)
  const risky = looksDestructive(approval)

  async function approve(): Promise<void> {
    if (risky && !confirming) {
      setConfirming(true)
      await haptic('warning')
      return
    }
    setBusy('approve')
    await haptic('medium')
    try {
      await onApprove()
    } finally {
      setBusy(null)
      setConfirming(false)
    }
  }

  async function deny(): Promise<void> {
    setBusy('deny')
    await haptic('light')
    try {
      await onDeny()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card tone={risky ? 'danger' : 'warn'} className="slide-up space-y-3">
      <div className="flex items-center gap-2">
        <span className={cx('size-2 rounded-full breathe', risky ? 'bg-rose-glow' : 'bg-amber-glow')} />
        <span className="text-[13px] font-semibold uppercase tracking-wider text-ink-200">
          {risky ? 'Needs a careful look' : 'Waiting on you'}
        </span>
        <span className="ml-auto font-mono text-[13px] text-ink-300">{approval.toolName}</span>
      </div>

      {approval.title && <div className="text-[15px] leading-snug">{approval.title}</div>}

      {detail && (
        <div className="space-y-1">
          <div className="font-mono text-[12px] uppercase tracking-wide text-ink-400">{detail.label}</div>
          {detail.body && (
            <pre className="selectable scroll no-scrollbar max-h-56 whitespace-pre-wrap break-words rounded-lg bg-ink-950 p-3 font-mono text-[12.5px] leading-relaxed text-ink-200">
              {detail.body}
            </pre>
          )}
        </div>
      )}

      {approval.decisionReason && (
        <div className="text-[13px] leading-relaxed text-ink-400">{approval.decisionReason}</div>
      )}
      {approval.blockedPath && (
        <div className="font-mono text-[12.5px] text-rose-glow">outside allowed paths: {approval.blockedPath}</div>
      )}

      {confirming ? (
        <div className="space-y-2">
          <div className="text-[14px] font-medium text-rose-glow">
            This looks destructive. Run it anyway?
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)} className="flex-1">
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void approve()} disabled={busy !== null} className="flex-1">
              Yes, run it
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="default" onClick={() => void deny()} disabled={busy !== null} className="flex-1">
            {busy === 'deny' ? 'Denying…' : 'Deny'}
          </Button>
          <Button variant="primary" onClick={() => void approve()} disabled={busy !== null} className="flex-1">
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
        </div>
      )}

      <p className="text-center text-[12px] text-ink-500">The run is paused until you answer.</p>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

/** The gateway rejects an unanswered question after five minutes. */
const QUESTION_TIMEOUT_MS = 300_000

export function QuestionCard({
  question,
  onAnswer,
}: {
  question: PendingQuestion
  onAnswer: (answers: Record<string, string>) => Promise<void>
}): ReactNode {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [, force] = useState(0)

  // A countdown, because this one really does expire and take the turn with it.
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const remaining = Math.max(0, QUESTION_TIMEOUT_MS - (Date.now() - question.timestamp))
  const mins = Math.floor(remaining / 60_000)
  const secs = Math.floor((remaining % 60_000) / 1000)
  const urgent = remaining < 60_000

  const questions = question.questions ?? []
  const complete = questions.every((q) => answers[q.question] || other[q.question]?.trim())

  async function submit(): Promise<void> {
    setBusy(true)
    await haptic('medium')
    try {
      const payload: Record<string, string> = {}
      for (const q of questions) {
        payload[q.question] = other[q.question]?.trim() || answers[q.question] || ''
      }
      await onAnswer(payload)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card tone="warn" className="slide-up space-y-4">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-amber-glow breathe" />
        <span className="text-[13px] font-semibold uppercase tracking-wider text-ink-200">dorabot is asking</span>
        <span className={cx('ml-auto font-mono text-[13px] tabular-nums', urgent ? 'text-rose-glow' : 'text-ink-400')}>
          {mins}:{String(secs).padStart(2, '0')}
        </span>
      </div>

      {questions.map((q) => (
        <div key={q.question} className="space-y-2">
          <div className="text-[15px] leading-snug">{q.question}</div>
          <div className="space-y-1.5">
            {(q.options ?? []).map((opt) => {
              const selected = answers[q.question] === opt.label
              return (
                <button
                  key={opt.label}
                  onClick={() => {
                    setAnswers((a) => ({ ...a, [q.question]: opt.label }))
                    setOther((o) => ({ ...o, [q.question]: '' }))
                    void haptic('light')
                  }}
                  className={cx(
                    'w-full rounded-xl border px-3.5 py-3 text-left transition-colors',
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
              className="w-full rounded-xl border border-ink-600 bg-ink-900 px-3.5 py-3"
            />
          </div>
        </div>
      ))}

      <Button variant="primary" onClick={() => void submit()} disabled={!complete || busy} className="w-full">
        {busy ? 'Sending…' : 'Answer'}
      </Button>
      <p className="text-center text-[12px] text-ink-500">
        If nobody answers in five minutes the run fails.
      </p>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Elicitation (structured form from an MCP server)
// ---------------------------------------------------------------------------

export function ElicitationCard({
  elicitation,
  onSubmit,
  onDismiss,
}: {
  elicitation: PendingElicitation
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

  const fields = elicitation.fields ?? []
  const complete = fields.every((f) => !f.required || values[f.name] !== undefined)

  return (
    <Card tone="warn" className="slide-up space-y-4">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-amber-glow breathe" />
        <span className="text-[13px] font-semibold uppercase tracking-wider text-ink-200">Needs details</span>
      </div>
      <div className="text-[15px] leading-snug">{elicitation.message}</div>

      {fields.map((f) => (
        <FieldInput key={f.name} field={f} value={values[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
      ))}

      <div className="flex gap-2">
        <Button
          variant="default"
          onClick={() => {
            setBusy(true)
            void onDismiss().finally(() => setBusy(false))
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
            void onSubmit(values).finally(() => setBusy(false))
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
          className="w-full rounded-xl border border-ink-600 bg-ink-900 px-3.5 py-3"
        />
      )}
    </div>
  )
}
