// Pure logic of the pi plugin: no `$` here (the engine follows `$` only
// within one file, so every engine call lives in register.tsx). Header lines,
// defaults, how pi events change a job, and the texts the model and the person
// read.

import type { EngineInterface, ToolSpec } from 'claude-code'

import type { PiAgent, PiSandbox } from '../types'

export type Settings = {
  piPath: string
  nodePath: string
  /** Undefined (userConfig per-model): each agent's built-in effort (KIND_EFFORTS). */
  defaultEffort: string | undefined
  defaultSandbox: PiSandbox
}

/** What one turn came to, as the bridge reports it. */
export type Turn = { id: string; status: string; text: string; error: string | null }

export type BridgeEvent =
  | { type: 'ready'; socket: string; reattached: boolean; active: Record<string, string>; platform?: string; sandboxUnavailable?: string | null }
  | { type: 'event'; jobId: string; turnId: string | null; event: PiEvent }
  | { type: 'turn_end'; jobId: string; turn: Turn }
  | { type: 'exit'; jobId: string; code: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'fatal'; message: string; logTail: string }

/** A failure to show the model as the tool's error. */
export class PiError extends Error {}

export const PREFIX = 'mcp__pi__'
export const SANDBOXES: PiSandbox[] = ['read-only', 'workspace-write', 'full-access']
/** pi's --thinking levels. */
export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const MAX_AGENTS = 40

/** The agent types: grok runs one fixed model, run takes its model from the prompt (or the project). */
export const KIND_MODELS: Record<string, string | null> = { grok: 'xai/grok-4.7', run: null }
export const KINDS = Object.keys(KIND_MODELS)
/** Each agent's built-in effort, used when neither userConfig nor the project sets one. */
export const KIND_EFFORTS: Record<string, string> = { grok: 'high', run: 'high' }
/** The defaultEffort userConfig value (its default) that leaves effort to KIND_EFFORTS. */
export const PER_MODEL_EFFORT = 'per-model'

/** The pi thinking level an effort names: `ultra` is kept as an alias of `max`. */
export function normalizeEffort(effort: string): string {
  const level = effort.trim().toLowerCase()
  const mapped = level === 'ultra' ? 'max' : level
  if (!(EFFORTS as readonly string[]).includes(mapped)) throw new PiError(`effort must be one of ${EFFORTS.join(', ')} (ultra means max)`)
  return mapped
}

/** The short model name the hint line shows: `xai/grok-4.7` -> `grok-4.7`. */
export const shortModel = (model: string): string => model.slice(model.lastIndexOf('/') + 1)

// ------------------------------------------------------------ text helpers

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`

export const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

export const elapsed = (from: number, to: number): string => {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`
}

export const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tok` : `${tokens} tok`

export const isLive = (agent: PiAgent): boolean => agent.status === 'running' || agent.status === 'starting'

export const timeOf = (agent: PiAgent, now: number): string =>
  isLive(agent) ? elapsed(agent.turnStartedAt, now) : agent.turnEndedAt ? elapsed(agent.turnStartedAt, agent.turnEndedAt) : ''

/** Splits a stream of text pieces into whole lines. */
export class LineBuffer {
  private pending = ''

  push(text: string): string[] {
    this.pending += text
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    return lines.filter(line => line.trim() !== '')
  }

  rest(): string[] {
    const rest = this.pending.trim()
    this.pending = ''
    return rest === '' ? [] : [rest]
  }
}

// ------------------------------------------------------------ registry

const MAX_DIGEST = 60
const MAX_MESSAGE = 20_000

export const sanitize = (agent: PiAgent): PiAgent => ({
  ...agent,
  lastMessage: clip(agent.lastMessage, MAX_MESSAGE),
  digest: agent.digest.slice(-MAX_DIGEST),
})

/** Keeps the live agents and the most recently updated, up to MAX_AGENTS. */
export const trim = (agents: Record<string, PiAgent>): Record<string, PiAgent> => {
  const list = Object.values(agents)
  if (list.length <= MAX_AGENTS) return agents
  const keep = list
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_AGENTS)
  return Object.fromEntries(keep.map(agent => [agent.id, agent]))
}

export const findIn = (agents: Record<string, PiAgent>, ref: string): PiAgent | undefined =>
  agents[ref] ?? Object.values(agents).find(agent => agent.name === ref)

export const sorted = (agents: Record<string, PiAgent>): PiAgent[] =>
  Object.values(agents).sort((a, b) => b.startedAt - a.startedAt)

export const uniqueName = (agents: Record<string, PiAgent>, wanted: string): string => {
  const taken = new Set(Object.values(agents).map(agent => agent.name))
  if (!taken.has(wanted)) return wanted
  let n = 2
  while (taken.has(`${wanted} (${n})`)) n += 1
  return `${wanted} (${n})`
}

/** What the bridge needs to (re)launch a job's pi. */
export const jobSpec = (agent: PiAgent) => ({
  id: agent.id,
  cwd: agent.cwd,
  model: agent.model,
  effort: agent.effort,
  sandbox: agent.sandbox,
  sessionFile: agent.sessionFile,
})

// ------------------------------------------------------------ pi events

export type PiContent = { type: string; text?: string; name?: string; arguments?: Record<string, unknown> }
export type PiMessage = {
  role: string
  content?: string | PiContent[]
  stopReason?: string
  errorMessage?: string
  usage?: { totalTokens?: number }
}
export type PiEvent = { type: string; [key: string]: unknown }

/** The text of a message's text blocks. */
export function messageText(message: PiMessage | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return (message.content ?? [])
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('')
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** One line naming a tool call: `$ cmd` for bash, `read src/a.ts` for the file tools. */
export function toolLine(toolName: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {}
  if (toolName === 'bash') return `$ ${clip(str(a.command) ?? '?', 160)}`
  const target = str(a.path) ?? str(a.file_path) ?? str(a.pattern) ?? str(a.query) ?? str(a.url)
  return target ? `${toolName} ${clip(target, 160)}` : toolName
}

/**
 * How one relayed pi event changes a job. Pure: the reducer the event stream
 * runs through; the turn's end comes separately, as the bridge's turn_end
 * (afterTurn).
 */
export function applyPiEvent(agent: PiAgent, event: PiEvent): Partial<PiAgent> {
  switch (event.type) {
    case 'agent_start':
    case 'turn_start':
      return { activity: 'thinking' }
    case 'tool_execution_start':
      return { activity: toolLine(String(event.toolName), event.args as Record<string, unknown>) }
    case 'tool_execution_end': {
      const line = toolLine(String(event.toolName), event.args as Record<string, unknown>)
      return { activity: 'thinking', digest: [...agent.digest, `${line} -> ${event.isError === true ? 'error' : 'ok'}`] }
    }
    case 'message_end': {
      const message = event.message as PiMessage | undefined
      if (!message) return {}
      if (message.role === 'user') {
        // A steer delivered mid-turn (the turn's own prompt comes first, with an empty digest).
        const text = messageText(message)
        return agent.digest.length > 0 && text ? { digest: [...agent.digest, `steer: ${clip(firstLine(text), 200)}`] } : {}
      }
      if (message.role !== 'assistant') return {}
      const tokens = agent.tokens + (message.usage?.totalTokens ?? 0)
      const text = messageText(message)
      const change: Partial<PiAgent> = { tokens }
      if (message.stopReason === 'error') change.error = message.errorMessage ?? 'the model call failed'
      if (text) {
        change.lastMessage = text
        change.activity = clip(firstLine(text), 160)
        change.digest = [...agent.digest, `note: ${clip(firstLine(text), 200)}`]
      }
      return change
    }
    case 'auto_retry_start':
      return { activity: `retrying (attempt ${String(event.attempt ?? '?')}): ${clip(firstLine(String(event.errorMessage ?? '')), 120)}` }
    case 'auto_retry_end':
      return event.success === false ? { error: String(event.finalError ?? 'retries failed') } : { activity: 'thinking' }
    case 'compaction_start':
      return { activity: 'compacting context' }
    case 'compaction_end':
      return { activity: 'thinking' }
    default:
      return {}
  }
}

/** The agent after its turn ended, from the bridge's turn_end. */
export function afterTurn(agent: PiAgent, turn: Turn, now: number): Partial<PiAgent> {
  const status = turn.status
  return {
    status: status === 'completed' ? 'idle' : status === 'interrupted' ? 'interrupted' : 'failed',
    currentTurnId: null,
    lastTurnId: turn.id,
    lastTurnStatus: status,
    error: turn.error ?? (status === 'failed' ? 'the turn failed' : null),
    activity: status,
    turnEndedAt: now,
    ...(turn.text ? { lastMessage: turn.text } : {}),
  }
}

// ------------------------------------------------------------ project config

/** `effort` undefined: the agent's own built-in (effortFor); `model` is pi:run's when its prompt names none. */
export type Defaults = { effort: string | undefined; sandbox: PiSandbox; model: string | undefined }

export const PROJECT_CONFIG = '.claude/pi.json'

/** Parses a project's .claude/pi.json: optional defaults {effort, sandbox, model}. */
export function parseProjectConfig(text: string, path: string): Partial<Defaults> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new PiError(`${path} is not valid JSON: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new PiError(`${path} must hold a JSON object`)
  const config = parsed as Record<string, unknown>
  const out: Partial<Defaults> = {}
  if ('approvals' in config) throw new PiError(`${path}: "approvals" is not supported: pi has no approval hooks; the sandbox alone limits it`)
  for (const key of ['effort', 'sandbox', 'model'] as const) {
    const value = config[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value === '') throw new PiError(`${path}: "${key}" must be a non-empty string`)
    if (key === 'sandbox') {
      if (!SANDBOXES.includes(value as PiSandbox)) throw new PiError(`${path}: sandbox must be one of ${SANDBOXES.join(', ')}`)
      out.sandbox = value as PiSandbox
    } else if (key === 'effort') {
      try {
        out.effort = normalizeEffort(value)
      } catch (error) {
        throw new PiError(`${path}: ${(error as Error).message}`)
      }
    } else out.model = value
  }
  return out
}

/** The directories from `cwd` up to `root` (or up to / when cwd is not under root). */
export function configDirs(cwd: string, root: string): string[] {
  const dirs: string[] = []
  let dir = cwd.replace(/\/+$/, '') || '/'
  for (;;) {
    dirs.push(dir)
    if (dir === root || dir === '/') return dirs
    const up = dir.slice(0, dir.lastIndexOf('/')) || '/'
    dir = up
  }
}

/** Precedence: prompt header lines > project config > userConfig > built-ins. */
export const effectiveDefaults = (settings: Settings, project: Partial<Defaults>): Defaults => ({
  effort: project.effort ?? settings.defaultEffort,
  sandbox: project.sandbox ?? settings.defaultSandbox,
  model: project.model,
})

/** The effort a `pi:<kind>` spawn runs with when its prompt sets none. */
export const effortFor = (defaults: Defaults, kind: string): string => defaults.effort ?? (KIND_EFFORTS[kind] as string)

// ------------------------------------------------------------ header lines

const HEADER_KEYS = ['model', 'effort', 'sandbox', 'approvals'] as const
type HeaderKey = (typeof HEADER_KEYS)[number]
export type PromptHeader = Partial<Record<HeaderKey, string>> & { body: string }

const HEADER_LINE = /^[ \t]*(model|effort|sandbox|approvals)[ \t]*:[ \t]*(\S+)[ \t]*$/i

/** Reads the `model:`, `effort:`, `sandbox:` (and refused `approvals:`) lines at the top of a prompt; `body` is the rest, as given. */
export function parseHeader(prompt: string): PromptHeader {
  const lines = prompt.split('\n')
  const header: PromptHeader = { body: prompt }
  let count = 0
  for (const line of lines) {
    const match = HEADER_LINE.exec(line)
    if (!match) break
    const key = (match[1] as string).toLowerCase() as HeaderKey
    if (header[key] !== undefined) throw new PiError(`the prompt's header sets ${key} twice`)
    // Model ids keep their case; the other values are keywords.
    header[key] = key === 'model' ? (match[2] as string) : (match[2] as string).toLowerCase()
    count += 1
  }
  if (count > 0) header.body = lines.slice(count).join('\n').replace(/^(?:[ \t]*\n)+/, '')
  return header
}

export type JobSettings = { model: string; effort: string; sandbox: PiSandbox }

/**
 * The model, effort and sandbox a `pi:<kind>` spawn runs with: header lines >
 * project > userConfig > built-ins. Throws a PiError the Agent call shows.
 */
export function jobSettings(kind: string, header: PromptHeader, defaults: Defaults): JobSettings {
  if (header.approvals !== undefined) {
    throw new PiError('the approvals: header is not supported: pi has no approval hooks, so the sandbox alone limits what it can write')
  }
  const fixed = KIND_MODELS[kind]
  let model: string
  if (fixed) {
    if (header.model !== undefined) throw new PiError(`pi:${kind} always runs ${fixed}; the model: header is for pi:run`)
    model = fixed
  } else {
    const named = header.model ?? defaults.model
    if (!named) {
      throw new PiError(`pi:${kind} needs a model: start the prompt with a line "model: provider/id" (as \`pi --list-models\` names it), or set "model" in ${PROJECT_CONFIG}`)
    }
    if (!/^[^/\s]+\/\S+$/.test(named)) throw new PiError(`model "${named}" must be provider/id, as \`pi --list-models\` names it`)
    model = named
  }
  const effort = normalizeEffort(header.effort ?? effortFor(defaults, kind))
  const sandbox = (header.sandbox ?? defaults.sandbox) as PiSandbox
  if (!SANDBOXES.includes(sandbox)) throw new PiError(`sandbox must be one of ${SANDBOXES.join(', ')}`)
  return { model, effort, sandbox }
}

/** Undefined when pi knows the model; otherwise the error. */
export const unknownModelError = (models: readonly string[], model: string): string | undefined =>
  models.includes(model) ? undefined : `pi does not know model "${model}" (see \`pi --list-models\`).`

/**
 * Undefined when the bridge's host can run the sandbox; otherwise why not.
 * `unavailable` is the bridge's own verdict (sandbox.mjs sandboxUnavailable):
 * macOS uses sandbox-exec, Linux bubblewrap.
 */
export const sandboxPlatformError = (
  platform: string | undefined,
  sandbox: PiSandbox,
  unavailable?: string | null,
): string | undefined => {
  if (sandbox === 'full-access' || platform === undefined) return undefined
  const why = unavailable ?? (platform === 'darwin' || platform === 'linux' ? undefined : `needs macOS sandbox-exec or Linux bubblewrap; ${platform} has neither`)
  return why ? `sandbox ${sandbox} ${why}; only "sandbox: full-access" runs, unconfined` : undefined
}

// ------------------------------------------------------------ native agent types

/**
 * Each kind is a native agent type, `pi:<kind>`. Its subagent is a wrapper:
 * the plugin starts the pi turn with the spawn's own prompt, and answers every
 * model request of the wrapper's loop itself (turn.step), so no Claude model
 * reads or rewrites the task or the result.
 */
export const AGENT_PREFIX = 'pi:'
export const AWAIT_TOOL = `${PREFIX}pi_await`
/** The wrapper's Claude model: named because the definition needs one, and never called. */
export const WRAPPER_MODEL = 'haiku'
/** How a background subagent hands its report back where the engine requires it (auto mode); elsewhere its final text is the report. */
export const HANDBACK_TOOL = 'SubagentHandback'

type AgentSpec = Parameters<EngineInterface['agent']['register']>[0]

/** The kind a `pi:<kind>` agent type names, or undefined for any other type. */
export const kindOfType = (subagentType: string): string | undefined => {
  if (!subagentType.startsWith(AGENT_PREFIX)) return undefined
  const kind = subagentType.slice(AGENT_PREFIX.length)
  return kind in KIND_MODELS ? kind : undefined
}

const EFFORT_CHOICES = 'off|minimal|low|medium|high|xhigh|max (ultra = max)'

/** The listing line the main model reads for `pi:<kind>`; `defaults` are the effective ones at session start. */
export function agentDescription(kind: string, defaults: Defaults): string {
  const effort = effortFor(defaults, kind)
  const intro =
    kind === 'grok'
      ? `xAI Grok through the pi CLI, on xai/grok-4.7, effort ${effort}.`
      : `Any model the pi CLI knows (\`pi --list-models\`), effort ${effort}. Needs a header line "model: provider/id"${defaults.model ? ` (project default ${defaults.model})` : ''}.`
  return [
    intro,
    'pi gets your prompt verbatim, sees nothing of this conversation, and its final message is the result. Always runs in the background.',
    'Optional header lines at the top of the prompt, stripped before pi sees it:',
    ...(kind === 'run' ? ['"model: provider/id";'] : []),
    `"effort: ${EFFORT_CHOICES}";`,
    `"sandbox: read-only|workspace-write|full-access" (macOS sandbox-exec, Linux bubblewrap; workspace-write writes only in the cwd, /tmp and pi's session dir; read-only also limits pi to its read tools; reads and network stay open; default ${defaults.sandbox}).`,
    'No approvals: pi asks nobody; full-access ONLY when the user explicitly asked for it.',
    `Project defaults: ${PROJECT_CONFIG}.`,
    'SendMessage to it steers the running pi turn, or starts a new turn in the same pi session once it finished; TaskStop aborts it.',
  ].join(' ')
}

/** What the wrapper's model would follow if it ever ran (only when the plugin's turn.step hook failed). */
export const WRAPPER_PROMPT = [
  'You relay one pi job that the pi plugin has already started with your task.',
  `Call the ${AWAIT_TOOL} tool with no arguments: it blocks until the pi turn ends. While it says the job is still running, call it again.`,
  `When it returns the result, deliver exactly that text, nothing added, removed or reworded: with ${HANDBACK_TOOL} when you have that tool, else as your reply.`,
  'Never do the task yourself and never call any other tool.',
].join(' ')

export const agentSpecs = (defaults: Defaults): AgentSpec[] =>
  KINDS.map(kind => ({
    name: kind,
    description: agentDescription(kind, defaults),
    prompt: WRAPPER_PROMPT,
    tools: [AWAIT_TOOL, HANDBACK_TOOL],
    model: WRAPPER_MODEL,
    background: true,
    omitClaudeMd: true,
  }))

/** The wrapper's final answer once the pi turn ended: on success the pi final message, verbatim. */
export function wrapperAnswer(agent: PiAgent): string {
  if (agent.status === 'failed') return `pi failed: ${agent.error ?? 'the turn failed'}`
  if (agent.status === 'interrupted') return agent.error ? `pi turn interrupted: ${agent.error}` : 'pi turn interrupted.'
  return agent.lastMessage || '(pi finished without a final message.)'
}

// ------------------------------------------------------------ texts

export function describeAgent(agent: PiAgent, now: number): string {
  const time = timeOf(agent, now)
  const doing = isLive(agent) ? agent.activity : (agent.lastTurnStatus ?? agent.status)
  return `${agent.id} ${agent.name} [${agent.model}/${agent.effort}, ${agent.sandbox}] ${agent.status}${time ? ` ${time}` : ''}, ${formatTokens(agent.tokens)}: ${clip(firstLine(doing), 100)}`
}

/** How many of a session's jobs pi_list shows. */
export const LIST_LIMIT = 10

/** pi_list: the session's jobs, newest first (`agents` sorted so), the latest LIST_LIMIT of them. */
export function listText(agents: readonly PiAgent[], sessionId: string, now: number): string {
  const mine = agents.filter(agent => agent.sessionId === sessionId)
  if (mine.length === 0) return 'No pi agents in this session. The Agent tool starts one with subagent_type pi:grok or pi:run.'
  const lines = mine.slice(0, LIST_LIMIT).map(agent => describeAgent(agent, now))
  const older = mine.length - LIST_LIMIT
  if (older > 0) lines.push(`${older} older (pi_result still reads them by id).`)
  return lines.join('\n')
}

export function resultText(agent: PiAgent, full: boolean, now: number): string {
  const lines = [describeAgent(agent, now)]
  if (agent.error) lines.push(`Error: ${agent.error}`)
  if (full && agent.digest.length > 0) lines.push('Turn digest:', ...agent.digest.map(line => `  ${line}`))
  lines.push(agent.lastMessage ? `Final message:\n${agent.lastMessage}` : 'No final message yet.')
  return lines.join('\n')
}

// ------------------------------------------------------------ transcript rows

export type ToolName = 'pi_list' | 'pi_result' | 'pi_await'

/** The short task label: the spawn's `description`, else its prompt's first line. */
export const taskLabel = (input: { description?: string; prompt?: string }): string =>
  firstLine(input.description ?? '') || clip(firstLine(input.prompt ?? ''), 80)

/** A tool's result as text: a plugin tool's is a string, or text blocks. */
export function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map(part => (part as { text?: unknown }).text).filter(text => typeof text === 'string').join('\n')
  if (typeof output === 'object' && output !== null && typeof (output as { text?: unknown }).text === 'string') return (output as { text: string }).text
  return ''
}

/** What goes in a row's parentheses: the verb and the agent addressed. */
export function rowArgs(tool: ToolName, input: Record<string, unknown>): string {
  const verb = tool.slice('pi_'.length)
  return typeof input.id === 'string' && input.id.trim() ? `${verb} ${input.id.trim()}` : verb
}

export const STILL_RUNNING = 'pi is still running'

/** The row's result line once the call succeeded, read from the model's text: main text and a dim tail. */
export function rowResult(tool: ToolName, text: string): { main: string; dim: string } {
  switch (tool) {
    case 'pi_list': {
      const lines = text.split('\n').filter(line => / \[[^\]]*\] \w+/.test(line))
      if (lines.length === 0) return { main: 'No agents', dim: '' }
      const running = lines.filter(line => /\] (running|starting)\b/.test(line)).length
      return { main: `${lines.length} agent${lines.length === 1 ? '' : 's'} · ${running} running`, dim: '' }
    }
    case 'pi_result': {
      const status = /\] (\w+)/.exec(text)?.[1] ?? 'done'
      const final = /^Final message:\n(.*)$/m.exec(text)?.[1]
      return { main: status === 'idle' ? 'done' : status, dim: final ? ` · ${firstLine(final)}` : '' }
    }
    case 'pi_await':
      return text.startsWith(STILL_RUNNING) ? { main: 'still running', dim: '' } : { main: 'done', dim: ` · ${firstLine(text)}` }
  }
}

/** The footer text while agents run, beside the prompt's hint line; undefined when none run. */
export function runningTail(agents: PiAgent[]): string | undefined {
  const live = agents.filter(isLive)
  if (live.length === 0) return undefined
  if (live.length > 3) return `${live.length} pi agents running`
  return `pi: ${live.map(agent => `${agent.name} (${shortModel(agent.model)})`).join(' · ')}`
}

// ------------------------------------------------------------ tool specs

const ID_PARAM = { type: 'string', description: "The agent id (the pi:* agent's agentId) or its name, as pi_list shows them." }

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'pi_list',
    description: `List this session's pi jobs (pi:* agents), newest first, the latest ${LIST_LIMIT}: model, status and what each is doing.`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pi_result',
    description:
      "Read a pi job's result: its status and the final message of the last turn. With full=true also a digest of the turn: tool calls with their outcome, messages and steers.",
    inputSchema: {
      type: 'object',
      properties: { id: ID_PARAM, full: { type: 'boolean', description: 'Include the turn digest.' } },
      required: ['id'],
    },
  },
  {
    name: 'pi_await',
    description: "Internal to pi:* agents, which call it themselves: blocks until the agent's pi turn ends. Never call it.",
    inputSchema: { type: 'object', properties: {} },
  },
]
