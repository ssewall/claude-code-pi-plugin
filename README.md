# pi for Claude Code

A Claude Code plugin that runs the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) as native Claude Code background subagents. Claude hands a task to a `pi:grok` (or `pi:run`) agent through its own Agent tool and carries on. The job shows in the native task list, `SendMessage` steers it, `TaskStop` aborts it, and when it finishes Claude gets the normal subagent notification with pi's final message as the result.

This is a fork of [SSS135/claude-code-codex-plugin](https://github.com/SSS135/claude-code-codex-plugin), which does the same for OpenAI Codex. The wrapper-agent design, job store and transcript rows come from it; the backend is replaced with pi. It installs as a separate plugin named `pi`, so it runs side by side with the codex plugin.

## How it works

The plugin registers two agent types:

| Agent type | Model | Default effort | Use it for |
| --- | --- | --- | --- |
| `pi:grok` | `xai/grok-4.7` | high | Grok, through pi. |
| `pi:run` | whatever the prompt's `model:` line names | high | Any model `pi --list-models` shows. The `model:` line is required (or a project default, see below). |

Claude uses them like `general-purpose`, so you can ask in plain words, for example "have a pi grok agent review retry.ts". A call looks like:

```json
{ "subagent_type": "pi:run", "description": "Review retry logic", "prompt": "model: xai/grok-4.3\neffort: medium\nReview retry.ts for bugs." }
```

What happens then:

- The plugin checks the header, the model (against `pi --list-models`) and the sandbox before the subagent starts, so a bad one refuses the Agent call itself.
- It starts one `pi --mode rpc` process for the job, in the Agent call's `cwd` or the session's, and sends the prompt exactly as given (header lines taken off). Nothing is relayed through a Claude model.
- The agent the engine starts is a thin wrapper. Every model request of its loop is answered by the plugin (a `turn.step` hook): while pi works, the wrapper calls the plugin's `pi_await` tool; once pi's turn ends, it hands back pi's final message, word for word.
- `SendMessage` to the agent (by agentId, or the `name` the Agent call gave) goes to pi first: a `steer` while the turn runs, or a new `prompt` in the same pi session once it finished. pi keeps the conversation, so a follow-up can refer to the earlier turn. If the pi process is gone (the bridge restarted), the plugin relaunches pi with `--session <file>` on the same session file.
- `TaskStop`, or stopping the task from the task list, sends pi `abort`; the job then shows as `interrupted` in `pi_list`.

### Prompt header lines

Optional lines at the very top of the prompt, one `key: value` each. They are taken off before pi sees the prompt.

| Line | Values | Default |
| --- | --- | --- |
| `model:` | `provider/id`, as `pi --list-models` names it. `pi:run` only. | the project's `model`; otherwise required |
| `effort:` | off, minimal, low, medium, high, xhigh, max (`ultra` is accepted and means max) | high, unless `defaultEffort` or the project sets one |
| `sandbox:` | read-only, workspace-write, full-access | `defaultSandbox` |

An unknown value, a key given twice, `model:` on `pi:grok`, a model pi does not list, or a prompt with nothing after its header refuses the Agent call. pi passes the effort to the model as its thinking level (`--thinking`); what a model that lacks that level gets is pi's choice.

There is no `approvals:` line. pi has no approval hooks, so nothing is ever asked: the sandbox alone limits what a job can write. An `approvals:` line is refused with an error rather than ignored.

## Sandbox

Sandboxed modes work on macOS (with `sandbox-exec`) and Linux (with [bubblewrap](https://github.com/containers/bubblewrap), `bwrap`). The rules are the same on both, apart from one gap on Linux, listed below.

### macOS

pi runs under `sandbox-exec` with this profile (see `bin/sandbox.mjs`):

```
(version 1)(allow default)(deny file-write*)
(allow file-write* (subpath PROJECT) (subpath "/private/tmp") (subpath "/private/var/folders")
                   (subpath "~/.pi/agent/sessions")
                   (literal "~/.pi/agent/auth.json") (literal "~/.pi/agent/auth.json.lock")
                   (literal "~/.pi/agent/settings.json") (literal "~/.pi/agent/settings.json.lock")
                   (subpath "/dev"))
```

- `workspace-write` (default): pi and every process it starts can write only inside the project (its real path), `/private/tmp`, `/private/var/folders` (the per-user temp dirs), `/dev`, pi's own session directory, and pi's credential and settings files (below). A write anywhere else fails with "Operation not permitted".
- `read-only`: the same profile without the project, and pi is started with only its read tools (`--tools read,grep,find,ls`).
- `full-access`: no sandbox at all. Claude should use it only when you ask for it explicitly.

### Linux

pi runs under `bwrap` (bubblewrap: an unprivileged tool that runs a program in its own view of the filesystem). The command looks like this:

```
bwrap --ro-bind / / --dev-bind /dev /dev --proc /proc
      --bind /tmp /tmp --bind /var/tmp /var/tmp [--bind $TMPDIR $TMPDIR]
      --bind PROJECT PROJECT                      # workspace-write only
      --bind ~/.pi/agent ~/.pi/agent
      --ro-bind-try ~/.pi/agent/<entry> ...       # every existing entry but sessions/, auth.json, settings.json
      --die-with-parent --chdir PROJECT  pi --mode rpc ...
```

The whole filesystem is mounted read-only, then the writable paths are mounted on top. Network is shared. A write anywhere else fails with "Read-only file system".

- Install bubblewrap first (`sudo apt install bubblewrap` on Debian and Ubuntu). Without it, `workspace-write` and `read-only` refuse to start with an error that says so; only `full-access` runs.
- **Gap vs macOS:** bwrap can only mount paths that already exist, and pi creates its lock directories (`auth.json.lock`, `settings.json.lock`) on the fly. So all of `~/.pi/agent` is mounted writable, and then each entry already in it (except `sessions/`, `auth.json` and `settings.json`) is mounted read-only again when pi starts. Existing extensions, `npm/`, `models.json` and so on stay read-only, but a sandboxed job **can create new files** in `~/.pi/agent`. A new file there could be one pi reads later (for example a `models.json` that did not exist before), so keep that in mind.
- On Ubuntu 23.10 and later, AppArmor blocks unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`), which bwrap needs. If `bwrap --ro-bind / / true` fails with "Permission denied" or "setting up uid map", give bwrap an AppArmor profile that allows them, for example `/etc/apparmor.d/bwrap`:

  ```
  abi <abi/4.0>,
  include <tunables/global>
  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,
  }
  ```

  then `sudo apparmor_parser -r /etc/apparmor.d/bwrap`.

Any other system: sandboxed modes refuse to start rather than run unconfined.

### Limits

Know what it does not do:

- **Reads are open.** pi can read any file your user can, including `~/.ssh`, `~/.aws` and `.env` files. This matches Codex's `workspace-write`.
- **Network is open.** The model API needs it, and so does anything pi's tools fetch.
- **No approvals.** Nothing asks you before a command runs. Inside the writable paths, pi can do anything.
- `/tmp` is writable in every mode, so a project that lives under `/tmp` is writable even with `read-only` (there, only the read-only tool list stops pi from writing).
- pi's credential and settings files are writable: `~/.pi/agent/auth.json`, `~/.pi/agent/settings.json`, and their lock directories `auth.json.lock` and `settings.json.lock`. pi locks each file (by creating the `.lock` directory) before it reads it, so without these pi cannot read your API keys at all, and it rewrites `auth.json` when it refreshes an OAuth token (xAI login, for example). **Tradeoff:** a sandboxed job can overwrite `auth.json` and `settings.json`. Nothing else in `~/.pi` is writable: not extensions, `npm/`, or `models.json`.
- Sandboxed modes need macOS or Linux with bwrap. Elsewhere `workspace-write` and `read-only` refuse to start rather than run unconfined; only `full-access` runs.
- `sandbox-exec` is deprecated by Apple but still works.
- On Linux, `/tmp` and `/var/tmp` (and `$TMPDIR`) are the temp dirs that stay writable.

## Install

From a clone:

```
claude --plugin-dir /path/to/claude-code-pi-plugin
```

Or add the repo as a marketplace:

```
claude plugin marketplace add ssewall/claude-code-pi-plugin
claude plugin install pi@pi-plugin
```

### Requirements

- Claude Code with the hooks plugin API (function hooks, currently early access).
- pi 1.0 or newer (`pi --mode rpc`), with credentials for the providers you use (`pi auth`).
- Node 18 or newer.
- macOS, or Linux with `bwrap`, for the sandboxed modes.

## Tools

Besides the agent types, Claude sees two tools as `mcp__pi__<name>`:

| Tool | Parameters | What it does |
| --- | --- | --- |
| `pi_list` | none | This session's pi jobs, newest first, at most 10, with model, effort, sandbox, status, tokens and current activity. |
| `pi_result` | `id`, `full` | Status and final message. With `full=true` it adds the turn digest: tool calls with their outcome, notes and steers. |

`id` is the agent's agentId or the job's name (its description). A third tool, `pi_await`, serves the wrapper agents only.

In the transcript each call is one row, for example `● Pi(list)` over `⎿  2 agents · 1 running`. While jobs run they are also named at the end of the hint line under the prompt (`pi: Review retry logic (grok-4.7)`).

## Configuration

Set these in the install screen or the plugin's config menu (`userConfig`):

| Option | Default | Meaning |
| --- | --- | --- |
| `piPath` | empty | The pi CLI. When unset or missing, the plugin tries `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `~/.local/bin`, `~/.local/npm/bin`, `~/.npm-global/bin`, then PATH. |
| `nodePath` | empty | Node used to run the bridge (and pi, which is a Node script). Found the same way as `piPath`. |
| `defaultEffort` | `per-model` | `per-model` uses each agent's own default (high). Any other level applies to every agent. |
| `defaultSandbox` | `workspace-write` | read-only, workspace-write, full-access. |

A project can set its own defaults in `.claude/pi.json`. The plugin uses the nearest one found walking up to the project root:

```json
{ "effort": "medium", "sandbox": "workspace-write", "model": "xai/grok-4.3" }
```

`model` is the model `pi:run` uses when its prompt has no `model:` line; `pi:grok` always runs Grok. The prompt's header lines beat `.claude/pi.json`, which beats `userConfig`, which beats the built-in defaults.

## Architecture

The hooks module (`hooks/register.tsx`, with the pure logic in `hooks/model.ts`) starts `bin/bridge.mjs` as a relay. The relay launches a detached daemon, or reattaches to one still running, in `/tmp/pxb-<uid>/<session>-<build>/` (the codex plugin uses `/tmp/cxb-<uid>/`, so the two never meet). The daemon serves HTTP on a Unix socket there and owns one `pi --mode rpc` child per job, wrapped by `sandbox-exec` (macOS) or `bwrap` (Linux). It talks JSONL to each child on stdin and stdout and relays the events the plugin needs as NDJSON.

| Plugin action | pi RPC |
| --- | --- |
| Agent call | `prompt` |
| SendMessage while running | `steer` |
| SendMessage after the turn | `prompt` on the live process, or a relaunch with `--session <file>` first |
| TaskStop | `abort` |
| Final message | the last assistant message of `agent_end`, else `get_last_assistant_text` |

A turn ends at `agent_settled` (or 3 seconds after a final `agent_end` if that never comes). Dialogs that pi extensions open are cancelled, since there is no one to answer them.

The bridge exists because the plugin API cannot write to a child's stdin once it has spawned it. The daemon runs detached so that pi turns keep running through a plugin reload.

Processes end with the work they serve:

- Each pi process stays alive between turns (so a follow-up continues the same process) until the daemon exits.
- The daemon exits 20 seconds after its relay goes away (the Claude session ended), or after 10 minutes with no turn running and no request. Every pi process exits with it. The plugin starts a new daemon on demand, and a job's next message relaunches pi on its session file.
- The daemon's directory names the bridge build (its path and code), so a session reloaded onto another plugin version starts a new daemon, and the old one exits once its relay is gone.

## Known limits

- The wrapper agent is defined on `haiku`, because an agent type must name a Claude model; the plugin answers every request of its loop, so that model is never called.
- pi cannot message Claude mid-task (the codex plugin's `message_claude` is not ported).
- A steer is delivered after pi's current tool calls finish, before its next model call.
- The final message is passed on whole up to 20,000 characters.
- `tokens` in `pi_list` is the sum of each model call's reported total, so it counts the context once per call.
- The running-jobs line under the prompt is drawn on the terminal only.
- The hooks plugin API is early access and may change between Claude Code releases.

## Development

```
claude plugin validate .
claude plugin test .
docs/verify.sh
claude --plugin-dir .
```

## License

MIT. See [LICENSE](LICENSE). Original work copyright (c) 2026 SSS135; forked from [SSS135/claude-code-codex-plugin](https://github.com/SSS135/claude-code-codex-plugin).
