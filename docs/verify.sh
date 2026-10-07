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

echo "== sandbox blocks writes outside the project (no model call; sandbox-exec on macOS, bwrap on Linux)"
# The scratch project is not under a temp dir: those stay writable in every mode.
proj=$(mktemp -d "$PWD/.verify-proj.XXXXXX"); proj=$(cd "$proj" && pwd -P)
trap 'rm -f "$proj/in" "$proj/ro"; rmdir "$proj" 2>/dev/null || true' EXIT
# run_sandboxed MODE SCRIPT: runs /bin/sh -c SCRIPT under sandboxArgv, as the bridge would.
run_sandboxed() {
  node --input-type=module -e "
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
    const { spawnSync, execSync } = await import('node:child_process');
    const m = await import('$PWD/bin/sandbox.mjs');
    const home = fs.realpathSync(os.homedir());
    const linux = {};
    if (process.platform === 'linux') {
      let bwrap = null; try { bwrap = execSync('command -v bwrap', { shell: '/bin/sh' }).toString().trim() || null } catch {}
      const agent = path.join(home, '.pi', 'agent'); fs.mkdirSync(agent, { recursive: true });
      Object.assign(linux, { bwrap, piAgentEntries: fs.readdirSync(agent) });
    }
    const argv = m.sandboxArgv({ project: '$proj', home, mode: process.argv[1], cmd: ['/bin/sh', '-c', process.argv[2]], ...linux });
    process.exit(spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', cwd: '$proj' }).status ?? 1);
  " "$1" "$2"
}
run_sandboxed workspace-write 'touch "$PWD/in"; touch "$HOME/pi-verify-escape" 2>/dev/null; exit 0' || fail "sandboxed run failed to start"
[ -f "$proj/in" ] || fail "sandbox blocked an in-project write"
if [ -e "$HOME/pi-verify-escape" ]; then rm -f "$HOME/pi-verify-escape"; fail "sandbox allowed a write to \$HOME"; fi
run_sandboxed read-only 'touch "$PWD/ro" 2>/dev/null; exit 0' || fail "read-only run failed to start"
[ -e "$proj/ro" ] && fail "read-only sandbox allowed a project write"

echo "ALL AUTOMATED CHECKS PASS"
