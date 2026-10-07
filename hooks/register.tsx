// pi: jobs of the pi coding agent as native background subagents of this Claude session.
//
//   Agent({ subagent_type: "pi:<kind>" }) --agent.spawn--> this module starts
//   the pi turn with the spawn's own prompt, keyed by the new agentId; the
//   subagent's loop is answered by turn.step here (no Claude model runs): it
//   calls pi_await until the turn ends, then answers the pi final message.
//
//   this module --$.http.fetch(socketPath)--> bin/bridge.mjs daemon
//   --JSONL over stdio--> one `pi --mode rpc` per job (under sandbox-exec or bwrap);
//   the relay's stdout (NDJSON events) --$.process.spawn--> onEvent
//
// Every engine call lives in this file (the engine follows `$` only within
// one file); hooks/model.ts holds the pure logic it calls.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { PiAgent, PiSandbox } from '../types'
import {
  agentSpecs,
  afterTurn,
  applyPiEvent,
  AWAIT_TOOL,
  HANDBACK_TOOL,
  configDirs,
  type Defaults,
  effectiveDefaults,
  jobSettings,
  jobSpec,
  kindOfType,
  parseHeader,
  parseProjectConfig,
  PROJECT_CONFIG,
  type BridgeEvent,
  clip,
  PiError,
  describeAgent,
  findIn,
  firstLine,
  isLive,
  listText,
  outputText,
  rowArgs,
  rowResult,
  runningTail,
  sandboxPlatformError,
  taskLabel,
  type ToolName,
  type Turn,
  LineBuffer,
  PER_MODEL_EFFORT,
  PREFIX,
  resultText,
  sanitize,
  type Settings,
  sorted,
  STILL_RUNNING,
  TOOL_SPECS,
  trim,
  uniqueName,
  unknownModelError,
  wrapperAnswer,
} from './model'

type Engine = EngineInterface

// ------------------------------------------------------------ state

const agentsAtom = atom({ plugin: 'pi', key: 'agents' } as const, {})
const bridgeKeyAtom = atom({ plugin: 'pi', key: 'bridgeKey' } as const, null)

const STORE_KEY = 'agents'
/** The native transcript's row bullet and result mark. */
const DOT = '●'
const RESULT_MARK = '  ⎿  '
/** Under the 30 s after which $.http.fetch gives up on an answer. */
const POLL_SLICE_MS = 25_000
/** How long one pi_await call blocks before the wrapper's loop calls it again. */
const AWAIT_MS = 3_600_000
/** A short wait between reads of the registry; it counts against the hook's 10 s budget. */
const SETTLE_MS = 100
/** At most this much of an await's budget goes to such short waits. */
const SETTLE_BUDGET_MS = 5_000

// Module state starts over on a reload, which is right: a reload ends every
// in-flight wait and the bridge relay along with it.
type Socket = { promise: Promise<string>; resolve: (path: string) => void; reject: (error: Error) => void }
let socket: Socket | null = null
let isBridgeRunning = false
/** The userConfig the bridge starts with; set when the module registers. */
let bridgeSettings: Settings | null = null
/** The bridge's platform and sandbox verdict, from its ready line (sandboxed modes need sandbox-exec or bwrap). */
let bridgePlatform: string | undefined
let bridgeSandboxUnavailable: string | null | undefined
/** Subagents seen at turn.step that are not pi:* agents. */
const foreignAgents = new Set<string>()
let models: string[] | null = null

// ------------------------------------------------------------ registry

async function afterWrite($: Engine, agents: Record<string, PiAgent>): Promise<void> {
  await $.store.set(STORE_KEY, agents)
}

/** Records a new job, its name made unique among the jobs at that moment; resolves the job as written. */
async function putAgent($: Engine, agent: PiAgent): Promise<PiAgent> {
  let written = agent
  const agents = await update($, agentsAtom, all => {
    written = sanitize({ ...agent, name: uniqueName(all, agent.name) })
    return trim({ ...all, [agent.id]: written })
  })
  await afterWrite($, agents)
  return written
}

/** Applies `change` to the agent if it exists; resolves the agent as written. */
async function patchAgent($: Engine, id: string, change: (agent: PiAgent) => Partial<PiAgent>): Promise<PiAgent | undefined> {
  const now = await $.clock.now()
  let written: PiAgent | undefined
  const agents = await update($, agentsAtom, all => {
    const agent = all[id]
    if (!agent) return all
    written = sanitize({ ...agent, ...change(agent), updatedAt: now })
    return { ...all, [id]: written }
  })
  if (written) await afterWrite($, agents)
  return written
}

/** Fills $.state from the store after a restart; after a reload $.state is the fresher copy. */
async function loadFromStore($: Engine): Promise<void> {
  const stored = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, PiAgent>
  const agents = await update($, agentsAtom, live => ({ ...stored, ...live }))
  await afterWrite($, agents)
}

// ------------------------------------------------------------ bridge

function newSocket(): Socket {
  let resolve!: (path: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

/** The configured binary when it is on disk, else its bare name, which the spawn finds on PATH. */
async function resolveBinary($: Engine, configured: string, name: string): Promise<string> {
  return (await $.fs.exists(configured)) ? configured : name
}

/** Starts the relay, unless it runs; its events reach `onEvent` in order until the daemon exits (the session ended, or it sat idle). */
async function startBridge($: Engine): Promise<void> {
  if (isBridgeRunning) return
  const settings = bridgeSettings
  if (!settings) throw new PiError('the pi plugin is not registered')
  isBridgeRunning = true
  const current = newSocket()
  socket = current
  // Kept in $.state so a reload reattaches to the same daemon; a restart starts a new one.
  const fresh = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  const key = (await update($, bridgeKeyAtom, held => held ?? fresh)) as string
  const node = await resolveBinary($, settings.nodePath, 'node')
  const pi = await resolveBinary($, settings.piPath, 'pi')
  const argv = [node, `${$.plugin.root}/bin/bridge.mjs`, pi, key]

  const handle = async (line: string) => {
    let event: BridgeEvent
    try {
      event = JSON.parse(line) as BridgeEvent
    } catch {
      $.ui.log(`pi bridge: unreadable line ${clip(line, 200)}`, { to: 'debug' })
      return
    }
    if (event.type === 'ready') {
      bridgePlatform = event.platform
      bridgeSandboxUnavailable = event.sandboxUnavailable
      current.resolve(event.socket)
    }
    if (event.type === 'fatal') current.reject(new PiError(`pi bridge failed: ${event.message}`))
    try {
      await onEvent($, event)
    } catch (error) {
      $.ui.log(`pi: handling ${clip(line, 120)} failed: ${String(error)}`, { to: 'debug' })
    }
  }

  void (async () => {
    const lines = new LineBuffer()
    try {
      for await (const chunk of $.process.spawn({ argv })) {
        if (chunk.stream === 'stderr') {
          $.ui.log(`pi bridge: ${chunk.text.trimEnd()}`, { to: 'debug' })
          continue
        }
        for (const line of lines.push(chunk.text)) await handle(line)
      }
      for (const line of lines.rest()) await handle(line)
    } catch (error) {
      $.ui.log(`pi bridge stopped: ${String(error)}`)
    } finally {
      isBridgeRunning = false
      current.reject(new PiError('the pi bridge stopped'))
      if (socket === current) socket = null
    }
  })()
}

/** The daemon's socket, starting the bridge when none runs (the daemon exits when idle). */
async function bridgeSocket($: Engine): Promise<string> {
  await startBridge($)
  if (!socket) throw new PiError('the pi bridge is not running')
  return socket.promise
}

async function call($: Engine, method: 'GET' | 'POST', endpoint: string, body?: unknown): Promise<Record<string, unknown>> {
  const socketPath = await bridgeSocket($)
  const response = await $.http.fetch(`http://pi${endpoint}`, {
    method,
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    socketPath,
  })
  const parsed = JSON.parse(response.text) as Record<string, unknown>
  const error = parsed.error as { message?: string } | undefined
  if (error) throw new PiError(error.message ?? JSON.stringify(error))
  return parsed
}

const post = ($: Engine, endpoint: string, body: unknown) => call($, 'POST', endpoint, body)

type WaitAnswer = { status: 'completed' | 'idle'; turn: Turn | null } | { status: 'timeout' }

/** Long-polls until the job's turn ends: time inside $.http.fetch is budget-free. */
async function waitTurn($: Engine, jobId: string, timeoutMs: number): Promise<WaitAnswer> {
  // $.http.fetch gives up after 30 s and takes no timeout option: poll in slices under that.
  const deadline = (await $.clock.now()) + timeoutMs
  for (;;) {
    const left = deadline - (await $.clock.now())
    const slice = Math.max(1, Math.min(left, POLL_SLICE_MS))
    const answer = (await post($, '/wait', { jobId, timeoutMs: slice })) as unknown as WaitAnswer
    if (answer.status !== 'timeout' || left <= POLL_SLICE_MS) return answer
  }
}

// ------------------------------------------------------------ operations

async function listModels($: Engine): Promise<string[]> {
  if (models) return models
  const answer = await call($, 'GET', '/models')
  models = ((answer.result as { models?: string[] } | undefined)?.models ?? []).map(String)
  return models
}

type JobInput = {
  description: string
  name: string
  kind: string
  model: string
  effort: string
  sandbox: PiSandbox
  cwd: string
}

async function newAgent($: Engine, id: string, input: JobInput): Promise<PiAgent> {
  const now = await $.clock.now()
  return {
    id,
    name: input.name,
    description: input.description,
    kind: input.kind,
    model: input.model,
    effort: input.effort,
    sandbox: input.sandbox,
    cwd: input.cwd,
    sessionFile: null,
    status: 'starting',
    currentTurnId: null,
    lastTurnId: null,
    lastTurnStatus: null,
    lastMessage: '',
    activity: 'starting',
    tokens: 0,
    error: null,
    digest: [],
    startedAt: now,
    updatedAt: now,
    turnStartedAt: now,
    turnEndedAt: 0,
    sessionId: await $.session.id(),
  }
}

type SendResult = { action: 'steered' | 'started'; turnId: string; sessionFile: string | null }

/** Steers the running turn, or starts a new one when none runs (the bridge relaunches pi on its session when needed). */
async function sendMessage($: Engine, agent: PiAgent, text: string): Promise<'steered' | 'started'> {
  const now = await $.clock.now()
  const answer = (await post($, '/send', { job: jobSpec(agent), text })).result as SendResult
  await patchAgent($, agent.id, current => ({
    sessionFile: answer.sessionFile ?? current.sessionFile,
    ...(answer.action === 'started'
      ? {
          status: 'running' as const,
          currentTurnId: answer.turnId,
          error: null,
          digest: [],
          activity: 'thinking',
          turnStartedAt: now,
        }
      : {}),
  }))
  return answer.action
}

// ------------------------------------------------------------ native agents

/** Whether a subagent no record names yet is a pi:* agent (its spawn hook is still starting the turn). */
async function isPiType($: Engine, agentId: string): Promise<boolean> {
  const info = (await $.agent.list()).find(agent => agent.id === agentId)
  return info !== undefined && kindOfType(info.type) !== undefined
}

/** The pi job a SendMessage recipient names: an agentId, or the name the Agent call gave. */
async function recipient($: Engine, to: string): Promise<PiAgent | undefined> {
  const agents = await read($, agentsAtom)
  if (agents[to]) return agents[to]
  const info = (await $.agent.list()).find(agent => agent.name === to)
  return info ? agents[info.id] : undefined
}

/** Records how the turn the bridge reported ended, if the registry has not yet. */
async function settleTurn($: Engine, agent: PiAgent, answer: WaitAnswer): Promise<void> {
  if (answer.status === 'timeout') return
  const now = await $.clock.now()
  const turn = answer.turn
  await patchAgent($, agent.id, current => {
    if (!isLive(current)) return {}
    if (turn && (current.currentTurnId === null || turn.id === current.currentTurnId)) return afterTurn(current, turn, now)
    // The bridge runs no turn for the job and its last one is not ours.
    return { status: 'failed', currentTurnId: null, lastTurnStatus: 'failed', error: 'the pi turn was lost', turnEndedAt: now }
  })
}

/** A wrapper step that is one tool call the plugin makes. */
async function* toolStep(e: { turnId: string; index: number }, name: string, input: Record<string, unknown>): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const id = `toolu_pi_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`
  yield { kind: 'tool', index: 0, id, name }
  yield { kind: 'input', index: 0, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name, input }], stopReason: 'tool_use', usage: null }
}

/** Whether the wrapper's last step was a SubagentHandback call that failed: the engine does not offer that tool here. */
async function isHandbackRefused($: Engine, agentId: string): Promise<boolean> {
  const messages = await $.session.messages({ agentId })
  if (!Array.isArray(messages)) throw new PiError(`reading the agent's messages failed: ${messages.deny}`)
  const last = messages.filter(message => message.role === 'assistant').at(-1)
  return last?.toolUses.some(use => use.tool === HANDBACK_TOOL && use.isError === true) ?? false
}

/**
 * pi_await: blocks until the wrapper's pi turn ends and answers the result;
 * after AWAIT_MS it answers that the job still runs. The wrapper's loop
 * (turn.step) then calls it again, or ends with the result.
 */
async function awaitJob($: Engine, agentId: string | undefined, signal: AbortSignal): Promise<string> {
  if (agentId === undefined) throw new PiError('pi_await serves pi:* agents only')
  const startedAt = await $.clock.now()
  const deadline = startedAt + AWAIT_MS
  let settling = 0
  for (;;) {
    const agent = (await read($, agentsAtom))[agentId]
    if (agent && !isLive(agent)) return wrapperAnswer(agent)
    if (!agent || agent.status === 'starting') {
      // The spawn hook is between the subagent's start and the pi turn's.
      if (settling >= SETTLE_BUDGET_MS) {
        if (agent) return `${STILL_RUNNING}: its turn is still starting.`
        throw new PiError('pi_await serves pi:* agents only, and no pi job runs under this agent')
      }
      await $.clock.sleep(SETTLE_MS)
      settling += SETTLE_MS
      continue
    }
    const left = deadline - (await $.clock.now())
    if (left <= 0) return `${STILL_RUNNING}: ${describeAgent(agent, await $.clock.now())}`
    let answer: WaitAnswer
    try {
      answer = await waitTurn($, agent.id, Math.min(left, POLL_SLICE_MS))
    } catch (error) {
      if (signal.aborted) throw error
      // The bridge is gone: the job cannot finish, so it ends here with the reason.
      const now = await $.clock.now()
      await patchAgent($, agentId, () => ({ status: 'failed', currentTurnId: null, error: errorText(error), turnEndedAt: now }))
      continue
    }
    await settleTurn($, agent, answer)
  }
}

// ------------------------------------------------------------ events

/** After the bridge (re)starts: settle agents whose turn did not survive. */
async function onReady($: Engine, reattached: boolean, active: Record<string, string>): Promise<void> {
  for (const agent of Object.values(await read($, agentsAtom))) {
    if (!isLive(agent)) continue
    const turnId = active[agent.id]
    if (turnId) {
      await patchAgent($, agent.id, () => ({ status: 'running', currentTurnId: turnId }))
    } else if (!reattached) {
      // A reattached daemon replays the turn's end from its buffer; a new one never saw it.
      await patchAgent($, agent.id, () => ({
        status: 'interrupted',
        currentTurnId: null,
        lastTurnStatus: 'interrupted',
        error: 'the turn was lost when the pi bridge restarted; a SendMessage to its agent resumes the pi session with a new turn',
      }))
    }
  }
}

async function onEvent($: Engine, event: BridgeEvent): Promise<void> {
  switch (event.type) {
    case 'ready':
      await onReady($, event.reattached, event.active)
      return
    case 'event': {
      // A late event of an earlier turn leaves a newer one alone.
      await patchAgent($, event.jobId, current =>
        event.turnId === null || current.currentTurnId === null || current.currentTurnId === event.turnId ? applyPiEvent(current, event.event) : {},
      )
      return
    }
    case 'turn_end': {
      const now = await $.clock.now()
      // A late end of an earlier turn leaves a newer running one alone.
      await patchAgent($, event.jobId, current =>
        current.currentTurnId === null || current.currentTurnId === event.turn.id ? afterTurn(current, event.turn, now) : {},
      )
      return
    }
    case 'exit':
      $.ui.log(`pi for job ${event.jobId} exited (${event.code ?? event.signal}). ${event.stderrTail.slice(-3).join(' | ')}`, { to: 'debug' })
      return
    case 'fatal':
      $.ui.log(`pi bridge failed: ${event.message}\n${event.logTail}`)
      return
  }
}

// ------------------------------------------------------------ the module

/** The nearest .claude/pi.json from the session's cwd up to the project root. */
async function projectConfig($: Engine): Promise<Partial<Defaults>> {
  for (const dir of configDirs(await $.session.cwd(), await $.session.root())) {
    const path = `${dir === '/' ? '' : dir}/${PROJECT_CONFIG}`
    if (await $.fs.exists(path)) return parseProjectConfig(await $.fs.read(path), path)
  }
  return {}
}

const textArg = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const TOOL_NAMES: readonly ToolName[] = ['pi_list', 'pi_result', 'pi_await']

/** Serves pi_list (this session's jobs) and pi_result (any job); a PiError becomes the call's error text. */
async function runTool($: Engine, name: 'pi_list' | 'pi_result', e: unknown): Promise<string> {
  const args = e as Record<string, unknown>
  if (name === 'pi_list') return listText(sorted(await read($, agentsAtom)), await $.session.id(), await $.clock.now())
  const ref = textArg(args.id)
  if (!ref) throw new PiError('id is required')
  const agent = findIn(await read($, agentsAtom), ref)
  if (!agent) throw new PiError(`No pi agent "${ref}". pi_list shows them.`)
  return resultText(agent, args.full === true, await $.clock.now())
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const register: Register = (on, options) => {
  const settings: Settings = {
    piPath: String(options.piPath),
    nodePath: String(options.nodePath),
    defaultEffort: options.defaultEffort === PER_MODEL_EFFORT ? undefined : String(options.defaultEffort),
    defaultSandbox: String(options.defaultSandbox) as PiSandbox,
  }
  bridgeSettings = settings

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    let project: Partial<Defaults> = {}
    try {
      project = await projectConfig($)
    } catch (error) {
      $.ui.log(`pi: ${errorText(error)}`)
    }
    for (const tool of TOOL_SPECS) await $.tool.register(tool)
    for (const spec of agentSpecs(effectiveDefaults(settings, project))) await $.agent.register(spec)
    await loadFromStore($)
    await startBridge($)
    return started
  })

  // ---------------------------------------------------------- native agents

  // A pi:* spawn: the header, model and sandbox are checked before the subagent
  // starts, so a bad one refuses the Agent call itself; the pi turn starts with
  // the prompt as given, header lines stripped, once the subagent's id is known.
  on('agent.spawn', async ($, e, next) => {
    const kind = kindOfType(e.subagentType)
    if (kind === undefined) return next(e)
    let input: JobInput
    let body: string
    try {
      const header = parseHeader(e.prompt)
      body = header.body
      if (body.trim() === '') return { deny: 'pi: the prompt is empty once its header lines are taken off' }
      const job = jobSettings(kind, header, effectiveDefaults(settings, await projectConfig($)))
      const unknown = unknownModelError(await listModels($), job.model)
      if (unknown) return { deny: `pi: ${unknown}` }
      await bridgeSocket($)
      const platform = sandboxPlatformError(bridgePlatform, job.sandbox, bridgeSandboxUnavailable)
      if (platform) return { deny: `pi: ${platform}` }
      input = {
        description: taskLabel(e),
        // Made unique as the job is recorded (putAgent), so two spawns at once never share one.
        name: taskLabel(e) || kind,
        kind,
        ...job,
        cwd: e.cwd ?? (await $.session.cwd()),
      }
    } catch (error) {
      return { deny: `pi: ${errorText(error)}` }
    }
    const spawned = await next({ ...e, background: true })
    if (spawned.agentId === undefined) return spawned
    const agent = await putAgent($, await newAgent($, spawned.agentId, input))
    try {
      await sendMessage($, agent, body)
    } catch (error) {
      // The subagent runs: it ends at once with this reason as its answer.
      await patchAgent($, agent.id, () => ({ status: 'failed', error: `the pi turn did not start: ${errorText(error)}` }))
    }
    return spawned
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pi: the pi job did not start (the hook failed or ran out of time)' }))

  // The pi:* subagent's loop: every model request is answered here and no
  // Claude model runs. While the pi turn runs, the answer is a pi_await call;
  // once the turn ended, the answer is the pi final message, verbatim.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined || foreignAgents.has(e.agentId)) return yield* next(e)
    const agent = (await read($, agentsAtom))[e.agentId]
    if (!agent && !(await isPiType($, e.agentId))) {
      foreignAgents.add(e.agentId)
      return yield* next(e)
    }
    if (agent && !isLive(agent)) {
      const text = wrapperAnswer(agent)
      // Where the engine requires it (auto mode), the report goes back through SubagentHandback;
      // where that tool is not offered, its call fails and the final text is the report.
      if (!(await isHandbackRefused($, e.agentId))) return yield* toolStep(e, HANDBACK_TOOL, { message: text })
      yield { kind: 'text' as const, index: 0, text }
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn' as const, usage: null }
    }
    return yield* toolStep(e, AWAIT_TOOL, {})
  })

  // SendMessage to a pi:* agent goes to pi first: a steer while its turn runs,
  // a new turn in the same pi session once it ended (the delivery then resumes
  // the subagent, whose loop waits for that turn). Refused when pi refuses it.
  on('session.send', async ($, e, next) => {
    const agent = await recipient($, e.to)
    if (!agent) return next(e)
    try {
      await sendMessage($, agent, e.text)
    } catch (error) {
      return { isDelivered: false as const, reason: `pi did not take the message: ${errorText(error)}` }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { isDelivered: false as const, reason: 'pi: the message did not reach pi' }))

  // TaskStop, or the task list's stop, kills the subagent mid pi_await: its
  // turn ends aborted, and the pi turn under it is aborted.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined || e.reason !== 'aborted') return done
    const agent = (await read($, agentsAtom))[e.agentId]
    if (agent && isLive(agent)) {
      try {
        await post($, '/abort', { jobId: agent.id })
      } catch (error) {
        $.ui.log(`pi: aborting ${agent.name} failed: ${errorText(error)}`)
      }
      // The bridge's turn_end says so too; recorded here so pi_list shows it at once.
      const now = await $.clock.now()
      await patchAgent($, agent.id, current =>
        isLive(current) ? { status: 'interrupted', currentTurnId: null, lastTurnStatus: 'interrupted', activity: 'interrupted', turnEndedAt: now } : {},
      )
    }
    return done
  })

  // ---------------------------------------------------------- tools

  // A pattern: the tools table a type-check reads lists the MCP tools of the last reload alone.
  on('tool.call', { tool: new RegExp(`^${AWAIT_TOOL}$`) }, async ($, e, next) => {
    try {
      return { result: await awaitJob($, e.agentId, next.signal) }
    } catch (error) {
      return { deny: errorText(error) }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pi: pi_await did not finish (its hook failed or ran out of time)' }))

  // One hook for both: a matcher over a union of names does not type-check.
  const toolPattern = new RegExp(`^${PREFIX}(pi_list|pi_result)$`)
  on('tool.call', { tool: toolPattern }, async ($, e) => {
    try {
      return { result: await runTool($, e.tool.slice(PREFIX.length) as 'pi_list' | 'pi_result', e) }
    } catch (error) {
      return { deny: errorText(error) }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `pi: ${e.tool.slice(PREFIX.length)} did not finish (its hook failed or ran out of time)` }))

  // List pi_list and pi_result up front rather than behind ToolSearch; pi_await stays behind it.
  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    return e.tool.startsWith(PREFIX) && e.tool !== AWAIT_TOOL ? { ...described, isDeferred: false } : described
  })

  // ---------------------------------------------------------- drawing

  // Every pi_* call draws like a native Agent row: one header line and one result line, each
  // cut to the width, never wrapped. They read only the call's own props.
  for (const tool of TOOL_NAMES) {
    on('ui.render', { component: 'ToolUse', props: { tool: `${PREFIX}${tool}` } }, async ($, e) => {
      const { Box, Text } = $.ui.resolve(e)
      const { isRunning, isErrored, isInterrupted } = e.props
      const text = outputText(e.props.output)
      const result = isRunning || isInterrupted || isErrored ? null : rowResult(tool, text)
      const dot = isErrored || isInterrupted ? 'error' : isRunning ? 'inactive' : 'success'
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={dot}>{DOT} </Text>
            <Text bold>Pi</Text>({rowArgs(tool, (e.props.input ?? {}) as Record<string, unknown>)})
          </Text>
          {!isRunning && (
            <Text wrap="truncate-end">
              <Text dimColor>{RESULT_MARK}</Text>
              {isInterrupted ? (
                <Text dimColor>Interrupted</Text>
              ) : isErrored ? (
                <Text color="error">failed: {firstLine(text)}</Text>
              ) : (
                result?.main
              )}
              {result?.dim && <Text dimColor>{result.dim}</Text>}
            </Text>
          )}
        </Box>
      )
    })

    // The text under the row is the model's; the row above already says what it came to.
    on('ui.render', { component: 'ToolResult', props: { tool: `${PREFIX}${tool}` } }, async ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
  }

  // Running agents ride at the end of the hint line under the prompt, where native background
  // tasks show; nothing is added while none runs.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const tail = runningTail(Object.values(await read($, agentsAtom)))
    if (!tail) return next(e)
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${tail}` : tail } })
  })
}
