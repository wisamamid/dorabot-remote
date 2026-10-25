import { SCOPE_DESCRIPTIONS, SCOPE_LABELS, SCOPES, type Scope } from '@dorabot-remote/protocol'
import { useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic, platformName } from '../lib/platform.js'
import { useAppLock } from '../lib/app-lock.js'
import { usePush } from '../lib/push-context.js'
import { useSavedPrompts } from '../lib/saved-prompts-context.js'
import { ConnectionLogScreen } from './ConnectionLogScreen.js'
import { MacsSection } from './MacsSection.js'
import { RulesSection } from './RulesSection.js'
import { displayName } from '../lib/hosts.js'
import { Button, Card, Dot, Screen, cx } from './ui.js'

/**
 * What this phone is connected to, what it is allowed to do, and how to take
 * that away. Permissions are read-only here on purpose: a device cannot widen
 * its own access, it can only ask.
 */
export function SettingsScreen({ onBack }: { onBack: () => void }): ReactNode {
  const conn = useConnection()
  const push = usePush()
  const lock = useAppLock()
  const savedPrompts = useSavedPrompts()
  const [confirmForget, setConfirmForget] = useState(false)
  const [requesting, setRequesting] = useState<Scope | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [editingPrompts, setEditingPrompts] = useState(false)

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

  if (showLog) return <ConnectionLogScreen onBack={() => setShowLog(false)} />
  if (editingPrompts) return <SavedPromptsEditScreen onBack={() => setEditingPrompts(false)} />

  return (
    <Screen title="Settings" onBack={onBack}>
      <div className="scroll h-full space-y-6 px-4 py-4">
        {!conn.demo && <MacsSection />}

        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-[16px] font-medium">{conn.pairing ? displayName(conn.pairing) : (conn.host?.name ?? 'Not paired')}</div>
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

        <button
          onClick={() => setShowLog(true)}
          className="flex w-full items-center justify-between rounded-2xl border border-ink-700 bg-ink-800 px-4 py-3 text-left active:bg-ink-700"
        >
          <span>
            <span className="block text-[15px] font-medium">Connection log</span>
            <span className="block text-[13px] text-ink-400">What this phone tried when connecting</span>
          </span>
          <span className="text-ink-400">›</span>
        </button>

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

        {conn.hasScope('approvals') && <RulesSection />}

        {push.supported && conn.hasScope('approvals') && (
          <section className="space-y-2">
            <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wider text-ink-400">Notifications</h2>
            <Card className="space-y-3 text-[13.5px]">
              <Row
                label="Status"
                value={
                  push.permission === 'granted'
                    ? push.registered
                      ? 'on'
                      : 'on, connecting…'
                    : push.permission === 'denied'
                      ? 'off in iOS Settings'
                      : 'not enabled'
                }
              />
              {push.permission === 'prompt' && (
                <Button variant="primary" onClick={() => void push.enable()} className="w-full">
                  Enable notifications
                </Button>
              )}
              {push.permission === 'denied' && (
                <p className="text-[13px] leading-snug text-ink-400">
                  Allow notifications for DoraBot Remote in the iOS Settings app.
                </p>
              )}
              {push.permission === 'granted' && (
                <label className="flex items-center justify-between gap-3 border-t border-ink-700 pt-3">
                  <span className="text-[14px]">Notify when a run finishes</span>
                  <input
                    type="checkbox"
                    className="size-5 accent-mint-500"
                    checked={push.notifyOnResult}
                    disabled={conn.state !== 'ready'}
                    onChange={(e) => void push.setNotifyOnResult(e.target.checked).catch((err) => setNote((err as Error).message))}
                  />
                </label>
              )}
              <p className="text-[12.5px] leading-snug text-ink-500">
                Notifications show the real question or tool request, end-to-end encrypted: only this phone can read
                it. They are sent only when this phone is not connected. Approve and Deny ask for Face ID.
              </p>
            </Card>
          </section>
        )}

        {lock.supported && (
          <section className="space-y-2">
            <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wider text-ink-400">Security</h2>
            <Card className="space-y-2 text-[13.5px]">
              <label className="flex items-center justify-between gap-3">
                <span className="text-[14px]">Require Face ID</span>
                <input
                  type="checkbox"
                  className="size-5 accent-mint-500"
                  checked={lock.enabled}
                  onChange={(e) => {
                    const on = e.target.checked
                    void lock.setEnabled(on).then((ok) => {
                      if (!ok) setNote('Could not turn on Face ID. Check that Face ID or a passcode is set up.')
                    })
                  }}
                />
              </label>
              <p className="text-[12.5px] leading-snug text-ink-500">
                Ask for Face ID when the app opens and when you come back after more than a minute.
              </p>
            </Card>
          </section>
        )}

        <section className="space-y-2">
          <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wider text-ink-400">Composer</h2>
          <button
            onClick={() => setEditingPrompts(true)}
            className="flex w-full items-center justify-between rounded-2xl border border-ink-700 bg-ink-800 px-4 py-3 text-left active:bg-ink-700"
          >
            <span>
              <span className="block text-[15px] font-medium">Saved prompts</span>
              <span className="block text-[13px] text-ink-400">{savedPrompts.prompts.length} prompts</span>
            </span>
            <span className="text-ink-400">›</span>
          </button>
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
                This stops notifications from this Mac and deletes its key and saved data on this phone. You will need
                to scan a new code to connect to it again. It does not revoke the device on the Mac. Your other Macs
                stay paired.
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
              Unpair this Mac
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
  if (state === 'pending') return 'waiting for approval on your Mac'
  return detail ? `offline (${detail})` : 'offline'
}

function SavedPromptsEditScreen({ onBack }: { onBack: () => void }): ReactNode {
  const savedPrompts = useSavedPrompts()
  const [editing, setEditing] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newText, setNewText] = useState('')

  const startEdit = (id: string) => {
    const prompt = savedPrompts.prompts.find((p) => p.id === id)
    if (prompt) {
      setEditing(id)
      setNewTitle(prompt.title)
      setNewText(prompt.text)
    }
  }

  const saveEdit = async () => {
    if (editing && newTitle.trim()) {
      await savedPrompts.update(editing, { title: newTitle.trim(), text: newText.trim() })
      setEditing(null)
    }
  }

  return (
    <Screen title="Saved prompts" onBack={onBack}>
      <div className="scroll h-full space-y-4 px-4 py-4">
        {editing ? (
          <Card className="space-y-3">
            <h3 className="text-[15px] font-semibold">Edit prompt</h3>
            <div className="space-y-2">
              <label className="block text-[13px] font-medium">Title</label>
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Prompt title"
                className="w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5 text-[14px]"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-[13px] font-medium">Text</label>
              <textarea
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="Prompt text"
                rows={3}
                className="w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5 text-[14px]"
              />
            </div>
            <div className="flex gap-2 border-t border-ink-700 pt-3">
              <Button variant="ghost" onClick={() => setEditing(null)} className="flex-1">
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void saveEdit()} className="flex-1">
                Save
              </Button>
            </div>
          </Card>
        ) : (
          <>
            {savedPrompts.prompts.length === 0 ? (
              <div className="py-8 text-center text-[14px] text-ink-400">No saved prompts</div>
            ) : (
              <div className="space-y-2">
                {savedPrompts.prompts.map((prompt) => (
                  <Card key={prompt.id} className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-medium text-ink-100">{prompt.title}</div>
                        {prompt.title !== prompt.text && (
                          <div className="text-[13px] text-ink-400 line-clamp-2">{prompt.text}</div>
                        )}
                      </div>
                      <button
                        onClick={() => startEdit(prompt.id)}
                        className="text-[13px] font-medium text-mint-500 active:opacity-70"
                      >
                        Edit
                      </button>
                    </div>
                    <button
                      onClick={() => void savedPrompts.remove(prompt.id)}
                      className="text-[13px] font-medium text-rose-glow active:opacity-70"
                    >
                      Delete
                    </button>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Screen>
  )
}
