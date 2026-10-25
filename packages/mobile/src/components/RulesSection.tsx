import { useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic } from '../lib/platform.js'
import { useRpc } from '../lib/useRpc.js'
import { Button, Card } from './ui.js'

interface Rule {
  id: string
  kind: 'tool' | 'exact'
  toolName: string
  command: string | null
  createdAt: number
  createdBy: string | null
}

/** Settings > Always-allow rules: read-only list with remove. Rules are only ever added from an approval. */
export function RulesSection(): ReactNode {
  const conn = useConnection()
  const can = conn.can('remote.rules.list')
  const rules = useRpc<Rule[]>('remote.rules.list', undefined, { enabled: can })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!can) return null

  async function remove(id: string): Promise<void> {
    setBusy(id)
    setError(null)
    try {
      await conn.rpc('remote.rules.remove', { id })
      await haptic('medium')
      await rules.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const list = rules.data ?? []
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wider text-ink-400">Always-allow rules</h2>
      <Card className="space-y-3 text-[13.5px]">
        {list.length === 0 ? (
          <p className="leading-snug text-ink-400">None. Every approval asks you. Choose "Always allow" on an approval to add one.</p>
        ) : (
          list.map((r) => (
            <div key={r.id} data-testid="rule-row" className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="selectable break-words font-mono text-[13px]">{r.kind === 'exact' ? r.command : r.toolName}</div>
                <div className="text-[12.5px] text-ink-400">{r.kind === 'exact' ? 'Bash, this exact command' : 'Any non-risky use'}</div>
              </div>
              <Button variant="danger" onClick={() => void remove(r.id)} disabled={busy !== null}>
                {busy === r.id ? '…' : 'Remove'}
              </Button>
            </div>
          ))
        )}
        {error && <p className="text-rose-glow">{error}</p>}
        <p className="border-t border-ink-700 pt-3 text-[13px] leading-snug text-ink-400">
          Your Mac approves these by itself and records each one in the audit log. Risky actions are never covered.
        </p>
      </Card>
    </section>
  )
}
