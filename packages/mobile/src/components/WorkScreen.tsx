import type { StoredSession } from '@dorabot-remote/protocol'
import { useState, type ReactNode } from 'react'
import { ScopeGate } from './ScopeGate.js'
import { Segmented } from './ui.js'
import { ProjectsView } from './WorkProjects.js'
import { ResearchView } from './WorkResearch.js'
import { ScheduleView } from './WorkSchedule.js'
import { TasksView } from './WorkTasks.js'

type Part = 'tasks' | 'projects' | 'research' | 'schedule'

const PARTS: Array<{ value: Part; label: string }> = [
  { value: 'tasks', label: 'Tasks' },
  { value: 'projects', label: 'Projects' },
  { value: 'research', label: 'Research' },
  { value: 'schedule', label: 'Schedule' },
]

/**
 * Tasks, projects, research and the schedule: the things dorabot is working on
 * and the things you have asked it to do later. No screen header of its own, so
 * the detail layers inside can cover the whole tab without a second header
 * showing underneath.
 */
export function WorkScreen({
  onOpenSession,
}: {
  onOpenSession: (session: StoredSession | null, sessionKey: string) => void
}): ReactNode {
  const [part, setPart] = useState<Part>('tasks')
  return (
    <ScopeGate scope="work" title="Work">
      <div className="relative flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-ink-700 bg-ink-900 px-3 py-2">
          <Segmented value={part} options={PARTS} onChange={setPart} />
        </div>
        <div className="min-h-0 flex-1">
          {part === 'tasks' && <TasksView onOpenSession={onOpenSession} />}
          {part === 'projects' && <ProjectsView />}
          {part === 'research' && <ResearchView />}
          {part === 'schedule' && <ScheduleView />}
        </div>
      </div>
    </ScopeGate>
  )
}
