import { useState, type ReactNode } from 'react'
import { FilesScreen } from './FilesScreen.js'
import { GitScreen } from './GitScreen.js'
import { Segmented } from './ui.js'

type Part = 'files' | 'git'

/** Files and Git share a tab: both answer "what is on my Mac's disk right now". */
export function CodeScreen(): ReactNode {
  const [part, setPart] = useState<Part>('files')
  const [repo, setRepo] = useState<string | undefined>()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-ink-700 bg-ink-900 px-3 py-2">
        <Segmented
          value={part}
          options={[
            { value: 'files', label: 'Files' },
            { value: 'git', label: 'Git' },
          ]}
          onChange={setPart}
        />
      </div>
      <div className="min-h-0 flex-1">
        {part === 'files' ? (
          <FilesScreen
            onUseAsRepo={(dir) => {
              setRepo(dir)
              setPart('git')
            }}
          />
        ) : (
          <GitScreen key={repo ?? 'default'} initialRepo={repo} />
        )}
      </div>
    </div>
  )
}
