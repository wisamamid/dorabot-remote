import { useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic } from '../lib/platform.js'
import { useReloadOnEvents, useRpc } from '../lib/useRpc.js'
import { formatWhen, type CalendarItem } from '../lib/work.js'
import { Button, Chip, ConfirmButton, Empty, ErrorNote, Layer, Row, Screen, Spinner } from './ui.js'

/** Scheduled runs: reminders, events and recurring prompts. Toggle, run now, remove. */
export function ScheduleView(): ReactNode {
  const items = useRpc<CalendarItem[]>('calendar.list')
  // A run finishing is when lastRunAt/nextRunAt move.
  useReloadOnEvents(['calendar.result'], items.reload)
  const [openId, setOpenId] = useState<string | null>(null)

  const rows = [...(items.data ?? [])].sort((a, b) => (a.nextRunAt ?? '9').localeCompare(b.nextRunAt ?? '9'))
  const open = openId ? rows.find((r) => r.id === openId) : null

  return (
    <div className="relative h-full">
      <div className="scroll h-full min-h-0 space-y-1.5 px-3 py-2 pb-4">
        <ErrorNote error={items.error} onRetry={() => void items.reload()} />
        {items.loading && !items.data ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : rows.length === 0 && !items.error ? (
          <div className="h-[50vh]">
            <Empty title="Nothing scheduled" body="Ask dorabot to remind you or run something later." />
          </div>
        ) : (
          rows.map((r) => (
            <Row
              key={r.id}
              onClick={() => setOpenId(r.id)}
              title={r.summary}
              subtitle={r.nextRunAt ? `Next: ${formatWhen(r.nextRunAt)}` : 'No upcoming run'}
              meta={
                <>
                  <Chip tone={r.enabled === false ? 'idle' : 'good'}>{r.enabled === false ? 'Off' : 'On'}</Chip>
                  <span>{r.rrule ? 'Repeats' : r.type}</span>
                </>
              }
            />
          ))
        )}
      </div>
      {open && (
        <Layer>
          <ScheduleDetail item={open} onClose={() => setOpenId(null)} onChanged={items.reload} />
        </Layer>
      )}
    </div>
  )
}

function ScheduleDetail({ item, onClose, onChanged }: { item: CalendarItem; onClose: () => void; onChanged: () => Promise<void> }): ReactNode {
  const conn = useConnection()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function run(label: string, fn: () => Promise<unknown>, closeAfter = false): Promise<void> {
    setBusy(label)
    setError(null)
    setNote(null)
    try {
      await fn()
      await haptic('success')
      await onChanged()
      if (label === 'run') setNote('Started. Watch it in Sessions.')
      if (closeAfter) onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Screen title={item.summary} subtitle={item.type} onBack={onClose}>
      <div className="scroll h-full space-y-4 px-4 py-4">
        <div className="space-y-2 rounded-card border border-ink-700 bg-ink-850 p-3.5 text-[14px] leading-relaxed">
          <Line label="Prompt" value={item.message} />
          <Line label="Starts" value={formatWhen(item.dtstart)} />
          <Line label="Next run" value={formatWhen(item.nextRunAt)} />
          <Line label="Last run" value={formatWhen(item.lastRunAt)} />
          <Line label="Repeats" value={item.rrule} />
        </div>
        <Button variant="primary" className="w-full" disabled={busy !== null} onClick={() => void run('run', () => conn.rpc('calendar.run', { id: item.id }))}>
          {busy === 'run' ? 'Starting…' : 'Run now'}
        </Button>
        <Button className="w-full" disabled={busy !== null} onClick={() => void run('toggle', () => conn.rpc('calendar.toggle', { id: item.id }))}>
          {item.enabled === false ? 'Turn on' : 'Turn off'}
        </Button>
        {note && <p className="text-[14px] text-mint-500">{note}</p>}
        <ErrorNote error={error} />
        <div className="safe-bottom pt-4">
          <ConfirmButton
            label="Remove from schedule"
            confirmLabel="Tap again to remove"
            disabled={busy !== null}
            onConfirm={() => void run('remove', () => conn.rpc('calendar.remove', { id: item.id }), true)}
          />
        </div>
      </div>
    </Screen>
  )
}

function Line({ label, value }: { label: string; value?: string }): ReactNode {
  if (!value) return null
  return (
    <div>
      <div className="text-[13px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="selectable whitespace-pre-wrap break-words text-ink-200">{value}</div>
    </div>
  )
}
