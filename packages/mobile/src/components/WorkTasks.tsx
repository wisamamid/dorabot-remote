import type { StoredSession } from '@dorabot-remote/protocol'
import { useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic } from '../lib/platform.js'
import { useReloadOnEvents, useRpc } from '../lib/useRpc.js'
import {
  TASK_STATUSES,
  taskStatusLabel,
  taskTone,
  type Project,
  type Task,
  type TaskLog,
  type TaskStatus,
} from '../lib/work.js'
import { sessionLabel } from '../lib/sessionName.js'
import { Button, Chip, ConfirmButton, Empty, ErrorNote, Layer, Row, Screen, SectionTitle, SelectField, Spinner, TextField, timeAgo } from './ui.js'

const FILTERS: Array<{ value: 'open' | 'all'; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
]

export function TasksView({
  onOpenSession,
}: {
  onOpenSession: (session: StoredSession | null, sessionKey: string) => void
}): ReactNode {
  const tasks = useRpc<Task[]>('tasks.list')
  const projects = useRpc<Project[]>('projects.list')
  useReloadOnEvents(['projects.update'], async () => {
    await Promise.all([tasks.reload(), projects.reload()])
  })
  const [filter, setFilter] = useState<'open' | 'all'>('open')
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const all = [...(tasks.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const rows = filter === 'open' ? all.filter((t) => t.status !== 'done' && t.status !== 'cancelled') : all
  const projectName = (id?: string): string | undefined => projects.data?.find((p) => p.id === id)?.title
  const open = openId ? all.find((t) => t.id === openId) : null

  return (
    <div className="relative h-full">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 px-3 py-2">
          <div className="flex flex-1 gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`tap rounded-xl px-4 text-[14px] font-medium ${filter === f.value ? 'bg-ink-700 text-ink-100' : 'text-ink-400 active:bg-ink-800'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button variant="primary" onClick={() => setCreating(true)} className="px-4">
            New task
          </Button>
        </div>
        <div className="scroll min-h-0 flex-1 space-y-1.5 px-3 pb-4">
          <ErrorNote error={tasks.error} onRetry={() => void tasks.reload()} />
          {tasks.loading && !tasks.data ? (
            <div className="flex h-40 items-center justify-center">
              <Spinner className="size-6" />
            </div>
          ) : rows.length === 0 && !tasks.error ? (
            <div className="h-[50vh]">
              <Empty title={filter === 'open' ? 'No open tasks' : 'No tasks yet'} body="Create one here, or ask dorabot to." />
            </div>
          ) : (
            rows.map((t) => (
              <Row
                key={t.id}
                onClick={() => setOpenId(t.id)}
                title={t.title}
                meta={
                  <>
                    <Chip tone={taskTone(t.status)}>{taskStatusLabel(t.status)}</Chip>
                    {projectName(t.goalId) && <span className="truncate">{projectName(t.goalId)}</span>}
                    <span className="ml-auto">{timeAgo(t.updatedAt)}</span>
                  </>
                }
              />
            ))
          )}
        </div>
      </div>

      {open && (
        <Layer>
          <TaskDetail
            task={open}
            projects={projects.data ?? []}
            onClose={() => setOpenId(null)}
            onChanged={async () => {
              await tasks.reload()
            }}
            onOpenSession={onOpenSession}
          />
        </Layer>
      )}
      {creating && (
        <Layer>
          <TaskForm
            projects={projects.data ?? []}
            onClose={() => setCreating(false)}
            onSaved={async () => {
              setCreating(false)
              await tasks.reload()
            }}
          />
        </Layer>
      )}
    </div>
  )
}

function TaskForm({
  projects,
  onClose,
  onSaved,
}: {
  projects: Project[]
  onClose: () => void
  onSaved: () => Promise<void>
}): ReactNode {
  const conn = useConnection()
  const [title, setTitle] = useState('')
  const [goalId, setGoalId] = useState('')
  const [status, setStatus] = useState<TaskStatus>('todo')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await conn.rpc('tasks.add', { title: title.trim(), status, goalId: goalId || undefined })
      await haptic('success')
      await onSaved()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Screen title="New task" onBack={onClose}>
      <div className="scroll h-full space-y-4 px-4 py-4">
        <TextField label="Title" value={title} onChange={setTitle} placeholder="What needs doing?" />
        <SelectField
          label="Project"
          value={goalId}
          onChange={setGoalId}
          options={[{ value: '', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.title }))]}
        />
        <SelectField label="Status" value={status} onChange={setStatus} options={TASK_STATUSES} />
        <ErrorNote error={error} />
        <Button variant="primary" onClick={() => void save()} disabled={!title.trim() || busy} className="w-full">
          {busy ? 'Saving…' : 'Create task'}
        </Button>
      </div>
    </Screen>
  )
}

function TaskDetail({
  task,
  projects,
  onClose,
  onChanged,
  onOpenSession,
}: {
  task: Task
  projects: Project[]
  onClose: () => void
  onChanged: () => Promise<void>
  onOpenSession: (session: StoredSession | null, sessionKey: string) => void
}): ReactNode {
  const conn = useConnection()
  const logs = useRpc<TaskLog[]>('tasks.logs', { id: task.id, limit: 30 })
  const [title, setTitle] = useState(task.title)
  const [goalId, setGoalId] = useState(task.goalId ?? '')
  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dirty = title.trim() !== task.title || goalId !== (task.goalId ?? '') || status !== task.status
  const canStart = status !== 'done' && status !== 'cancelled'

  async function run(label: string, fn: () => Promise<unknown>, closeAfter = false): Promise<void> {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await onChanged()
      if (closeAfter) onClose()
      else await logs.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function start(mode: 'plan' | 'execute'): Promise<void> {
    setBusy(mode)
    setError(null)
    try {
      const res = await conn.rpc<{ sessionKey: string }>('tasks.start', { id: task.id, mode })
      await haptic('success')
      await onChanged()
      await conn.refreshSessions()
      if (res?.sessionKey) onOpenSession(null, res.sessionKey)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Screen title={`Task #${task.id}`} onBack={onClose}>
      <div className="scroll h-full space-y-4 px-4 py-4">
        <TextField label="Title" value={title} onChange={setTitle} multiline rows={2} />
        <SelectField label="Status" value={status} onChange={setStatus} options={TASK_STATUSES} />
        <SelectField
          label="Project"
          value={goalId}
          onChange={setGoalId}
          options={[{ value: '', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.title }))]}
        />
        <Button
          variant="primary"
          disabled={!dirty || !title.trim() || busy !== null}
          onClick={() =>
            void run('save', () =>
              conn.rpc('tasks.update', { id: task.id, title: title.trim(), status, goalId: goalId || '' }),
            )
          }
          className="w-full"
        >
          {busy === 'save' ? 'Saving…' : 'Save changes'}
        </Button>

        {(task.result || task.reason) && (
          <div className="space-y-2 rounded-card border border-ink-700 bg-ink-850 p-3.5 text-[14px] leading-relaxed">
            {task.result && (
              <div>
                <div className="text-[13px] font-medium uppercase tracking-wide text-ink-400">Result</div>
                <div className="selectable whitespace-pre-wrap break-words text-ink-200">{task.result}</div>
              </div>
            )}
            {task.reason && (
              <div>
                <div className="text-[13px] font-medium uppercase tracking-wide text-ink-400">Reason</div>
                <div className="selectable whitespace-pre-wrap break-words text-ink-200">{task.reason}</div>
              </div>
            )}
          </div>
        )}

        {task.sessionKey && (
          <Button
            variant="default"
            className="w-full"
            onClick={() => onOpenSession(null, task.sessionKey!)}
          >
            Open its session ({sessionLabel(conn.sessions, task.sessionKey)})
          </Button>
        )}

        {canStart && (
          <div className="flex gap-2">
            <Button variant="default" onClick={() => void start('plan')} disabled={busy !== null} className="flex-1">
              {busy === 'plan' ? 'Starting…' : 'Plan it'}
            </Button>
            <Button variant="default" onClick={() => void start('execute')} disabled={busy !== null} className="flex-1">
              {busy === 'execute' ? 'Starting…' : 'Run it'}
            </Button>
          </div>
        )}

        <ErrorNote error={error} />

        <SectionTitle>Activity</SectionTitle>
        {logs.loading && !logs.data ? (
          <Spinner className="mx-auto size-5" />
        ) : (logs.data ?? []).length === 0 ? (
          <div className="px-1 text-[14px] text-ink-400">No activity recorded.</div>
        ) : (
          <ul className="space-y-1.5">
            {(logs.data ?? []).map((l) => (
              <li key={l.id} className="rounded-xl bg-ink-850 px-3.5 py-2.5 text-[14px] leading-snug">
                <div className="selectable text-ink-200">{l.message}</div>
                <div className="mt-0.5 text-[13px] text-ink-500">{timeAgo(l.createdAt)}</div>
              </li>
            ))}
          </ul>
        )}

        <div className="safe-bottom pt-4">
          <ConfirmButton
            label="Delete task"
            confirmLabel="Tap again to delete"
            disabled={busy !== null}
            onConfirm={() => void run('delete', () => conn.rpc('tasks.delete', { id: task.id }), true)}
          />
        </div>
      </div>
    </Screen>
  )
}
