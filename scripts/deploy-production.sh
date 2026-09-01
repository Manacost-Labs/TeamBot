#!/usr/bin/env bash

set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
compose_file="$repo_dir/docker-compose.production.yml"
base_environment_file="$repo_dir/.env"
protected_auth_environment_file="$repo_dir/.env.manacostteam-auth"
drain_timeout_seconds=${DEPLOY_DRAIN_TIMEOUT_SECONDS:-1800}

if ! [[ "$drain_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
	echo "DEPLOY_DRAIN_TIMEOUT_SECONDS must be a positive integer." >&2
	exit 2
fi

# The protected file, not an inherited interactive shell, is authoritative for these values. This
# also keeps them out of every Docker, sudo and helper process the deployment starts.
unset TELEGRAM_LOGIN_BOT_TOKEN TELEGRAM_ALLOWED_USER_IDS TELEGRAM_OWNER_USER_IDS OPENROUTER_MODEL

docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then
	# Compose must receive required interpolation variables through sudo.
	docker_cmd=(sudo -n -E docker)
fi
# `--env-file` feeds Compose interpolation only. Services still receive only the explicit variables
# in the Compose file, so the combined Telegram/OpenRouter operator file is never injected wholesale
# into the model-facing agent container. Values stay out of arguments; only protected file paths are
# passed to Compose. Removing these four inherited variables also makes the protected file the only
# source at Compose's highest interpolation precedence.
compose_cmd=(
	env
	-u TELEGRAM_LOGIN_BOT_TOKEN
	-u TELEGRAM_ALLOWED_USER_IDS
	-u TELEGRAM_OWNER_USER_IDS
	-u OPENROUTER_MODEL
	"${docker_cmd[@]}" compose
	--env-file "$base_environment_file"
	--env-file "$protected_auth_environment_file"
	-f "$compose_file"
)

if [[ -z ${ARTIFACT_RENDERER_TOKEN:-} ]]; then
	artifact_container=workkolodahearthstonecom-artifact-renderer-1
	if ! "${docker_cmd[@]}" inspect "$artifact_container" >/dev/null 2>&1; then
		echo "ARTIFACT_RENDERER_TOKEN is not set and no running production renderer can supply it." >&2
		exit 2
	fi
	ARTIFACT_RENDERER_TOKEN=$(
		"${docker_cmd[@]}" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
			"$artifact_container" |
			sed -n 's/^ARTIFACT_RENDERER_TOKEN=//p' |
			head -1
	)
	export ARTIFACT_RENDERER_TOKEN
fi

build_services=("$@")
services=("${build_services[@]}")
replace_openbot=false

# routine-worker shares OpenBot's network namespace so it can reach embedded PostgreSQL on
# 127.0.0.1. Recreating OpenBot alone leaves an already-running worker attached to the retired
# namespace: its process stays up, but every database query and heartbeat fails. Always replace the
# worker beside a targeted OpenBot replacement. A full deployment already includes both services.
if ((${#services[@]})); then
	openbot_selected=false
	routine_worker_selected=false
	for service in "${services[@]}"; do
		[[ "$service" == openbot ]] && openbot_selected=true
		[[ "$service" == routine-worker ]] && routine_worker_selected=true
	done
	if [[ "$openbot_selected" == true && "$routine_worker_selected" == false ]]; then
		services+=(routine-worker)
	fi
	replace_openbot=$openbot_selected
else
	replace_openbot=true
fi

"${compose_cmd[@]}" config --quiet
if ((${#build_services[@]})); then
	"${compose_cmd[@]}" build "${build_services[@]}"
else
	"${compose_cmd[@]}" build
fi

agent_container=$("${compose_cmd[@]}" ps -q agent-codex 2>/dev/null || true)
drain_started=false
routine_worker_stopped=false

resume_agent() {
	local container
	container=$("${compose_cmd[@]}" ps -q agent-codex 2>/dev/null || true)
	if [[ -z "$container" ]] || ! "${docker_cmd[@]}" inspect "$container" >/dev/null 2>&1; then
		return
	fi
	"${docker_cmd[@]}" exec "$container" bun -e '
    const response = await fetch("http://127.0.0.1:4202/admin/resume", {
      method: "POST",
      headers: { "x-openbot-agent-token": process.env.MANAGED_AGENT_TOKEN },
    });
    process.exit(response.ok ? 0 : 1);
  ' >/dev/null 2>&1 || true
}

cleanup() {
	if [[ "$routine_worker_stopped" == true ]]; then
		"${compose_cmd[@]}" up -d --no-build routine-worker >/dev/null 2>&1 || true
	fi
	if [[ "$drain_started" == true ]]; then
		resume_agent
	fi
}
trap cleanup EXIT

if [[ -n "$agent_container" ]] && "${docker_cmd[@]}" inspect "$agent_container" >/dev/null 2>&1; then
	"${docker_cmd[@]}" exec "$agent_container" bun -e '
    const response = await fetch("http://127.0.0.1:4202/admin/drain", {
      method: "POST",
      headers: { "x-openbot-agent-token": process.env.MANAGED_AGENT_TOKEN },
    });
    process.exit(response.ok ? 0 : 1);
  ' >/dev/null
	drain_started=true

	deadline=$((SECONDS + drain_timeout_seconds))
	while ((SECONDS < deadline)); do
		# The `${...}` expression below belongs to the Bun program, not to this shell.
		# shellcheck disable=SC2016
		snapshot=$(
			"${docker_cmd[@]}" exec "$agent_container" bun -e '
        const response = await fetch("http://127.0.0.1:4202/health");
        const body = await response.json();
        console.log(`${body.managedRuns?.active ?? -1} ${body.managedRuns?.queued ?? -1}`);
      '
		)
		read -r active queued <<<"$snapshot"
		if [[ "$active" == 0 && "$queued" == 0 ]]; then
			break
		fi
		echo "Waiting for active managed runs to finish: active=$active queued=$queued" >&2
		sleep 5
	done
	if [[ "$active" != 0 || "$queued" != 0 ]]; then
		echo "Deployment cancelled: managed runs did not drain within ${drain_timeout_seconds}s." >&2
		exit 1
	fi
fi

# A container that shares another service's network namespace must leave that namespace before
# Compose can replace its owner. Stopping it after the managed-run drain also prevents the worker
# from submitting new work during the narrow replacement window.
if [[ "$replace_openbot" == true ]]; then
	"${compose_cmd[@]}" stop --timeout 30 routine-worker
	routine_worker_stopped=true
fi

if ((${#services[@]})); then
	"${compose_cmd[@]}" up -d --no-build --wait "${services[@]}"
else
	"${compose_cmd[@]}" up -d --no-build --wait
fi

routine_worker_stopped=false
resume_agent
drain_started=false
trap - EXIT
