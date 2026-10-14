import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { EditorState, type Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, lineNumbers } from '@codemirror/view'
import { useEffect, useRef, type ReactNode } from 'react'

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
 * Read-only code view. This module is the only importer of CodeMirror and is
 * loaded with React.lazy, so the editor stays out of the first-load bundle.
 */
export default function CodeViewer({ name, text }: { name: string; text: string }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          oneDark,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.theme({ '&': { fontSize: '14px', height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
          ...languageFor(name),
        ],
      }),
    })
    return () => view.destroy()
  }, [name, text])
  return <div ref={host} className="h-full" />
}
