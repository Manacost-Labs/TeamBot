#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/.." && pwd)"
env_file="$project_root/.env"
mode=${1:-all}

if [[ "$mode" != all && "$mode" != --transcript-only ]]; then
  printf 'Usage: %s [--transcript-only]\n' "$0" >&2
  exit 2
fi

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
transcriptapi_token=''
tinyfish_key=''
if [[ "$mode" == all ]]; then
  prompt_secret 'RedditAPI key' reddit_key
  prompt_secret 'GetXAPI key' getx_key
fi
prompt_secret 'TranscriptAPI token' transcriptapi_token
if [[ "$mode" == all ]]; then
  prompt_secret 'TinyFish API key' tinyfish_key
fi

umask 077
touch "$env_file"
chmod 0600 "$env_file"
temporary_env="$(mktemp "${env_file}.tmp.XXXXXX")"
trap 'rm -f -- "$temporary_env"' EXIT

seen_reddit=false
seen_getx=false
seen_transcriptapi=false
seen_tinyfish=false

while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    RESEARCH_REDDITAPIS_KEY=*)
      if [[ "$mode" == all ]]; then
        printf 'RESEARCH_REDDITAPIS_KEY=%s\n' "$reddit_key"
      else
        printf '%s\n' "$line"
      fi
      seen_reddit=true
      ;;
    RESEARCH_GETXAPI_KEY=*)
      if [[ "$mode" == all ]]; then
        printf 'RESEARCH_GETXAPI_KEY=%s\n' "$getx_key"
      else
        printf '%s\n' "$line"
      fi
      seen_getx=true
      ;;
    RESEARCH_TRANSCRIPTAPI_TOKEN=*)
      printf 'RESEARCH_TRANSCRIPTAPI_TOKEN=%s\n' "$transcriptapi_token"
      seen_transcriptapi=true
      ;;
    RESEARCH_TINYFISH_API_KEY=*)
      if [[ "$mode" == all ]]; then
        printf 'RESEARCH_TINYFISH_API_KEY=%s\n' "$tinyfish_key"
      else
        printf '%s\n' "$line"
      fi
      seen_tinyfish=true
      ;;
    *) printf '%s\n' "$line" ;;
  esac
done <"$env_file" >"$temporary_env"

if [[ "$mode" == all && "$seen_reddit" == false ]]; then
  printf 'RESEARCH_REDDITAPIS_KEY=%s\n' "$reddit_key" >>"$temporary_env"
fi
if [[ "$mode" == all && "$seen_getx" == false ]]; then
  printf 'RESEARCH_GETXAPI_KEY=%s\n' "$getx_key" >>"$temporary_env"
fi
if [[ "$seen_transcriptapi" == false ]]; then
  printf 'RESEARCH_TRANSCRIPTAPI_TOKEN=%s\n' "$transcriptapi_token" >>"$temporary_env"
fi
if [[ "$mode" == all && "$seen_tinyfish" == false ]]; then
  printf 'RESEARCH_TINYFISH_API_KEY=%s\n' "$tinyfish_key" >>"$temporary_env"
fi

chmod 0600 "$temporary_env"
mv -- "$temporary_env" "$env_file"
trap - EXIT
unset reddit_key getx_key transcriptapi_token tinyfish_key

printf 'Research provider keys saved. Values were not printed.\n'
printf 'Ask the operator to restart research-sources, agent-codex and openbot.\n'
