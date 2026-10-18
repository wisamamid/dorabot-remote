import { lazy, Suspense, useState, type ReactNode } from 'react'
import { useConnection } from '../lib/connection.js'
import { useRpc } from '../lib/useRpc.js'
import { ScopeGate } from './ScopeGate.js'
import { Button, Empty, ErrorNote, Layer, Row, Screen, Spinner, TextField } from './ui.js'

const CodeViewer = lazy(() => import('./CodeViewer.js'))

interface Entry {
  name: string
  type: 'file' | 'directory'
  size?: number
}

const MAX_VIEW_BYTES = 512 * 1024

const join = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)
const parent = (dir: string): string => {
  const i = dir.lastIndexOf('/')
  return i <= 0 ? (dir.startsWith('/') ? '/' : '.') : dir.slice(0, i)
}
const sizeLabel = (n?: number): string => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`)

/** Read-only browser over the Mac's filesystem, starting at the gateway's working directory. */
export function FilesScreen({ onUseAsRepo }: { onUseAsRepo?: (dir: string) => void }): ReactNode {
  return (
    <ScopeGate scope="files" title="Files">
      <Browser onUseAsRepo={onUseAsRepo} />
    </ScopeGate>
  )
}

function Browser({ onUseAsRepo }: { onUseAsRepo?: (dir: string) => void }): ReactNode {
  const conn = useConnection()
  const [dir, setDir] = useState('.')
  const [file, setFile] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const list = useRpc<Entry[]>('fs.list', { path: dir })
  const canSearch = conn.can('search.files')

  const crumbs = dir === '.' ? ['.'] : dir.split('/').filter(Boolean)
  const goCrumb = (i: number): void => {
    if (dir === '.') return
    setDir((dir.startsWith('/') ? '/' : '') + crumbs.slice(0, i + 1).join('/'))
  }

  return (
    <div className="relative h-full">
      <Screen
        title="Files"
        subtitle={dir}
        onBack={dir === '.' || dir === '/' ? undefined : () => setDir(parent(dir))}
        right={
          canSearch ? (
            <button onClick={() => setSearching(true)} className="tap px-3 text-[15px] font-medium text-mint-500">
              Search
            </button>
          ) : undefined
        }
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="scroll flex shrink-0 gap-1 border-b border-ink-700 px-3 py-1.5">
            {crumbs.map((c, i) => (
              <button key={i} onClick={() => goCrumb(i)} className="tap shrink-0 rounded-lg px-2.5 text-[14px] text-ink-300 active:bg-ink-800">
                {c}
              </button>
            ))}
            {onUseAsRepo && (
              <button onClick={() => onUseAsRepo(dir)} className="tap ml-auto shrink-0 rounded-lg px-2.5 text-[14px] font-medium text-mint-500">
                Open in Git
              </button>
            )}
          </div>
          <div className="scroll min-h-0 flex-1 space-y-1.5 px-3 py-2 pb-4">
            <ErrorNote error={list.error} onRetry={() => void list.reload()} />
            {list.loading && !list.data ? (
              <div className="flex h-40 items-center justify-center">
                <Spinner className="size-6" />
              </div>
            ) : (list.data ?? []).length === 0 && !list.error ? (
              <div className="h-[50vh]">
                <Empty title="Empty folder" />
              </div>
            ) : (
              (list.data ?? []).map((e) => (
                <Row
                  key={e.name}
                  title={e.type === 'directory' ? `${e.name}/` : e.name}
                  meta={e.type === 'file' ? <span>{sizeLabel(e.size)}</span> : undefined}
                  onClick={() => (e.type === 'directory' ? setDir(join(dir, e.name)) : setFile(join(dir, e.name)))}
                />
              ))
            )}
          </div>
        </div>
      </Screen>
      {file && (
        <Layer>
          <FileView path={file} onClose={() => setFile(null)} />
        </Layer>
      )}
      {searching && (
        <Layer>
          <Search
            dir={dir}
            onClose={() => setSearching(false)}
            onOpen={(p) => {
              setSearching(false)
              setFile(p)
            }}
          />
        </Layer>
      )}
    </div>
  )
}

function FileView({ path, onClose }: { path: string; onClose: () => void }): ReactNode {
  const stat = useRpc<{ size: number }>('fs.stat', { path })
  const tooBig = (stat.data?.size ?? 0) > MAX_VIEW_BYTES
  const content = useRpc<{ content: string }>('fs.read', { path }, { enabled: stat.data != null && !tooBig })
  const name = path.split('/').pop() ?? path
  return (
    <Screen title={name} subtitle={path} onBack={onClose}>
      {stat.error || content.error ? (
        <div className="p-4">
          <ErrorNote error={stat.error ?? content.error} />
          <p className="mt-3 text-[14px] text-ink-400">Binary files cannot be shown here.</p>
        </div>
      ) : tooBig ? (
        <Empty title="Too large to open" body={`This file is ${sizeLabel(stat.data?.size)}. The phone viewer stops at ${sizeLabel(MAX_VIEW_BYTES)}.`} />
      ) : content.data ? (
        <Suspense fallback={<Spinner className="mx-auto mt-10 size-6" />}>
          <CodeViewer name={name} text={content.data.content} />
        </Suspense>
      ) : (
        <Spinner className="mx-auto mt-10 size-6" />
      )}
    </Screen>
  )
}

interface Hit {
  path: string
  line: number
  text: string
}

function Search({ dir, onClose, onOpen }: { dir: string; onClose: () => void; onOpen: (path: string) => void }): ReactNode {
  const conn = useConnection()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await conn.rpc<Hit[] | { results: Hit[] }>('search.files', { path: dir, query: q.trim(), maxResults: 60 })
      setHits(Array.isArray(res) ? res : res.results ?? [])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title="Search" subtitle={dir} onBack={onClose}>
      <div className="scroll h-full space-y-3 px-4 py-4">
        <TextField value={q} onChange={setQ} placeholder="Text to find" mono />
        {/* search.files resolves against the gateway process cwd, not its configured
            one, so a relative start folder would search the wrong place. */}
        {dir === '.' && <p className="text-[14px] text-ink-400">Open a folder first. Search runs inside the folder you are in.</p>}
        <Button variant="primary" className="w-full" disabled={!q.trim() || busy || dir === '.'} onClick={() => void run()}>
          {busy ? 'Searching…' : 'Search'}
        </Button>
        <ErrorNote error={error} />
        {hits?.length === 0 && <p className="text-[14px] text-ink-400">No matches.</p>}
        {(hits ?? []).map((h, i) => (
          <Row key={i} onClick={() => onOpen(h.path)} title={`${h.path.split('/').pop()}:${h.line}`} subtitle={h.text} meta={<span className="truncate">{h.path}</span>} />
        ))}
      </div>
    </Screen>
  )
}
