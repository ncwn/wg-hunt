#!/bin/sh
# Starts as root only to make the mounted data folder writable (Docker creates a missing
# bind-mount source as root), then runs wg-hunt as the unprivileged `node` user.
set -e

# What wg-hunt writes (the database, the token, saved pages) is for its user alone.
umask 077

if [ "$(id -u)" = "0" ]; then
  chown node:node "$WG_HUNT_DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
