import { buildPreview, lineDiff, type DiffOp, type EditPair, type RiskAssessment } from '@dorabot-remote/protocol'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { cx } from './ui.js'

/** Red "Risky" badge with the reasons the classifier gave. */
export function RiskBadge({ risk }: { risk: RiskAssessment }): ReactNode {
  if (!risk.risky) return null
  return (
    <div data-testid="risk-badge" className="space-y-1">
      <span className="inline-flex items-center gap-1.5 rounded-md bg-rose-glow px-2 py-0.5 text-[12px] font-bold uppercase tracking-wider text-ink-950">
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l10 18H2z" />
          <path d="M12 10v5M12 18v.5" />
        </svg>
        Risky
      </span>
      <ul className="space-y-0.5 text-[13px] leading-snug text-rose-glow">
        {risk.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  )
}

const BOX = 'selectable scroll no-scrollbar rounded-lg bg-ink-950 p-3 font-mono text-[13px] leading-relaxed text-ink-200'

function Label({ children }: { children: ReactNode }): ReactNode {
  return <div className="break-all font-mono text-[13px] uppercase tracking-wide text-ink-400">{children}</div>
}

function DiffView({ ops, max }: { ops: DiffOp[]; max: string }): ReactNode {
  return (
    <div className={cx(BOX, 'overflow-x-auto', max)} data-testid="diff">
      {ops.map((o, i) => (
        <div
          key={i}
          className={cx(
            'whitespace-pre-wrap break-words',
            o.t === 'add' && 'bg-mint-900 text-mint-500',
            o.t === 'del' && 'bg-rose-dim text-rose-glow',
            o.t === 'ctx' && 'text-ink-400',
          )}
        >
          <span className="select-none pr-1.5">{o.t === 'add' ? '+' : o.t === 'del' ? '-' : ' '}</span>
          {o.text || ' '}
        </div>
      ))}
    </div>
  )
}

function EditsView({ edits, max }: { edits: EditPair[]; max: string }): ReactNode {
  const ops = useMemo(() => edits.flatMap((e, i) => [...(i > 0 ? [{ t: 'ctx' as const, text: '...' }] : []), ...lineDiff(e.oldText, e.newText)]), [edits])
  return <DiffView ops={ops} max={max} />
}

/** Write: a diff against the file as it is now when the Mac can read it (shared folders), else the new content. */
function WriteView({ path, content, max }: { path: string; content: string; max: string }): ReactNode {
  const conn = useConnection()
  const canRead = conn.can('fs.read')
  const [current, setCurrent] = useState<string | null | undefined>(canRead ? undefined : null)
  useEffect(() => {
    if (!canRead) return
    let alive = true
    conn
      .rpc<{ content?: string }>('fs.read', { path })
      .then((r) => alive && setCurrent(typeof r?.content === 'string' ? r.content : null))
      .catch(() => alive && setCurrent(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, canRead])
  const ops = useMemo(() => (typeof current === 'string' ? lineDiff(current, content) : null), [current, content])
  if (ops) {
    return (
      <>
        <div className="text-[12.5px] text-ink-400">Changes to the existing file</div>
        <DiffView ops={ops} max={max} />
      </>
    )
  }
  return (
    <>
      <div className="text-[12.5px] text-ink-400">{current === undefined ? 'Checking the current file…' : 'New file content'}</div>
      <pre className={cx(BOX, 'whitespace-pre-wrap break-words', max)}>{content.slice(0, 20_000)}</pre>
    </>
  )
}

/** The full tool input: command, diff, or key fields. */
export function ToolInputPreview({ toolName, input, compact }: { toolName: string; input: Record<string, unknown>; compact?: boolean }): ReactNode {
  const preview = useMemo(() => buildPreview(toolName, input), [toolName, input])
  const max = compact ? 'max-h-48' : 'max-h-72'
  switch (preview.kind) {
    case 'command':
      return (
        <div className="space-y-1">
          <Label>Command</Label>
          {preview.description && <div className="text-[13px] text-ink-400">{preview.description}</div>}
          <pre data-testid="full-command" className={cx(BOX, 'whitespace-pre-wrap break-words', max)}>
            {preview.command}
          </pre>
        </div>
      )
    case 'edit':
      return (
        <div className="space-y-1">
          <Label>{preview.path}</Label>
          <EditsView edits={preview.edits} max={max} />
        </div>
      )
    case 'write':
      return (
        <div className="space-y-1">
          <Label>{preview.path}</Label>
          <WriteView path={preview.path} content={preview.content} max={max} />
        </div>
      )
    case 'fields':
      if (preview.fields.length === 0) return null
      return (
        <div className="space-y-1.5">
          {preview.fields.map((f) => (
            <div key={f.key} className="space-y-0.5">
              <Label>{f.key}</Label>
              <div className="selectable whitespace-pre-wrap break-words font-mono text-[13px] text-ink-200">{f.value.slice(0, 2000)}</div>
            </div>
          ))}
        </div>
      )
  }
}
