# Spec: pi backend plugin for Claude Code

## Underlying need
Run non-Claude models (via the `pi` CLI) as native background subagents in Claude Code, with the same feel as the codex plugin, without giving them write access outside the project.

## Scope (in)
- GitHub fork of SSS135/claude-code-codex-plugin as `ssewall/claude-code-pi-plugin`, cloned to `~/code/claude-code-pi-plugin`, installable as a local plugin alongside the codex plugin (no name collisions).
- Keep the function-hooks wrapper layer: wrapper agents answered in `turn.step`, an await tool, job store that survives reload, SendMessage → steer (or new turn when finished), TaskStop → abort, header-line parsing, per-project defaults file.
- Replace the Codex bridge with a pi bridge: a detached daemon (same Unix-socket HTTP + NDJSON relay pattern) that owns one `pi --mode rpc` child per job.
  - start → `prompt`; steer mid-turn → `steer`; message after finish → `prompt` on the same live process (or relaunch with `--session <file>` if the process died); interrupt → `abort`; final text → `agent_end` / `get_last_assistant_text`.
- Agents:
  - `pi:grok` → `xai/grok-4.7`, default thinking `high`.
  - `pi:run` → generic; model chosen by a `model: provider/id` header line (required; clear error if missing or unknown to `pi --list-models`).
- Header lines (stripped before pi sees the prompt): `model:` (pi:run only), `effort: off|minimal|low|medium|high|xhigh|max` (`ultra` accepted as alias for `max`), `sandbox: read-only|workspace-write|full-access`.
- Sandbox via `sandbox-exec` (profile from spike):
  - `workspace-write` (default): writes allowed only to the project realpath, `/private/tmp`, `/private/var/folders`, `/dev`, and pi's session dir. Reads and network open.
  - `read-only`: same profile minus the project dir, plus `--tools read,grep,find,ls`.
  - `full-access`: no sandbox-exec. Only when the header asks for it.
- Tools: `mcp__pi__pi_list`, `mcp__pi__pi_result` (status + final message; `full=true` adds tool-call digest), `pi_await` for wrappers.
- Defaults file `.claude/pi.json` `{effort, sandbox, model}`; plugin userConfig `piPath`, `nodePath`, `defaultEffort`, `defaultSandbox`.
- README rewritten for pi; MIT license and original copyright kept, fork credited.

## Scope (out / anti-goals)
- No approval dialogs or `approvals:` header (pi has no approval hooks). Header is rejected with a clear message, not silently ignored.
- No multi-backend abstraction; this is a separate plugin, not a refactor of the codex plugin.
- No changes to upstream codex plugin or PRs to it.
- Not hiding secrets from reads (`~/.ssh` etc. stay readable) — same as codex workspace-write. Documented in README.
- skipped: `message_claude` (pi → Claude mid-task messaging) — add when a real task needs pi to ask Claude something mid-run.
- skipped: Gemini/OpenAI preset agents — add when wanted; `pi:run` covers them meanwhile.
- skipped: Linux sandbox (bwrap) — add when run on Linux; on non-macOS, `workspace-write` refuses to start rather than run unsandboxed.

## Done criteria
1. `claude plugin validate` (or equivalent load) passes; with the plugin installed, `pi:grok` and `pi:run` appear as agent types next to `codex:*`, and `mcp__pi__pi_list` is callable.
2. `pi:grok` with prompt "reply with the word PONG" returns text containing PONG as the subagent result and triggers the native completion notification.
3. Steer: a long task steered mid-turn via SendMessage changes its output; a SendMessage after completion starts a new turn in the same session (pi remembers the earlier turn).
4. TaskStop on a running job ends it within 5 s and the job shows as interrupted in `pi_list`.
5. Sandbox, checked by a real model-driven run in a scratch project: pi asked to create `./inside.txt` and `~/pi-escape.txt` → first exists, second does not exist (and the run reports a permission error). Same request under `sandbox: read-only` → neither file exists.
6. `pi:run` without a `model:` header returns a clear error; with `model: xai/grok-4.3` it works.
7. Header lines are not present in the prompt pi receives (verified from the pi session file).
8. Unit tests (bun/node test runner, whichever upstream uses) for header parsing, effort mapping, sandbox profile/argv building, and pi RPC event → job state reduction; all pass.
9. Running both plugins at once: codex jobs still work (bridge socket dirs and tool names don't collide).

## Decisions made
- Fork, not new repo: user choice. Fork renamed to `claude-code-pi-plugin` so it's clearly a different plugin.
- Keep the bridge daemon: the plugin API can't write to a child's stdin, the same reason upstream has it. Socket dir `/tmp/pxb-<uid>/`.
- sandbox-exec, not a container: spike showed it confines pi and all child processes with 5 write paths and no startup breakage. It's deprecated by Apple but works on Darwin 27.
- pi state write access narrowed to `~/.pi/agent/sessions` (not all of `~/.pi`) so the agent can't rewrite pi's auth/config/extensions. If a real run shows pi needs more, widen to the specific path and record why.
- Network open: user choice; model APIs need it anyway.
- Grok model `xai/grok-4.7` (newest xai model in `pi --list-models`).
- One pi process per job, kept alive until the job is dismissed or the bridge idles out (mirrors Codex thread lifetime).

## Decisions deferred
- Whether to publish the fork as a marketplace entry: after it works locally; user decides.

## Test seams
- Header parsing / effort / sandbox argv → pure functions in `hooks/model.ts`, unit-tested.
- RPC event handling → reducer from pi JSONL events to job state, unit-tested with recorded event fixtures.
- End-to-end → the Agent tool (`pi:grok`, `pi:run`) + `pi_list`/`pi_result`, exercised manually in a Claude Code session (criteria 2–7, 9).

## Constraints
- macOS only for sandboxed modes. Node 18+. Claude Code with the function-hooks plugin API.
- Live model calls in done criteria use xai credits; keep test prompts tiny.
- Don't touch the installed codex plugin.
