import { SCOPE_DESCRIPTIONS, SCOPE_LABELS, SCOPES, type Scope } from '@dorabot-remote/protocol'
import { useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic, platformName } from '../lib/platform.js'
import { Button, Card, Dot, Screen, cx } from './ui.js'

/**
 * What this phone is connected to, what it is allowed to do, and how to take
 * that away. Permissions are read-only here on purpose: a device cannot widen
 * its own access, it can only ask.
 */
export function SettingsScreen({ onBack }: { onBack: () => void }): ReactNode {
  const conn = useConnection()
  const [confirmForget, setConfirmForget] = useState(false)
  const [requesting, setRequesting] = useState<Scope | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const scopes = conn.device?.scopes ?? conn.pairing?.scopes ?? []

  async function request(scope: Scope): Promise<void> {
    setRequesting(scope)
    setNote(null)
    try {
      await conn.rpc('remote.requestScope', { scope, reason: `Enable ${SCOPE_LABELS[scope]} on the phone` })
      await haptic('medium')
      setNote(`Asked for "${SCOPE_LABELS[scope]}". Approve it on ${conn.host?.name ?? 'your Mac'}.`)
    } catch (err) {
      setNote((err as Error).message)
    } finally {
      setRequesting(null)
    }
  }

  return (
    <Screen title="Settings" onBack={onBack}>
      <div className="scroll h-full space-y-6 px-4 py-4">
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-[16px] font-medium">{conn.host?.name ?? conn.pairing?.hostName ?? 'Not paired'}</div>
              <div className="font-mono text-[12.5px] text-ink-400">
                {conn.host?.fingerprint || 'unknown key'}
              </div>
            </div>
            <Dot tone={conn.state === 'ready' ? (conn.gatewayConnected ? 'good' : 'warn') : 'bad'} />
          </div>

          <dl className="space-y-1.5 border-t border-ink-700 pt-3 text-[13.5px]">
            <Row label="Connection" value={describeState(conn.state, conn.stateDetail)} />
            <Row label="dorabot" value={conn.gatewayConnected ? 'running' : 'not reachable'} />
            {conn.host?.dorabotVersion && <Row label="Version" value={conn.host.dorabotVersion} />}
            <Row label="Bridge" value={conn.host?.version ?? '—'} />
          </dl>

          <p className="border-t border-ink-700 pt-3 text-[13px] leading-relaxed text-ink-400">
            Check the key fingerprint matches the one shown on the Mac. If it ever changes, stop and re-pair.
          </p>
        </Card>

        <section className="space-y-2">
          <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wider text-ink-400">This device</h2>
          <Card className="space-y-1.5 text-[13.5px]">
            <Row label="Name" value={conn.device?.name ?? '—'} />
            <Row label="Platform" value={conn.device?.platform ?? platformName} />
            <Row label="Key" value={conn.device?.fingerprint ?? '—'} mono />
            <Row
              label="Paired"
              value={conn.pairing ? new Date(conn.pairing.pairedAt).toLocaleDateString() : '—'}
            />
          </Card>
        </section>

        <section className="space-y-2">
          <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wider text-ink-400">Permissions</h2>
          <div className="space-y-1.5">
            {SCOPES.map((scope) => {
              const on = scopes.includes(scope)
              return (
                <Card key={scope} className={cx('space-y-1.5', !on && 'opacity-80')}>
                  <div className="flex items-center gap-2">
                    <span className={cx('size-1.5 rounded-full', on ? 'bg-mint-500' : 'bg-ink-500')} />
                    <span className="flex-1 text-[15px] font-medium">{SCOPE_LABELS[scope]}</span>
                    {on ? (
                      <span className="text-[12.5px] font-medium text-mint-500">on</span>
                    ) : (
                      <button
                        onClick={() => void request(scope)}
                        disabled={requesting !== null || conn.state !== 'ready'}
                        className="rounded-lg border border-ink-600 px-2.5 py-1 text-[12.5px] text-ink-300 active:bg-ink-700 disabled:opacity-40"
                      >
                        {requesting === scope ? 'asking…' : 'request'}
                      </button>
                    )}
                  </div>
                  <p className="text-[13px] leading-snug text-ink-400">{SCOPE_DESCRIPTIONS[scope]}</p>
                </Card>
              )
            })}
          </div>
          {note && <div className="px-1 text-[13px] leading-relaxed text-ink-300">{note}</div>}
          <p className="px-1 text-[13px] leading-relaxed text-ink-500">
            Permissions are granted on the Mac, never from here. Approve a request on the pairing page.
          </p>
        </section>

        <section className="safe-bottom space-y-2 pb-4">
          <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wider text-ink-400">Danger zone</h2>
          {confirmForget ? (
            <Card tone="danger" className="space-y-3">
              <p className="text-[14px] leading-relaxed">
                This deletes the key on this phone. You will need to scan a new code to connect again. It does not
                revoke the device on the Mac.
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setConfirmForget(false)} className="flex-1">
                  Keep it
                </Button>
                <Button variant="danger" onClick={() => void conn.forget()} className="flex-1">
                  Unpair
                </Button>
              </div>
            </Card>
          ) : (
            <Button variant="default" onClick={() => setConfirmForget(true)} className="w-full text-rose-glow">
              Unpair this phone
            </Button>
          )}
        </section>
      </div>
    </Screen>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-ink-400">{label}</dt>
      <dd className={cx('truncate text-right text-ink-200', mono && 'font-mono text-[12.5px]')}>{value}</dd>
    </div>
  )
}

function describeState(state: string, detail?: string): string {
  if (state === 'ready') return 'connected'
  if (state === 'connecting') return 'connecting…'
  if (state === 'handshaking') return 'verifying…'
  return detail ? `offline (${detail})` : 'offline'
}
