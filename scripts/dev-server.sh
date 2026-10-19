#!/bin/sh
# Recreate the disposable hub-test profile, install the local checkout, and
# serve it. Usage: scripts/dev-server.sh [port] [dsh-home]
set -eu

PORT="${1:-5601}"
HOME_DIR="${2:-/tmp/hub-dev-home}"
PROFILE=hub-test
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_BIN="$ROOT/node_modules/.bin/dsh"

mkdir -p /tmp/dsh-bin
if [ -n "${PNPM_BIN:-}" ]; then
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$PNPM_BIN" > /tmp/dsh-bin/pnpm
elif command -v pnpm >/dev/null 2>&1; then
  printf '#!/bin/sh\nexec pnpm "$@"\n' > /tmp/dsh-bin/pnpm
elif [ -f "${DSH_RUNTIME_PNPM:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs}" ]; then
  RUNTIME_PNPM="${DSH_RUNTIME_PNPM:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs}"
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$RUNTIME_PNPM" > /tmp/dsh-bin/pnpm
else
  echo "no pnpm found; set PNPM_BIN or install pnpm" >&2
  exit 1
fi
chmod +x /tmp/dsh-bin/pnpm
CACHE_DIR="${NPM_CACHE:-/tmp/npm-cache}"

if [ ! -x "$DSH_BIN" ]; then
  DSH_BIN="npx --yes @deepseek-ai/dsh@0.2.1-rc.2"
fi

PATH="/tmp/dsh-bin:$PATH" DSH_HOME="$HOME_DIR" npm_config_cache="$CACHE_DIR" \
  $DSH_BIN --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null

cat > "$HOME_DIR/profiles/$PROFILE/cordis.patch.yml" <<'PATCH'
- id: ui-settings-general
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: ui-settings-account
  config:
    version: 1
    step: done
    usage: detailed
    developerTools: true
    purpose: null
    process: standard
    completion: api-key
PATCH

PATH="/tmp/dsh-bin:$PATH" DSH_HOME="$HOME_DIR" npm_config_cache="$CACHE_DIR" \
  $DSH_BIN plugin --profile "$PROFILE" add "$ROOT" >/dev/null

pkill -f "dsh.*--profile $PROFILE.*--port $PORT" 2>/dev/null || true
sleep 1
PATH="/tmp/dsh-bin:$PATH" DSH_HOME="$HOME_DIR" npm_config_cache="$CACHE_DIR" \
  nohup $DSH_BIN --profile "$PROFILE" --port "$PORT" --no-open > /tmp/hub-dev-$PORT.log 2>&1 &
sleep 8
grep -o "http://127.0.0.1:$PORT/?token=[A-Za-z0-9_-]*" /tmp/hub-dev-$PORT.log
