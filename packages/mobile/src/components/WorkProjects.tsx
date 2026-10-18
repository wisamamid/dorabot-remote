import { useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { haptic } from '../lib/platform.js'
import { useReloadOnEvents, useRpc } from '../lib/useRpc.js'
import { PROJECT_STATUSES, splitTags, type Project, type ProjectStatus, type Task } from '../lib/work.js'
import { taskStatusLabel } from '../lib/work.js'
import { Button, Chip, ConfirmButton, Empty, ErrorNote, Layer, Row, Screen, SectionTitle, SelectField, Spinner, TextField, timeAgo } from './ui.js'

const projectTone = (s: ProjectStatus): 'good' | 'warn' | 'idle' => (s === 'active' ? 'good' : s === 'paused' ? 'warn' : 'idle')

export function ProjectsView(): ReactNode {
  const projects = useRpc<Project[]>('projects.list')
  const tasks = useRpc<Task[]>('tasks.list')
  useReloadOnEvents(['projects.update'], async () => {
    await Promise.all([projects.reload(), tasks.reload()])
  })
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const rows = [...(projects.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const open = openId ? rows.find((p) => p.id === openId) : null
  const countFor = (id: string): number =>
    (tasks.data ?? []).filter((t) => t.goalId === id && t.status !== 'done' && t.status !== 'cancelled').length

  return (
    <div className="relative h-full">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 justify-end px-3 py-2">
          <Button variant="primary" onClick={() => setCreating(true)} className="px-4">
            New project
          </Button>
        </div>
        <div className="scroll min-h-0 flex-1 space-y-1.5 px-3 pb-4">
          <ErrorNote error={projects.error} onRetry={() => void projects.reload()} />
          {projects.loading && !projects.data ? (
            <div className="flex h-40 items-center justify-center">
              <Spinner className="size-6" />
            </div>
          ) : rows.length === 0 && !projects.error ? (
            <div className="h-[50vh]">
              <Empty title="No projects yet" body="Projects group tasks. Create one here, or ask dorabot to." />
            </div>
          ) : (
            rows.map((p) => (
              <Row
                key={p.id}
                onClick={() => setOpenId(p.id)}
                title={p.title}
                subtitle={p.description}
                meta={
                  <>
                    <Chip tone={projectTone(p.status)}>{p.status}</Chip>
                    <span>{countFor(p.id)} open</span>
                    <span className="ml-auto">{timeAgo(p.updatedAt)}</span>
                  </>
                }
              />
            ))
          )}
        </div>
      </div>
      {open && (
        <Layer>
          <ProjectDetail project={open} tasks={(tasks.data ?? []).filter((t) => t.goalId === open.id)} onClose={() => setOpenId(null)} onChanged={projects.reload} />
        </Layer>
      )}
      {creating && (
        <Layer>
          <ProjectForm
            onClose={() => setCreating(false)}
            onSaved={async () => {
              setCreating(false)
              await projects.reload()
            }}
          />
        </Layer>
      )}
    </div>
  )
}

function ProjectForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }): ReactNode {
  const conn = useConnection()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await conn.rpc('projects.add', { title: title.trim(), description: description.trim() || undefined, tags: splitTags(tags) })
      await haptic('success')
      await onSaved()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Screen title="New project" onBack={onClose}>
      <div className="scroll h-full space-y-4 px-4 py-4">
        <TextField label="Title" value={title} onChange={setTitle} />
        <TextField label="Description" value={description} onChange={setDescription} multiline rows={3} />
        <TextField label="Tags (comma separated)" value={tags} onChange={setTags} />
        <ErrorNote error={error} />
        <Button variant="primary" onClick={() => void save()} disabled={!title.trim() || busy} className="w-full">
          {busy ? 'Saving…' : 'Create project'}
        </Button>
      </div>
    </Screen>
  )
}

function ProjectDetail({
  project,
  tasks,
  onClose,
  onChanged,
}: {
  project: Project
  tasks: Task[]
  onClose: () => void
  onChanged: () => Promise<void>
}): ReactNode {
  const conn = useConnection()
  const [title, setTitle] = useState(project.title)
  const [description, setDescription] = useState(project.description ?? '')
  const [status, setStatus] = useState<ProjectStatus>(project.status)
  const [tags, setTags] = useState((project.tags ?? []).join(', '))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dirty =
    title.trim() !== project.title ||
    description !== (project.description ?? '') ||
    status !== project.status ||
    tags !== (project.tags ?? []).join(', ')

  async function run(label: string, fn: () => Promise<unknown>, closeAfter = false): Promise<void> {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await onChanged()
      if (closeAfter) onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Screen title={`Project #${project.id}`} onBack={onClose}>
      <div className="scroll h-full space-y-4 px-4 py-4">
        <TextField label="Title" value={title} onChange={setTitle} />
        <TextField label="Description" value={description} onChange={setDescription} multiline rows={3} />
        <SelectField label="Status" value={status} onChange={setStatus} options={PROJECT_STATUSES} />
        <TextField label="Tags (comma separated)" value={tags} onChange={setTags} />
        {status === 'done' && project.status !== 'done' && (
          <p className="text-[14px] text-ink-400">Marking a project done cancels its tasks that have not started.</p>
        )}
        <Button
          variant="primary"
          disabled={!dirty || !title.trim() || busy !== null}
          onClick={() =>
            void run('save', () =>
              conn.rpc('projects.update', { id: project.id, title: title.trim(), description, status, tags: splitTags(tags) }),
            )
          }
          className="w-full"
        >
          {busy === 'save' ? 'Saving…' : 'Save changes'}
        </Button>
        <ErrorNote error={error} />

        <SectionTitle>Tasks</SectionTitle>
        {tasks.length === 0 ? (
          <div className="px-1 text-[14px] text-ink-400">No tasks in this project.</div>
        ) : (
          <ul className="space-y-1.5">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2 rounded-xl bg-ink-850 px-3.5 py-2.5 text-[14px]">
                <span className="min-w-0 flex-1 truncate text-ink-200">{t.title}</span>
                <Chip>{taskStatusLabel(t.status)}</Chip>
              </li>
            ))}
          </ul>
        )}

        <div className="safe-bottom pt-4">
          <ConfirmButton
            label="Delete project"
            confirmLabel="Tap again to delete"
            disabled={busy !== null}
            onConfirm={() => void run('delete', () => conn.rpc('projects.delete', { id: project.id }), true)}
          />
        </div>
      </div>
    </Screen>
  )
}
