import type { On, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import {
  afterTurn,
  agentDescription,
  agentSpecs,
  applyPiEvent,
  configDirs,
  effectiveDefaults,
  effortFor,
  jobSettings,
  listText,
  normalizeEffort,
  parseHeader,
  parseProjectConfig,
  type PiEvent,
  sandboxPlatformError,
  toolLine,
  wrapperAnswer,
} from '../hooks/model'
import { parseModelList, piCommand, sandboxArgv, sandboxProfile, sandboxUnavailable } from '../bin/sandbox.mjs'
import type { PiAgent } from '../types'

// A fake bridge: the relay's stdout is a queue the test pushes NDJSON into,
// and its HTTP endpoints are answered by an `http.fetch` hook. Beneath the
// plugin, the test stands for the engine: the Agent tool's spawn, the agent
// list, SendMessage's delivery and a Claude model's turn.step.

type Send = { job: Record<string, unknown>; text: string }

type Fake = {
  argv: readonly string[]
  queue: string[]
  closed: boolean
  wake: () => void
  /** Every /send body, and what the fake answered. */
  sends: Send[]
  actions: string[]
  /** The next /send fails with this message. */
  sendError: string | null
  aborts: string[]
  waits: Record<string, unknown>[]
  /** Jobs whose turn the fake bridge runs: jobId -> turnId. */
  running: Record<string, string>
  turnCount: number
  models: string[]
  spawned: Record<string, unknown>[]
  agentIds: string[]
  agentList: { id: string; type: string; name?: string }[]
  delivered: { to: string; text: string }[]
  messages: Record<string, SessionMessage[]>
  modelSteps: number
  files: Record<string, string>
  waitAnswer: Record<string, unknown>
  waitQueue: Record<string, unknown>[]
  waitError: string | null
  registeredAgents: Record<string, unknown>[]
  store: Record<string, unknown>
  clock: MockClock
}

function fakeBridge(on: On, stored: Record<string, unknown> = {}, files: Record<string, string> = {}): Fake {
  const fake: Fake = {
    argv: [],
    queue: [],
    closed: false,
    wake: () => undefined,
    sends: [],
    actions: [],
    sendError: null,
    aborts: [],
    waits: [],
    running: {},
    turnCount: 0,
    models: ['xai/grok-4.7', 'xai/grok-4.3', 'novita/deepseek/deepseek-v4.1-flash'],
    spawned: [],
    agentIds: ['a1', 'a2', 'a3'],
    agentList: [],
    delivered: [],
    messages: {},
    modelSteps: 0,
    files: { ...files },
    waitAnswer: { status: 'timeout' },
    waitQueue: [],
    waitError: null,
    registeredAgents: [],
    store: { ...stored },
    clock: mock.clock(on, { now: 1_000_000 }),
  }
  // The engine beneath the plugin.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__pi__${e.name}` } }))
  on('agent.register', (_$, e) => {
    fake.registeredAgents.push(JSON.parse(JSON.stringify(e)))
    return { value: { agent: `pi:${e.name}` } }
  })
  on('agent.spawn', (_$, e) => {
    fake.spawned.push(JSON.parse(JSON.stringify(e)))
    const agentId = fake.agentIds.shift() as string
    fake.agentList.push({ id: agentId, type: e.subagentType, ...(e.name ? { name: e.name } : {}) })
    return { model: 'claude-haiku-4-5', agentId }
  })
  on('agent.list', () => ({
    value: fake.agentList.map(agent => ({ ...agent, description: '', status: 'running' as const })),
  }))
  on('session.messages', (_$, e) => ({ value: fake.messages[(e as { agentId?: string }).agentId ?? ''] ?? [] }))
  on('tool.check', () => ({ decision: 'ask' as const, reason: 'beneath' }))
  on('session.send', (_$, e) => {
    fake.delivered.push({ to: e.to, text: e.text })
    return { isDelivered: true as const }
  })
  on('turn.step', async function* (_$, e) {
    fake.modelSteps += 1
    yield { kind: 'text' as const, index: 0, text: 'from Claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from Claude', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.root', () => ({ value: '/work' }))
  on('fs.exists', (_$, e) => ({ value: e.path in fake.files }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.read', (_$, e) => (e.path in fake.files ? { value: fake.files[e.path] as string } : { deny: `no file ${e.path}` }))
  on('ui.log', () => ({ value: undefined }))

  on('store.get', (_$, e) => ({ value: fake.store[e.key] }))
  on('store.set', (_$, e) => {
    fake.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })

  on('process.spawn', async function* (_$, e) {
    fake.argv = e.argv
    for (;;) {
      const text = fake.queue.shift()
      if (text !== undefined) {
        yield { stream: 'stdout' as const, text }
        continue
      }
      if (fake.closed) return { value: { code: 0, signal: null } }
      await new Promise<void>(resolve => (fake.wake = resolve))
    }
  })

  on('http.fetch', (_$, e) => {
    const path = new URL(e.url).pathname
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    let reply: unknown = { ok: true }
    if (path === '/models') reply = { result: { models: fake.models } }
    if (path === '/send') {
      const send = body as unknown as Send
      fake.sends.push(send)
      const id = String(send.job.id)
      if (fake.sendError !== null) {
        reply = { error: { message: fake.sendError } }
        fake.sendError = null
      } else if (fake.running[id]) {
        fake.actions.push('steered')
        reply = { result: { action: 'steered', turnId: fake.running[id], sessionFile: `/sessions/${id}.jsonl` } }
      } else {
        fake.turnCount += 1
        const turnId = `turn-${fake.turnCount}`
        fake.running[id] = turnId
        fake.actions.push('started')
        reply = { result: { action: 'started', turnId, sessionFile: `/sessions/${id}.jsonl` } }
      }
    }
    if (path === '/abort') {
      fake.aborts.push(String(body.jobId))
      reply = { result: { aborted: true } }
    }
    if (path === '/wait') {
      fake.waits.push(body)
      if (fake.waitError !== null) reply = { error: { message: fake.waitError } }
      else reply = fake.waitQueue.shift() ?? fake.waitAnswer
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } }
  })

  return fake
}

const push = (fake: Fake, event: unknown) => {
  fake.queue.push(`${JSON.stringify(event)}\n`)
  fake.wake()
}

const piEvent = (jobId: string, turnId: string | null, event: Record<string, unknown>) => ({ type: 'event', jobId, turnId, event })

/** The bridge's report that a job's turn ended. */
const endTurn = (fake: Fake, jobId: string, turnId: string, text = '', status = 'completed', error: string | null = null) => {
  if (fake.running[jobId] === turnId) delete fake.running[jobId]
  push(fake, { type: 'turn_end', jobId, turn: { id: turnId, status, text, error } })
}

const done = (fake: Fake) => {
  fake.closed = true
  fake.wake()
}

/** Polls `check`, letting the event loop settle between polls. */
async function until(fake: Fake, check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return
    await fake.clock.settle()
  }
  throw new Error(`timed out waiting for ${what}`)
}

const agentsOf = async (fake: Fake) => (fake.store.agents ?? {}) as Record<string, Record<string, unknown>>

async function start($: Engine, fake: Fake, ready: Record<string, unknown> = {}) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  // Split across pieces: the plugin must buffer until the newline.
  const line = JSON.stringify({ type: 'ready', socket: '/tmp/pxb-test/s', reattached: false, active: {}, platform: 'darwin', ...ready })
  fake.queue.push(line.slice(0, 10), `${line.slice(10)}\n`)
  fake.wake()
}

/** What the Agent tool hands `agent.spawn` for a call. */
const spawnInput = (prompt: string, extra: Record<string, unknown> = {}) => ({
  tool_use_id: 'toolu_test',
  prompt,
  description: 'Sleep a while',
  subagentType: 'pi:grok',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  ...extra,
})

/** SendMessage from the main loop's model. */
const send = ($: Engine, to: string, text: string) => $.session.send({ to, text, origin: { kind: 'model' } })

/** The Agent tool starting a pi:grok agent, as the engine raises it. */
async function spawn($: Engine, fake: Fake, prompt = 'sleep 20', extra: Record<string, unknown> = {}) {
  const spawned = await $.agent.spawn(spawnInput(prompt, extra))
  expect(spawned.deny).toBeUndefined()
  return (await agentsOf(fake))[spawned.agentId as string] as Record<string, unknown>
}

/** One model request of a loop: the chunks it yielded and its result. */
async function step($: Engine, agentId: string, index = 0): Promise<{ chunks: TurnStepChunk[]; result: TurnStepResult }> {
  const stream = $.turn.step({ turnId: `t-${agentId}`, index, model: 'claude-haiku-4-5', messageCount: 1, agentId })
  const chunks: TurnStepChunk[] = []
  for (;;) {
    const next = await stream.next()
    if (next.done) return { chunks, result: next.value }
    chunks.push(next.value)
  }
}

const awaitCall = ($: Engine, agentId: string) => $.tool.call({ tool: 'mcp__pi__pi_await', agentId } as never)

/** The JSON arguments a tool step streamed. */
const inputOf = (chunks: TurnStepChunk[]) =>
  JSON.parse(chunks.filter(chunk => chunk.kind === 'input').map(chunk => (chunk as { json: string }).json).join('')) as Record<string, unknown>

/** The report a wrapper's final step hands back. */
async function finalOf($: Engine, agentId: string, index = 0): Promise<unknown> {
  const { chunks } = await step($, agentId, index)
  expect(chunks[0]).toMatchObject({ kind: 'tool', name: 'SubagentHandback' })
  return inputOf(chunks).message
}

const completed = (id: string, text: string) => ({ status: 'completed', turn: { id, status: 'completed', text, error: null } })

const PI_DEFAULT = '/opt/homebrew/bin/pi'
const NODE_DEFAULT = '/opt/homebrew/bin/node'

const baseAgent = (extra: Partial<PiAgent> = {}): PiAgent => ({
  id: 'a1', name: 'job', description: '', kind: 'grok', model: 'xai/grok-4.7', effort: 'high', sandbox: 'workspace-write', cwd: '/work',
  sessionFile: null, status: 'running', currentTurnId: 'turn-1', lastTurnId: null, lastTurnStatus: null, lastMessage: '', activity: 'thinking',
  tokens: 0, error: null, digest: [], startedAt: 1, updatedAt: 1, turnStartedAt: 1, turnEndedAt: 0, sessionId: 's', ...extra,
})

// ------------------------------------------------------------ pure logic

test('parseHeader reads only the leading key lines, keeps the model case and the rest as given', () => {
  expect(parseHeader('plain\neffort: low')).toEqual({ body: 'plain\neffort: low' })
  expect(parseHeader('  effort:  HIGH \n\n\n  indented body\n')).toEqual({ effort: 'high', body: '  indented body\n' })
  expect(parseHeader('Model: novita/Qwen/Q-3\nsandbox: Read-Only\nbody')).toEqual({ model: 'novita/Qwen/Q-3', sandbox: 'read-only', body: 'body' })
  expect(parseHeader('approvals: never\nbody')).toEqual({ approvals: 'never', body: 'body' })
  expect(() => parseHeader('sandbox: a\nsandbox: b\nx')).toThrow('twice')
})

test('effort: pi thinking levels, ultra as max, anything else refused', () => {
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) expect(normalizeEffort(level)).toBe(level)
  expect(normalizeEffort('ULTRA')).toBe('max')
  expect(() => normalizeEffort('extreme')).toThrow('effort must be one of off, minimal, low, medium, high, xhigh, max')
})

test('jobSettings: header > project > userConfig > built-ins; grok fixed, run needs a model; approvals refused', () => {
  const settings = { piPath: 'p', nodePath: 'n', defaultEffort: undefined, defaultSandbox: 'workspace-write' as const }
  const builtIn = effectiveDefaults(settings, {})
  expect(builtIn).toEqual({ effort: undefined, sandbox: 'workspace-write', model: undefined })
  expect(jobSettings('grok', { body: 'x' }, builtIn)).toEqual({ model: 'xai/grok-4.7', effort: 'high', sandbox: 'workspace-write' })
  expect(jobSettings('grok', { body: 'x', effort: 'ultra', sandbox: 'read-only' }, builtIn)).toEqual({ model: 'xai/grok-4.7', effort: 'max', sandbox: 'read-only' })
  expect(() => jobSettings('grok', { body: 'x', model: 'xai/grok-4.3' }, builtIn)).toThrow('the model: header is for pi:run')
  expect(() => jobSettings('run', { body: 'x' }, builtIn)).toThrow('pi:run needs a model')
  expect(() => jobSettings('run', { body: 'x', model: 'grok' }, builtIn)).toThrow('must be provider/id')
  expect(jobSettings('run', { body: 'x', model: 'xai/grok-4.3' }, builtIn)).toEqual({ model: 'xai/grok-4.3', effort: 'high', sandbox: 'workspace-write' })
  const project = effectiveDefaults({ ...settings, defaultEffort: 'low' }, { model: 'xai/grok-4.3', sandbox: 'read-only' })
  expect(jobSettings('run', { body: 'x' }, project)).toEqual({ model: 'xai/grok-4.3', effort: 'low', sandbox: 'read-only' })
  expect(jobSettings('run', { body: 'x', model: 'novita/a/b', effort: 'medium', sandbox: 'full-access' }, project)).toEqual({ model: 'novita/a/b', effort: 'medium', sandbox: 'full-access' })
  expect(() => jobSettings('grok', { body: 'x', approvals: 'never' }, builtIn)).toThrow('approvals: header is not supported')
  expect(() => jobSettings('grok', { body: 'x', sandbox: 'everything' }, builtIn)).toThrow('sandbox must be one of')
  expect(effortFor(builtIn, 'run')).toBe('high')
  expect(sandboxPlatformError('linux', 'workspace-write', 'needs bubblewrap (bwrap) on Linux')).toContain('needs bubblewrap')
  expect(sandboxPlatformError('linux', 'workspace-write', null)).toBeUndefined()
  expect(sandboxPlatformError('linux', 'full-access', 'needs bubblewrap')).toBeUndefined()
  expect(sandboxPlatformError('darwin', 'read-only')).toBeUndefined()
  expect(sandboxPlatformError('win32', 'read-only')).toContain('has neither')
  expect(configDirs('/work/app/src', '/work')).toEqual(['/work/app/src', '/work/app', '/work'])
  expect(configDirs('/elsewhere', '/work')).toEqual(['/elsewhere', '/'])
  expect(parseProjectConfig('{"effort":"ultra","model":"xai/grok-4.3"}', 'p.json')).toEqual({ effort: 'max', model: 'xai/grok-4.3' })
  expect(() => parseProjectConfig('{"approvals":"auto"}', 'p.json')).toThrow('"approvals" is not supported')
  expect(agentSpecs(builtIn).map(spec => spec.name)).toEqual(['grok', 'run'])
})

test('linux sandbox argv: bwrap with read-only root, writable project, tmp and pi state, existing pi entries re-bound read-only', () => {
  const cmd = ['/usr/bin/pi', '--mode', 'rpc']
  const agent = '/home/u/.pi/agent'
  const entries = ['sessions', 'auth.json', 'settings.json', 'models.json', 'extensions', 'skills', 'auth.json.lock', 'models.json']
  const ws = sandboxArgv({ project: '/home/u/proj', home: '/home/u', mode: 'workspace-write', cmd, platform: 'linux', bwrap: '/usr/bin/bwrap', piAgentEntries: entries })
  expect(ws).toEqual([
    '/usr/bin/bwrap',
    '--ro-bind', '/', '/',
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
    '--bind', '/tmp', '/tmp',
    '--bind', '/var/tmp', '/var/tmp',
    '--bind', '/home/u/proj', '/home/u/proj',
    '--bind', agent, agent,
    // Every existing entry but sessions/, auth.json and settings.json, sorted and deduplicated.
    '--ro-bind-try', `${agent}/auth.json.lock`, `${agent}/auth.json.lock`,
    '--ro-bind-try', `${agent}/extensions`, `${agent}/extensions`,
    '--ro-bind-try', `${agent}/models.json`, `${agent}/models.json`,
    '--ro-bind-try', `${agent}/skills`, `${agent}/skills`,
    '--die-with-parent',
    '--chdir', '/home/u/proj',
    ...cmd,
  ])
  // No network or pid isolation flags: network stays shared.
  expect(ws.some(arg => arg.startsWith('--unshare'))).toBe(false)
  // read-only: same minus the project bind; cwd still the project.
  const ro = sandboxArgv({ project: '/home/u/proj', home: '/home/u', mode: 'read-only', cmd, platform: 'linux', bwrap: '/usr/bin/bwrap', piAgentEntries: [], tmpdir: '/run/user/1000/tmp' })
  expect(ro.join(' ')).not.toContain('--bind /home/u/proj')
  expect(ro.join(' ')).toContain('--bind /run/user/1000/tmp /run/user/1000/tmp')
  expect(ro.slice(-5)).toEqual(['--chdir', '/home/u/proj', ...cmd])
  // $TMPDIR=/tmp is not bound twice.
  const plain = sandboxArgv({ project: '/p', home: '/h', mode: 'read-only', cmd, platform: 'linux', bwrap: 'bwrap', tmpdir: '/tmp' })
  expect(plain.filter(arg => arg === '/tmp')).toHaveLength(2)
  expect(() => sandboxArgv({ home: '/h', mode: 'workspace-write', cmd, platform: 'linux', bwrap: 'bwrap' })).toThrow('project is required')
})

test('sandbox argv: workspace-write allows the project, read-only does not, full-access runs bare, non-macOS refuses', () => {
  const cmd = ['/bin/echo', 'hi']
  const ws = sandboxArgv({ project: '/private/tmp', home: '/Users/x', mode: 'workspace-write', cmd, platform: 'darwin' })
  expect(ws[0]).toBe('/usr/bin/sandbox-exec')
  expect(ws.slice(1, 3)).toEqual(['-p', sandboxProfile('workspace-write')])
  expect(ws).toContain('PROJECT=/private/tmp')
  expect(ws).toContain('HOME=/Users/x')
  expect(ws.slice(-2)).toEqual(cmd)
  expect(sandboxProfile('workspace-write')).toContain('(deny file-write*)')
  expect(sandboxProfile('workspace-write')).toContain('(subpath (param "PROJECT"))')
  expect(sandboxProfile('workspace-write')).toContain('"/.pi/agent/sessions"')
  // pi's auth and settings stores: the files and their proper-lockfile lock dirs, as literals.
  for (const name of ['auth.json', 'auth.json.lock', 'settings.json', 'settings.json.lock']) {
    expect(sandboxProfile('workspace-write')).toContain(`(literal (string-append (param "HOME") "/.pi/agent/${name}"))`)
  }
  // Nothing else in ~/.pi: only the session dir is a subpath, and no extension or models paths.
  const piRules = sandboxProfile('workspace-write').match(/\(\w+ \(string-append \(param "HOME"\) "[^"]*"\)\)/g)
  expect(piRules).toHaveLength(5)
  expect(piRules.filter(rule => rule.startsWith('(subpath'))).toEqual(['(subpath (string-append (param "HOME") "/.pi/agent/sessions"))'])
  expect(sandboxProfile('workspace-write')).not.toMatch(/models|npm|extensions|"\/\.pi"|"\/\.pi\/agent"\)/)
  // read-only is the same profile minus the project.
  expect(sandboxProfile('read-only')).toBe(sandboxProfile('workspace-write').replace('(subpath (param "PROJECT")) ', ''))
  const ro = sandboxArgv({ project: '/private/tmp', home: '/Users/x', mode: 'read-only', cmd, platform: 'darwin' })
  expect(ro.join(' ')).not.toContain('PROJECT')
  expect(sandboxProfile('read-only')).not.toContain('PROJECT')
  expect(sandboxArgv({ project: '/p', home: '/h', mode: 'full-access', cmd, platform: 'linux' })).toEqual(cmd)
  expect(() => sandboxArgv({ project: '/p', home: '/h', mode: 'workspace-write', cmd, platform: 'linux' })).toThrow('needs bubblewrap (bwrap)')
  expect(() => sandboxArgv({ project: '/p', home: '/h', mode: 'read-only', cmd, platform: 'linux', bwrap: null })).toThrow('needs bubblewrap (bwrap)')
  expect(() => sandboxArgv({ project: '/p', home: '/h', mode: 'read-only', cmd, platform: 'win32' })).toThrow('has neither')
  expect(sandboxUnavailable({ platform: 'darwin' })).toBeUndefined()
  expect(sandboxUnavailable({ platform: 'linux', bwrap: '/usr/bin/bwrap' })).toBeUndefined()
  expect(() => sandboxArgv({ project: '/p', home: '/h', mode: 'yolo', cmd, platform: 'darwin' })).toThrow('sandbox must be one of')

  expect(piCommand({ piPath: 'pi', model: 'xai/grok-4.7', effort: 'high', sandbox: 'workspace-write', sessionFile: null })).toEqual([
    'pi', '--mode', 'rpc', '--model', 'xai/grok-4.7', '--thinking', 'high',
  ])
  expect(piCommand({ piPath: 'pi', model: 'm/x', effort: 'low', sandbox: 'read-only', sessionFile: '/s/1.jsonl' })).toEqual([
    'pi', '--mode', 'rpc', '--model', 'm/x', '--thinking', 'low', '--tools', 'read,grep,find,ls', '--session', '/s/1.jsonl',
  ])
  const listing = [
    'Warning: Extension package "x": Host-provided extension packages must be declared',
    'provider  model                 context  max-out  thinking  images',
    'novita    deepseek/deepseek_v3  128K     8K       no        no',
    'xai       grok-4.7              500K     500K     yes       yes   ',
  ].join('\n')
  expect(parseModelList(listing)).toEqual(['novita/deepseek/deepseek_v3', 'xai/grok-4.7'])
})

test('pi events reduce to job state: tools, assistant text, tokens, steers, retries; the turn end settles it', () => {
  // Recorded from a pi --mode rpc run (fields trimmed to what the reducer reads).
  const fixture: PiEvent[] = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'create inside.txt' }] } },
    { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'touch inside.txt' } },
    { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', args: { command: 'touch inside.txt' }, result: {}, isError: false },
    { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'write', args: { path: '/Users/x/pi-escape.txt', content: 'x' } },
    { type: 'tool_execution_end', toolCallId: 'c2', toolName: 'write', args: { path: '/Users/x/pi-escape.txt' }, result: {}, isError: true },
    { type: 'message_end', message: { role: 'user', content: 'also say BANANA' } },
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' },
    { type: 'auto_retry_end', success: true, attempt: 2 },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Created inside.txt.\nEscape: permission denied' }], stopReason: 'stop', usage: { totalTokens: 1500 } } },
  ]
  let agent = baseAgent()
  const activities: string[] = []
  for (const event of fixture) {
    agent = { ...agent, ...applyPiEvent(agent, event) }
    activities.push(agent.activity)
  }
  expect(activities.slice(0, 6)).toEqual(['thinking', 'thinking', 'thinking', '$ touch inside.txt', 'thinking', 'write /Users/x/pi-escape.txt'])
  expect(activities[8]).toBe('retrying (attempt 1): 529 overloaded')
  expect(agent.digest).toEqual([
    '$ touch inside.txt -> ok',
    'write /Users/x/pi-escape.txt -> error',
    'steer: also say BANANA',
    'note: Created inside.txt.',
  ])
  expect(agent).toMatchObject({ tokens: 1500, lastMessage: 'Created inside.txt.\nEscape: permission denied', activity: 'Created inside.txt.' })
  // A provider error is recorded; the bridge's turn_end then sets the outcome.
  expect(applyPiEvent(agent, { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 bad key' } })).toMatchObject({ error: '401 bad key' })
  expect(applyPiEvent(agent, { type: 'auto_retry_end', success: false, finalError: 'gave up' })).toEqual({ error: 'gave up' })
  expect(applyPiEvent(agent, { type: 'queue_update' })).toEqual({})
  expect(afterTurn(agent, { id: 'turn-1', status: 'completed', text: 'FINAL', error: null }, 5)).toMatchObject({ status: 'idle', currentTurnId: null, lastTurnId: 'turn-1', lastMessage: 'FINAL', turnEndedAt: 5, error: null })
  expect(afterTurn(agent, { id: 'turn-1', status: 'interrupted', text: '', error: null }, 5)).toMatchObject({ status: 'interrupted', lastTurnStatus: 'interrupted' })
  expect(afterTurn(agent, { id: 'turn-1', status: 'failed', text: '', error: 'pi exited (1)' }, 5)).toMatchObject({ status: 'failed', error: 'pi exited (1)' })
  expect(toolLine('read', { path: 'src/a.ts' })).toBe('read src/a.ts')
  expect(toolLine('ls', {})).toBe('ls')
})

// ------------------------------------------------------------ the plugin

test('configured binaries missing from disk fall back to node and pi on PATH', async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  expect(fake.argv[0]).toBe('node')
  expect(fake.argv[2]).toBe('pi')
  done(fake)
})

test('registers pi:grok and pi:run, run on haiku with pi_await alone', async ($, on) => {
  const fake = fakeBridge(on, {}, { '/work/.claude/pi.json': JSON.stringify({ effort: 'medium' }) })
  await start($, fake)
  expect(fake.registeredAgents.map(spec => spec.name)).toEqual(['grok', 'run'])
  for (const spec of fake.registeredAgents) {
    expect(spec).toMatchObject({ tools: ['mcp__pi__pi_await', 'SubagentHandback'], model: 'haiku', background: true, omitClaudeMd: true })
  }
  const grok = String(fake.registeredAgents[0]?.description)
  expect(grok).toContain('xai/grok-4.7, effort medium.')
  expect(grok).toContain('No approvals')
  expect(grok).not.toContain('"model: provider/id"')
  expect(String(fake.registeredAgents[1]?.description)).toContain('"model: provider/id"')
  done(fake)
})

test('pi and node are found in common install folders, else by bare name on PATH', async ($, on) => {
  const found = fakeBridge(on, {}, { '/home/u/.local/npm/bin/pi': '', '/usr/bin/node': '' })
  await start($, found)
  expect(found.argv[0]).toBe('/usr/bin/node')
  expect(found.argv[2]).toBe('/home/u/.local/npm/bin/pi')
  done(found)
})

test('with nothing installed in a known folder, the bridge spawns bare pi and node', async ($, on) => {
  const bare = fakeBridge(on, {}, {})
  await start($, bare)
  expect(bare.argv[0]).toBe('node')
  expect(bare.argv[2]).toBe('pi')
  done(bare)
})

test('a pi:grok spawn sends the exact prompt with its job spec, keyed by the agentId; events update it', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, { [PI_DEFAULT]: '', [NODE_DEFAULT]: '' })
  await start($, fake)
  expect(fake.argv[0]).toBe(NODE_DEFAULT)
  expect(fake.argv[1]).toMatch(/bin\/bridge\.mjs$/)
  expect(fake.argv[2]).toBe(PI_DEFAULT)

  const prompt = 'Write unit tests for calc.js\n\n  keep the indentation\n'
  const agent = await spawn($, fake, prompt, { description: 'Write calc tests' })
  expect(fake.spawned[0]).toMatchObject({ subagentType: 'pi:grok', prompt, background: true })
  expect(agent).toMatchObject({
    id: 'a1', name: 'Write calc tests', kind: 'grok', model: 'xai/grok-4.7', effort: 'high', sandbox: 'workspace-write',
    status: 'running', currentTurnId: 'turn-1', cwd: '/work/app', sessionFile: '/sessions/a1.jsonl',
  })
  expect(fake.sends[0]).toEqual({
    job: { id: 'a1', cwd: '/work/app', model: 'xai/grok-4.7', effort: 'high', sandbox: 'workspace-write', sessionFile: null },
    text: prompt,
  })

  // The cwd the Agent call set wins, and a second job gets its own name.
  await spawn($, fake, 'x', { cwd: '/elsewhere' })
  expect((await agentsOf(fake)).a2).toMatchObject({ name: 'Sleep a while', cwd: '/elsewhere' })
  await spawn($, fake, 'z')
  expect((await agentsOf(fake)).a3?.name).toBe('Sleep a while (2)')

  push(fake, piEvent('a1', 'turn-1', { type: 'tool_execution_start', toolName: 'bash', args: { command: 'sleep 20' } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.activity === '$ sleep 20', 'activity')
  push(fake, piEvent('a1', 'turn-1', { type: 'tool_execution_end', toolName: 'bash', args: { command: 'sleep 20' }, isError: false }))
  push(fake, piEvent('a1', 'turn-1', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }], usage: { totalTokens: 1234 } } }))
  await until(fake, async () => (await agentsOf(fake)).a1?.tokens === 1234, 'tokens')
  expect((await agentsOf(fake)).a1?.digest).toEqual(['$ sleep 20 -> ok', 'note: DONE'])
  // An event of another turn leaves this one alone.
  push(fake, piEvent('a1', 'turn-0', { type: 'tool_execution_start', toolName: 'bash', args: { command: 'old' } }))
  push(fake, piEvent('a1', 'turn-1', { type: 'turn_start' }))
  await until(fake, async () => (await agentsOf(fake)).a1?.activity === 'thinking', 'thinking')
  done(fake)
})

test('header lines set model, effort and sandbox and are stripped; a bad one refuses the spawn', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake, 'model: xai/grok-4.3\neffort: ultra\nSandbox: read-only\n\nDo X\nthen Y', { subagentType: 'pi:run' })
  expect(fake.sends[0]).toMatchObject({ job: { model: 'xai/grok-4.3', effort: 'max', sandbox: 'read-only' }, text: 'Do X\nthen Y' })
  expect((await agentsOf(fake)).a1).toMatchObject({ kind: 'run', model: 'xai/grok-4.3' })

  // Refused before any subagent starts.
  const before = fake.spawned.length
  for (const [prompt, type, reason] of [
    ['x', 'pi:run', 'pi:run needs a model'],
    ['model: xai/grok-9\nx', 'pi:run', 'pi does not know model "xai/grok-9"'],
    ['model: xai/grok-4.3\nx', 'pi:grok', 'the model: header is for pi:run'],
    ['approvals: never\nx', 'pi:grok', 'approvals: header is not supported'],
    ['effort: extreme\nx', 'pi:grok', 'effort must be one of'],
    ['sandbox: everything\nx', 'pi:grok', 'sandbox must be one of'],
    ['effort: low\neffort: high\nx', 'pi:grok', 'sets effort twice'],
    ['effort: low\n\n', 'pi:grok', 'prompt is empty'],
  ] as const) {
    const refused = await $.agent.spawn(spawnInput(prompt, { subagentType: type }))
    expect(refused.deny).toContain(reason)
  }
  expect(fake.spawned).toHaveLength(before)

  // Any other agent type passes untouched.
  const other = await $.agent.spawn(spawnInput('effort: low\nhi', { subagentType: 'general-purpose' }))
  expect(other.agentId).toBeDefined()
  expect(fake.spawned.at(-1)).toMatchObject({ subagentType: 'general-purpose', prompt: 'effort: low\nhi' })
  done(fake)
})

test('where the bridge has no sandbox tool a sandboxed spawn is refused; full-access still runs', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake, { platform: 'linux', sandboxUnavailable: 'needs bubblewrap (bwrap) on Linux, and it is not on PATH' })
  expect((await $.agent.spawn(spawnInput('x'))).deny).toContain('needs bubblewrap (bwrap)')
  await spawn($, fake, 'sandbox: full-access\nx')
  expect(fake.sends[0]?.job).toMatchObject({ sandbox: 'full-access' })
  done(fake)
})

test('the wrapper loop: pi_await while pi runs, then the pi final message verbatim, with no Claude model', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)

  const first = await step($, 'a1')
  expect(first.chunks.map(chunk => chunk.kind)).toEqual(['tool', 'input', 'stop'])
  expect(first.chunks[0]).toMatchObject({ kind: 'tool', name: 'mcp__pi__pi_await' })
  expect(first.result).toMatchObject({ toolUses: [{ name: 'mcp__pi__pi_await', input: {} }], stopReason: 'tool_use' })

  const final = 'Line one\n\n  exact *markdown*, kept as is\n'
  fake.waitQueue = [{ status: 'timeout' }, { status: 'timeout' }, completed('turn-1', final)]
  const awaited = await awaitCall($, 'a1')
  expect(awaited.result).toBe(final)
  expect(fake.waits.map(wait => wait.timeoutMs)).toEqual([25_000, 25_000, 25_000])
  expect(fake.waits[0]).toMatchObject({ jobId: 'a1' })
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'idle', lastMessage: final })

  // The report goes back through SubagentHandback, verbatim.
  const last = await step($, 'a1', 1)
  expect(last.chunks[0]).toMatchObject({ kind: 'tool', name: 'SubagentHandback' })
  expect(inputOf(last.chunks)).toEqual({ message: final })
  // Where the engine offers no SubagentHandback, the failed call is followed by the final text.
  fake.messages.a1 = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h1', tool: 'SubagentHandback', input: {}, isError: true }] }]
  const plain = await step($, 'a1', 2)
  expect(plain.chunks.filter(chunk => chunk.kind === 'text').map(chunk => (chunk as { text: string }).text).join('')).toBe(final)
  expect(plain.result).toMatchObject({ answer: final, toolUses: [], stopReason: 'end_turn' })
  expect(fake.modelSteps).toBe(0)

  // Another subagent's requests go to its model.
  fake.agentList.push({ id: 'other', type: 'general-purpose' })
  const foreign = await step($, 'other')
  expect(foreign.result.answer).toBe('from Claude')
  expect(fake.modelSteps).toBe(1)
  done(fake)
})

test('a failed or lost pi turn ends the wrapper with the reason', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  fake.waitError = 'the pi bridge stopped'
  expect(await awaitCall($, 'a1').then(ran => ran.result)).toBe('pi failed: the pi bridge stopped')
  expect(await finalOf($, 'a1', 1)).toBe('pi failed: the pi bridge stopped')

  // A turn that did not start: the wrapper still runs, and ends with why.
  fake.waitError = null
  fake.sendError = 'cannot start pi (/nope): ENOENT'
  await spawn($, fake, 'y')
  expect(await finalOf($, 'a2')).toBe('pi failed: the pi turn did not start: cannot start pi (/nope): ENOENT')

  // The bridge knows no turn for the job: lost.
  await spawn($, fake, 'z')
  fake.waitQueue = [{ status: 'idle', turn: null }]
  expect((await awaitCall($, 'a3')).result).toBe('pi failed: the pi turn was lost')

  expect((await $.tool.call({ tool: 'mcp__pi__pi_await' } as never)).deny).toContain('pi:* agents only')
  expect(wrapperAnswer({ status: 'interrupted', error: null } as unknown as PiAgent)).toBe('pi turn interrupted.')
  expect(wrapperAnswer({ status: 'idle', lastMessage: '' } as unknown as PiAgent)).toBe('(pi finished without a final message.)')
  done(fake)
})

test('SendMessage steers a running pi turn and starts a new one in the same session once it ended, then delivers', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake, 'task', { name: 'helper' })

  expect(await send($, 'a1', 'also say BANANA')).toEqual({ isDelivered: true })
  expect(fake.actions).toEqual(['started', 'steered'])
  expect(fake.sends[1]).toMatchObject({ job: { id: 'a1', sessionFile: '/sessions/a1.jsonl' }, text: 'also say BANANA' })
  expect(fake.delivered).toEqual([{ to: 'a1', text: 'also say BANANA' }])
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-1' })

  endTurn(fake, 'a1', 'turn-1', 'first answer')
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')
  expect((await agentsOf(fake)).a1?.lastMessage).toBe('first answer')

  // By the name the Agent call gave: a new turn on the same pi session, before the delivery resumes the subagent.
  await send($, 'helper', 'next task')
  expect(fake.actions.at(-1)).toBe('started')
  expect(fake.sends.at(-1)).toMatchObject({ job: { id: 'a1', sessionFile: '/sessions/a1.jsonl' }, text: 'next task' })
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-2' })
  expect((await step($, 'a1', 0)).result.stopReason).toBe('tool_use')

  // Refused when pi refuses it; anyone else's messages pass untouched.
  endTurn(fake, 'a1', 'turn-2')
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle again')
  fake.sendError = 'pi did not start: Model not found'
  const refused = await send($, 'a1', 'again')
  expect(refused).toMatchObject({ isDelivered: false, reason: 'pi did not take the message: pi did not start: Model not found' })
  const sends = fake.sends.length
  await send($, 'someone-else', 'hi')
  expect(fake.sends).toHaveLength(sends)
  expect(fake.delivered.map(one => one.to)).toEqual(['a1', 'helper', 'someone-else'])
  done(fake)
})

test('a late end of an earlier turn does not end the turn started after it', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  // The wrapper learns of the end from /wait before the event lands, and a new turn starts.
  fake.waitQueue = [completed('turn-1', 'R')]
  delete fake.running.a1
  expect((await awaitCall($, 'a1')).result).toBe('R')
  await send($, 'a1', 'more')
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-2' })

  endTurn(fake, 'a1', 'turn-1', 'R')
  for (let i = 0; i < 5; i += 1) await fake.clock.settle()
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'running', currentTurnId: 'turn-2' })

  endTurn(fake, 'a1', 'turn-2', 'R2')
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'second end')
  expect((await agentsOf(fake)).a1?.lastMessage).toBe('R2')
  done(fake)
})

test('TaskStop: an aborted wrapper turn aborts the pi turn, and pi_list shows it interrupted', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  await spawn($, fake)
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't-a1', agentId: 'a1', reason: 'aborted' })
  expect(fake.aborts).toEqual(['a1'])
  expect((await agentsOf(fake)).a1).toMatchObject({ status: 'interrupted', currentTurnId: null })
  expect(String((await $.tool.call({ tool: 'mcp__pi__pi_list' } as never)).result)).toMatch(/^a1 Sleep a while \[xai\/grok-4\.7\/high, workspace-write\] interrupted/)
  // The bridge's own report of the end changes nothing more.
  endTurn(fake, 'a1', 'turn-1', '', 'interrupted')
  for (let i = 0; i < 5; i += 1) await fake.clock.settle()
  expect((await agentsOf(fake)).a1?.status).toBe('interrupted')
  // A turn that ended normally, or the main loop's, aborts nothing.
  await $.turn.complete({ answer: 'x', durationMs: 5, isAborted: false, turnId: 't-a1', agentId: 'a1', reason: 'answer' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 'main', reason: 'aborted' })
  expect(fake.aborts).toHaveLength(1)
  done(fake)
})

test('project config: header lines > .claude/pi.json (nearest up to the root) > userConfig', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on, {}, { '/work/.claude/pi.json': JSON.stringify({ effort: 'medium', sandbox: 'read-only', model: 'xai/grok-4.3' }) })
  await start($, fake)
  await spawn($, fake, 'x', { subagentType: 'pi:run' })
  expect(fake.sends[0]?.job).toMatchObject({ model: 'xai/grok-4.3', effort: 'medium', sandbox: 'read-only' })
  // pi:grok keeps its model whatever the project says.
  await spawn($, fake, 'y')
  expect(fake.sends[1]?.job).toMatchObject({ model: 'xai/grok-4.7', effort: 'medium' })
  // Header lines win over the project.
  await spawn($, fake, 'effort: low\nsandbox: workspace-write\nz')
  expect(fake.sends[2]?.job).toMatchObject({ effort: 'low', sandbox: 'workspace-write' })
  // A broken config is reported, not ignored.
  fake.files['/work/.claude/pi.json'] = '{"sandbox": "everything"}'
  expect((await $.agent.spawn(spawnInput('w'))).deny).toContain('sandbox must be one of')
  fake.files['/work/.claude/pi.json'] = '{"approvals": "auto"}'
  expect((await $.agent.spawn(spawnInput('w'))).deny).toContain('"approvals" is not supported')
  done(fake)
})

test('effort: a userConfig defaultEffort replaces the built-in, below the project', { options: { defaultEffort: 'medium' }, timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  expect(String(fake.registeredAgents[0]?.description)).toContain('xai/grok-4.7, effort medium.')
  await spawn($, fake, 'x')
  fake.files['/work/.claude/pi.json'] = JSON.stringify({ effort: 'low' })
  await spawn($, fake, 'y')
  expect(fake.sends.map(one => one.job.effort)).toEqual(['medium', 'low'])
  const builtIn = effectiveDefaults({ piPath: 'p', nodePath: 'n', defaultEffort: undefined, defaultSandbox: 'workspace-write' }, {})
  expect(agentDescription('grok', builtIn)).toContain('xai/grok-4.7, effort high.')
  done(fake)
})

test('after a reload the registry comes back from the store; live turns reattach, lost ones resume their pi session', async ($, on) => {
  const base = {
    kind: 'grok', model: 'xai/grok-4.7', effort: 'low', sandbox: 'workspace-write', cwd: '/work', currentTurnId: 'turn-9',
    lastTurnId: null, lastTurnStatus: null, lastMessage: '', activity: 'x', tokens: 0, error: null, digest: [],
    startedAt: 1, updatedAt: 1, turnStartedAt: 1, turnEndedAt: 0, sessionId: 's', description: '',
  }
  const fake = fakeBridge(on, {
    agents: {
      aaa111: { ...base, id: 'aaa111', name: 'alive', status: 'running', sessionFile: '/s/alive.jsonl' },
      bbb222: { ...base, id: 'bbb222', name: 'lost', status: 'running', sessionFile: '/s/lost.jsonl' },
    },
  })
  await start($, fake, { reattached: false, active: { aaa111: 'turn-9' } })
  await until(fake, async () => (await agentsOf(fake)).bbb222?.status === 'interrupted', 'lost turn settled')
  const agents = await agentsOf(fake)
  expect(agents.aaa111).toMatchObject({ status: 'running', currentTurnId: 'turn-9' })
  expect(agents.bbb222?.error).toContain('lost')

  // A message to the lost agent starts a turn; the bridge relaunches pi on its session file.
  await send($, 'bbb222', 'continue')
  expect(fake.sends).toEqual([{ job: { id: 'bbb222', cwd: '/work', model: 'xai/grok-4.7', effort: 'low', sandbox: 'workspace-write', sessionFile: '/s/lost.jsonl' }, text: 'continue' }])
  expect((await agentsOf(fake)).bbb222).toMatchObject({ status: 'running', error: null })
  done(fake)
})

type Node = string | { type: string; props?: Record<string, unknown>; children?: Node[] }

/** The drawn tree as the lines it shows: a column Box stacks its children, a Text runs them on. */
function linesOf(node: Node): string {
  if (typeof node === 'string') return node
  const parts = (node.children ?? []).map(linesOf)
  return node.type === 'Box' && node.props?.flexDirection === 'column' ? parts.join('\n') : parts.join('')
}

/** The color of the row's bullet. */
function dotColor(node: Node): unknown {
  if (typeof node === 'string') return undefined
  if (node.type === 'Text' && node.children?.[0] === '●') return node.props?.color
  for (const child of node.children ?? []) {
    const color = dotColor(child)
    if (color !== undefined) return color
  }
  return undefined
}

test("pi rows are one header and one result line; the result text stays the model's", { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  const row = (tool: string, input: Record<string, unknown>, output: unknown, flags: Record<string, boolean> = {}) => ({
    component: 'ToolUse' as const,
    requestId: `tu-${tool}`,
    props: { tool_use_id: `tu-${tool}`, tool: `mcp__pi__${tool}`, input, isRunning: false, isErrored: false, isInterrupted: false, output, ...flags },
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const running = await $.ui.mount({ plugin: 'pi', surface, ...row('pi_await', {}, undefined, { isRunning: true }) })
    expect(linesOf((await running.drawn()) as Node)).toBe('● Pi(await)')
    await running.unmount()

    const result = await $.ui.mount({
      plugin: 'pi',
      surface,
      component: 'ToolResult',
      requestId: 'tu-pi_list',
      props: { tool_use_id: 'tu-pi_list', tool: 'mcp__pi__pi_list', output: 'x', isErrored: false },
    })
    expect(linesOf((await result.drawn()) as Node)).toBe('')
    await result.unmount()

    const cases: [string, Record<string, unknown>, string, string][] = [
      ['pi_list', {}, 'abc w1 [xai/grok-4.7/high, workspace-write] running 3s: thinking\ndef w2 [xai/grok-4.7/high, read-only] idle 9s: completed', 'Pi(list)\n  ⎿  2 agents · 1 running'],
      ['pi_result', { id: 'w1' }, 'abc w1 [xai/grok-4.7/high, workspace-write] idle 9s: completed\nFinal message:\nDONE BANANA\nmore', 'Pi(result w1)\n  ⎿  done · DONE BANANA'],
      ['pi_await', {}, 'DONE BANANA\nmore', 'Pi(await)\n  ⎿  done · DONE BANANA'],
      ['pi_await', {}, 'pi is still running: a1 grok [...] running', 'Pi(await)\n  ⎿  still running'],
    ]
    for (const [tool, input, output, expected] of cases) {
      const ui = await $.ui.mount({ plugin: 'pi', surface, ...row(tool, input, output) })
      expect(linesOf((await ui.drawn()) as Node)).toBe(`● ${expected}`)
      await ui.unmount()
    }

    const failed = await $.ui.mount({ plugin: 'pi', surface, ...row('pi_result', { id: 'nope' }, 'No pi agent "nope". pi_list shows them.', { isErrored: true }) })
    expect(linesOf((await failed.drawn()) as Node)).toBe('● Pi(result nope)\n  ⎿  failed: No pi agent "nope". pi_list shows them.')
    expect(dotColor((await failed.drawn()) as Node)).toBe('error')
    await failed.unmount()
  }
  done(fake)
})

test('pi_list and pi_result read the jobs', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  await start($, fake)
  expect(String((await $.tool.call({ tool: 'mcp__pi__pi_list' } as never)).result)).toContain('subagent_type pi:grok or pi:run')
  await spawn($, fake)
  expect(String((await $.tool.call({ tool: 'mcp__pi__pi_list' } as never)).result)).toMatch(/^a1 Sleep a while \[xai\/grok-4\.7\/high, workspace-write\] running/)
  push(fake, piEvent('a1', 'turn-1', { type: 'tool_execution_end', toolName: 'read', args: { path: 'a.ts' }, isError: false }))
  endTurn(fake, 'a1', 'turn-1', 'ALL GREEN')
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')
  expect(String((await $.tool.call({ tool: 'mcp__pi__pi_result', id: 'Sleep a while' } as never)).result)).toContain('Final message:\nALL GREEN')
  const full = String((await $.tool.call({ tool: 'mcp__pi__pi_result', id: 'a1', full: true } as never)).result)
  expect(full).toContain('Turn digest:\n  read a.ts -> ok')
  done(fake)
})

test("pi_list shows this session's latest 10 jobs, newest first; pi_result reads any job", { timeoutMs: 20_000 }, async ($, on) => {
  const base = {
    kind: 'grok', model: 'xai/grok-4.7', effort: 'low', sandbox: 'workspace-write', cwd: '/work', status: 'idle', sessionFile: null,
    currentTurnId: null, lastTurnId: 'turn-1', lastTurnStatus: 'completed', lastMessage: 'OLD RESULT', activity: 'completed',
    tokens: 0, error: null, digest: [], updatedAt: 1, turnStartedAt: 1, turnEndedAt: 2, description: '',
  }
  const agents: Record<string, unknown> = {
    other: { ...base, id: 'other', name: 'elsewhere', startedAt: 99, sessionId: 'session-0' },
  }
  for (let i = 1; i <= 12; i += 1) agents[`j${i}`] = { ...base, id: `j${i}`, name: `job ${i}`, startedAt: i, sessionId: 'session-1' }
  const fake = fakeBridge(on, { agents })
  await start($, fake, { reattached: true })
  const listed = String((await $.tool.call({ tool: 'mcp__pi__pi_list' } as never)).result).split('\n')
  expect(listed).toHaveLength(11)
  expect(listed[0]).toMatch(/^j12 job 12 \[xai\/grok-4\.7\/low, workspace-write\] idle 0s, 0 tok: completed$/)
  expect(listed[9]).toMatch(/^j3 job 3 /)
  expect(listed[10]).toBe('2 older (pi_result still reads them by id).')
  expect(String((await $.tool.call({ tool: 'mcp__pi__pi_result', id: 'other' } as never)).result)).toContain('Final message:\nOLD RESULT')
  expect(listText([], 'session-1', 0)).toContain('No pi agents in this session')
  done(fake)
})

test('running agents show beside the prompt hint, and nothing once none runs', { timeoutMs: 20_000 }, async ($, on) => {
  const fake = fakeBridge(on)
  on('ui.render', { component: 'PromptHint' }, (_$, e) => ({ type: 'Text', children: [`${e.props.hint}|${e.props.tail ?? ''}`] }))
  await start($, fake)
  const hint = { component: 'PromptHint' as const, requestId: 'hint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } }
  const ui = await $.ui.mount({ plugin: 'pi', surface: 'terminal', ...hint })
  expect(linesOf((await ui.drawn()) as Node)).toBe('? for shortcuts|')
  await spawn($, fake)
  await ui.redraw()
  expect(linesOf((await ui.drawn()) as Node)).toBe('? for shortcuts|pi: Sleep a while (grok-4.7)')
  endTurn(fake, 'a1', 'turn-1')
  await until(fake, async () => (await agentsOf(fake)).a1?.status === 'idle', 'idle')
  await ui.redraw()
  expect(linesOf((await ui.drawn()) as Node)).toBe('? for shortcuts|')
  await ui.unmount()
  done(fake)
})
