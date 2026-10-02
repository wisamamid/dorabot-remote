/**
 * Turning the gateway's event stream into a renderable conversation.
 *
 * This is the hardest part of talking to dorabot and the part most worth getting
 * exactly right, so the logic here deliberately mirrors dorabot's own desktop
 * renderer (desktop/src/hooks/useGateway.ts, MIT). Three behaviours look like
 * bugs but are not, and are preserved on purpose:
 *
 *  1. A `text_delta` with no streaming text block falls back to the LAST text
 *     block. The SDK can emit deltas after `agent.result` has already landed.
 *  2. `content_block_stop` does NOT clear `streaming` on a tool_use item. For a
 *     tool, that event means "the input JSON is complete", not "the tool
 *     finished". Only `agent.tool_result` ends it. Clear it early and tool
 *     spinners never stop.
 *  3. Subagent output is nested under its parent Task tool via activeTaskIds,
 *     and orphaned scopes (an interrupted subagent that never produced a
 *     tool_result) are force-closed so later messages are not swallowed.
 *
 * Everything here is pure and has no React, DOM or Node dependency, so the same
 * code runs in the bridge, in tests and in the phone app.
 */
import type { ChatItem, ImageAttachment, SessionMessage } from './gateway.js'

/** Strip the `mcp__<server>__` prefix the SDK puts on MCP tool names. */
export function cleanToolName(name: string): string {
  if (!name || !name.startsWith('mcp__')) return name || 'unknown'
  const idx = name.indexOf('__', 5)
  return idx >= 0 ? name.slice(idx + 2) : name
}

/**
 * Best-effort parse of tool input that is still streaming in as
 * `input_json_delta` fragments. Returns null when nothing sensible can be made
 * of it yet, which the UI renders as "still arriving" rather than as an error.
 */
export function parsePartialJson(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // Close whatever is still open, in reverse order, and try once more.
  }
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of trimmed) {
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  let repaired = trimmed
  if (escaped) repaired = repaired.slice(0, -1)
  if (inString) repaired += '"'
  // A dangling key or comma cannot be closed meaningfully; drop it.
  repaired = repaired.replace(/,\s*$/, '').replace(/:\s*$/, ': null')
  for (let i = stack.length - 1; i >= 0; i--) repaired += stack[i]
  try {
    return JSON.parse(repaired)
  } catch {
    return null
  }
}

/**
 * Apply one raw Anthropic streaming event to a ChatItem list.
 * Works on a top-level list or on a subagent's nested list.
 */
export function applyStreamEvent(items: ChatItem[], evt: Record<string, unknown>): ChatItem[] {
  if (evt.type === 'content_block_start') {
    const cb = evt.content_block as Record<string, unknown> | undefined
    if (!cb) return items
    if (cb.type === 'text') {
      return [...items, { type: 'text', content: '', streaming: true, timestamp: Date.now() }]
    }
    if (cb.type === 'tool_use') {
      return [
        ...items,
        {
          type: 'tool_use',
          id: (cb.id as string) || '',
          name: cleanToolName((cb.name as string) || 'unknown'),
          input: '',
          streaming: true,
          timestamp: Date.now(),
        },
      ]
    }
    if (cb.type === 'thinking') {
      return [...items, { type: 'thinking', content: '', streaming: true, timestamp: Date.now() }]
    }
    return items
  }

  if (evt.type === 'content_block_delta') {
    const delta = evt.delta as Record<string, unknown> | undefined
    if (!delta) return items

    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      let target = -1
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!
        if (it.type === 'text' && it.streaming) {
          target = i
          break
        }
      }
      if (target < 0) {
        // Late delta after the turn closed: append to the last text block.
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i]!.type === 'text') {
            target = i
            break
          }
        }
      }
      if (target >= 0) {
        const it = items[target]!
        if (it.type === 'text') {
          const u = [...items]
          u[target] = { ...it, content: it.content + delta.text }
          return u
        }
      }
      return items
    }

    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!
        if (it.type === 'tool_use' && it.streaming) {
          const u = [...items]
          u[i] = { ...it, input: it.input + delta.partial_json }
          return u
        }
      }
      return items
    }

    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!
        if (it.type === 'thinking' && it.streaming) {
          const u = [...items]
          u[i] = { ...it, content: it.content + delta.thinking }
          return u
        }
      }
      return items
    }

    return items
  }

  if (evt.type === 'content_block_stop') {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if ('streaming' in it && it.streaming) {
        // See note 2 at the top of this file.
        if (it.type === 'tool_use') return items
        const u = [...items]
        u[i] = { ...it, streaming: false }
        return u
      }
    }
  }

  return items
}

/** Append streamed stdout onto the matching tool_use item. */
export function appendToolOutputDelta(
  items: ChatItem[],
  toolUseId: string,
  delta: string,
): { items: ChatItem[]; applied: boolean } {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.type === 'tool_use' && it.id === toolUseId) {
      const u = [...items]
      u[i] = { ...it, output: `${it.output || ''}${delta}`, streaming: true }
      return { items: u, applied: true }
    }
  }
  return { items, applied: false }
}

/** Attach a finished tool result, ending that tool's streaming state. */
export function applyToolResult(
  items: ChatItem[],
  result: { toolUseId: string; content: string; imageData?: string; isError?: boolean },
): { items: ChatItem[]; applied: boolean } {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.type === 'tool_use' && it.id === result.toolUseId) {
      const u = [...items]
      u[i] = {
        ...it,
        output: result.content,
        imageData: result.imageData ?? it.imageData,
        is_error: result.isError ?? false,
        streaming: false,
      }
      return { items: u, applied: true }
    }
    if (it.type === 'tool_use' && it.subItems) {
      const nested = applyToolResult(it.subItems, result)
      if (nested.applied) {
        const u = [...items]
        u[i] = { ...it, subItems: nested.items }
        return { items: u, applied: true }
      }
    }
  }
  return { items, applied: false }
}

/** Mark every still-streaming item as finished. Used when a turn ends. */
export function finalizeStreaming(items: ChatItem[]): ChatItem[] {
  let changed = false
  const out = items.map((it) => {
    if ('streaming' in it && it.streaming) {
      changed = true
      return { ...it, streaming: false }
    }
    return it
  })
  return changed ? out : items
}

function extractResultText(block: Record<string, unknown>): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => (b as { type?: string })?.type === 'text')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

/**
 * Rebuild a conversation from persisted messages (chat.history / sessions.get).
 *
 * This is the cold-start path: the bridge's durable event log only goes back so
 * far, so a session opened fresh on the phone is reconstructed from here and then
 * live events are applied on top.
 */
export function sessionMessagesToChatItems(messages: SessionMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  // A Task tool_use opens a scope; everything until its matching tool_result is
  // subagent output and gets nested rather than shown at the top level.
  const activeTaskIds = new Set<string>()
  const taskSubItems = new Map<string, ChatItem[]>()

  const closeOrphanScopes = (): void => {
    for (const orphanId of activeTaskIds) {
      const subs = taskSubItems.get(orphanId) || []
      taskSubItems.delete(orphanId)
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!
        if (it.type === 'tool_use' && it.id === orphanId) {
          items[i] = {
            ...it,
            output: '(interrupted)',
            is_error: false,
            subItems: subs.length > 0 ? subs : undefined,
          }
          break
        }
      }
    }
    activeTaskIds.clear()
  }

  for (const msg of messages) {
    const c = msg.content as Record<string, unknown>
    const ts = new Date(msg.timestamp).getTime()

    if (msg.type === 'system') continue

    if (msg.type === 'user') {
      const userMsg = c.message as Record<string, unknown> | undefined
      const parentToolUseId = c.parent_tool_use_id as string | undefined
      const blocks = userMsg?.content
      const blockList = Array.isArray(blocks) ? (blocks as Record<string, unknown>[]) : null
      const hasToolResult = blockList?.some((b) => b.type === 'tool_result') ?? false

      if (hasToolResult && blockList) {
        for (const block of blockList) {
          if (block.type !== 'tool_result') continue
          const resultText = extractResultText(block)
          const toolUseId = block.tool_use_id as string

          // The Task tool itself finishing: fold the collected subagent output in.
          if (activeTaskIds.has(toolUseId)) {
            activeTaskIds.delete(toolUseId)
            const subs = taskSubItems.get(toolUseId) || []
            taskSubItems.delete(toolUseId)
            const trimmed = resultText.slice(0, 2000)
            for (let i = items.length - 1; i >= 0; i--) {
              const it = items[i]!
              if (it.type === 'tool_use' && it.id === toolUseId) {
                items[i] = {
                  ...it,
                  output: trimmed,
                  is_error: Boolean(block.is_error),
                  subItems:
                    subs.length > 0
                      ? subs
                      : trimmed
                        ? [{ type: 'text' as const, content: trimmed, timestamp: it.timestamp }]
                        : undefined,
                }
                break
              }
            }
            continue
          }

          // A tool inside a subagent: patch the nested list.
          if (parentToolUseId && activeTaskIds.has(parentToolUseId)) {
            const subs = taskSubItems.get(parentToolUseId)
            if (subs) {
              for (let i = subs.length - 1; i >= 0; i--) {
                const si = subs[i]!
                if (si.type === 'tool_use' && si.id === toolUseId) {
                  subs[i] = { ...si, output: resultText.slice(0, 1000), is_error: Boolean(block.is_error) }
                  break
                }
              }
            }
            continue
          }

          // An ordinary tool result.
          for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i]!
            if (it.type === 'tool_use' && it.id === toolUseId) {
              items[i] = { ...it, output: resultText.slice(0, 2000), is_error: Boolean(block.is_error) }
              break
            }
          }
        }
        continue
      }

      if (activeTaskIds.size > 0) {
        if (parentToolUseId) {
          // A subagent prompt. Not top-level content.
          continue
        }
        // A real user message while a scope is open means the subagent never
        // finished. Close it so this message is not swallowed.
        closeOrphanScopes()
      }

      let text = ''
      let images: ImageAttachment[] | undefined
      if (typeof blocks === 'string') {
        text = blocks
      } else if (blockList) {
        text = blockList
          .filter((b) => b.type === 'text')
          .map((b) => b.text as string)
          .join('\n')
        const imgBlocks = blockList.filter(
          (b) => b.type === 'image' && (b.source as { type?: string } | undefined)?.type === 'base64',
        )
        if (imgBlocks.length) {
          images = imgBlocks.map((b) => {
            const src = b.source as { data: string; media_type: string }
            return { data: src.data, mediaType: src.media_type }
          })
        }
      }
      if (text || images?.length) {
        items.push({ type: 'user', content: text, images, timestamp: ts })
      }
      continue
    }

    if (msg.type === 'assistant') {
      const assistantMsg = c.message as Record<string, unknown> | undefined
      const blocks = assistantMsg?.content
      const blockList = Array.isArray(blocks) ? (blocks as Record<string, unknown>[]) : null
      const isSubagentAssistant = Boolean(c.parent_tool_use_id)

      if (activeTaskIds.size > 0 && isSubagentAssistant) {
        const taskId = [...activeTaskIds].at(-1)!
        const subs = taskSubItems.get(taskId) || []
        if (blockList) {
          for (const block of blockList) {
            if (block.type === 'text' && block.text) {
              subs.push({ type: 'text', content: block.text as string, timestamp: ts })
            } else if (block.type === 'tool_use') {
              subs.push({
                type: 'tool_use',
                id: (block.id as string) || '',
                name: cleanToolName((block.name as string) || 'unknown'),
                input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
                timestamp: ts,
              })
            }
          }
        }
        taskSubItems.set(taskId, subs)
        continue
      }

      if (activeTaskIds.size > 0 && !isSubagentAssistant) {
        closeOrphanScopes()
      }

      if (blockList) {
        for (const block of blockList) {
          if (block.type === 'text' && block.text) {
            items.push({ type: 'text', content: block.text as string, timestamp: ts })
          } else if (block.type === 'tool_use') {
            const name = cleanToolName((block.name as string) || 'unknown')
            items.push({
              type: 'tool_use',
              id: (block.id as string) || '',
              name,
              input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
              timestamp: ts,
            })
            if (name === 'Task' || name === 'Agent') {
              activeTaskIds.add(block.id as string)
              taskSubItems.set(block.id as string, [])
            }
          } else if (block.type === 'thinking' && block.thinking) {
            items.push({ type: 'thinking', content: block.thinking as string, timestamp: ts })
          }
        }
      }
      continue
    }

    if (msg.type === 'result') {
      items.push({ type: 'result', cost: c.total_cost_usd as number | undefined, timestamp: ts })
    }
  }

  return items
}

/** Short label for what a tool is doing, for the status line. */
export const TOOL_PENDING_TEXT: Record<string, string> = {
  Read: 'reading file',
  Write: 'writing file',
  Edit: 'editing file',
  Glob: 'searching files',
  Grep: 'searching code',
  Bash: 'running command',
  WebFetch: 'fetching url',
  WebSearch: 'searching web',
  Task: 'running task',
  Agent: 'running agent',
  AskUserQuestion: 'asking question',
  TodoWrite: 'updating tasks',
  NotebookEdit: 'editing notebook',
  message: 'sending message',
  screenshot: 'taking screenshot',
  browser: 'using browser',
  imageView: 'viewing image',
  imageGeneration: 'generating image',
  schedule: 'scheduling',
  list_schedule: 'listing schedule',
  update_schedule: 'updating schedule',
  cancel_schedule: 'cancelling schedule',
  projects_view: 'viewing projects',
  projects_add: 'adding project',
  projects_update: 'updating project',
  projects_delete: 'deleting project',
  tasks_view: 'viewing tasks',
  tasks_add: 'adding task',
  tasks_update: 'updating task',
  tasks_done: 'completing task',
  tasks_delete: 'deleting task',
  research_view: 'viewing research',
  research_add: 'adding research',
  research_update: 'updating research',
}

export function toolStatusText(toolName: string | undefined): string {
  if (!toolName) return 'working'
  const clean = cleanToolName(toolName)
  return TOOL_PENDING_TEXT[clean] ?? `running ${clean}`
}
