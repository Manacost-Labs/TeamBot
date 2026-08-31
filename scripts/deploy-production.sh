#!/usr/bin/env bash

set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
compose_file="$repo_dir/docker-compose.production.yml"
drain_timeout_seconds=${DEPLOY_DRAIN_TIMEOUT_SECONDS:-1800}

if ! [[ "$drain_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
	echo "DEPLOY_DRAIN_TIMEOUT_SECONDS must be a positive integer." >&2
	exit 2
fi

docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then
	docker_cmd=(sudo -n docker)
fi
compose_cmd=("${docker_cmd[@]}" compose -f "$compose_file")

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

services=("$@")
"${compose_cmd[@]}" config --quiet
if ((${#services[@]})); then
	"${compose_cmd[@]}" build "${services[@]}"
else
	"${compose_cmd[@]}" build
fi

agent_container=$("${compose_cmd[@]}" ps -q agent-codex 2>/dev/null || true)
drain_started=false

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

if ((${#services[@]})); then
	"${compose_cmd[@]}" up -d --no-build --wait "${services[@]}"
else
	"${compose_cmd[@]}" up -d --no-build --wait
fi

resume_agent
drain_started=false
trap - EXIT
