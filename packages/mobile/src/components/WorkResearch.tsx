import { useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { useReloadOnEvents, useRpc } from '../lib/useRpc.js'
import { RESEARCH_STATUSES, type ResearchItem, type ResearchStatus } from '../lib/work.js'
import { Markdown } from './Markdown.js'
import { Chip, ConfirmButton, Empty, ErrorNote, Layer, Row, Screen, SectionTitle, SelectField, Spinner, timeAgo } from './ui.js'

export function ResearchView(): ReactNode {
  const items = useRpc<ResearchItem[]>('research.list')
  useReloadOnEvents(['research.update'], items.reload)
  const [openId, setOpenId] = useState<string | null>(null)

  const rows = [...(items.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
            <Empty title="No research yet" body="Notes dorabot saves while researching show up here." />
          </div>
        ) : (
          rows.map((r) => (
            <Row
              key={r.id}
              onClick={() => setOpenId(r.id)}
              title={r.title}
              subtitle={r.preview}
              meta={
                <>
                  <Chip tone={r.status === 'active' ? 'good' : 'idle'}>{r.status}</Chip>
                  <span className="truncate">{r.topic}</span>
                  <span className="ml-auto">{timeAgo(r.updatedAt)}</span>
                </>
              }
            />
          ))
        )}
      </div>
      {open && (
        <Layer>
          <ResearchDetail item={open} onClose={() => setOpenId(null)} onChanged={items.reload} />
        </Layer>
      )}
    </div>
  )
}

function ResearchDetail({ item, onClose, onChanged }: { item: ResearchItem; onClose: () => void; onChanged: () => Promise<void> }): ReactNode {
  const conn = useConnection()
  const full = useRpc<ResearchItem>('research.read', { id: item.id })
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<unknown>, closeAfter = false): Promise<void> {
    setError(null)
    try {
      await fn()
      await onChanged()
      if (closeAfter) onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Screen title={item.title} subtitle={item.topic} onBack={onClose}>
      <div className="scroll h-full space-y-4 px-4 py-4">
        <SelectField
          label="Status"
          value={item.status}
          onChange={(s: ResearchStatus) => void run(() => conn.rpc('research.update', { id: item.id, status: s }))}
          options={RESEARCH_STATUSES}
        />
        <ErrorNote error={error} />
        {full.loading && !full.data ? (
          <Spinner className="mx-auto size-5" />
        ) : (
          <div className="selectable text-[15px] leading-relaxed">
            <Markdown source={full.data?.content ?? ''} />
          </div>
        )}
        {(item.sources ?? []).length > 0 && (
          <>
            <SectionTitle>Sources</SectionTitle>
            <ul className="space-y-1.5">
              {(item.sources ?? []).map((s) => (
                <li key={s} className="selectable break-all rounded-xl bg-ink-850 px-3.5 py-2.5 text-[14px] text-ink-300">
                  {s}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="safe-bottom pt-4">
          <ConfirmButton
            label="Delete research"
            confirmLabel="Tap again to delete"
            onConfirm={() => void run(() => conn.rpc('research.delete', { id: item.id }), true)}
          />
        </div>
      </div>
    </Screen>
  )
}
