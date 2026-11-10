#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-wg-hunt:smoke}"
NAME="wg-hunt-smoke-$$"
DATA="$(mktemp -d)"
PORT="${SMOKE_PORT:-18787}"
VERSION="$(node -p 'require("./package.json").version')"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # The container gives the data folder to its own user and keeps its files to that user, so
  # only a container can empty it and give it back before it is removed here.
  docker run --rm -v "$DATA:/data" --entrypoint sh "$IMAGE" \
    -c "rm -rf /data/* /data/.[!.]*; chown $(id -u):$(id -g) /data" >/dev/null 2>&1 || true
  rm -rf "$DATA"
}

# The host may not read the data folder: on Linux it belongs to the container's user once it has
# started (Docker Desktop on macOS hides this).
in_data() {
  docker exec -w /app/.data "$NAME" sh -c "$1"
}
trap cleanup EXIT

if [ -z "${IMAGE_PREBUILT:-}" ]; then
  docker build -t "$IMAGE" .
fi

start() {
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8787" -v "$DATA:/app/.data" "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null | grep -q '"status":"ok"'; then
      return 0
    fi
    sleep 1
  done
  echo "health check did not answer; container logs:" >&2
  docker logs "$NAME" >&2
  return 1
}

start
in_data 'test -s access-token' || { echo "access token was not written to the data folder" >&2; exit 1; }
in_data 'test -f wg-hunt.sqlite' || { echo "database was not written to the data folder" >&2; exit 1; }
[ -n "$(docker run --rm -v "$DATA:/data" --entrypoint sh "$IMAGE" -c 'ls -A /data')" ] \
  || { echo "the data folder on the host is empty" >&2; exit 1; }
token_before="$(in_data 'cat access-token')"
docker exec "$NAME" wg-hunt offers list --json >/dev/null \
  || { echo "wg-hunt inside the container could not list Offers" >&2; exit 1; }
server_version="$(curl -fsS "http://127.0.0.1:$PORT/api/v1/health" | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>process.stdout.write(JSON.parse(s).version))')"
[ "$server_version" = "$VERSION" ] || { echo "server reports $server_version, expected $VERSION" >&2; exit 1; }
cli_version="$(docker exec "$NAME" wg-hunt --version)"
[ "$cli_version" = "$VERSION" ] || { echo "wg-hunt --version prints $cli_version, expected $VERSION" >&2; exit 1; }

docker rm -f "$NAME" >/dev/null
start
[ "$(in_data 'cat access-token')" = "$token_before" ] || { echo "token changed across a restart" >&2; exit 1; }

echo "smoke test passed"
