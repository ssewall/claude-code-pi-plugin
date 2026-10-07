# Pulling in upstream changes

This plugin is a fork of [SSS135/claude-code-codex-plugin](https://github.com/SSS135/claude-code-codex-plugin).
GitHub does not sync forks on its own, and our `main` has diverged a lot, so updates are brought in by hand.

## Never do this

- Do not click **Sync fork → Discard commits** on GitHub.
- Do not run `gh repo sync --force`.

Both reset `main` to the upstream Codex plugin and throw away the pi work.

## Check for updates

```sh
git remote add upstream https://github.com/SSS135/claude-code-codex-plugin.git  # once per clone
git fetch upstream
git log --oneline main..upstream/main      # what upstream added since we last merged
```

No output means there is nothing new.

## Decide what to take

Most of our code was rewritten, so look at each upstream commit and sort it:

| Upstream change touches | What to do |
|---|---|
| Codex only: `bin/bridge.mjs`'s app-server calls, `bin/codex-msg`, approvals, Codex sandbox flags | Usually skip. |
| Shared plumbing: wrapper agents, `turn.step`, the job store, SendMessage/TaskStop handling, the hint line, daemon lifetime and leaks, the hooks API | Take it. Port it by hand into `hooks/register.tsx`, `hooks/model.ts` or `bin/bridge.mjs`. |
| Changes to the Claude Code plugin API (`.claude-plugin/types`, the shape of `hooks.json`) | Take it. These often keep the plugin loading on new Claude Code versions. |
| README, assets, demo GIF | Skip. |

## Merge

```sh
git checkout -b upstream-sync main
git merge upstream/main          # expect conflicts; keep our version of anything Codex-specific
# or cherry-pick only the commits you want: git cherry-pick <sha>
./docs/verify.sh                 # must print ALL AUTOMATED CHECKS PASS
git checkout main && git merge --ff-only upstream-sync && git push origin main
```

Merging (rather than only cherry-picking) records that upstream is merged up to that point, so the next `git log main..upstream/main` shows only newer commits.

If a change touches the bridge or sandbox, also run the live checks in `docs/EXIT.md`.

## Update the installs

Both installs read the local clone directly:

- Mac: `~/code/claude-code-pi-plugin`
- Linux host: `~/code/claude-code-pi-plugin`

On each machine, `git pull` (on whichever branch is checked out), then start a new Claude Code session.
