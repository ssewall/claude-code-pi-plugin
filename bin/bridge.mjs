#!/usr/bin/env node
// Bridge between the pi plugin and `pi --mode rpc` processes.
//
// Three roles in one file:
//   relay:  node bridge.mjs <piPath> <sessionKey>
//           Started by the plugin with $.process.spawn. Finds (or starts) the
//           daemon for this Claude session and this build of the bridge (the
//           daemon's directory is <sessionKey>-<BUILD>, so a reload onto another
//           plugin version or path starts a new daemon instead of driving an old
//           one), then copies its event stream to stdout as NDJSON. First line:
//           {"type":"ready","socket",...}. It exits when its parent goes away,
//           stdout breaks or the daemon exits; the plugin killing it on reload is
//           expected and harmless.
//   launch: node bridge.mjs --launch <piPath> <dir>
//           Started detached by the relay; starts the daemon detached, writes
//           its pid to <dir>/pid and exits at once. The daemon is thus never a
//           descendant of the relay: the engine kills the relay's whole tree
//           when the plugin reloads, and the daemon (with its pi processes and
//           their running turns) must outlive that.
//   daemon: node bridge.mjs --daemon <piPath> <dir>
//           Owns one `pi --mode rpc` child per job (wrapped by sandbox-exec, see
//           sandbox.mjs) and serves HTTP on the Unix socket <dir>/s:
//             GET  /health
//             GET  /events  NDJSON stream (one subscriber, the relay)
//             GET  /models  {result: {models}}: provider/id from `pi --list-models`
//             POST /send    {job, text} -> {result: {action: steered|started, turnId, sessionFile}}
//                           steers the running turn, else prompts (relaunching
//                           pi with --session when its process is gone)
//             POST /abort   {jobId}             aborts the running turn
//             POST /wait    {jobId, timeoutMs}  long-poll for the turn's end
//             POST /release {jobId}             stops the job's pi process
//           While no relay is attached it buffers events (so a plugin reload
//           loses nothing) and exits, killing every pi, after GRACE_MS alone.
//           With a relay attached it exits after IDLE_MS with no turn running
//           and no request in flight; the plugin starts a new one when it next
//           needs pi, and a job's next message relaunches pi on its session file.

import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseModelList, piCommand, sandboxArgv } from './sandbox.mjs'

const GRACE_MS = 20_000
const IDLE_MS = 10 * 60_000
const IDLE_CHECK_MS = 60_000
const BUFFER_CAP = 5_000
/** After agent_end (no retry), how long to wait for agent_settled before ending the turn anyway. */
const SETTLE_FALLBACK_MS = 3_000
const SELF = fileURLToPath(import.meta.url)
const SANDBOX_SELF = path.join(path.dirname(SELF), 'sandbox.mjs')
/** Names this bridge build: its path and its code (sandbox.mjs included). */
const BUILD = createHash('sha256')
  .update(SELF)
  .update(fs.readFileSync(SELF))
  .update(fs.readFileSync(SANDBOX_SELF))
  .digest('hex')
  .slice(0, 8)

/** pi events the plugin reads; the rest (streaming deltas, UI chatter, whole-run message lists) stay here. */
const RELAYED = new Set([
  'agent_start',
  'turn_start',
  'message_end',
  'tool_execution_start',
  'tool_execution_end',
  'auto_retry_start',
  'auto_retry_end',
  'compaction_start',
  'compaction_end',
])

const readBody = req =>
  new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', chunk => (data += chunk))
    req.on('end', () => {
      try {
        resolve(data === '' ? {} : JSON.parse(data))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })

const sendJson = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** Calls `onLine` per LF-terminated record (pi's JSONL may hold U+2028 inside strings, which readline would split on). */
const jsonLines = (stream, onLine) => {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    pending += chunk
    let at
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at).replace(/\r$/, '')
      pending = pending.slice(at + 1)
      if (line.trim() !== '') onLine(line)
    }
  })
}

/** The text of an assistant message's text blocks. */
const assistantText = message =>
  Array.isArray(message?.content)
    ? message.content
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('')
    : typeof message?.content === 'string'
      ? message.content
      : ''

// ---------------------------------------------------------------- daemon

async function daemon(piPath, dir) {
  const socketPath = path.join(dir, 's')
  /** jobId -> job: its pi child, the running turn and the last one. */
  const jobs = new Map()
  const waiters = new Map() // jobId -> Set<(value) => void>
  let buffer = []
  let subscriber = null
  let graceTimer = null
  let everSubscribed = false
  let inFlight = 0
  let lastUse = Date.now()
  let runCounter = 0
  let models = null
  // pi is a node script: let it find the node this bridge runs on.
  const childEnv = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` }

  const emit = event => {
    if (subscriber) subscriber.write(JSON.stringify(event) + '\n')
    else {
      buffer.push(event)
      if (buffer.length > BUFFER_CAP) buffer = buffer.slice(-BUFFER_CAP)
    }
  }

  const activeRuns = () =>
    Object.fromEntries([...jobs.values()].filter(job => job.run).map(job => [job.id, job.run.id]))

  const settleWaiters = (jobId, value) => {
    const set = waiters.get(jobId)
    if (!set) return
    waiters.delete(jobId)
    for (const done of set) done(value)
  }

  /** One RPC command to a job's pi; resolves its response ({success, data} | {success: false, error}). */
  const command = (job, type, fields = {}, timeoutMs = 60_000) =>
    new Promise(resolve => {
      if (!job.child || job.exited) return resolve({ success: false, error: 'the pi process is not running' })
      const id = `b${job.nextId++}`
      const timer = setTimeout(() => {
        job.pending.delete(id)
        resolve({ success: false, error: `${type} timed out after ${timeoutMs} ms` })
      }, timeoutMs)
      job.pending.set(id, { resolve, timer })
      job.child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n')
    })

  /** Ends the job's running turn and tells the plugin and any waiter. */
  const finishRun = async (job, override) => {
    const run = job.run
    if (!run || run.finishing) return
    run.finishing = true
    clearTimeout(run.settleTimer)
    let text = assistantText(run.lastAssistant)
    if (text === '' && !job.exited) {
      const last = await command(job, 'get_last_assistant_text', {}, 10_000)
      if (last.success && typeof last.data?.text === 'string') text = last.data.text
    }
    const stop = run.lastAssistant?.stopReason
    let status = 'completed'
    let error = null
    if (override) ({ status, error } = override)
    else if (run.aborting || stop === 'aborted') status = 'interrupted'
    else if (stop === 'error') {
      status = 'failed'
      error = run.lastAssistant?.errorMessage ?? 'the model call failed'
    }
    const turn = { id: run.id, status, text, error }
    if (job.run === run) job.run = null
    job.lastTurn = turn
    lastUse = Date.now()
    emit({ type: 'turn_end', jobId: job.id, turn })
    settleWaiters(job.id, { status: 'completed', turn })
  }

  const onPiRecord = (job, record) => {
    if (record.type === 'response') {
      const entry = record.id !== undefined ? job.pending.get(record.id) : undefined
      if (!entry) return
      job.pending.delete(record.id)
      clearTimeout(entry.timer)
      entry.resolve(record)
      return
    }
    if (record.type === 'extension_ui_request') {
      // No person to ask here: every dialog an extension opens is cancelled.
      if (['select', 'confirm', 'input', 'editor'].includes(record.method)) {
        job.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: record.id, cancelled: true }) + '\n')
      }
      return
    }
    const run = job.run
    if (run) {
      if (record.type === 'agent_start') clearTimeout(run.settleTimer)
      if (record.type === 'message_end' && record.message?.role === 'assistant') run.lastAssistant = record.message
      if (record.type === 'agent_end') {
        const last = (record.messages ?? []).filter(message => message?.role === 'assistant').at(-1)
        if (last) run.lastAssistant = last
        clearTimeout(run.settleTimer)
        if (record.willRetry !== true) run.settleTimer = setTimeout(() => void finishRun(job), SETTLE_FALLBACK_MS)
      }
      if (record.type === 'agent_settled') void finishRun(job)
    }
    if (RELAYED.has(record.type)) emit({ type: 'event', jobId: job.id, turnId: run?.id ?? null, event: record })
  }

  /** Starts the job's pi (resuming its session file when it has one); resolves once pi answers get_state. */
  const launch = async (job, spec) => {
    const cwd = fs.realpathSync(spec.cwd)
    const argv = sandboxArgv({
      project: cwd,
      home: fs.realpathSync(os.homedir()),
      mode: spec.sandbox,
      cmd: piCommand({ piPath, model: spec.model, effort: spec.effort, sandbox: spec.sandbox, sessionFile: job.sessionFile }),
    })
    const child = spawn(argv[0], argv.slice(1), { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    job.child = child
    job.exited = false
    job.stderrTail = []
    const started = new Promise((resolve, reject) => {
      child.once('error', error => reject(new Error(`cannot start pi (${piPath}): ${error.message}`)))
      child.once('spawn', resolve)
    })
    child.stdin.on('error', () => undefined)
    jsonLines(child.stdout, line => {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        return
      }
      onPiRecord(job, record)
    })
    jsonLines(child.stderr, line => {
      job.stderrTail.push(line)
      if (job.stderrTail.length > 40) job.stderrTail.shift()
    })
    child.on('exit', (code, signal) => {
      if (job.child !== child) return
      job.exited = true
      for (const { resolve, timer } of job.pending.values()) {
        clearTimeout(timer)
        resolve({ success: false, error: `pi exited (${code ?? signal}): ${job.stderrTail.slice(-3).join(' | ')}` })
      }
      job.pending.clear()
      emit({ type: 'exit', jobId: job.id, code, signal, stderrTail: job.stderrTail.slice(-10) })
      if (job.run) {
        const why = job.run.aborting ? null : `pi exited (${code ?? signal}): ${job.stderrTail.slice(-3).join(' | ')}`
        void finishRun(job, why === null ? { status: 'interrupted', error: null } : { status: 'failed', error: why })
      }
    })
    await started
    const state = await command(job, 'get_state', {}, 30_000)
    if (!state.success) throw new Error(`pi did not start: ${state.error}`)
    if (typeof state.data?.sessionFile === 'string') job.sessionFile = state.data.sessionFile
  }

  const jobFor = spec => {
    let job = jobs.get(spec.id)
    if (!job) {
      job = { id: spec.id, child: null, exited: true, pending: new Map(), nextId: 1, run: null, lastTurn: null, sessionFile: spec.sessionFile ?? null, stderrTail: [], queue: Promise.resolve() }
      jobs.set(spec.id, job)
    }
    return job
  }

  /** Runs `work` after the job's earlier sends and aborts. */
  const onJob = (job, work) => {
    const run = job.queue.then(work)
    job.queue = run.catch(() => undefined)
    return run
  }

  const send = (spec, text) => {
    const job = jobFor(spec)
    return onJob(job, async () => {
      if (job.run && !job.run.finishing && !job.exited) {
        const steered = await command(job, 'steer', { message: text })
        if (!steered.success) throw new Error(steered.error ?? 'pi refused the steer')
        return { action: 'steered', turnId: job.run.id, sessionFile: job.sessionFile }
      }
      if (!job.child || job.exited) await launch(job, spec)
      const run = { id: `${job.id}-${++runCounter}`, lastAssistant: null, aborting: false, finishing: false, settleTimer: null }
      job.run = run
      const prompted = await command(job, 'prompt', { message: text })
      if (!prompted.success) {
        if (job.run === run) job.run = null
        throw new Error(prompted.error ?? 'pi refused the prompt')
      }
      // An extension command handled it: no run starts.
      if (prompted.data?.disposition === 'handled') void finishRun(job)
      return { action: 'started', turnId: run.id, sessionFile: job.sessionFile }
    })
  }

  const abort = jobId => {
    const job = jobs.get(jobId)
    if (!job) return Promise.resolve({ aborted: false })
    return onJob(job, async () => {
      if (!job.run || job.exited) return { aborted: false }
      job.run.aborting = true
      const answer = await command(job, 'abort', {}, 20_000)
      // pi answers abort once idle; a run that sent no end event ends here.
      if (job.run) void finishRun(job, { status: 'interrupted', error: answer.success ? null : answer.error })
      return { aborted: true }
    })
  }

  const stopJob = job => {
    if (job.child && !job.exited) {
      try {
        job.child.stdin.end()
      } catch {}
      job.child.kill('SIGTERM')
    }
  }

  const listModels = () =>
    new Promise(resolve => {
      if (models) return resolve({ result: { models } })
      execFile(piPath, ['--list-models'], { env: childEnv, timeout: 30_000, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
        const found = parseModelList(`${stdout}\n${stderr}`)
        if (found.length === 0) {
          return resolve({ error: { message: `pi --list-models listed no models${error ? `: ${error.message}` : ''}` } })
        }
        models = found
        resolve({ result: { models } })
      })
    })

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }

  const shutdown = code => {
    for (const job of jobs.values()) stopJob(job)
    cleanup()
    // End the relay's stream before exiting, so the relay reads an ordinary end, not a reset.
    if (subscriber) subscriber.end()
    subscriber = null
    setTimeout(() => process.exit(code), 300)
  }

  const armGrace = () => {
    clearTimeout(graceTimer)
    graceTimer = setTimeout(() => shutdown(0), GRACE_MS)
  }

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown(0))

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://bridge')
      if (url.pathname !== '/events') {
        inFlight += 1
        lastUse = Date.now()
        res.on('close', () => {
          inFlight -= 1
          lastUse = Date.now()
        })
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, pid: process.pid, build: BUILD, platform: process.platform, active: activeRuns() })
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        if (subscriber) subscriber.end()
        clearTimeout(graceTimer)
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(JSON.stringify({ type: 'hello', reattached: everSubscribed, active: activeRuns(), platform: process.platform }) + '\n')
        for (const event of buffer) res.write(JSON.stringify(event) + '\n')
        buffer = []
        subscriber = res
        everSubscribed = true
        res.on('close', () => {
          if (subscriber === res) {
            subscriber = null
            armGrace()
          }
        })
        return
      }
      if (req.method === 'GET' && url.pathname === '/models') return sendJson(res, 200, await listModels())
      if (req.method !== 'POST') return sendJson(res, 404, { error: { message: 'not found' } })
      const body = await readBody(req)
      if (url.pathname === '/send') {
        const spec = body.job
        if (!spec || typeof spec.id !== 'string' || typeof body.text !== 'string') {
          return sendJson(res, 400, { error: { message: 'job and text are required' } })
        }
        try {
          return sendJson(res, 200, { result: await send(spec, body.text) })
        } catch (error) {
          return sendJson(res, 200, { error: { message: String(error?.message ?? error) } })
        }
      }
      if (url.pathname === '/abort') return sendJson(res, 200, { result: await abort(body.jobId) })
      if (url.pathname === '/release') {
        const job = jobs.get(body.jobId)
        if (job && !job.run) {
          stopJob(job)
          jobs.delete(job.id)
        }
        return sendJson(res, 200, { ok: true })
      }
      if (url.pathname === '/wait') {
        const { jobId, timeoutMs = 600_000 } = body
        const job = jobs.get(jobId)
        if (!job?.run) return sendJson(res, 200, { status: 'idle', turn: job?.lastTurn ?? null })
        const answer = await new Promise(resolve => {
          const set = waiters.get(jobId) ?? new Set()
          waiters.set(jobId, set)
          const done = value => {
            clearTimeout(timer)
            set.delete(done)
            resolve(value)
          }
          const timer = setTimeout(() => done({ status: 'timeout', turnId: job.run?.id ?? null }), timeoutMs)
          set.add(done)
        })
        return sendJson(res, 200, answer)
      }
      return sendJson(res, 404, { error: { message: 'not found' } })
    } catch (error) {
      return sendJson(res, 500, { error: { message: String(error?.message ?? error) } })
    }
  })
  server.requestTimeout = 0
  server.headersTimeout = 0
  try {
    fs.unlinkSync(socketPath)
  } catch {}
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600)
    armGrace()
  })

  setInterval(() => {
    if (Object.keys(activeRuns()).length > 0 || inFlight > 0) lastUse = Date.now()
    else if (subscriber && Date.now() - lastUse >= IDLE_MS) shutdown(0)
  }, IDLE_CHECK_MS)
}

// ---------------------------------------------------------------- relay

const request = (socketPath, method, urlPath, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: urlPath, timeout: timeoutMs }, resolve)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

/** A daemon's /health answer, or null when none answers on the socket. */
const readHealth = async socketPath => {
  try {
    const res = await request(socketPath, 'GET', '/health', 1000)
    res.setEncoding('utf8')
    let text = ''
    for await (const chunk of res) text += chunk
    return res.statusCode === 200 ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const isHealthy = async socketPath => (await readHealth(socketPath)) !== null

/** /tmp/pxb-<uid>: apart from the codex plugin's directory, so both run side by side. */
const privateBase = () => {
  const base = `/tmp/pxb-${process.getuid()}`
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(base)
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error(`${base} is not a directory this user owns`)
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(base, 0o700)
  return base
}

async function relay(piPath, sessionKey) {
  const out = line => process.stdout.write(JSON.stringify(line) + '\n')
  process.stdout.on('error', () => process.exit(0))
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0)
  }, 1000).unref()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0))

  const key = sessionKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'default'
  const dir = path.join(privateBase(), `${key}-${BUILD}`)
  const socketPath = path.join(dir, 's')

  if (!(await isHealthy(socketPath))) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { mode: 0o700 })
    const launcher = spawn(process.execPath, [SELF, '--launch', piPath, dir], { detached: true, stdio: 'ignore' })
    await new Promise(resolve => launcher.on('exit', resolve))
    const daemonPid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'))
    const deadline = Date.now() + 30_000
    while (!(await isHealthy(socketPath))) {
      const isAlive = (() => {
        try {
          process.kill(daemonPid, 0)
          return true
        } catch {
          return false
        }
      })()
      if (!isAlive || Date.now() > deadline) {
        let logTail = ''
        try {
          logTail = fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8').slice(-2000)
        } catch {}
        out({ type: 'fatal', message: !isAlive ? 'the daemon exited' : 'daemon did not start in 30 s', logTail })
        process.exit(1)
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  const res = await request(socketPath, 'GET', '/events', 0)
  let first = true
  let pending = ''
  res.setEncoding('utf8')
  for await (const chunk of res) {
    pending += chunk
    let at
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at)
      pending = pending.slice(at + 1)
      if (line.trim() === '') continue
      if (first) {
        first = false
        const hello = JSON.parse(line)
        out({ type: 'ready', socket: socketPath, reattached: hello.reattached, active: hello.active, platform: hello.platform })
        continue
      }
      process.stdout.write(line + '\n')
    }
  }
  process.exit(0)
}

function launchDaemon(piPath, dir) {
  const log = fs.openSync(path.join(dir, 'daemon.log'), 'a', 0o600)
  const daemonChild = spawn(process.execPath, [SELF, '--daemon', piPath, dir], { detached: true, stdio: ['ignore', log, log] })
  fs.writeFileSync(path.join(dir, 'pid'), String(daemonChild.pid), { mode: 0o600 })
  daemonChild.unref()
  process.exit(0)
}

const [, , first, ...rest] = process.argv
if (first === '--launch') {
  const [piPath, dir] = rest
  launchDaemon(piPath, dir)
} else if (first === '--daemon') {
  const [piPath, dir] = rest
  daemon(piPath, dir)
} else if (first && rest[0]) {
  relay(first, rest[0])
} else {
  process.stderr.write('usage: bridge.mjs <piPath> <sessionKey>\n')
  process.exit(2)
}
