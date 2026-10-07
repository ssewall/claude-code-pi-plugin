#!/usr/bin/env bash
# Automated checks for docs/SPEC.md. Live model checks (criteria 2-7, 9) are in docs/EXIT.md.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $*"; exit 1; }

echo "== validate"; claude plugin validate . || fail "plugin validate"
echo "== tests";    claude plugin test .     || fail "plugin tests"

echo "== no codex leftovers in runtime code"
if grep -rnE "codex app-server|turn/steer|thread/start|mcp__codex__|cxb-" hooks bin types 2>/dev/null; then
  fail "codex-specific code remains"
fi

echo "== names don't collide with codex plugin"
grep -q '"name": *"pi"' .claude-plugin/plugin.json || fail "plugin name is not 'pi'"
grep -rq "pxb-" bin hooks || fail "bridge socket dir should be /tmp/pxb-<uid>"

echo "== sandbox profile blocks a write outside the project (no model call)"
tmp=$(mktemp -d); proj=$(cd "$tmp" && pwd -P)
node --input-type=module -e "
  const m = await import('$PWD/bin/sandbox.mjs');
  const argv = m.sandboxArgv({ project: '$proj', home: process.env.HOME, mode: 'workspace-write', cmd: ['/bin/sh','-c','touch \"$proj/in\"; touch \"\$HOME/pi-verify-escape\" 2>/dev/null; exit 0'] });
  const { spawnSync } = await import('node:child_process');
  spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
"
[ -f "$proj/in" ] || fail "sandbox blocked an in-project write"
if [ -e "$HOME/pi-verify-escape" ]; then rm -f "$HOME/pi-verify-escape"; fail "sandbox allowed a write to \$HOME"; fi
rm -rf "$tmp"

echo "ALL AUTOMATED CHECKS PASS"
