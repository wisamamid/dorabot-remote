import { memo, type ReactNode } from 'react'

/**
 * A small Markdown renderer for assistant replies.
 *
 * dorabot's desktop uses react-markdown plus a plugin stack. That is a lot of
 * bytes for a phone on cellular, and most of it renders things the agent never
 * emits. This covers what actually shows up in a reply, nothing more: fenced
 * code, headings, lists, blockquotes, horizontal rules, and inline bold, italic,
 * code, strikethrough and links.
 *
 * It is a plain string walk, not a real parser, so pathological input degrades
 * into plain text rather than breaking. That is the right failure mode here.
 */

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  const flushParagraph = (buf: string[]): void => {
    if (buf.length) blocks.push({ kind: 'p', text: buf.join('\n').trim() })
    buf.length = 0
  }

  const paragraph: string[] = []

  while (i < lines.length) {
    const line = lines[i]!

    const fence = /^\s*```(\S*)\s*$/.exec(line)
    if (fence) {
      flushParagraph(paragraph)
      const lang = fence[1] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!)
        i++
      }
      i++
      blocks.push({ kind: 'code', lang, text: body.join('\n') })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph(paragraph)
      blocks.push({ kind: 'h', level: heading[1]!.length, text: heading[2]! })
      i++
      continue
    }

    if (/^\s*(?:-\s*-\s*-[-\s]*|\*\s*\*\s*\*[*\s]*|_\s*_\s*_[_\s]*)$/.test(line)) {
      flushParagraph(paragraph)
      blocks.push({ kind: 'hr' })
      i++
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph(paragraph)
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      blocks.push({ kind: 'ul', items })
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph(paragraph)
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      blocks.push({ kind: 'ol', items })
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph)
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      flushParagraph(paragraph)
      i++
      continue
    }

    paragraph.push(line)
    i++
  }
  flushParagraph(paragraph)
  return blocks
}

/** Inline spans. Code is matched first so markers inside it stay literal. */
function inline(text: string, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = []
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|((?:https?:\/\/)[^\s<>()]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let n = 0

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]
    const key = `${keyPrefix}i${n++}`

    if (token.startsWith('`')) {
      out.push(
        <code key={key} className="selectable rounded bg-ink-800 px-1 py-px font-mono text-[13px] text-ink-100">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(
        <strong key={key} className="font-semibold text-ink-100">
          {token.slice(2, -2)}
        </strong>,
      )
    } else if (token.startsWith('~~')) {
      out.push(
        <span key={key} className="line-through opacity-60">
          {token.slice(2, -2)}
        </span>,
      )
    } else if (token.startsWith('*')) {
      out.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      )
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      out.push(
        <a
          key={key}
          href={link?.[2] ?? '#'}
          target="_blank"
          rel="noreferrer noopener"
          className="text-mint-500 underline underline-offset-2"
        >
          {link?.[1] ?? token}
        </a>,
      )
    } else {
      out.push(
        <a
          key={key}
          href={token}
          target="_blank"
          rel="noreferrer noopener"
          className="break-all text-mint-500 underline underline-offset-2"
        >
          {token}
        </a>,
      )
    }
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export const Markdown = memo(function Markdown({ source }: { source: string }): ReactNode {
  const blocks = parse(source)
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'code':
            return (
              <pre
                key={i}
                className="selectable scroll no-scrollbar max-h-80 overflow-x-auto rounded-xl bg-ink-950 p-3 font-mono text-[12.5px] leading-relaxed text-ink-200"
              >
                {b.text}
              </pre>
            )
          case 'h':
            return (
              <div
                key={i}
                className={
                  b.level <= 2
                    ? 'pt-1 text-[17px] font-semibold tracking-[-0.01em]'
                    : 'pt-0.5 text-[15px] font-semibold'
                }
              >
                {inline(b.text, `h${i}`)}
              </div>
            )
          case 'ul':
            return (
              <ul key={i} className="space-y-1 pl-1">
                {b.items.map((item, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="mt-[0.6em] size-1 shrink-0 rounded-full bg-ink-400" />
                    <span className="min-w-0 flex-1">{inline(item, `u${i}-${j}`)}</span>
                  </li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={i} className="space-y-1 pl-1">
                {b.items.map((item, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="shrink-0 font-mono text-[13px] text-ink-400">{j + 1}.</span>
                    <span className="min-w-0 flex-1">{inline(item, `o${i}-${j}`)}</span>
                  </li>
                ))}
              </ol>
            )
          case 'quote':
            return (
              <blockquote key={i} className="border-l-2 border-ink-600 pl-3 text-ink-300">
                {inline(b.text, `q${i}`)}
              </blockquote>
            )
          case 'hr':
            return <hr key={i} className="border-ink-700" />
          default:
            return (
              <p key={i} className="whitespace-pre-wrap break-words">
                {inline(b.text, `p${i}`)}
              </p>
            )
        }
      })}
    </div>
  )
})
