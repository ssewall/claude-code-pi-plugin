// How a pi job is confined, and the pi command line it runs with.
//
// workspace-write: sandbox-exec allows writes only under the project (its
// realpath), /private/tmp, /private/var/folders, /dev, pi's session dir, and
// the four ~/.pi/agent paths pi's credential and settings stores write (see
// PI_STATE_FILES).
// read-only: the same minus the project, and pi gets only its read tools.
// full-access: no sandbox at all. Reads and network stay open in every mode.
//
// Linux uses bubblewrap (bwrap) instead: the whole filesystem read-only, then
// writable binds for the project (workspace-write), /tmp, /var/tmp, $TMPDIR and
// pi's state. bwrap cannot bind a path that does not exist yet (pi's `*.lock`
// dirs), so all of ~/.pi/agent is bound writable and then every entry already
// in it, except sessions/, auth.json and settings.json, is re-bound read-only.
// Gap vs macOS: the agent can create new files in ~/.pi/agent.
// Any other platform, or Linux without bwrap: a sandboxed mode refuses to start
// rather than run unconfined.

// No imports: the plugin's tests load this file, and they may import nothing but
// relative files. Callers pass real paths (the bridge resolves them first).

export const SANDBOXES = ['read-only', 'workspace-write', 'full-access']
export const READ_ONLY_TOOLS = 'read,grep,find,ls'

// Paths under ~/.pi/agent that pi 1.0.x writes outside its session dir. Its
// auth store (FileAuthStorageBackend) and settings store (FileSettingsStorage)
// lock a file with proper-lockfile, which mkdirs `<file>.lock`, touches its
// mtime and rmdirs it, then rewrite the file in place with writeFileSync (no
// temp file, no rename). Without them pi cannot read credentials at all
// ("Credential store read failed ... mkdir auth.json.lock") or apply settings.
// OAuth refresh rewrites auth.json. Literal paths only: nothing else in ~/.pi.
export const PI_STATE_FILES = ['auth.json', 'auth.json.lock', 'settings.json', 'settings.json.lock']

/** The sandbox-exec profile for a mode; PROJECT and HOME arrive as -D parameters. */
export function sandboxProfile(mode) {
  const writable = [
    ...(mode === 'workspace-write' ? ['(subpath (param "PROJECT"))'] : []),
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
    '(subpath (string-append (param "HOME") "/.pi/agent/sessions"))',
    ...PI_STATE_FILES.map(name => `(literal (string-append (param "HOME") "/.pi/agent/${name}"))`),
    '(subpath "/dev")',
  ]
  return `(version 1)(allow default)(deny file-write*)(allow file-write* ${writable.join(' ')})`
}

// Entries of ~/.pi/agent that stay writable on Linux (sessions/ is pi's session
// store; the two files are rewritten in place, see PI_STATE_FILES).
export const PI_AGENT_WRITABLE = ['sessions', 'auth.json', 'settings.json']

/** Undefined when `platform` can confine a sandboxed mode; otherwise why not. */
export function sandboxUnavailable({ platform, bwrap }) {
  if (platform === 'darwin') return undefined
  if (platform === 'linux') {
    return bwrap ? undefined : 'needs bubblewrap (bwrap) on Linux, and it is not on PATH; install it (e.g. apt install bubblewrap)'
  }
  return `needs macOS sandbox-exec or Linux bubblewrap; ${platform} has neither`
}

/**
 * The argv that runs `cmd` under `mode`: sandbox-exec (macOS) or bwrap (Linux)
 * around it, or `cmd` itself for full-access. Throws on an unknown mode, and on
 * a sandboxed mode where no sandbox tool is available. `project` and `home`
 * must be real paths: sandbox-exec matches resolved paths (/tmp is
 * /private/tmp). Linux only: `bwrap` is its path (null when missing),
 * `piAgentEntries` the names now in ~/.pi/agent, `tmpdir` an existing $TMPDIR.
 */
export function sandboxArgv({ project, home, mode, cmd, platform = globalThis.process?.platform, bwrap, piAgentEntries = [], tmpdir }) {
  if (!SANDBOXES.includes(mode)) throw new Error(`sandbox must be one of ${SANDBOXES.join(', ')}`)
  if (!Array.isArray(cmd) || cmd.length === 0) throw new Error('cmd must be a non-empty argv')
  if (mode === 'full-access') return [...cmd]
  const unavailable = sandboxUnavailable({ platform, bwrap })
  if (unavailable) throw new Error(`sandbox ${mode} ${unavailable}; only sandbox: full-access runs (unconfined)`)
  if (!home) throw new Error('home is required for a sandboxed mode')
  if (mode === 'workspace-write' && !project) throw new Error('project is required for workspace-write')
  if (platform === 'linux') return bwrapArgv({ project, home, mode, cmd, bwrap, piAgentEntries, tmpdir })
  const params = ['-D', `HOME=${home}`]
  if (mode === 'workspace-write') params.push('-D', `PROJECT=${project}`)
  return ['/usr/bin/sandbox-exec', '-p', sandboxProfile(mode), ...params, ...cmd]
}

/** The bubblewrap argv (Linux); see the header comment for the layout. */
function bwrapArgv({ project, home, mode, cmd, bwrap, piAgentEntries, tmpdir }) {
  const bind = dir => ['--bind', dir, dir]
  const agent = `${home}/.pi/agent`
  const readOnly = [...new Set(piAgentEntries)]
    .filter(name => name && !name.includes('/') && name !== '.' && name !== '..' && !PI_AGENT_WRITABLE.includes(name))
    .sort()
  return [
    bwrap,
    '--ro-bind', '/', '/',
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
    ...bind('/tmp'),
    ...bind('/var/tmp'),
    ...(tmpdir && tmpdir !== '/tmp' && tmpdir !== '/var/tmp' ? bind(tmpdir) : []),
    ...(mode === 'workspace-write' ? bind(project) : []),
    ...bind(agent),
    // -try: an entry removed since it was listed is skipped, not fatal.
    ...readOnly.flatMap(name => ['--ro-bind-try', `${agent}/${name}`, `${agent}/${name}`]),
    '--die-with-parent',
    ...(project ? ['--chdir', project] : []),
    ...cmd,
  ]
}

/** The `pi --mode rpc` command line for a job (before sandboxArgv wraps it). */
export function piCommand({ piPath, model, effort, sandbox, sessionFile }) {
  return [
    piPath,
    '--mode',
    'rpc',
    '--model',
    model,
    '--thinking',
    effort,
    ...(sandbox === 'read-only' ? ['--tools', READ_ONLY_TOOLS] : []),
    ...(sessionFile ? ['--session', sessionFile] : []),
  ]
}

/** The `provider/id` names in `pi --list-models` output. */
export function parseModelList(text) {
  const models = []
  // Rows: provider, model, context, max-out, thinking yes|no, images yes|no.
  const row = /^([A-Za-z0-9._-]+)\s+(\S+)\s+\S+\s+\S+\s+(?:yes|no)\s+(?:yes|no)\s*$/
  for (const line of text.split('\n')) {
    const match = row.exec(line.trim())
    if (match) models.push(`${match[1]}/${match[2]}`)
  }
  return models
}
