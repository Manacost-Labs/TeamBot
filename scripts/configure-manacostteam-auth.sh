#!/usr/bin/env bash

set -euo pipefail
set +x

helper_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
if [[ -z "$helper_path" || ! -f "$helper_path" ]]; then
	printf 'INVALID HELPER_PATH\n' >&2
	exit 2
fi
script_dir="${helper_path%/*}"
source_root="$(cd -P -- "$script_dir/.." && pwd)"
test_mode="${MANACOSTTEAM_AUTH_TEST_MODE:-}"
test_root="${MANACOSTTEAM_AUTH_TEST_ROOT:-}"
test_input_fd="${MANACOSTTEAM_AUTH_INPUT_FD:-}"
test_expected_source_root="${MANACOSTTEAM_AUTH_TEST_EXPECT_SOURCE_ROOT:-}"
test_pause_stage="${MANACOSTTEAM_AUTH_TEST_PAUSE_STAGE:-}"
test_ready_fd="${MANACOSTTEAM_AUTH_TEST_READY_FD:-}"
test_continue_fd="${MANACOSTTEAM_AUTH_TEST_CONTINUE_FD:-}"
if [[ "$test_mode" == 1 ]]; then
	project_root="$test_root"
	input_fd="$test_input_fd"
else
	if [[ -n "$test_mode" || -n "$test_root" || -n "$test_input_fd" || -n "$test_expected_source_root" || -n "$test_pause_stage" || -n "$test_ready_fd" || -n "$test_continue_fd" ]]; then
		printf 'INVALID TEST_CONFIGURATION\n' >&2
		exit 2
	fi
	project_root="$source_root"
	input_fd=''
fi
config_file="$project_root/.env.manacostteam-auth"
mode='write'

usage() {
	printf 'Usage: %s [--dry-run]\n' "$0" >&2
}

if [[ $# -gt 1 ]]; then
	usage
	exit 2
fi
if [[ $# -eq 1 ]]; then
	case "$1" in
	--dry-run) mode=dry-run ;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage
		exit 2
		;;
	esac
fi

if [[ "$project_root" != /* || ! -d "$project_root" || -L "$project_root" ]]; then
	printf 'INVALID OPERATOR_CONFIG\n' >&2
	exit 2
fi
if [[ "$test_mode" == 1 ]]; then
	if [[ "$(stat -c '%a' "$project_root")" != 700 || "$(stat -c '%u' "$project_root")" != "$EUID" ]]; then
		printf 'INVALID TEST_CONFIGURATION\n' >&2
		exit 2
	fi
	if [[ -n "$test_expected_source_root" && "$source_root" != "$test_expected_source_root" ]]; then
		printf 'INVALID TEST_CONFIGURATION\n' >&2
		exit 2
	fi
	if [[ -n "$test_pause_stage" || -n "$test_ready_fd" || -n "$test_continue_fd" ]]; then
		if [[ "$test_pause_stage" != before-recheck && "$test_pause_stage" != before-rename ]]; then
			printf 'INVALID TEST_CONFIGURATION\n' >&2
			exit 2
		fi
		for control_fd in "$test_ready_fd" "$test_continue_fd"; do
			if [[ ! "$control_fd" =~ ^[0-9]+$ || "$control_fd" -lt 3 || "$control_fd" -gt 255 ]]; then
				printf 'INVALID TEST_CONFIGURATION\n' >&2
				exit 2
			fi
		done
	fi
fi

bot_token=''
oidc_client_id=''
oidc_client_secret=''
allowed_ids=''
owner_ids=''
openrouter_model=''
seen_bot_token=false
seen_oidc_client_id=false
seen_oidc_client_secret=false
seen_allowed_ids=false
seen_owner_ids=false
seen_openrouter_model=false
config_invalid=false
temporary_file=''

wipe_sensitive() {
	unset bot_token oidc_client_id oidc_client_secret allowed_ids owner_ids openrouter_model
	unset new_bot_token new_oidc_client_id new_oidc_client_secret new_allowed_ids new_owner_ids new_openrouter_model
	unset candidate_bot_token candidate_oidc_client_id candidate_oidc_client_secret candidate_allowed_ids candidate_owner_ids candidate_openrouter_model
	unset candidate_owner_ids_trimmed
}

cleanup() {
	wipe_sensitive
	if [[ -n "$temporary_file" ]]; then
		rm -f -- "$temporary_file"
	fi
}
trap cleanup EXIT
trap 'exit 1' HUP TERM
trap 'exit 130' INT

load_config() {
	local line

	[[ -f "$config_file" ]] || return 0
	while IFS= read -r line || [[ -n "$line" ]]; do
		line="${line%$'\r'}"
		case "$line" in
		'' | \#*) ;;
		TELEGRAM_LOGIN_BOT_TOKEN=*)
			if [[ "$seen_bot_token" == true ]]; then
				config_invalid=true
			else
				seen_bot_token=true
				bot_token="${line#*=}"
			fi
			;;
		TELEGRAM_OIDC_CLIENT_ID=*)
			if [[ "$seen_oidc_client_id" == true ]]; then
				config_invalid=true
			else
				seen_oidc_client_id=true
				oidc_client_id="${line#*=}"
			fi
			;;
		TELEGRAM_OIDC_CLIENT_SECRET=*)
			if [[ "$seen_oidc_client_secret" == true ]]; then
				config_invalid=true
			else
				seen_oidc_client_secret=true
				oidc_client_secret="${line#*=}"
			fi
			;;
		TELEGRAM_ALLOWED_USER_IDS=*)
			if [[ "$seen_allowed_ids" == true ]]; then
				config_invalid=true
			else
				seen_allowed_ids=true
				allowed_ids="${line#*=}"
			fi
			;;
		TELEGRAM_OWNER_USER_IDS=*)
			if [[ "$seen_owner_ids" == true ]]; then
				config_invalid=true
			else
				seen_owner_ids=true
				owner_ids="${line#*=}"
			fi
			;;
		OPENROUTER_MODEL=*)
			if [[ "$seen_openrouter_model" == true ]]; then
				config_invalid=true
			else
				seen_openrouter_model=true
				openrouter_model="${line#*=}"
			fi
			;;
		*) config_invalid=true ;;
		esac
	done <"$config_file"
}

trim_value() {
	local value=$1
	local destination=$2

	value="${value#"${value%%[![:space:]]*}"}"
	value="${value%"${value##*[![:space:]]}"}"
	printf -v "$destination" '%s' "$value"
}

normalize_id_list() {
	local raw=$1
	local destination=$2
	local trimmed
	local item
	local normalized=''
	local existing
	local -a items=()
	local -a accepted=()

	trim_value "$raw" trimmed
	if [[ -z "$trimmed" || ${#trimmed} -gt 4096 ]]; then
		return 1
	fi
	if [[ "$trimmed" == ,* || "$trimmed" == *, || "$trimmed" == *,,* ]]; then
		return 1
	fi
	IFS=',' read -r -a items <<<"$trimmed"
	if [[ ${#items[@]} -gt 256 ]]; then
		return 1
	fi
	for item in "${items[@]}"; do
		trim_value "$item" item
		if [[ ! "$item" =~ ^[1-9][0-9]*$ ]]; then
			return 1
		fi
		if [[ ${#item} -gt 16 ]]; then
			return 1
		fi
		if [[ ${#item} -eq 16 ]] && ((10#$item > 9007199254740991)); then
			return 1
		fi
		for existing in "${accepted[@]}"; do
			if [[ "$existing" == "$item" ]]; then
				return 1
			fi
		done
		accepted+=("$item")
		if [[ -n "$normalized" ]]; then
			normalized+=','
		fi
		normalized+="$item"
	done
	printf -v "$destination" '%s' "$normalized"
}

owners_are_subset() {
	local allowed=$1
	local owners=$2
	local owner
	local allowed_id
	local found
	local -a allowed_items=()
	local -a owner_items=()

	IFS=',' read -r -a allowed_items <<<"$allowed"
	IFS=',' read -r -a owner_items <<<"$owners"
	for owner in "${owner_items[@]}"; do
		found=false
		for allowed_id in "${allowed_items[@]}"; do
			if [[ "$allowed_id" == "$owner" ]]; then
				found=true
				break
			fi
		done
		[[ "$found" == true ]] || return 1
	done
}

bot_token_is_valid() {
	local value=$1

	[[ ${#value} -le 256 && "$value" =~ ^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,}$ ]]
}

oidc_client_id_is_valid() {
	local value=$1

	[[ "$value" =~ ^[1-9][0-9]{4,15}$ ]]
}

oidc_client_secret_is_valid() {
	local value=$1

	[[ "$value" =~ ^[A-Za-z0-9._~-]{20,256}$ ]]
}

model_is_valid() {
	local value=$1

	[[ ${#value} -le 200 && "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]]
}

operator_target_is_safe() {
	if [[ -L "$config_file" || (-e "$config_file" && ! -f "$config_file") ]]; then
		return 1
	fi
	if [[ -f "$config_file" ]]; then
		[[ "$(stat -c '%a' "$config_file")" == 600 && "$(stat -c '%h' "$config_file")" == 1 ]]
	fi
}

test_pause() {
	local stage=$1
	local response=''

	[[ "$test_mode" == 1 && "$test_pause_stage" == "$stage" ]] || return 0
	printf 'READY %s\n' "$stage" >&"$test_ready_fd"
	if ! IFS= read -r -u "$test_continue_fd" response || [[ "$response" != CONTINUE ]]; then
		printf 'INVALID TEST_CONTROL\n' >&2
		exit 2
	fi
}

validate_and_report() {
	local token=$1
	local oidc_id=$2
	local oidc_secret=$3
	local allowed=$4
	local owners=$5
	local model=$6
	local report=$7
	local valid=true
	local normalized_allowed=''
	local normalized_owners=''
	local allowed_valid=false
	local owners_valid=false

	if [[ -z "$token" ]]; then
		[[ "$report" == true ]] && printf 'MISSING TELEGRAM_LOGIN_BOT_TOKEN\n'
		valid=false
	elif ! bot_token_is_valid "$token"; then
		[[ "$report" == true ]] && printf 'INVALID TELEGRAM_LOGIN_BOT_TOKEN\n'
		valid=false
	fi

	if [[ -z "$oidc_id" ]]; then
		[[ "$report" == true ]] && printf 'MISSING TELEGRAM_OIDC_CLIENT_ID\n'
		valid=false
	elif ! oidc_client_id_is_valid "$oidc_id"; then
		[[ "$report" == true ]] && printf 'INVALID TELEGRAM_OIDC_CLIENT_ID\n'
		valid=false
	fi

	if [[ -z "$oidc_secret" ]]; then
		[[ "$report" == true ]] && printf 'MISSING TELEGRAM_OIDC_CLIENT_SECRET\n'
		valid=false
	elif ! oidc_client_secret_is_valid "$oidc_secret"; then
		[[ "$report" == true ]] && printf 'INVALID TELEGRAM_OIDC_CLIENT_SECRET\n'
		valid=false
	fi

	if [[ -z "$allowed" ]]; then
		[[ "$report" == true ]] && printf 'MISSING TELEGRAM_ALLOWED_USER_IDS\n'
		valid=false
	elif normalize_id_list "$allowed" normalized_allowed; then
		allowed_valid=true
	else
		[[ "$report" == true ]] && printf 'INVALID TELEGRAM_ALLOWED_USER_IDS\n'
		valid=false
	fi

	if [[ -z "$owners" ]]; then
		[[ "$report" == true ]] && printf 'MISSING TELEGRAM_OWNER_USER_IDS\n'
		valid=false
	elif normalize_id_list "$owners" normalized_owners; then
		owners_valid=true
	else
		[[ "$report" == true ]] && printf 'INVALID TELEGRAM_OWNER_USER_IDS\n'
		valid=false
	fi

	if [[ -z "$model" ]]; then
		[[ "$report" == true ]] && printf 'MISSING OPENROUTER_MODEL\n'
		valid=false
	elif ! model_is_valid "$model"; then
		[[ "$report" == true ]] && printf 'INVALID OPENROUTER_MODEL\n'
		valid=false
	fi

	if [[ "$owners_valid" == true ]]; then
		[[ "$report" == true ]] && printf 'RELATION TELEGRAM_OWNER_USER_IDS non-empty: ok\n'
	else
		[[ "$report" == true ]] && printf 'RELATION TELEGRAM_OWNER_USER_IDS non-empty: failed\n'
	fi
	if [[ "$allowed_valid" == true && "$owners_valid" == true ]]; then
		if owners_are_subset "$normalized_allowed" "$normalized_owners"; then
			[[ "$report" == true ]] && printf 'RELATION TELEGRAM_OWNER_USER_IDS subset-of TELEGRAM_ALLOWED_USER_IDS: ok\n'
		else
			[[ "$report" == true ]] && printf 'RELATION TELEGRAM_OWNER_USER_IDS subset-of TELEGRAM_ALLOWED_USER_IDS: failed\n'
			valid=false
		fi
	else
		[[ "$report" == true ]] && printf 'RELATION TELEGRAM_OWNER_USER_IDS subset-of TELEGRAM_ALLOWED_USER_IDS: unknown\n'
	fi

	[[ "$valid" == true ]]
}

if ! operator_target_is_safe; then
	printf 'INVALID OPERATOR_CONFIG\n' >&2
	exit 2
fi
if [[ "$mode" == write ]]; then
	umask 077
	temporary_file="$(mktemp "$config_file.tmp.XXXXXX")"
fi
load_config

if [[ "$mode" == dry-run ]]; then
	status=0
	if [[ "$config_invalid" == true ]]; then
		printf 'INVALID OPERATOR_CONFIG\n'
		status=1
	fi
	if ! validate_and_report \
		"$bot_token" \
		"$oidc_client_id" \
		"$oidc_client_secret" \
		"$allowed_ids" \
		"$owner_ids" \
		"$openrouter_model" \
		true; then
		status=1
	fi
	exit "$status"
fi

if [[ "$config_invalid" == true ]]; then
	printf 'INVALID OPERATOR_CONFIG\n' >&2
	exit 2
fi
if [[ -n "$input_fd" ]]; then
	if [[ ! "$input_fd" =~ ^[0-9]+$ || "$input_fd" -lt 3 || "$input_fd" -gt 255 ]]; then
		printf 'INVALID PRIVATE_INPUT\n' >&2
		exit 2
	fi
elif [[ ! -t 0 || ! -t 2 ]]; then
	printf 'Private interactive terminal required.\n' >&2
	exit 2
fi

read_private() {
	local label=$1
	local destination=$2
	local value=''

	printf '%s [hidden; blank keeps current]: ' "$label" >&2
	if [[ -n "$input_fd" ]]; then
		if ! IFS= read -r -u "$input_fd" value; then
			printf '\nINVALID PRIVATE_INPUT\n' >&2
			exit 2
		fi
	else
		IFS= read -r -s value
	fi
	printf '\n' >&2
	printf -v "$destination" '%s' "$value"
}

new_bot_token=''
new_oidc_client_id=''
new_oidc_client_secret=''
new_allowed_ids=''
new_owner_ids=''
new_openrouter_model=''
read_private TELEGRAM_LOGIN_BOT_TOKEN new_bot_token
read_private TELEGRAM_OIDC_CLIENT_ID new_oidc_client_id
read_private TELEGRAM_OIDC_CLIENT_SECRET new_oidc_client_secret
read_private TELEGRAM_ALLOWED_USER_IDS new_allowed_ids
read_private TELEGRAM_OWNER_USER_IDS new_owner_ids
read_private OPENROUTER_MODEL new_openrouter_model

candidate_bot_token="${new_bot_token:-$bot_token}"
candidate_oidc_client_id="${new_oidc_client_id:-$oidc_client_id}"
candidate_oidc_client_secret="${new_oidc_client_secret:-$oidc_client_secret}"
candidate_allowed_ids="${new_allowed_ids:-$allowed_ids}"
candidate_owner_ids="${new_owner_ids:-$owner_ids}"
candidate_openrouter_model="${new_openrouter_model:-$openrouter_model}"
unset new_bot_token new_oidc_client_id new_oidc_client_secret new_allowed_ids new_owner_ids new_openrouter_model

trim_value "$candidate_owner_ids" candidate_owner_ids_trimmed
if [[ -z "$candidate_owner_ids_trimmed" || "$candidate_owner_ids_trimmed" == - ]]; then
	printf 'REFUSED TELEGRAM_OWNER_USER_IDS non-empty\n' >&2
	exit 2
fi
unset candidate_owner_ids_trimmed
if ! validate_and_report \
	"$candidate_bot_token" \
	"$candidate_oidc_client_id" \
	"$candidate_oidc_client_secret" \
	"$candidate_allowed_ids" \
	"$candidate_owner_ids" \
	"$candidate_openrouter_model" \
	true; then
	exit 2
fi

normalize_id_list "$candidate_allowed_ids" candidate_allowed_ids
normalize_id_list "$candidate_owner_ids" candidate_owner_ids

{
	printf 'TELEGRAM_LOGIN_BOT_TOKEN=%s\n' "$candidate_bot_token"
	printf 'TELEGRAM_OIDC_CLIENT_ID=%s\n' "$candidate_oidc_client_id"
	printf 'TELEGRAM_OIDC_CLIENT_SECRET=%s\n' "$candidate_oidc_client_secret"
	printf 'TELEGRAM_ALLOWED_USER_IDS=%s\n' "$candidate_allowed_ids"
	printf 'TELEGRAM_OWNER_USER_IDS=%s\n' "$candidate_owner_ids"
	printf 'OPENROUTER_MODEL=%s\n' "$candidate_openrouter_model"
} >"$temporary_file"
wipe_sensitive

test_pause before-recheck
if ! operator_target_is_safe; then
	printf 'INVALID OPERATOR_CONFIG\n' >&2
	exit 2
fi
test_pause before-rename
mv -T -- "$temporary_file" "$config_file"
temporary_file=''

printf 'Configuration updated. Values were not printed.\n'
