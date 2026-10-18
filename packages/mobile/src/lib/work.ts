/** Shapes of the work objects, as the gateway returns them (src/tools/*.ts, src/calendar/scheduler.ts). */

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked' | 'cancelled'

export interface Task {
  id: string
  goalId?: string
  title: string
  status: TaskStatus
  result?: string
  reason?: string
  sessionId?: string
  sessionKey?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export type ProjectStatus = 'active' | 'paused' | 'done'

export interface Project {
  id: string
  title: string
  description?: string
  status: ProjectStatus
  tags?: string[]
  reason?: string
  createdAt: string
  updatedAt: string
}

export type ResearchStatus = 'active' | 'completed' | 'archived'

export interface ResearchItem {
  id: string
  topic: string
  title: string
  status: ResearchStatus
  sources?: string[]
  tags?: string[]
  createdAt: string
  updatedAt: string
  preview?: string
  /** Only on research.read. */
  content?: string
}

export interface CalendarItem {
  id: string
  type: 'event' | 'todo' | 'reminder'
  summary: string
  description?: string
  dtstart: string
  dtend?: string
  due?: string
  rrule?: string
  timezone?: string
  message: string
  enabled?: boolean
  deleteAfterRun?: boolean
  createdAt: string
  lastRunAt?: string
  nextRunAt?: string
}

export interface TaskLog {
  id: number
  taskId: string
  eventType: string
  message: string
  createdAt: string
}

export const TASK_STATUSES: Array<{ value: TaskStatus; label: string }> = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
]

export const taskStatusLabel = (s: string): string => TASK_STATUSES.find((x) => x.value === s)?.label ?? s

export function taskTone(s: TaskStatus): 'good' | 'warn' | 'bad' | 'idle' {
  if (s === 'done') return 'good'
  if (s === 'in_progress' || s === 'review') return 'warn'
  if (s === 'blocked') return 'bad'
  return 'idle'
}

export const PROJECT_STATUSES: Array<{ value: ProjectStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
]

export const RESEARCH_STATUSES: Array<{ value: ResearchStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
]

export function splitTags(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** "Mon 3 Nov, 14:30" in the phone's locale, or '' for a missing/invalid date. */
export function formatWhen(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
