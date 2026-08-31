#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/.." && pwd)"
env_file="$project_root/.env"

if [[ ! -t 0 || ! -t 1 ]]; then
  printf 'Run this command in an interactive terminal.\n' >&2
  exit 2
fi

prompt_secret() {
  local label=$1
  local destination=$2
  local value

  read -r -s -p "$label: " value
  printf '\n'
  if [[ -z "$value" ]]; then
    printf '%s cannot be empty. No secrets were changed.\n' "$label" >&2
    exit 2
  fi
  printf -v "$destination" '%s' "$value"
}

printf 'Values stay hidden and are written only to %s.\n' "$env_file"
reddit_key=''
getx_key=''
tinyfish_key=''
prompt_secret 'RedditAPI key' reddit_key
prompt_secret 'GetXAPI key' getx_key
prompt_secret 'TinyFish API key' tinyfish_key

umask 077
touch "$env_file"
chmod 0600 "$env_file"
temporary_env="$(mktemp "${env_file}.tmp.XXXXXX")"
trap 'rm -f -- "$temporary_env"' EXIT

seen_reddit=false
seen_getx=false
seen_tinyfish=false

while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    RESEARCH_REDDITAPIS_KEY=*)
      printf 'RESEARCH_REDDITAPIS_KEY=%s\n' "$reddit_key"
      seen_reddit=true
      ;;
    RESEARCH_GETXAPI_KEY=*)
      printf 'RESEARCH_GETXAPI_KEY=%s\n' "$getx_key"
      seen_getx=true
      ;;
    RESEARCH_TINYFISH_API_KEY=*)
      printf 'RESEARCH_TINYFISH_API_KEY=%s\n' "$tinyfish_key"
      seen_tinyfish=true
      ;;
    *) printf '%s\n' "$line" ;;
  esac
done <"$env_file" >"$temporary_env"

if [[ "$seen_reddit" == false ]]; then
  printf 'RESEARCH_REDDITAPIS_KEY=%s\n' "$reddit_key" >>"$temporary_env"
fi
if [[ "$seen_getx" == false ]]; then
  printf 'RESEARCH_GETXAPI_KEY=%s\n' "$getx_key" >>"$temporary_env"
fi
if [[ "$seen_tinyfish" == false ]]; then
  printf 'RESEARCH_TINYFISH_API_KEY=%s\n' "$tinyfish_key" >>"$temporary_env"
fi

chmod 0600 "$temporary_env"
mv -- "$temporary_env" "$env_file"
trap - EXIT
unset reddit_key getx_key tinyfish_key

printf 'Research provider keys saved. Values were not printed.\n'
printf 'Ask the operator to restart research-sources and agent-codex.\n'
