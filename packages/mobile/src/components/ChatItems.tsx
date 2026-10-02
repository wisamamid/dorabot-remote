import { parsePartialJson, toolStatusText, type ChatItem } from '@dorabot-remote/protocol'
import { memo, useState, type ReactNode } from 'react'
import { Markdown } from './Markdown.js'
import { cx } from './ui.js'

/**
 * Rendering one turn of a conversation.
 *
 * Tool calls are collapsed by default and show a one-line summary of what they
 * actually did, because on a phone a wall of JSON is worse than useless. Tap to
 * expand the full input and output.
 */

/** A short, human line describing what a tool is doing to what. */
function summarise(input: string): string {
  const parsed = parsePartialJson(input)
  if (!parsed || typeof parsed !== 'object') return ''
  const o = parsed as Record<string, unknown>
  const path = (o.file_path ?? o.path ?? o.notebook_path) as string | undefined
  if (path) return String(path).split('/').slice(-2).join('/')
  if (typeof o.command === 'string') return o.command.split('\n')[0]!.slice(0, 90)
  if (typeof o.pattern === 'string') return String(o.pattern).slice(0, 60)
  if (typeof o.query === 'string') return String(o.query).slice(0, 60)
  if (typeof o.url === 'string') return String(o.url).slice(0, 60)
  if (typeof o.prompt === 'string') return String(o.prompt).slice(0, 70)
  if (typeof o.description === 'string') return String(o.description).slice(0, 70)
  return ''
}

function Bubble({ children, mine }: { children: ReactNode; mine?: boolean }): ReactNode {
  return (
    <div className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'selectable max-w-[86%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[15px] leading-[1.55]',
          mine ? 'bg-ink-700 text-ink-100' : 'text-ink-100',
        )}
      >
        {children}
      </div>
    </div>
  )
}

function ToolBlock({ item }: { item: Extract<ChatItem, { type: 'tool_use' }> }): ReactNode {
  const [open, setOpen] = useState(false)
  const summary = summarise(item.input)
  const failed = item.is_error
  const running = item.streaming

  return (
    <div className="my-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
          failed ? 'border-rose-glow/30 bg-rose-dim' : 'border-ink-700 bg-ink-850 active:bg-ink-800',
        )}
      >
        <span
          className={cx(
            'size-1.5 shrink-0 rounded-full',
            failed ? 'bg-rose-glow' : running ? 'bg-amber-glow breathe' : 'bg-ink-500',
          )}
        />
        <span className="shrink-0 font-mono text-[13px] font-medium text-ink-200">{item.name}</span>
        {summary && <span className="truncate font-mono text-[12.5px] text-ink-400">{summary}</span>}
        <svg
          viewBox="0 0 24 24"
          className={cx('ml-auto size-4 shrink-0 text-ink-500 transition-transform', open && 'rotate-90')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="mt-1.5 space-y-1.5">
          {item.input && (
            <pre className="selectable scroll no-scrollbar max-h-64 rounded-xl bg-ink-950 p-3 font-mono text-[12px] leading-relaxed text-ink-300">
              {formatInput(item.input)}
            </pre>
          )}
          {item.output && (
            <pre
              className={cx(
                'selectable scroll no-scrollbar max-h-72 rounded-xl p-3 font-mono text-[12px] leading-relaxed',
                failed ? 'bg-rose-dim text-rose-glow' : 'bg-ink-950 text-ink-300',
              )}
            >
              {item.output.slice(0, 8000)}
            </pre>
          )}
          {item.imageData && (
            <img src={`data:image/png;base64,${item.imageData}`} alt="tool output" className="rounded-xl" />
          )}
          {item.subItems && item.subItems.length > 0 && (
            <div className="ml-2 border-l border-ink-700 pl-3">
              <ChatItemList items={item.subItems} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatInput(input: string): string {
  const parsed = parsePartialJson(input)
  if (parsed === null) return input
  // A lone command or file path reads better raw than wrapped in JSON braces.
  if (typeof parsed === 'object' && parsed !== null) {
    const o = parsed as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 1 && typeof o[keys[0]!] === 'string') return String(o[keys[0]!])
  }
  return JSON.stringify(parsed, null, 2)
}

const Item = memo(function Item({ item }: { item: ChatItem }): ReactNode {
  switch (item.type) {
    case 'user':
      return (
        <Bubble mine>
          {item.content}
          {item.images && item.images.length > 0 && (
            <div className="mt-2 flex gap-2">
              {item.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt="attachment"
                  className="size-20 rounded-lg object-cover"
                />
              ))}
            </div>
          )}
        </Bubble>
      )

    case 'text':
      return (
        <Bubble>
          <Markdown source={item.content} />
          {item.streaming && (
            <span className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[2px] bg-mint-500 breathe" />
          )}
        </Bubble>
      )

    case 'thinking':
      return (
        <div className="selectable my-1 border-l-2 border-ink-600 pl-3 text-[14px] italic leading-relaxed text-ink-400">
          {item.content}
        </div>
      )

    case 'tool_use':
      return <ToolBlock item={item} />

    case 'error':
      return (
        <div className="selectable my-1 rounded-xl border border-rose-glow/30 bg-rose-dim px-3.5 py-2.5 text-[14px] leading-relaxed text-rose-glow">
          {item.content}
        </div>
      )

    case 'compacting':
      return <div className="my-2 text-center text-[12.5px] text-ink-500">compacting conversation…</div>

    case 'result':
      return (
        <div className="my-2 flex items-center gap-2 text-[12.5px] text-ink-500">
          <span className="h-px flex-1 bg-ink-700" />
          {typeof item.cost === 'number' && <span className="font-mono">${item.cost.toFixed(3)}</span>}
          <span className="h-px flex-1 bg-ink-700" />
        </div>
      )

    default:
      return null
  }
})

export function ChatItemList({ items }: { items: ChatItem[] }): ReactNode {
  return (
    <div className="space-y-1.5">
      {items.map((item, i) => (
        <Item key={`${item.type}-${i}-${'id' in item ? item.id : item.timestamp}`} item={item} />
      ))}
    </div>
  )
}

export function StatusLine({ status, detail }: { status: string; detail?: string }): ReactNode {
  if (status === 'idle') return null
  const label =
    status === 'thinking' ? 'thinking' : status === 'tool_use' ? toolStatusText(detail) : detail ? toolStatusText(detail) : 'responding'
  return (
    <div className="flex items-center gap-2 px-1 py-2 text-[13.5px] text-ink-300">
      <span className="size-1.5 rounded-full bg-mint-500 breathe" />
      {label}
    </div>
  )
}
