import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { EditorState, type Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, lineNumbers } from '@codemirror/view'
import { useEffect, useRef, useState, type ReactNode } from 'react'

function languageFor(name: string): Extension[] {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return [javascript({ typescript: ext.startsWith('t'), jsx: ext.endsWith('x') })]
  if (ext === 'json') return [json()]
  if (ext === 'md') return [markdown()]
  if (ext === 'py') return [python()]
  if (ext === 'css') return [css()]
  if (ext === 'html') return [html()]
  return []
}

/**
 * Unified diff viewer with syntax highlighting and toggle for side-by-side view.
 * Diff format: lines starting with + (added), - (removed), or neither (context).
 */
export default function DiffViewer({ filename, diffText }: { filename: string; diffText: string }): ReactNode {
  const [sideBySide, setSideBySide] = useState(false)
  const hostLeft = useRef<HTMLDivElement>(null)
  const hostRight = useRef<HTMLDivElement>(null)

  const lines = diffText.split('\n')
  const oldLines: string[] = []
  const newLines: string[] = []

  // Parse diff: separate old (removed) and new (added) content
  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1))
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1))
    } else {
      oldLines.push(line)
      newLines.push(line)
    }
  }

  const oldText = oldLines.join('\n')
  const newText = newLines.join('\n')

  // Setup CodeMirror views for old and new content
  useEffect(() => {
    if (sideBySide) {
      if (!hostLeft.current || !hostRight.current) return

      const extensions = [
        lineNumbers(),
        oneDark,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.theme({ '&': { fontSize: '12px', height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
        ...languageFor(filename),
      ]

      const leftView = new EditorView({
        parent: hostLeft.current,
        state: EditorState.create({
          doc: oldText,
          extensions,
        }),
      })

      const rightView = new EditorView({
        parent: hostRight.current,
        state: EditorState.create({
          doc: newText,
          extensions,
        }),
      })

      return () => {
        leftView.destroy()
        rightView.destroy()
      }
    }
  }, [sideBySide, oldText, newText, filename])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 flex items-center justify-between border-b border-ink-700 px-3 py-2">
        <div className="text-[13px] font-medium text-ink-300">{filename}</div>
        <button
          onClick={() => setSideBySide(!sideBySide)}
          className="rounded px-2 py-1 text-[12px] text-ink-400 hover:bg-ink-700 hover:text-ink-200 active:bg-ink-600"
        >
          {sideBySide ? 'Unified' : 'Side-by-side'}
        </button>
      </div>

      {sideBySide ? (
        <div className="min-h-0 flex-1 flex">
          <div className="min-h-0 flex-1 border-r border-ink-700">
            <div ref={hostLeft} className="h-full" />
          </div>
          <div className="min-h-0 flex-1">
            <div ref={hostRight} className="h-full" />
          </div>
        </div>
      ) : (
        <pre className="scroll selectable h-full overflow-auto px-3 py-3 font-mono text-[12px] leading-[1.5] flex-1">
          {lines.map((l, i) => (
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
    </div>
  )
}
