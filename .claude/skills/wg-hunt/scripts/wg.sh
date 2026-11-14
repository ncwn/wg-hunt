#!/usr/bin/env bash
# wg.sh: one way into a wg-hunt server, whatever is installed.
#
#   wg.sh <wg-hunt command...>      the CLI, always with --json   (offers list --band match)
#   wg.sh api METHOD PATH [BODY|-]  one API call with curl        (api GET /offers?band=match)
#   wg.sh api --if-match REV PUT …  refused (exit 4) unless REV, the GET's noted revision, is current
#   wg.sh ops [filter]              the API's operations, from its OpenAPI document
#   wg.sh doctor                    the route, versions, the address and token in use, and signing in
#
# Routes, tried in this order (WG_HUNT_ROUTE=path|compose|curl picks one):
#   path     a `wg-hunt` on PATH (or WG_HUNT_CLI="node /somewhere/wg-hunt.mjs")
#   compose  `docker compose exec` in a running wg-hunt project (WG_HUNT_COMPOSE_DIR, WG_HUNT_SERVICE)
#   curl     the HTTP API at WG_HUNT_URL, for `api` and `ops`
# Other settings: WG_HUNT_URL, WG_HUNT_TOKEN, WG_HUNT_DATA_DIR, WG_HUNT_CACHE_TTL (seconds, default 300).
set -u

CLI=${WG_HUNT_CLI:-wg-hunt}
SERVICE=${WG_HUNT_SERVICE:-wg-hunt}
COMPOSE_DIR=${WG_HUNT_COMPOSE_DIR:-.}
WANTED=${WG_HUNT_ROUTE:-auto}
TTL=${WG_HUNT_CACHE_TTL:-300}
CONFIG_FILE="${XDG_CONFIG_HOME:-${HOME:-/nonexistent}/.config}/wg-hunt/config.json"

say() { printf 'wg-hunt: %s\n' "$*" >&2; }

json_escape() { local s=${1//\\/\\\\}; printf '%s' "${s//\"/\\\"}"; }

problem() {
  printf '{"type":"%s","title":"%s","detail":"%s"}\n' "$1" "$(json_escape "$2")" "$(json_escape "$3")" >&2
}

# The codes the CLI gives these types.
die() {
  case "$1" in
    usage-error) problem "$1" "Usage error" "$2"; exit 2 ;;
    not-configured) problem "$1" "No access token" "$2" ;;
    connection-failed) problem "$1" "Could not reach the server" "$2" ;;
    *) problem "$1" "wg.sh failed" "$2" ;;
  esac
  exit 1
}

json_string() { sed -n 's/.*"'"$1"'" *: *"\([^"]*\)".*/\1/p' | head -n 1; }

config_value() { [ -r "$CONFIG_FILE" ] && json_string "$1" <"$CONFIG_FILE"; }

BASE=${WG_HUNT_URL:-}; BASE_FROM=env
[ -n "$BASE" ] || { BASE=$(config_value url); BASE_FROM=config; }
[ -n "$BASE" ] || { BASE="http://127.0.0.1:${WG_HUNT_PORT:-8787}"; BASE_FROM=default; }
BASE=${BASE%/}

address_is_local() {
  local host=${BASE#*://}
  host=${host%%[/?#\\]*}
  host=${host##*@}
  case "$host" in
    \[*) host=${host%%\]*}; host=${host#\[} ;;
    *) host=${host%%:*} ;;
  esac
  case "$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')" in
    127.0.0.1|localhost|::1) return 0 ;;
  esac
  return 1
}

# For the curl route only; the CLI routes find their own token. TOKEN_FROM uses the CLI's words.
find_token() {
  TOKEN=""; TOKEN_FROM="none"
  if [ -n "${WG_HUNT_TOKEN:-}" ]; then TOKEN=$WG_HUNT_TOKEN; TOKEN_FROM="env"; return; fi
  local t file
  t=$(config_value token)
  if [ -n "$t" ]; then TOKEN=$t; TOKEN_FROM="config"; return; fi
  for file in "${WG_HUNT_DATA_DIR:+$WG_HUNT_DATA_DIR/access-token}" "$COMPOSE_DIR/.data/access-token" ".data/access-token"; do
    if [ -n "$file" ] && [ -r "$file" ]; then
      TOKEN=$(head -n 1 "$file" | tr -d '[:space:]')
      [ -n "$TOKEN" ] && { TOKEN_FROM="data-folder"; return; }
    fi
  done
}

major() { local v=${1#v}; printf '%s' "${v%%.*}"; }

run_path() { $CLI --json "$@"; }

# Sets CID and MODE; no subshell, so they stay.
find_container() {
  CID=""; MODE=""
  CID=$(cd "$COMPOSE_DIR" 2>/dev/null && docker compose ps --status running -q "$SERVICE" 2>/dev/null </dev/null | head -n 1)
  if [ -n "$CID" ]; then MODE=compose; return 0; fi
  CID=$(docker ps -q --filter "label=com.docker.compose.service=$SERVICE" --filter status=running 2>/dev/null </dev/null | head -n 1)
  if [ -n "$CID" ]; then MODE=label; return 0; fi
  return 1
}

run_compose() {
  find_container || die connection-failed "no running '$SERVICE' container found (set WG_HUNT_COMPOSE_DIR or WG_HUNT_SERVICE)"
  if [ "$MODE" = compose ]; then
    (cd "$COMPOSE_DIR" && docker compose exec -T "$SERVICE" wg-hunt --json "$@")
  else
    docker exec -i "$CID" wg-hunt --json "$@"
  fi
}

try_path() {
  PATH_ANSWERS=0
  command -v "${CLI%% *}" >/dev/null 2>&1 || return 1
  local out
  out=$($CLI --json health 2>/dev/null </dev/null) || return 1
  PATH_ANSWERS=1
  SERVER_VERSION=$(printf '%s' "$out" | json_string version)
  CLI_VERSION=$($CLI --version 2>/dev/null </dev/null | head -n 1)
  ROUTE=path
  # `health` needs no token. A CLI with none, or with a refused one, fails every other command
  # while the container may sign in by itself, so the route counts once a read that needs it works.
  [ "${1:-}" = reachable ] || $CLI --json profile show >/dev/null 2>&1 </dev/null
}

# The CLI on PATH answered but cannot sign in: still the route when no container is there, so
# its own problem says what to set up rather than a note that only curl is left.
path_answered() {
  [ "${PATH_ANSWERS:-0}" = 1 ] || return 1
  ROUTE=path
}

try_compose() {
  command -v docker >/dev/null 2>&1 || return 1
  local out
  find_container || return 1
  if [ "$MODE" = compose ]; then
    out=$(cd "$COMPOSE_DIR" && docker compose exec -T "$SERVICE" wg-hunt --json health 2>/dev/null </dev/null) || return 1
    CLI_VERSION=$(cd "$COMPOSE_DIR" && docker compose exec -T "$SERVICE" wg-hunt --version 2>/dev/null </dev/null | head -n 1)
  else
    out=$(docker exec -i "$CID" wg-hunt --json health 2>/dev/null </dev/null) || return 1
    CLI_VERSION=$(docker exec -i "$CID" wg-hunt --version 2>/dev/null </dev/null | head -n 1)
  fi
  SERVER_VERSION=$(printf '%s' "$out" | json_string version)
  ROUTE=compose
}

try_curl() {
  command -v curl >/dev/null 2>&1 || return 1
  local out
  out=$(curl -fsS --max-time 10 "$BASE/api/v1/health" 2>/dev/null </dev/null) || return 1
  SERVER_VERSION=$(printf '%s' "$out" | json_string version)
  CLI_VERSION=""
  ROUTE=curl
}

# The memory is kept under the settings that pick the route. Where the CLI on PATH may find a token
# is one of them, since whether it signs in decides between it and the container; no token is kept.
cache_file() {
  local dir=${TMPDIR:-/tmp}/wg-hunt-skill-$(id -u)
  mkdir -p "$dir" 2>/dev/null && chmod 700 "$dir" 2>/dev/null
  local picked_by="$BASE|$WANTED|$CLI|$SERVICE|$COMPOSE_DIR|${WG_HUNT_TOKEN:+token}|${WG_HUNT_DATA_DIR:-}"
  printf '%s/route-%s' "$dir" "$(printf '%s' "$picked_by" | cksum | cut -d' ' -f1)"
}

read_cache() {
  [ "$TTL" -gt 0 ] 2>/dev/null || return 1
  local file epoch token_file
  file=$(cache_file)
  [ -r "$file" ] || return 1
  # A token file written since (a login, a rotation) may have changed which route signs in.
  for token_file in "$CONFIG_FILE" "${WG_HUNT_DATA_DIR:+$WG_HUNT_DATA_DIR/access-token}"; do
    [ -z "$token_file" ] || [ ! -e "$token_file" ] || [ "$file" -nt "$token_file" ] || return 1
  done
  { read -r epoch; read -r ROUTE; read -r SERVER_VERSION; read -r CLI_VERSION; } <"$file"
  [ -n "${epoch:-}" ] && [ -n "${ROUTE:-}" ] && [ $(( $(date +%s) - epoch )) -lt "$TTL" ]
}

write_cache() {
  [ "$TTL" -gt 0 ] 2>/dev/null || return 0
  printf '%s\n%s\n%s\n%s\n' "$(date +%s)" "$ROUTE" "$SERVER_VERSION" "$CLI_VERSION" >"$(cache_file)" 2>/dev/null
  return 0
}

warn_on_version_mismatch() {
  [ -n "$CLI_VERSION" ] && [ -n "$SERVER_VERSION" ] || return 0
  if [ "$(major "$CLI_VERSION")" != "$(major "$SERVER_VERSION")" ]; then
    say "warning: CLI $CLI_VERSION and server $SERVER_VERSION differ in major version; commands may not match the API (compare with 'wg.sh ops')"
  fi
}

no_route() {
  local tried="on PATH, through docker compose or at $BASE"
  local fix="Start it with 'docker compose up -d', or set WG_HUNT_URL."
  say "no route to a wg-hunt server. Tried:"
  say "  wg-hunt on PATH (or WG_HUNT_CLI), answering 'health'"
  if [ "$WANTED" = auto ] && ! address_is_local; then
    # A container here is another instance than the one named, so starting one is no way back.
    tried="on PATH or at $BASE"
    fix="Check that address and that its server is up. A container on this machine is not tried for another machine's address; WG_HUNT_ROUTE=compose uses one all the same."
  else
    say "  docker compose exec into a running '$SERVICE' (WG_HUNT_COMPOSE_DIR=$COMPOSE_DIR)"
  fi
  say "  curl $BASE/api/v1/health (WG_HUNT_URL)"
  say "$fix"
  [ "${1:-}" = noted ] || problem connection-failed "No route to a wg-hunt server" \
    "Nothing answered /health $tried. $fix"
}

forget_route() { rm -f "$(cache_file)" 2>/dev/null; return 0; }

# After a command failed on a remembered route: if that route no longer answers /health, the
# server is down rather than the command wrong, so forget the route and say how to start it.
recheck_route() {
  [ "$FROM_CACHE" = 1 ] || return 0
  case "$ROUTE" in
    path) try_path reachable ;;
    compose) try_compose ;;
    curl) try_curl ;;
  esac && return 0
  forget_route
  no_route noted
}

detect() {
  local only=${1:-$WANTED} fresh=${2:-}
  FROM_CACHE=0
  if [ -z "$fresh" ] && [ "$only" = "$WANTED" ] && read_cache; then FROM_CACHE=1; return 0; fi
  case "$only" in
    auto) try_path || { address_is_local && try_compose; } || path_answered || try_curl ;;
    path|cli) try_path || path_answered ;;
    compose|docker) try_compose ;;
    curl) try_curl ;;
    *) die usage-error "unknown WG_HUNT_ROUTE '$only' (use path, compose or curl)" ;;
  esac || { no_route; exit 1; }
  say "route: $ROUTE (server ${SERVER_VERSION:-?}${CLI_VERSION:+, cli $CLI_VERSION})"
  warn_on_version_mismatch
  [ "$only" = "$WANTED" ] && write_cache
  return 0
}

# exit-by-type: begin. Mirrors EXIT_BY_TYPE in apps/cli/src/problem.ts; a test keeps them in step.
exit_for_type() {
  case "$1" in
    unauthorized|invalid-token|origin-not-allowed|internal-error) echo 1 ;;
    validation-error|invalid-body|invalid-cursor) echo 2 ;;
    not-found|not-known|offer-merged) echo 3 ;;
    bot-check-cooldown|wipe-running|search-disabled|unknown-city|offer-untracked|no-api-key|api-key-refused|analysis-in-batch|spend-cap-reached|analysis-run-active|nothing-to-reanalyze|offer-has-one-ad|stale-revision) echo 4 ;;
    *) return 1 ;;
  esac
}
# exit-by-type: end

# For a type the table lacks, such as a newer server's (or `http-error`, whose status varies).
exit_for_status() {
  case "$1" in
    404) echo 3 ;;
    409|412) echo 4 ;;
    400) echo 2 ;;
    *) echo 1 ;;
  esac
}

crawl_now_outcome() {
  local reply=$1 waiting
  waiting=$(json_string waiting <"$reply")
  [ -n "$waiting" ] || return 0
  case "$waiting" in
    # crawl-now-holds
    needs-resume|paused|layout-changed|disk-full|wiped) ;;
    *) grep -Eq '"runsAt" *: *null' "$reply" || return 0 ;;
  esac
  printf '{"type":"crawl-waits-for-resume","title":"Crawl now waits for a Resume","detail":"The poll is queued, but it runs only after a person resumes the crawl.","waiting":"%s"}\n' "$waiting" >&2
  return 4
}

api_call() {
  local if_match=""
  if [ "${1:-}" = "--if-match" ]; then
    if_match=${2:-}
    [ -n "$if_match" ] || die usage-error "usage: wg.sh api --if-match REVISION METHOD PATH [JSON|-]"
    shift 2
  fi
  local method=${1:-} path=${2:-} body=${3:-}
  [ -n "$method" ] && [ -n "$path" ] || die usage-error "usage: wg.sh api [--if-match REVISION] METHOD PATH [JSON|-]"
  case "$path" in
    /api/v1/*) path=${path#/api/v1} ;;
  esac
  case "$path" in
    //*|*://*|[!/]*) die usage-error "PATH is a path on the wg-hunt API, such as /offers?band=match" ;;
  esac
  method=$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')
  case "${path%%\?*}" in
    /auth/token/rotate*) die usage-error "the API's reply to a rotation is the new token, which would be printed. Use 'wg.sh token rotate': it saves the token and prints none" ;;
  esac
  detect curl
  find_token
  [ -n "$TOKEN" ] || die not-configured "set WG_HUNT_TOKEN, run 'wg-hunt login', or point WG_HUNT_DATA_DIR at the data folder"
  local out head status code args etag
  out=$(mktemp "${TMPDIR:-/tmp}/wg-hunt-reply.XXXXXX") || die internal-error "cannot create a temporary file"
  head=$(mktemp "${TMPDIR:-/tmp}/wg-hunt-head.XXXXXX") || { rm -f "$out"; die internal-error "cannot create a temporary file"; }
  args=(-sS --max-time 60 -o "$out" -D "$head" -w '%{http_code}' -X "$method" -H 'Accept: application/json')
  if [ -n "$if_match" ]; then
    case "$if_match" in
      *[$'\r\n']*) rm -f "$out" "$head"; die usage-error "--if-match takes one revision, such as \"3f2a…\"" ;;
      \"*\"|W/\"*\") ;;
      *) if_match="\"$if_match\"" ;;
    esac
    args+=(-H "If-Match: $if_match")
  fi
  if [ "$body" = "-" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary @-)
  elif [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary "$body")
  fi
  # The token goes in through a config on a pipe, so it is not in the process list.
  status=$(curl "${args[@]}" --config <(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN") "$BASE/api/v1$path" 2>/dev/null)
  local rc=$?
  if [ $rc -ne 0 ] || [ -z "$status" ]; then
    rm -f "$out" "$head"; say "could not reach $BASE (curl exit $rc)"; forget_route; no_route; exit 1
  fi
  # The revision goes to stderr, as the CLI's `Revision:` line does, so stdout stays the JSON.
  etag=$(sed -n 's/^[Ee][Tt][Aa][Gg]: *\(.*[^[:space:]]\)[[:space:]]*$/\1/p' "$head" | head -n 1)
  rm -f "$head"
  case "$status" in 2??) [ -n "$etag" ] && say "revision: $etag" ;; esac
  case "$status" in
    2??)
      cat "$out"; code=0
      if [ "$method" = POST ]; then
        case "${path%%\?*}" in
          /searches/*/crawl-now) crawl_now_outcome "$out"; code=$? ;;
        esac
      fi ;;
    *)
      cat "$out" >&2; echo >&2
      code=$(exit_for_type "$(json_string type <"$out")") || code=$(exit_for_status "$status") ;;
  esac
  rm -f "$out"
  return $code
}

ops() {
  detect curl
  local doc
  doc=$(curl -fsS --max-time 20 "$BASE/api/v1/openapi.json" 2>/dev/null) || die connection-failed "could not read $BASE/api/v1/openapi.json"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$doc" | jq -r '.paths | to_entries[] | .key as $p | .value | to_entries[]
      | select(.key | test("^(get|post|put|patch|delete)$"))
      | "\(.key | ascii_upcase) \($p)  \(.value.summary // "")"' | { if [ -n "${1:-}" ]; then grep -i -- "$1"; else cat; fi; }
  else
    say "jq is not installed, so here is the raw document:"
    printf '%s\n' "$doc"
  fi
}

doctor() {
  detect "$WANTED" fresh
  local url token sign_in="" report err code=0
  if [ "$ROUTE" = curl ]; then
    find_token
    url="$BASE ($BASE_FROM)"; token=$TOKEN_FROM
  else
    err=$(mktemp "${TMPDIR:-/tmp}/wg-hunt-doctor.XXXXXX") || die internal-error "cannot create a temporary file"
    if [ "$ROUTE" = path ]; then
      report=$(run_path doctor 2>"$err" </dev/null); code=$?
    else
      report=$(run_compose doctor 2>"$err" </dev/null); code=$?
    fi
    if [ $code -eq 2 ]; then
      # A CLI from before `doctor` refuses it as an unknown command.
      : >"$err"; code=0
      url=unknown; token=unknown; sign_in=unknown
      say "this CLI has no 'doctor', so where its address and token come from is unknown; update the CLI to see it"
    else
      url=$(printf '%s' "$report" | json_string url)
      [ -z "$url" ] || url="$url ($(printf '%s' "$report" | json_string urlSource))"
      token=$(printf '%s' "$report" | json_string tokenSource)
      sign_in=$(printf '%s' "$report" | json_string signIn)
    fi
    # The container's CLI talks to the server beside it, not to the address the other routes use.
    [ "$ROUTE" = compose ] && url="the container's own server (container ${CID:0:12})"
  fi
  printf 'route: %s\nserver: %s\ncli: %s\nurl: %s\ntoken: %s\n' \
    "$ROUTE" "${SERVER_VERSION:-unknown}" "${CLI_VERSION:-none}" "${url:-unknown}" "${token:-unknown}"
  [ "$ROUTE" = curl ] || printf 'sign-in: %s\n' "${sign_in:-unknown}"
  if [ -n "${err:-}" ]; then cat "$err" >&2; rm -f "$err"; fi
  return $code
}

usage() {
  awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"
}

case "${1:-}" in
  ""|-h|--help|help) usage; exit 0 ;;
  api) shift; api_call "$@"; exit $? ;;
  ops) shift; ops "$@"; exit $? ;;
  doctor|route) doctor; exit $? ;;
esac

detect
case "$ROUTE" in
  path) run_path "$@" ;;
  compose) run_compose "$@" ;;
  curl)
    die usage-error "only curl is available, so CLI commands cannot run. Use: wg.sh api GET /offers?band=match  (wg.sh ops lists the operations)" ;;
esac
rc=$?
[ $rc -eq 1 ] && recheck_route
exit $rc
