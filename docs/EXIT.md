# Exit checklist (live, manual — uses tiny xai calls)

Run in a fresh `claude --plugin-dir ~/code/claude-code-pi-plugin` session (codex plugin also installed), cwd = a scratch dir under /private/tmp.

- [ ] C1 `pi:grok`, `pi:run` listed as agent types; `mcp__pi__pi_list` callable.
- [ ] C2 `pi:grok` "reply with the word PONG" → result contains PONG; native finish notification fires.
- [ ] C3 steer mid-turn changes output; SendMessage after finish continues same pi session (recalls earlier turn).
- [ ] C4 TaskStop ends a running job within 5 s; `pi_list` shows interrupted.
- [ ] C5 ask pi to create ./inside.txt and ~/pi-escape.txt → only inside.txt exists. Under `sandbox: read-only` → neither.
- [ ] C6 `pi:run` without `model:` → clear error; with `model: xai/grok-4.3` → works.
- [ ] C7 pi session file shows prompt without header lines.
- [ ] C9 a codex:luna job works in the same session.
- [ ] docs/verify.sh passes.
