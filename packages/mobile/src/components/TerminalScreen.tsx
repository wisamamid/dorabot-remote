import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic, watchKeyboard } from '../lib/platform.js'
import { Button, Card, Screen, Spinner, cx } from './ui.js'

/**
 * A real shell on the Mac, gated behind a permission that is off by default.
 *
 * Two deliberate frictions:
 *
 *  1. The `terminal` scope is never granted at pairing time. The phone has to ask,
 *     and a human has to approve on the Mac itself. A stolen phone with a paired
 *     app cannot grant itself a shell.
 *  2. xterm is loaded on demand. It is the single heaviest dependency in the app
 *     and most people will never open this screen, so it must not be in the
 *     initial bundle a phone downloads over cellular.
 */
export function TerminalScreen({ onBack }: { onBack: () => void }): ReactNode {
  const conn = useConnection()
  const granted = conn.hasScope('terminal')

  return (
    <Screen title="Terminal" subtitle={conn.host?.name} onBack={onBack}>
      {granted ? <LiveTerminal /> : <LockedTerminal />}
    </Screen>
  )
}

function LockedTerminal(): ReactNode {
  const conn = useConnection()
  const [requested, setRequested] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function request(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await conn.rpc('remote.requestScope', {
        scope: 'terminal',
        reason: 'Open a shell from the phone',
      })
      setRequested(true)
      await haptic('medium')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scroll flex h-full flex-col justify-center gap-6 px-6">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-ink-800 text-ink-300">
        <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 1 1 8 0v4" />
        </svg>
      </div>

      <div className="space-y-2">
        <h2 className="text-[22px] font-semibold tracking-[-0.01em]">Terminal is blocked</h2>
        <p className="text-[15px] leading-relaxed text-ink-300">
          A shell here is a shell on {conn.host?.name ?? 'your Mac'}, with everything your account can do. It stays off
          until you turn it on from the Mac itself.
        </p>
      </div>

      {requested ? (
        <Card className="space-y-2">
          <div className="flex items-center gap-2 text-[15px] font-medium text-mint-500">
            <Spinner className="size-4 text-mint-500" />
            Waiting for approval
          </div>
          <p className="text-[13.5px] leading-relaxed text-ink-400">
            Open the pairing page on {conn.host?.name ?? 'your Mac'} and allow it there. This screen unlocks the moment
            you do.
          </p>
        </Card>
      ) : (
        <Button variant="default" onClick={() => void request()} disabled={busy} className="w-full">
          {busy ? 'Asking…' : 'Ask for terminal access'}
        </Button>
      )}

      {error && <div className="text-[13.5px] text-rose-glow">{error}</div>}

      <Card className="space-y-1.5">
        <div className="text-[13px] font-medium uppercase tracking-wider text-ink-400">To allow it on the Mac</div>
        <p className="text-[13.5px] leading-relaxed text-ink-300">
          Open <span className="font-mono text-ink-200">http://127.0.0.1:7788</span> and tap Allow, or run
        </p>
        <pre className="selectable overflow-x-auto rounded-lg bg-ink-950 p-3 font-mono text-[12.5px] text-ink-200">
          dorabot-remote grant {conn.device?.id?.slice(0, 8) ?? '<device>'}… terminal
        </pre>
      </Card>
    </div>
  )
}

const KEYS = [
  { label: 'esc', seq: '\x1b' },
  { label: 'tab', seq: '\t' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: '^Z', seq: '\x1a' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '/', seq: '/' },
]

function LiveTerminal(): ReactNode {
  const conn = useConnection()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<{ write: (d: string) => void; dispose: () => void } | null>(null)
  const writeRef = useRef<(data: string) => void>(() => {})
  const [status, setStatus] = useState<'loading' | 'live' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [keyboard, setKeyboard] = useState(0)
  const shellId = useRef(`t${Math.random().toString(36).slice(2, 9)}`)

  useEffect(() => watchKeyboard(setKeyboard), [])

  useEffect(() => {
    let disposed = false
    let cleanupResize: (() => void) | null = null

    void (async () => {
      try {
        // Loaded here, not at module scope, so xterm never lands in the main bundle.
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ])
        await import('@xterm/xterm/css/xterm.css')
        if (disposed || !hostRef.current) return

        const term = new Terminal({
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          fontSize: 13,
          lineHeight: 1.25,
          cursorBlink: true,
          convertEol: true,
          theme: {
            background: '#090a0c',
            foreground: '#e7e9ec',
            cursor: '#6ee7a8',
            selectionBackground: '#2a3038',
          },
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(hostRef.current)
        fit.fit()
        termRef.current = term as never

        term.onData((data) => {
          void conn.rpc('shell.write', { shellId: shellId.current, data }).catch(() => {})
        })
        writeRef.current = (data: string) => {
          void conn.rpc('shell.write', { shellId: shellId.current, data }).catch(() => {})
        }

        await conn.rpc('shell.spawn', {
          shellId: shellId.current,
          cols: term.cols,
          rows: term.rows,
        })
        if (disposed) return
        setStatus('live')

        const onResize = (): void => {
          fit.fit()
          void conn
            .rpc('shell.resize', { shellId: shellId.current, cols: term.cols, rows: term.rows })
            .catch(() => {})
        }
        window.addEventListener('resize', onResize)
        cleanupResize = () => window.removeEventListener('resize', onResize)
      } catch (err) {
        if (disposed) return
        setError((err as Error).message)
        setStatus('error')
      }
    })()

    return () => {
      disposed = true
      cleanupResize?.()
      void conn.rpc('shell.kill', { shellId: shellId.current }).catch(() => {})
      termRef.current?.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The bridge only forwards output for shells this device spawned, so no
  // filtering is needed here beyond matching our own id.
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { shellId: string; type: string; data?: string; code?: number }
      if (detail.shellId !== shellId.current) return
      if (detail.type === 'data' && detail.data) termRef.current?.write(detail.data)
      if (detail.type === 'exit') termRef.current?.write(`\r\n\x1b[90m[exited ${detail.code ?? 0}]\x1b[0m\r\n`)
    }
    window.addEventListener('dorabot:shell', handler)
    return () => window.removeEventListener('dorabot:shell', handler)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-950">
      {status === 'loading' && (
        <div className="flex h-full items-center justify-center gap-2 text-[14px] text-ink-400">
          <Spinner /> starting shell…
        </div>
      )}
      {status === 'error' && (
        <div className="p-6 text-[14px] leading-relaxed text-rose-glow">{error}</div>
      )}
      <div ref={hostRef} className={cx('min-h-0 flex-1 px-2 pt-2', status !== 'live' && 'hidden')} />

      <div
        className="safe-bottom shrink-0 border-t border-ink-700 bg-ink-900"
        style={{ paddingBottom: keyboard > 0 ? keyboard + 8 : undefined }}
      >
        <div className="scroll no-scrollbar flex gap-1.5 overflow-x-auto px-3 py-2">
          {KEYS.map((k) => (
            <button
              key={k.label}
              onClick={() => {
                writeRef.current(k.seq)
                void haptic('light')
              }}
              className="shrink-0 rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 font-mono text-[13px] text-ink-200 active:bg-ink-700"
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
