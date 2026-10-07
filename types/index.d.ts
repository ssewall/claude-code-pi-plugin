export type PiSandbox = 'read-only' | 'workspace-write' | 'full-access'
export type PiStatus = 'starting' | 'running' | 'idle' | 'interrupted' | 'failed'

/** One pi job: a `pi --mode rpc` process run under a native `pi:<name>` subagent, keyed by that subagent's agentId. */
export type PiAgent = {
  /** The native subagent's agentId, which SendMessage and TaskStop take; also the bridge's job id. */
  id: string
  name: string
  /** The short task label the transcript shows (the spawn's description, else its prompt's first line). */
  description: string
  /** The agent type's short name: grok or run. */
  kind: string
  /** provider/id, as pi --list-models names it. */
  model: string
  effort: string
  sandbox: PiSandbox
  cwd: string
  /** pi's session file, once the bridge read it; a relaunch resumes it with --session. */
  sessionFile: string | null
  status: PiStatus
  /** The running turn (a bridge run id), null when none runs. */
  currentTurnId: string | null
  /** The last turn that ended, null before the first ends. */
  lastTurnId: string | null
  /** completed | interrupted | failed, as the bridge reported the last turn. */
  lastTurnStatus: string | null
  /** The final answer of the last turn (or the latest assistant text). */
  lastMessage: string
  /** One line of what it is doing now. */
  activity: string
  tokens: number
  error: string | null
  /** Compact lines of the current or last turn: tool calls, messages, steers. */
  digest: string[]
  startedAt: number
  updatedAt: number
  turnStartedAt: number
  turnEndedAt: number
  sessionId: string
}

declare module 'claude-code' {
  interface PluginState {
    pi: {
      agents: Record<string, PiAgent>
      /** Survives reloads: names this session's bridge daemon. */
      bridgeKey: string | null
    }
  }
}
