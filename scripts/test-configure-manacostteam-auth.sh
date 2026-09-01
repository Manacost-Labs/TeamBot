#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/.." && pwd)"
helper="$script_dir/configure-manacostteam-auth.sh"
test_root="$(mktemp -d /tmp/manacostteam-auth-test.XXXXXX)"
trap 'rm -rf -- "$test_root"' EXIT
process_wrapper_dir="$test_root/process-wrappers"
mkdir -m 0700 -- "$process_wrapper_dir"
read -r -d '' process_wrapper <<'WRAPPER' || true
#!/usr/bin/env bash
set -euo pipefail
set +x
capture_file="${MANACOSTTEAM_AUTH_PROCESS_CAPTURE:?}"
mapfile -d '' -t captured_arguments <"/proc/$$/cmdline"
mapfile -d '' -t captured_environment <"/proc/$$/environ"
{
	for captured_value in "${captured_arguments[@]}"; do
		printf 'ARG %q\n' "$captured_value"
	done
	for captured_value in "${captured_environment[@]}"; do
		printf 'ENV %q\n' "$captured_value"
	done
} >"$capture_file"
exec /usr/bin/mv "$@"
WRAPPER
printf '%s\n' "$process_wrapper" >"$process_wrapper_dir/mv"
chmod 0700 "$process_wrapper_dir/mv"
unset process_wrapper

test_count=0
last_status=0
last_output=''

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

pass() {
	test_count=$((test_count + 1))
	printf 'ok %d - %s\n' "$test_count" "$1"
}

assert_redacted() {
	local output=$1
	shift
	local value

	for value in "$@"; do
		if [[ -n "$value" && "$output" == *"$value"* ]]; then
			fail 'helper output exposed a configured value'
		fi
	done
}

run_with_input() {
	local root=$1
	local input_file=$2
	shift 2
	local output_file="$root/helper-output"

	set +e
	PATH="$process_wrapper_dir:$PATH" \
		MANACOSTTEAM_AUTH_PROCESS_CAPTURE="$root/mv-process-boundary" \
		MANACOSTTEAM_AUTH_TEST_MODE=1 \
		MANACOSTTEAM_AUTH_TEST_ROOT="$root" \
		MANACOSTTEAM_AUTH_INPUT_FD=3 \
		"$helper" "$@" 3<"$input_file" >"$output_file" 2>&1
	last_status=$?
	set -e
	last_output="$(<"$output_file")"
}

run_without_input() {
	local root=$1
	shift
	local output_file="$root/helper-output"

	set +e
	PATH="$process_wrapper_dir:$PATH" \
		MANACOSTTEAM_AUTH_PROCESS_CAPTURE="$root/mv-process-boundary" \
		MANACOSTTEAM_AUTH_TEST_MODE=1 \
		MANACOSTTEAM_AUTH_TEST_ROOT="$root" \
		"$helper" "$@" >"$output_file" 2>&1
	last_status=$?
	set -e
	last_output="$(<"$output_file")"
}

make_case() {
	local name=$1
	local destination="$test_root/$name"

	mkdir -m 0700 -- "$destination"
	printf '%s\n' "$destination"
}

write_input() {
	local destination=$1
	shift
	: >"$destination"
	chmod 0600 "$destination"
	printf '%s\n' "$@" >"$destination"
}

start_paused_helper() {
	local root=$1
	local input_file=$2
	local stage=$3
	local ready_message=''

	mkfifo -m 0600 -- "$root/ready" "$root/continue"
	exec 8<>"$root/ready"
	exec 9<>"$root/continue"
	PATH="$process_wrapper_dir:$PATH" \
		MANACOSTTEAM_AUTH_PROCESS_CAPTURE="$root/mv-process-boundary" \
		MANACOSTTEAM_AUTH_TEST_MODE=1 \
		MANACOSTTEAM_AUTH_TEST_ROOT="$root" \
		MANACOSTTEAM_AUTH_INPUT_FD=3 \
		MANACOSTTEAM_AUTH_TEST_PAUSE_STAGE="$stage" \
		MANACOSTTEAM_AUTH_TEST_READY_FD=8 \
		MANACOSTTEAM_AUTH_TEST_CONTINUE_FD=9 \
		"$helper" 3<"$input_file" >"$root/helper-output" 2>&1 &
	helper_pid=$!
	IFS= read -r -u 8 ready_message || fail 'helper did not reach the protected commit boundary'
	[[ "$ready_message" == "READY $stage" ]] || fail 'helper reached an unexpected commit boundary'
}

finish_paused_helper() {
	local root=$1

	printf 'CONTINUE\n' >&9
	set +e
	wait "$helper_pid"
	last_status=$?
	set -e
	exec 8>&-
	exec 9>&-
	last_output="$(<"$root/helper-output")"
}

assert_process_redacted() {
	local process_id=$1
	shift
	local -a observed_arguments=()
	local -a observed_environment=()
	local observed

	mapfile -d '' -t observed_arguments <"/proc/$process_id/cmdline"
	mapfile -d '' -t observed_environment <"/proc/$process_id/environ"
	for observed in "${observed_arguments[@]}" "${observed_environment[@]}"; do
		assert_redacted "$observed" "$@"
	done
}

token_id='123456789'
token_suffix='AA_task29_synthetic_token_0123456789'
token="${token_id}:${token_suffix}"
allowed_ids='123456789,987654321'
owner_ids='123456789'
model='openai/task29-test-model'

argv_root="$(make_case process-boundary)"
private_pipe="$argv_root/private-input"
mkfifo -m 0600 -- "$private_pipe"
exec {private_fd}<>"$private_pipe"
MANACOSTTEAM_AUTH_TEST_MODE=1 \
	MANACOSTTEAM_AUTH_TEST_ROOT="$argv_root" \
	MANACOSTTEAM_AUTH_INPUT_FD="$private_fd" \
	"$helper" >"$argv_root/helper-output" 2>&1 &
helper_pid=$!
mapfile -d '' -t observed_arguments <"/proc/$helper_pid/cmdline"
mapfile -d '' -t observed_environment <"/proc/$helper_pid/environ"
for observed in "${observed_arguments[@]}" "${observed_environment[@]}"; do
	assert_redacted "$observed" "$token" "$allowed_ids" "$owner_ids" "$model"
done
printf '%s\n' "$token" "$allowed_ids" "$owner_ids" "$model" >&"$private_fd"
wait "$helper_pid" || fail 'private descriptor process-boundary fixture failed'
exec {private_fd}>&-
assert_redacted "$(<"$argv_root/helper-output")" "$token" "$allowed_ids" "$owner_ids" "$model"
pass 'keeps synthetic values out of child arguments, environment and output'

case_root="$(make_case initial-write)"
input_file="$case_root/input"
write_input "$input_file" "$token" "$allowed_ids" "$owner_ids" "$model"
run_with_input "$case_root" "$input_file"
[[ "$last_status" -eq 0 ]] || fail 'initial configuration failed'
assert_redacted "$last_output" "$token" "$allowed_ids" "$owner_ids" "$model"
config_file="$case_root/.env.manacostteam-auth"
[[ -f "$config_file" ]] || fail 'configuration file was not created'
[[ "$(stat -c '%a' "$config_file")" == 600 ]] || fail 'configuration mode is not 0600'
[[ "$(<"$config_file")" == "TELEGRAM_LOGIN_BOT_TOKEN=$token
TELEGRAM_ALLOWED_USER_IDS=$allowed_ids
TELEGRAM_OWNER_USER_IDS=$owner_ids
OPENROUTER_MODEL=$model" ]] || fail 'configuration contents are not canonical'
[[ -f "$case_root/mv-process-boundary" ]] || fail 'post-secret child process was not observed'
assert_redacted "$(<"$case_root/mv-process-boundary")" "$token" "$allowed_ids" "$owner_ids" "$model"
[[ "$(<"$case_root/mv-process-boundary")" == *'ARG -T'* ]] || fail 'atomic rename did not use no-target-directory semantics'
pass 'writes a redacted mode-0600 operator configuration from a private input descriptor'

old_inode="$(stat -c '%i' "$config_file")"
blank_update="$case_root/blank-update"
write_input "$blank_update" '' '' '' ''
run_with_input "$case_root" "$blank_update"
[[ "$last_status" -eq 0 ]] || fail 'blank-preserving update failed'
[[ "$(stat -c '%i' "$config_file")" != "$old_inode" ]] || fail 'configuration was not replaced atomically'
if compgen -G "$case_root/.env.manacostteam-auth.tmp.*" >/dev/null; then
	fail 'temporary configuration was left behind'
fi
pass 'replaces the configuration atomically and removes its temporary file'

before_refusal="$(<"$config_file")"
refuse_input="$case_root/refuse-input"
write_input "$refuse_input" '' "$allowed_ids" '-' ''
run_with_input "$case_root" "$refuse_input"
[[ "$last_status" -ne 0 ]] || fail 'last-owner removal was accepted'
[[ "$last_output" == *'REFUSED TELEGRAM_OWNER_USER_IDS non-empty'* ]] || fail 'last-owner refusal was not explicit'
assert_redacted "$last_output" "$token" "$allowed_ids" "$owner_ids" "$model"
[[ "$(<"$config_file")" == "$before_refusal" ]] || fail 'refused owner update changed the configuration'
pass 'refuses removal of the last owner without changing the file'

subset_input="$case_root/subset-input"
write_input "$subset_input" '' '987654321' "$owner_ids" ''
run_with_input "$case_root" "$subset_input"
[[ "$last_status" -ne 0 ]] || fail 'owner outside the allowlist was accepted'
[[ "$last_output" == *'RELATION TELEGRAM_OWNER_USER_IDS subset-of TELEGRAM_ALLOWED_USER_IDS: failed'* ]] || fail 'subset failure was not reported safely'
assert_redacted "$last_output" "$token" "$allowed_ids" "$owner_ids" "$model"
[[ "$(<"$config_file")" == "$before_refusal" ]] || fail 'invalid subset update changed the configuration'
pass 'rejects an owner set outside the allowlist without printing IDs'

dry_root="$(make_case dry-run)"
dry_config="$dry_root/.env.manacostteam-auth"
printf '%s\n' \
	"TELEGRAM_LOGIN_BOT_TOKEN=$token" \
	'TELEGRAM_ALLOWED_USER_IDS=987654321' \
	"TELEGRAM_OWNER_USER_IDS=$owner_ids" >"$dry_config"
chmod 0600 "$dry_config"
run_without_input "$dry_root" --dry-run
[[ "$last_status" -ne 0 ]] || fail 'incomplete dry-run succeeded'
[[ "$last_output" == *'MISSING OPENROUTER_MODEL'* ]] || fail 'dry-run did not name the missing variable'
[[ "$last_output" == *'RELATION TELEGRAM_OWNER_USER_IDS non-empty: ok'* ]] || fail 'dry-run omitted the owner non-empty relation'
[[ "$last_output" == *'RELATION TELEGRAM_OWNER_USER_IDS subset-of TELEGRAM_ALLOWED_USER_IDS: failed'* ]] || fail 'dry-run omitted the subset relation'
assert_redacted "$last_output" "$token" '987654321' "$owner_ids"
pass 'dry-run reports only names and allowlist relationships, never values'

valid_dry_root="$(make_case valid-dry-run)"
valid_dry_config="$valid_dry_root/.env.manacostteam-auth"
printf '%s\n' \
	"TELEGRAM_LOGIN_BOT_TOKEN=$token" \
	"TELEGRAM_ALLOWED_USER_IDS=$allowed_ids" \
	"TELEGRAM_OWNER_USER_IDS=$owner_ids" \
	"OPENROUTER_MODEL=$model" >"$valid_dry_config"
chmod 0600 "$valid_dry_config"
run_without_input "$valid_dry_root" --dry-run
[[ "$last_status" -eq 0 ]] || fail 'complete dry-run failed'
[[ "$last_output" == *'RELATION TELEGRAM_OWNER_USER_IDS non-empty: ok'* ]] || fail 'complete dry-run omitted owner relation'
[[ "$last_output" == *'RELATION TELEGRAM_OWNER_USER_IDS subset-of TELEGRAM_ALLOWED_USER_IDS: ok'* ]] || fail 'complete dry-run omitted subset relation'
assert_redacted "$last_output" "$token" "$allowed_ids" "$owner_ids" "$model"
pass 'accepts a complete protected configuration without echoing it'

permissive_root="$(make_case permissive-file)"
permissive_config="$permissive_root/.env.manacostteam-auth"
printf '%s\n' \
	"TELEGRAM_LOGIN_BOT_TOKEN=$token" \
	"TELEGRAM_ALLOWED_USER_IDS=$allowed_ids" \
	"TELEGRAM_OWNER_USER_IDS=$owner_ids" \
	"OPENROUTER_MODEL=$model" >"$permissive_config"
chmod 0644 "$permissive_config"
permissive_input="$permissive_root/input"
write_input "$permissive_input" '' '' '' ''
run_with_input "$permissive_root" "$permissive_input"
[[ "$last_status" -ne 0 ]] || fail 'permissive operator configuration was accepted'
[[ "$(stat -c '%a' "$permissive_config")" == 644 ]] || fail 'refused operation mutated existing permissions'
assert_redacted "$last_output" "$token" "$allowed_ids" "$owner_ids" "$model"
pass 'refuses an existing operator configuration that is not mode 0600'

hardlink_root="$(make_case hard-linked-file)"
hardlink_config="$hardlink_root/.env.manacostteam-auth"
printf '%s\n' \
	"TELEGRAM_LOGIN_BOT_TOKEN=$token" \
	"TELEGRAM_ALLOWED_USER_IDS=$allowed_ids" \
	"TELEGRAM_OWNER_USER_IDS=$owner_ids" \
	"OPENROUTER_MODEL=$model" >"$hardlink_config"
chmod 0600 "$hardlink_config"
ln -- "$hardlink_config" "$hardlink_root/second-name"
hardlink_before="$(<"$hardlink_config")"
hardlink_input="$hardlink_root/input"
write_input "$hardlink_input" '' '' '' ''
run_with_input "$hardlink_root" "$hardlink_input"
[[ "$last_status" -ne 0 ]] || fail 'hard-linked operator configuration was accepted'
[[ "$(<"$hardlink_config")" == "$hardlink_before" ]] || fail 'hard-linked configuration was changed'
[[ "$(<"$hardlink_root/second-name")" == "$hardlink_before" ]] || fail 'second hard link was changed'
assert_redacted "$last_output" "$token" "$allowed_ids" "$owner_ids" "$model"
pass 'refuses a hard-linked existing operator configuration without mutation'

invalid_root="$(make_case invalid-input)"
invalid_input="$invalid_root/input"
write_input "$invalid_input" "$token" '0123,123' '123' 'model with spaces'
run_with_input "$invalid_root" "$invalid_input"
[[ "$last_status" -ne 0 ]] || fail 'dotenv-unsafe input was accepted'
[[ ! -e "$invalid_root/.env.manacostteam-auth" ]] || fail 'invalid input created a configuration file'
assert_redacted "$last_output" "$token" '0123,123' '123' 'model with spaces'
pass 'rejects non-canonical IDs and dotenv-unsafe model input before writing'

unknown_root="$(make_case unknown-entry)"
unknown_config="$unknown_root/.env.manacostteam-auth"
unknown_value='synthetic-unknown-value'
printf '%s\n' \
	"TELEGRAM_LOGIN_BOT_TOKEN=$token" \
	"TELEGRAM_ALLOWED_USER_IDS=$allowed_ids" \
	"TELEGRAM_OWNER_USER_IDS=$owner_ids" \
	"OPENROUTER_MODEL=$model" \
	"UNSUPPORTED_ENTRY=$unknown_value" >"$unknown_config"
chmod 0600 "$unknown_config"
unknown_before="$(<"$unknown_config")"
unknown_input="$unknown_root/input"
write_input "$unknown_input" '' '' '' ''
run_with_input "$unknown_root" "$unknown_input"
[[ "$last_status" -ne 0 ]] || fail 'unsupported configuration entry was overwritten'
[[ "$(<"$unknown_config")" == "$unknown_before" ]] || fail 'unsupported configuration file was changed'
assert_redacted "$last_output" "$token" "$allowed_ids" "$owner_ids" "$model" "$unknown_value"
pass 'refuses to overwrite an operator file containing unsupported entries'

canonical_root="$(make_case canonical-helper-path)"
canonical_link="$canonical_root/configure-manacostteam-auth.sh"
ln -s -- "$helper" "$canonical_link"
if [[ ! -e "$project_root/.env.manacostteam-auth" ]]; then
	printf '%s\n' \
		"TELEGRAM_LOGIN_BOT_TOKEN=$token" \
		"TELEGRAM_ALLOWED_USER_IDS=$allowed_ids" \
		"TELEGRAM_OWNER_USER_IDS=$owner_ids" \
		"OPENROUTER_MODEL=$model" >"$canonical_root/.env.manacostteam-auth"
	chmod 0600 "$canonical_root/.env.manacostteam-auth"
	set +e
	"$canonical_link" --dry-run >"$canonical_root/helper-output" 2>&1
	last_status=$?
	set -e
	[[ "$last_status" -eq 1 ]] || fail 'symlink invocation used the symlink directory as source root'
	[[ "$(<"$canonical_root/helper-output")" == *'MISSING TELEGRAM_LOGIN_BOT_TOKEN'* ]] || fail 'symlink invocation did not resolve the real project root'
	assert_redacted "$(<"$canonical_root/helper-output")" "$token" "$allowed_ids" "$owner_ids" "$model"
else
	set +e
	MANACOSTTEAM_AUTH_TEST_MODE=1 \
		MANACOSTTEAM_AUTH_TEST_ROOT="$canonical_root" \
		MANACOSTTEAM_AUTH_TEST_EXPECT_SOURCE_ROOT="$project_root" \
		"$canonical_link" --dry-run >"$canonical_root/helper-output" 2>&1
	last_status=$?
	set -e
	[[ "$last_status" -eq 1 ]] || fail 'symlink invocation did not retain the canonical source root'
fi
pass 'derives the source root from the real helper path when invoked through a symlink'

race_recheck_root="$(make_case race-before-recheck)"
race_recheck_external="$(make_case race-before-recheck-external)"
race_recheck_input="$race_recheck_root/input"
write_input "$race_recheck_input" "$token" "$allowed_ids" "$owner_ids" "$model"
start_paused_helper "$race_recheck_root" "$race_recheck_input" before-recheck
assert_process_redacted "$helper_pid" "$token" "$allowed_ids" "$owner_ids" "$model"
ln -s -- "$race_recheck_external" "$race_recheck_root/.env.manacostteam-auth"
finish_paused_helper "$race_recheck_root"
[[ "$last_status" -ne 0 ]] || fail 'target replacement before the repeated check was accepted'
[[ -L "$race_recheck_root/.env.manacostteam-auth" ]] || fail 'repeated target check mutated the raced symlink'
if [[ -n "$(find "$race_recheck_external" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
	fail 'target race wrote into the external directory before recheck'
fi
assert_redacted "$last_output" "$token" "$allowed_ids" "$owner_ids" "$model"
pass 'rechecks a target replaced after private input and performs no external write'

race_rename_root="$(make_case race-before-rename)"
race_rename_external="$(make_case race-before-rename-external)"
race_rename_input="$race_rename_root/input"
write_input "$race_rename_input" "$token" "$allowed_ids" "$owner_ids" "$model"
start_paused_helper "$race_rename_root" "$race_rename_input" before-rename
assert_process_redacted "$helper_pid" "$token" "$allowed_ids" "$owner_ids" "$model"
ln -s -- "$race_rename_external" "$race_rename_root/.env.manacostteam-auth"
finish_paused_helper "$race_rename_root"
[[ "$last_status" -eq 0 ]] || fail 'safe no-target-directory rename failed during a target race'
[[ -f "$race_rename_root/.env.manacostteam-auth" && ! -L "$race_rename_root/.env.manacostteam-auth" ]] || fail 'safe rename did not replace the raced symlink'
[[ "$(stat -c '%a' "$race_rename_root/.env.manacostteam-auth")" == 600 ]] || fail 'raced configuration mode is not 0600'
if [[ -n "$(find "$race_rename_external" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
	fail 'no-target-directory rename wrote into the external directory'
fi
assert_redacted "$last_output" "$token" "$allowed_ids" "$owner_ids" "$model"
assert_redacted "$(<"$race_rename_root/mv-process-boundary")" "$token" "$allowed_ids" "$owner_ids" "$model"
[[ "$(<"$race_rename_root/mv-process-boundary")" == *'ARG -T'* ]] || fail 'raced rename omitted no-target-directory semantics'
pass 'uses no-target-directory rename when the target changes after recheck'

symlink_root="$(make_case symlink-target)"
protected_file="$symlink_root/protected"
printf '%s\n' 'must-not-change' >"$protected_file"
ln -s -- "$protected_file" "$symlink_root/.env.manacostteam-auth"
symlink_input="$symlink_root/input"
write_input "$symlink_input" "$token" "$allowed_ids" "$owner_ids" "$model"
run_with_input "$symlink_root" "$symlink_input"
[[ "$last_status" -ne 0 ]] || fail 'symlinked configuration target was accepted'
[[ "$(<"$protected_file")" == 'must-not-change' ]] || fail 'symlink target was modified'
assert_redacted "$last_output" "$token" "$allowed_ids" "$owner_ids" "$model"
pass 'refuses a symlinked configuration target'

override_root="$(make_case unguarded-override)"
set +e
MANACOSTTEAM_AUTH_TEST_ROOT="$override_root" "$helper" --dry-run >"$override_root/helper-output" 2>&1
last_status=$?
set -e
[[ "$last_status" -ne 0 ]] || fail 'test root override worked without explicit test mode'
[[ ! -e "$override_root/.env.manacostteam-auth" ]] || fail 'unguarded test root override created a file'
pass 'keeps the normal operator target fixed when test mode is absent'

git -C "$project_root" check-ignore -q -- .env.manacostteam-auth || fail 'operator configuration path is not ignored by Git'
pass 'uses an explicitly ignored operator configuration path'

printf '1..%d\n' "$test_count"
