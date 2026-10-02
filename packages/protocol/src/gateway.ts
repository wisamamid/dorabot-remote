/**
 * Types for the dorabot gateway wire protocol (v0.3.2).
 *
 * These were derived from the `case` arms in dorabot's src/gateway/server.ts and
 * desktop/src/hooks/useGateway.ts, not from its exported `RpcMethod` and
 * `GatewayEventName` unions, both of which are significantly out of date.
 *
 * dorabot is MIT licensed. See NOTICE in the repository root.
 */

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface GatewayRequest {
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

export interface GatewayResponse {
  id?: number | string
  result?: unknown
  error?: string
}

export interface GatewayEvent {
  event: string
  data: unknown
  /** Present only on replayed events. Live broadcasts have no seq. */
  seq?: number
}

// ---------------------------------------------------------------------------
// Sessions
//
// There are two different shapes both called SessionInfo upstream. They share a
// name and no required fields, which is the single easiest thing to get wrong
// when integrating. They are named apart here.
// ---------------------------------------------------------------------------

/** What `status.update`'s `sessions` array carries (the live registry). */
export interface RegistrySession {
  /** `${channel}:${chatType}:${chatId}` */
  key: string
  channel: string
  chatId: string
  chatType: string
  /** Persistence id. Used by chat.history, sessions.get/resume/fork/rename. */
  sessionId: string
  /** Claude Agent SDK conversation UUID. */
  sdkSessionId?: string
  messageCount: number
  lastMessageAt: number
  activeRun: boolean
}

/** What `sessions.list` and `session.update` return (the on-disk history). */
export interface StoredSession {
  id: string
  messageCount: number
  createdAt: string
  updatedAt: string
  channel?: string
  chatId?: string
  chatType?: string
  senderName?: string
  preview?: string
  name?: string
  activeRun?: boolean
  model?: string
}

/** Build the sessionKey for a stored session, so the two id spaces can be bridged. */
export function sessionKeyFor(s: Pick<StoredSession, 'channel' | 'chatType' | 'chatId'>): string | null {
  if (!s.channel || !s.chatType || !s.chatId) return null
  return `${s.channel}:${s.chatType}:${s.chatId}`
}

export type AgentStatus = 'idle' | 'thinking' | 'tool_use' | 'responding'

export interface TaskProgress {
  taskId: string
  toolUseId: string
  agentType?: string
  description?: string
  toolCount: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  summary?: string
  status: 'running' | 'completed' | 'failed'
  updatedAt: number
}

export interface PendingApproval {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  tier?: string
  sessionKey?: string
  timestamp: number
  title?: string
  decisionReason?: string
  blockedPath?: string
  agentId?: string
  toolUseId?: string
  sdkRequestId?: string
  matchedAskRule?: { source?: string; toolName?: string; ruleContent?: string }
}

export interface AskUserQuestion {
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

export interface PendingQuestion {
  requestId: string
  sessionKey?: string
  questions: AskUserQuestion[]
  timestamp: number
}

export type QuestionStatus = 'pending' | 'answered' | 'timeout' | 'cancelled'

export interface ElicitationField {
  name: string
  type: 'text' | 'select' | 'boolean' | 'number'
  label: string
  description?: string
  required?: boolean
  options?: { value: string; label: string }[]
  default_value?: unknown
}

export interface PendingElicitation {
  elicitationId: string
  sessionKey: string
  message: string
  fields: ElicitationField[]
  timestamp: number
}

export interface SessionSnapshot {
  sessionKey: string
  status: AgentStatus
  text: string
  currentTool: { name: string; inputJson: string; detail?: string } | null
  completedTools: { name: string; detail: string }[]
  pendingApproval: PendingApproval | null
  pendingQuestion: { requestId: string; questions: AskUserQuestion[]; timestamp: number } | null
  pendingQuestionStatus?: QuestionStatus | null
  pendingQuestionUpdatedAt?: number | null
  taskProgress?: Record<string, TaskProgress>
  activeWorktrees?: { path: string; branch: string }[]
  backgroundTasks?: { taskId: string; taskType: string; description: string }[]
  capabilities?: string[]
  pendingElicitation?: PendingElicitation | null
  updatedAt: number
}

export interface ChannelStatusInfo {
  channel: string
  running?: boolean
  connected?: boolean
  [k: string]: unknown
}

export interface StatusUpdate {
  running?: boolean
  startedAt?: number
  activeRun?: boolean
  source?: string
  sessionKey?: string
  model?: string
  channels?: ChannelStatusInfo[]
  sessions?: RegistrySession[]
}

// ---------------------------------------------------------------------------
// Chat items (the rendered conversation)
// ---------------------------------------------------------------------------

export interface ImageAttachment {
  data: string
  mediaType: string
}

export type ChatItem =
  | { type: 'user'; content: string; images?: ImageAttachment[]; timestamp: number }
  | { type: 'text'; content: string; streaming?: boolean; timestamp: number }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: string
      output?: string
      imageData?: string
      is_error?: boolean
      streaming?: boolean
      subItems?: ChatItem[]
      timestamp: number
    }
  | { type: 'thinking'; content: string; streaming?: boolean; timestamp: number }
  | { type: 'result'; cost?: number; timestamp: number }
  | { type: 'error'; content: string; timestamp: number }
  | { type: 'compacting'; timestamp: number }

/** A row out of chat.history / sessions.get. */
export interface SessionMessage {
  type: 'user' | 'assistant' | 'system' | 'result'
  uuid?: string
  timestamp: string
  content: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Event payloads worth naming
// ---------------------------------------------------------------------------

export interface ShellDataEvent {
  shellId: string
  type: 'data' | 'exit'
  /** Present when type is 'data'. Raw pty bytes as a string, not base64. */
  data?: string
  /** Present when type is 'exit'. */
  code?: number
}

export interface ToolApprovalResolved {
  requestId: string
  approved: boolean
  timestamp: number
}

/**
 * Gateway close codes. 4101 is the only custom one and is used for BOTH
 * heartbeat timeout and backpressure, distinguished by the reason string.
 * Auth failures close with no code at all (peer sees 1005), so the preceding
 * `{error:'invalid token'}` frame is the only signal.
 */
export const GATEWAY_CLOSE_ABNORMAL = 4101

export const GATEWAY_LIMITS = {
  /** Client must send something within this window or be dropped. */
  heartbeatTimeoutMs: 30_000,
  /** What the desktop client uses. Comfortably inside the timeout. */
  pingIntervalMs: 10_000,
  pingTimeoutMs: 5_000,
  /** First frame must be `auth` within this window. */
  authTimeoutMs: 5_000,
  /** bufferedAmount at which the gateway closes a slow client. */
  backpressureBytes: 2 * 1024 * 1024,
  replayDefaultLimit: 2000,
  replayMaxLimit: 10_000,
} as const
