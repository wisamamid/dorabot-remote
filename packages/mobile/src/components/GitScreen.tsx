import { useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic } from '../lib/platform.js'
import { useRpc } from '../lib/useRpc.js'
import { LockedControl, ScopeGate } from './ScopeGate.js'
import { Button, Chip, Empty, ErrorNote, Layer, Row, Screen, SectionTitle, Segmented, Spinner, TextField, timeAgo } from './ui.js'

interface GitFile {
  path: string
  status: string
  staged: boolean
}
interface GitStatus {
  root: string
  branch: string
  files: GitFile[]
  ahead: number
  behind: number
}
interface Branch {
  name: string
  current: boolean
  remote: boolean
  lastCommitDate: string
  author: string
}
interface Commit {
  hash: string
  short: string
  subject: string
  author: string
  date: string
}

type Part = 'changes' | 'branches' | 'log'
const PARTS: Array<{ value: Part; label: string }> = [
  { value: 'changes', label: 'Changes' },
  { value: 'branches', label: 'Branches' },
  { value: 'log', label: 'History' },
]

const REPO_KEY = 'dorabot.gitRepo'

export function GitScreen({ initialRepo }: { initialRepo?: string }): ReactNode {
  return (
    <ScopeGate scope="git" title="Git">
      <Repo initialRepo={initialRepo} />
    </ScopeGate>
  )
}

function Repo({ initialRepo }: { initialRepo?: string }): ReactNode {
  const conn = useConnection()
  const [repo, setRepo] = useState(initialRepo ?? localStorage.getItem(REPO_KEY) ?? '.')
  const [editing, setEditing] = useState(false)
  const [part, setPart] = useState<Part>('changes')
  const status = useRpc<GitStatus>('git.status', { path: repo })
  const root = status.data?.root ?? repo
  const canWrite = conn.hasScope('git_write')

  function pick(p: string): void {
    localStorage.setItem(REPO_KEY, p)
    setRepo(p)
    setEditing(false)
  }

  return (
    <div className="relative h-full">
      <Screen
        title="Git"
        subtitle={status.data ? `${status.data.branch || 'detached'} · ${root}` : repo}
        right={
          <button onClick={() => setEditing(true)} className="tap px-3 text-[15px] font-medium text-mint-500">
            Repo
          </button>
        }
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 border-b border-ink-700 bg-ink-900 px-3 py-2">
            <Segmented value={part} options={PARTS} onChange={setPart} />
          </div>
          <div className="scroll min-h-0 flex-1 space-y-1.5 px-3 py-2 pb-4">
            <ErrorNote error={status.error} onRetry={() => void status.reload()} />
            {status.loading && !status.data ? (
              <div className="flex h-40 items-center justify-center">
                <Spinner className="size-6" />
              </div>
            ) : status.data ? (
              <>
                {part === 'changes' && <Changes root={root} status={status.data} canWrite={canWrite} reload={status.reload} />}
                {part === 'branches' && <Branches root={root} canWrite={canWrite} onSwitched={status.reload} />}
                {part === 'log' && <Log root={root} />}
              </>
            ) : !status.error ? (
              <Empty title="Not a repository" body="Pick a repo with the button above." />
            ) : null}
          </div>
        </div>
      </Screen>
      {editing && (
        <Layer>
          <RepoPicker current={repo} onClose={() => setEditing(false)} onPick={pick} />
        </Layer>
      )}
    </div>
  )
}

function RepoPicker({ current, onClose, onPick }: { current: string; onClose: () => void; onPick: (p: string) => void }): ReactNode {
  const [text, setText] = useState(current)
  return (
    <Screen title="Repository" onBack={onClose}>
      <div className="scroll h-full space-y-4 px-4 py-4">
        <TextField label="Path on the Mac" value={text} onChange={setText} placeholder="~/Code/project or ." mono />
        <p className="text-[14px] text-ink-400">Relative paths start from the folder dorabot runs in. You can also use Open in Git from the Files tab.</p>
        <Button variant="primary" className="w-full" disabled={!text.trim()} onClick={() => onPick(text.trim())}>
          Use this repo
        </Button>
      </div>
    </Screen>
  )
}

const STATUS_LABEL: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', '?': 'Untracked', U: 'Conflict' }

function Changes({ root, status, canWrite, reload }: { root: string; status: GitStatus; canWrite: boolean; reload: () => Promise<void> }): ReactNode {
  const conn = useConnection()
  const [diff, setDiff] = useState<GitFile | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const staged = status.files.filter((f) => f.staged)
  const unstaged = status.files.filter((f) => !f.staged)

  async function act(label: string, method: string, params: Record<string, unknown>): Promise<void> {
    setBusy(label)
    setError(null)
    setNote(null)
    try {
      await conn.rpc(method, { path: root, ...params })
      await haptic('success')
      if (method === 'git.commit') setMessage('')
      if (method === 'git.push') setNote('Pushed.')
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const fileRow = (f: GitFile): ReactNode => (
    <Row
      key={`${f.staged}:${f.path}`}
      onClick={() => setDiff(f)}
      title={f.path}
      meta={<Chip tone={f.status === 'D' ? 'bad' : f.status === 'A' || f.status === '?' ? 'good' : 'warn'}>{STATUS_LABEL[f.status] ?? f.status}</Chip>}
      trailing={
        canWrite && f.status !== 'U' ? (
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation()
              void act(f.path, f.staged ? 'git.unstageFile' : 'git.stageFile', { file: f.path })
            }}
            className="tap flex shrink-0 items-center rounded-xl border border-ink-600 px-3.5 text-[14px] font-medium"
          >
            {busy === f.path ? '…' : f.staged ? 'Unstage' : 'Stage'}
          </span>
        ) : undefined
      }
    />
  )

  return (
    <>
      {(status.ahead > 0 || status.behind > 0) && (
        <div className="px-1 pb-1 text-[14px] text-ink-300">
          {status.ahead > 0 && `${status.ahead} ahead`}
          {status.ahead > 0 && status.behind > 0 && ' · '}
          {status.behind > 0 && `${status.behind} behind`}
        </div>
      )}
      {status.files.length === 0 && (
        <div className="h-40">
          <Empty title="Working tree clean" />
        </div>
      )}
      {staged.length > 0 && <SectionTitle>Staged</SectionTitle>}
      {staged.map(fileRow)}
      {unstaged.length > 0 && <SectionTitle>Not staged</SectionTitle>}
      {unstaged.map(fileRow)}

      <SectionTitle>Commit and push</SectionTitle>
      {canWrite ? (
        <div className="space-y-3">
          <TextField value={message} onChange={setMessage} placeholder="Commit message" multiline rows={2} />
          <Button variant="primary" className="w-full" disabled={!message.trim() || staged.length === 0 || busy !== null} onClick={() => void act('commit', 'git.commit', { message: message.trim() })}>
            {busy === 'commit' ? 'Committing…' : `Commit ${staged.length} staged`}
          </Button>
          <Button className="w-full" disabled={busy !== null || status.ahead === 0} onClick={() => void act('push', 'git.push', {})}>
            {busy === 'push' ? 'Pushing…' : status.ahead > 0 ? `Push ${status.ahead} commit${status.ahead === 1 ? '' : 's'}` : 'Nothing to push'}
          </Button>
          {note && <p className="text-[14px] text-mint-500">{note}</p>}
          <ErrorNote error={error} />
        </div>
      ) : (
        <LockedControl scope="git_write" label="Stage, commit and push" />
      )}

      {diff && (
        <Layer>
          <DiffView root={root} file={diff} onClose={() => setDiff(null)} />
        </Layer>
      )}
    </>
  )
}

function DiffView({ root, file, onClose }: { root: string; file: GitFile; onClose: () => void }): ReactNode {
  const res = useRpc<{ diff: string }>('git.diff', { path: root, file: file.path, staged: file.staged })
  const text = res.data?.diff ?? ''
  return (
    <Screen title={file.path.split('/').pop() ?? file.path} subtitle={file.staged ? 'Staged changes' : 'Unstaged changes'} onBack={onClose}>
      {res.error ? (
        <div className="p-4">
          <ErrorNote error={res.error} />
        </div>
      ) : !res.data ? (
        <Spinner className="mx-auto mt-10 size-6" />
      ) : text.trim() === '' ? (
        <Empty title="No textual diff" body={file.status === '?' ? 'This file is not tracked yet.' : 'Nothing to show for this file.'} />
      ) : (
        <pre className="scroll selectable h-full overflow-auto px-3 py-3 font-mono text-[13px] leading-[1.5]">
          {text.split('\n').map((l, i) => (
            <div
              key={i}
              className={
                l.startsWith('+') && !l.startsWith('+++')
                  ? 'bg-mint-900/50 text-mint-500'
                  : l.startsWith('-') && !l.startsWith('---')
                    ? 'bg-rose-dim text-rose-glow'
                    : l.startsWith('@@')
                      ? 'text-amber-glow'
                      : 'text-ink-300'
              }
            >
              {l || ' '}
            </div>
          ))}
        </pre>
      )}
    </Screen>
  )
}

function Branches({ root, canWrite, onSwitched }: { root: string; canWrite: boolean; onSwitched: () => Promise<void> }): ReactNode {
  const conn = useConnection()
  const res = useRpc<{ branches: Branch[] }>('git.branches', { path: root })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function checkout(name: string): Promise<void> {
    setBusy(name)
    setError(null)
    try {
      await conn.rpc('git.checkout', { path: root, branch: name })
      await haptic('success')
      await Promise.all([res.reload(), onSwitched()])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <ErrorNote error={res.error ?? error} />
      {!canWrite && <LockedControl scope="git_write" label="Switch branch" />}
      {!res.data && !res.error && <Spinner className="mx-auto mt-6 size-5" />}
      {(res.data?.branches ?? []).map((b) => (
        <Row
          key={b.name}
          title={b.name}
          meta={
            <>
              {b.current && <Chip tone="good">Current</Chip>}
              {b.remote && <Chip>Remote</Chip>}
              <span className="truncate">{b.author}</span>
              <span className="ml-auto">{timeAgo(b.lastCommitDate)}</span>
            </>
          }
          trailing={
            canWrite && !b.current && !b.remote ? (
              <span
                role="button"
                onClick={() => void checkout(b.name)}
                className="tap flex shrink-0 items-center rounded-xl border border-ink-600 px-3.5 text-[14px] font-medium"
              >
                {busy === b.name ? '…' : 'Switch'}
              </span>
            ) : undefined
          }
        />
      ))}
    </>
  )
}

function Log({ root }: { root: string }): ReactNode {
  const res = useRpc<{ commits: Commit[] }>('git.log', { path: root, count: 50 })
  return (
    <>
      <ErrorNote error={res.error} onRetry={() => void res.reload()} />
      {!res.data && !res.error && <Spinner className="mx-auto mt-6 size-5" />}
      {(res.data?.commits ?? []).map((c) => (
        <Row
          key={c.hash}
          title={c.subject}
          meta={
            <>
              <span className="font-mono">{c.short}</span>
              <span className="truncate">{c.author}</span>
              <span className="ml-auto">{timeAgo(c.date)}</span>
            </>
          }
        />
      ))}
    </>
  )
}
