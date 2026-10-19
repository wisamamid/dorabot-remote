import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import {
  clearConnLog,
  copyText,
  fmtTime,
  formatConnLog,
  getConnLogVersion,
  getEntries,
  getMeta,
  subscribeConnLog,
} from '../lib/connlog.js'
import { Button, Card, Screen } from './ui.js'

/** What the phone tried, in order, so a failed connect can be explained afterwards. */
export function ConnectionLogScreen({ onBack }: { onBack: () => void }): ReactNode {
  useSyncExternalStore(subscribeConnLog, getConnLogVersion)
  const conn = useConnection()
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const meta = getMeta()
  const entries = [...getEntries()].reverse()

  async function copy(): Promise<void> {
    const ok = await copyText(formatConnLog())
    setCopied(ok ? 'ok' : 'fail')
    setTimeout(() => setCopied(null), 2500)
  }

  return (
    <Screen title="Connection log" onBack={onBack}>
      <div className="scroll h-full space-y-4 px-4 py-4">
        <Card className="space-y-1.5 text-[13.5px]">
          <Fact label="State" value={conn.stateDetail ? `${conn.state} (${conn.stateDetail})` : conn.state} />
          <Fact label="Transport" value={meta.transport ?? 'none'} />
          <Fact label="Network" value={meta.netType ? `${meta.netType}${meta.netConnected === false ? ' (offline)' : ''}` : 'unknown'} />
          <Fact label="Relay" value={meta.relayUrl ? `${meta.relayUrl}  id ${meta.relayId ?? '?'}` : 'none stored'} />
          <Fact label="LAN" value={meta.lan && meta.lan.length ? meta.lan.join('\n') : 'none'} />
        </Card>

        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void copy()} className="flex-1">
            {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy failed' : 'Copy'}
          </Button>
          <Button variant="default" onClick={() => clearConnLog()} className="flex-1">
            Clear
          </Button>
        </div>

        <div className="safe-bottom space-y-1 pb-4 font-mono text-[12px] leading-snug text-ink-200">
          {entries.length === 0 && <div className="text-ink-400">No events yet.</div>}
          {entries.map((e, i) => (
            <div key={`${e.t}-${i}`} className="break-words border-b border-ink-800 pb-1">
              <span className="text-ink-400">{fmtTime(e.t).slice(6)}</span> <span className="text-mint-500">{e.k}</span> {e.m}
            </div>
          ))}
        </div>
      </div>
    </Screen>
  )
}

function Fact({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-ink-400">{label}</dt>
      <dd className="whitespace-pre-line break-all text-right font-mono text-[12px] text-ink-200">{value}</dd>
    </div>
  )
}
