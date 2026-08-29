#!/bin/sh
# Migrations, for the embedded database only.
#
# An external database is somebody else's release process: two replicas starting together would
# race, and a failed migration should stop a deploy rather than leave a half-migrated database
# serving. An embedded one has exactly one process and no deploy pipeline, so doing it here is the
# difference between the container working and the operator reading a runbook.
set -eu
[ "${EMBEDDED_POSTGRES:-off}" = "on" ] || exit 0

# s6 marks a longrun as started as soon as its process exists, while PostgreSQL still needs a brief
# recovery window before it accepts connections. Wait here so the first boot and every restart do
# not race the migration against postmaster startup.
attempt=0
until /usr/lib/postgresql/16/bin/pg_isready -q -h 127.0.0.1 -p 5432 -U openbot -d openbot; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "migrate: PostgreSQL did not become ready within 30 seconds." >&2
    exit 1
  fi
  sleep 0.5
done

cd /app/server
# `scripts/migrate.ts`, not `drizzle-kit`. The CLI is a development dependency and needs esbuild to
# read its TypeScript config, which `bun install --production` leaves out of this image: asked to
# migrate here it exits 1 without printing why, and the container comes up against an empty database.
exec s6-setuidgid pwuser /usr/local/bin/bun scripts/migrate.ts
