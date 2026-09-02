#!/usr/bin/env python3
"""Narrow host boundary for OpenBot's Контроль данных agent."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

WORKSPACE = Path(os.environ.get("PARSER_OPS_WORKSPACE", "/srv/projects/agents/control-data/api"))
API_BASE = os.environ.get("PARSER_OPS_API_BASE", "https://api.kolodahearthstone.com").rstrip("/")
API_HOST = "api.kolodahearthstone.com"
RUNTIME_ENV = Path(os.environ.get("PARSER_OPS_RUNTIME_ENV", "/srv/hs-data-api/.env.docker"))
VALIDATION_FILE = Path(
    os.environ.get(
        "PARSER_OPS_VALIDATION_FILE",
        "/var/lib/openbot-parser-ops/validation.json",
    )
)
DEPLOY_HELPER = os.environ.get(
    "PARSER_OPS_DEPLOY_HELPER", "/usr/local/sbin/openbot-parser-deploy"
)
TEST_PYTHON = os.environ.get(
    "PARSER_OPS_TEST_PYTHON",
    "/srv/projects/data/api-koloda-token-pr/.venv/bin/python",
)
EXPECTED_BRANCH = "agent/data-control"
HSREPLAY_META_FRESH_ONLY_SOURCE_IDS = frozenset(
    {
        "hsreplay_meta_archetypes_legend_eu_1d",
        "hsreplay_meta_top_1000_legend_1d_firecrawl",
        "hsreplay_meta_legend_1d_firecrawl",
        "hsreplay_meta_diamond_4to1_1d_firecrawl",
    }
)
SOURCE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
TEST_PATH = re.compile(r"^tests/test_[A-Za-z0-9_./-]+\.py$")
SAFE_COMMIT = re.compile(r"^[a-f0-9]{40}$")
MAX_OUTPUT = 45_000
MUTATION_LOCK = threading.Lock()
SERVER_TOKEN = ""


class Refused(RuntimeError):
    """A caller supplied an unsafe or unsupported request."""


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects so a configured API cannot bounce into another trust zone."""

    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


HTTP_OPENER = urllib.request.build_opener(_NoRedirectHandler())


def _validated_api_url(path: str) -> str:
    base = urllib.parse.urlsplit(API_BASE)
    hostname = base.hostname
    try:
        port = base.port
    except ValueError as error:
        raise RuntimeError("The parser API base URL has an invalid port.") from error
    if (
        base.scheme != "https"
        or hostname != API_HOST
        or port not in {None, 443}
        or base.username is not None
        or base.password is not None
        or base.path not in {"", "/"}
        or base.query
        or base.fragment
    ):
        raise RuntimeError("The parser API base URL must be a plain HTTPS origin.")
    relative = urllib.parse.urlsplit(path)
    if relative.scheme or relative.netloc or relative.fragment:
        raise RuntimeError("The parser API path must stay relative to the configured origin.")
    return f"{API_BASE}/{path.lstrip('/')}"


def _redact(value: str) -> str:
    value = re.sub(
        r"(?i)(authorization|api[_-]?key|token|secret|password)(\s*[:=]\s*)\S+",
        r"\1\2[redacted]",
        value,
    )
    return value if len(value) <= MAX_OUTPUT else f"{value[:MAX_OUTPUT]}\n[truncated]"


def _run(
    args: list[str],
    *,
    timeout: int = 600,
    input_text: str | None = None,
) -> str:
    env = {
        "HOME": "/home/debian",
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
    }
    completed = subprocess.run(
        args,
        cwd=WORKSPACE,
        env=env,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )
    output = _redact(completed.stdout)
    if completed.returncode != 0:
        raise RuntimeError(
            f"Command {args[0]} failed with exit code {completed.returncode}.\n{output}"
        )
    return output


def _git(*args: str, timeout: int = 120) -> str:
    return _run(["git", *args], timeout=timeout).strip()


def _request_json(
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    orchestrator: bool = False,
    timeout: int = 30,
) -> dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "User-Agent": "OpenBot-Parser-Ops/1.0",
    }
    if orchestrator:
        headers["X-Orchestrator-Key"] = _orchestrator_token()
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        _validated_api_url(path),
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with HTTP_OPENER.open(request, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Parser API refused {path} with HTTP {error.code}.") from error
    if not isinstance(result, dict):
        raise RuntimeError(f"Parser API returned a non-object for {path}.")
    return result


def _read_env_value(path: Path, name: str) -> str:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise RuntimeError("The parser runtime credential file is unavailable.") from error
    prefix = f"{name}="
    for line in lines:
        if not line.startswith(prefix):
            continue
        value = line[len(prefix) :].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        return value
    return ""


def _orchestrator_token() -> str:
    token = _read_env_value(RUNTIME_ENV, "HS_ORCHESTRATOR_API_KEY")
    if len(token) < 32:
        raise RuntimeError("The scoped parser orchestrator credential is not configured safely.")
    return token


def _source_ids(value: Any) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 5:
        raise Refused("sourceIds must contain between one and five source ids.")
    if not all(isinstance(item, str) and SOURCE_ID.fullmatch(item) for item in value):
        raise Refused("sourceIds contains an invalid identifier.")
    if len(set(value)) != len(value):
        raise Refused("sourceIds must not contain duplicates.")
    known = {
        str(source.get("id"))
        for source in _sources_catalogue()
        if isinstance(source, dict) and source.get("id")
    }
    unknown = sorted(set(value) - known)
    if unknown:
        raise Refused(f"Unknown source ids: {', '.join(unknown)}")
    return value


def _sources_catalogue() -> list[dict[str, Any]]:
    envelope = _request_json("v1/sources")
    data = envelope.get("data")
    if not isinstance(data, list):
        raise RuntimeError("The public source catalogue has an invalid shape.")
    return [source for source in data if isinstance(source, dict)]


def _compact_reliability_windows(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    compact: list[dict[str, Any]] = []
    for window in value:
        if not isinstance(window, dict):
            continue
        failure_reasons = window.get("failure_reasons")
        scheduled = window.get("scheduled_reliability")
        completeness = window.get("verified_completeness")
        compact.append(
            {
                key: window.get(key)
                for key in (
                    "window",
                    "from_at",
                    "to_at",
                    "measurement_status",
                    "physical_attempts",
                    "eligible_attempts",
                    "upstream_pending_attempts",
                    "end_to_end_attempts",
                    "counts",
                    "full_fresh_rate_pct",
                    "end_to_end_fresh_rate_pct",
                    "accepted_fresh_rate_pct",
                    "data_available_rate_pct",
                )
            }
            | {
                "failureReasons": {
                    key: count
                    for key, count in failure_reasons.items()
                    if isinstance(count, (int, float)) and count
                }
                if isinstance(failure_reasons, dict)
                else {},
                "scheduled": {
                    key: scheduled.get(key)
                    for key in (
                        "measurement_status",
                        "pending_slots",
                        "late",
                        "missing",
                        "on_time_fresh_rate_pct",
                        "parser_on_time_fresh_rate_pct",
                        "objective_status",
                        "parser_objective_status",
                    )
                }
                if isinstance(scheduled, dict)
                else {},
                "completeness": {
                    key: completeness.get(key)
                    for key in (
                        "observed_instrumented_sources",
                        "sources_meeting_target",
                        "sources_below_target",
                        "sources_without_observations",
                        "complete_fresh_rate_pct",
                        "objective_status",
                    )
                }
                if isinstance(completeness, dict)
                else {},
            }
        )
    return compact


def audit_all_sources() -> dict[str, Any]:
    health_envelope = _request_json("v1/health")
    reliability_envelope = _request_json("v1/system/parsing-reliability")
    health = health_envelope.get("data")
    reliability = reliability_envelope.get("data")
    if not isinstance(health, dict) or not isinstance(reliability, dict):
        raise RuntimeError("The parser health contract has an invalid shape.")
    catalogue = _sources_catalogue()
    flags: dict[str, set[str]] = {}
    for field, label in (
        ("stale_sources", "stale"),
        ("cached_after_failure_sources", "cached_after_failure"),
        ("hard_failed_sources", "hard_failed"),
        ("semantic_failed_sources", "semantic_failed"),
        ("publication_failed_sources", "publication_failed"),
        ("operationally_disabled_sources", "disabled"),
    ):
        for source_id in health.get(field) or []:
            if isinstance(source_id, str):
                flags.setdefault(source_id, set()).add(label)
    for source in catalogue:
        source_id = source.get("id")
        if source_id not in HSREPLAY_META_FRESH_ONLY_SOURCE_IDS:
            continue
        if source.get("fresh_only_eligible") is not True:
            flags.setdefault(str(source_id), set()).add("fresh_only_unverified")
    sources = [
        {
            "id": source.get("id"),
            "site": source.get("site"),
            "category": source.get("category"),
            "hasDataset": source.get("has_dataset"),
            "datasetFetchedAt": source.get("dataset_fetched_at"),
            "upstreamFreshness": source.get("upstream_freshness"),
            "freshOnlyEligible": source.get("fresh_only_eligible"),
            "flags": sorted(flags.get(str(source.get("id")), set())),
        }
        for source in catalogue
    ]
    problem_sources = [source for source in sources if source["flags"]]
    return {
        "checkedAt": reliability.get("generated_at"),
        "sourceCount": len(sources),
        "sourceIds": [source["id"] for source in sources],
        "health": {
            key: health.get(key)
            for key in (
                "ok",
                "serving_ok",
                "freshness_ok",
                "degraded",
                "states",
                "stale_count",
                "cached_after_failure_count",
                "stale_sources",
                "cached_after_failure_sources",
                "hard_failed_sources",
                "semantic_failed_sources",
                "publication_failed_sources",
                "operationally_disabled_sources",
                "freshness_monitor_errors",
            )
        },
        "reliabilityWindows": _compact_reliability_windows(reliability.get("windows")),
        "problemSources": problem_sources,
    }


def _diagnostic_triage(
    source: dict[str, Any], status: dict[str, Any] | None
) -> dict[str, Any]:
    """Turn parser evidence into a mandatory next action for the maintenance agent."""
    status = status if isinstance(status, dict) else {}
    flags = set(source.get("flags") or [])
    last_error = str(status.get("last_refresh_error") or "")
    upstream_state = str(
        status.get("last_refresh_upstream_state")
        or status.get("upstream_state")
        or ""
    )
    last_quality = status.get("last_refresh_quality")
    blocked_marker = (
        bool(last_quality.get("blocked_marker"))
        if isinstance(last_quality, dict)
        else False
    )

    if "disabled" in flags:
        return {
            "disposition": "operationally_disabled",
            "requiresCodeInspection": False,
            "retryRecommended": False,
            "reason": "The source is explicitly disabled by operations policy.",
        }
    if upstream_state == "upstream_publication_pending" or (
        "upstream publication pending" in last_error.lower()
    ):
        return {
            "disposition": "upstream_pending",
            "requiresCodeInspection": False,
            "retryRecommended": False,
            "reason": "The upstream publisher has not finished publishing the expected dataset.",
        }
    if "unexpected_selected_params" in last_error:
        return {
            "disposition": "inspect_adapter",
            "requiresCodeInspection": True,
            "retryRecommended": False,
            "reason": "A valid candidate was rejected by our selected-parameter contract.",
            "inspectionHint": (
                "Compare the exact filters in the configured upstream request URL/constants "
                "with the validator's accepted coherent profiles; test that exact profile "
                "without weakening strict rejection of duplicates, extras, or mixed profiles."
            ),
        }
    if blocked_marker:
        return {
            "disposition": "retry_transient",
            "requiresCodeInspection": False,
            "retryRecommended": True,
            "reason": "The latest candidate contains an access-blocking marker.",
        }
    transport = status.get("last_refresh_parsesunix_transport")
    if (
        isinstance(transport, dict)
        and transport.get("transport_validated") is True
        and transport.get("candidate_validated") is True
        and "dataset regression" in last_error.lower()
    ):
        return {
            "disposition": "upstream_regression",
            "requiresCodeInspection": False,
            "retryRecommended": False,
            "reason": "A valid upstream candidate was preserved by the publication regression gate.",
        }
    if flags.intersection(
        {
            "cached_after_failure",
            "hard_failed",
            "semantic_failed",
            "publication_failed",
            "stale",
            "fresh_only_unverified",
        }
    ):
        return {
            "disposition": "investigate_implementation",
            "requiresCodeInspection": True,
            "retryRecommended": False,
            "reason": "The failure is not proven to be upstream-only or operationally disabled.",
        }
    return {
        "disposition": "healthy",
        "requiresCodeInspection": False,
        "retryRecommended": False,
        "reason": "No failing health flag remains for this source.",
    }


def diagnose_source(source_id: Any) -> dict[str, Any]:
    ids = _source_ids([source_id])
    encoded = urllib.parse.quote(ids[0], safe="")
    detail = _request_json(f"sources/{encoded}")
    audit = audit_all_sources()
    catalogue_source = next(
        item for item in _sources_catalogue() if item.get("id") == ids[0]
    )
    source = {
        "id": ids[0],
        "site": catalogue_source.get("site"),
        "category": catalogue_source.get("category"),
        "hasDataset": catalogue_source.get("has_dataset"),
        "datasetFetchedAt": catalogue_source.get("dataset_fetched_at"),
        "upstreamFreshness": catalogue_source.get("upstream_freshness"),
        "freshOnlyEligible": catalogue_source.get("fresh_only_eligible"),
        "flags": next(
            (
                item["flags"]
                for item in audit["problemSources"]
                if item["id"] == ids[0]
            ),
            [],
        ),
    }
    status = detail.get("status")
    return {
        "source": source,
        "status": status,
        "triage": _diagnostic_triage(source, status),
        "semanticQuality": detail.get("semantic_quality"),
        "hasDataset": detail.get("has_dataset"),
        "datasetFetchedAt": detail.get("dataset_fetched_at"),
        "category": detail.get("category"),
        "site": detail.get("site"),
        "systemHealth": audit["health"],
    }


def retry_sources(source_ids: Any, reason: Any = None) -> dict[str, Any]:
    ids = _source_ids(source_ids)
    if reason is not None and (not isinstance(reason, str) or len(reason) > 300):
        raise Refused("reason must be a string of at most 300 characters.")
    request_id = f"data-control:{int(time.time())}:{uuid.uuid4().hex[:12]}"
    created = _request_json(
        "admin/orchestrator/parser-runs",
        method="POST",
        orchestrator=True,
        payload={
            "requestId": request_id,
            "sourceIds": ids,
            "sectionIds": [],
            "reason": reason or "OpenBot data-control bounded refresh",
            "attemptPurpose": "manual",
            "originOccurrenceId": None,
            "recoveryChainId": None,
        },
    )
    run = created.get("run")
    if not isinstance(run, dict) or not isinstance(run.get("id"), str):
        raise RuntimeError("The parser control enqueue response has an invalid shape.")
    deadline = time.monotonic() + 20 * 60
    while run.get("status") in {"queued", "running"}:
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Parser run {run['id']} did not finish within 20 minutes.")
        time.sleep(15)
        fetched = _request_json(
            f"admin/orchestrator/parser-runs/{run['id']}", orchestrator=True
        )
        run = fetched.get("run")
        if not isinstance(run, dict):
            raise RuntimeError("The parser control status response has an invalid shape.")
    return {
        "runId": run.get("id"),
        "status": run.get("status"),
        "sourceIds": run.get("sourceIds"),
        "totalSources": run.get("totalSources"),
        "completedSources": run.get("completedSources"),
        "failedSources": run.get("failedSources"),
        "results": run.get("results"),
    }


def codegraph_explore(question: Any) -> dict[str, Any]:
    if not isinstance(question, str) or not 3 <= len(question) <= 1000:
        raise Refused("question must contain between 3 and 1000 characters.")
    return {"output": _run(["codegraph", "explore", question], timeout=180)}


def _head() -> str:
    head = _git("rev-parse", "HEAD")
    if not SAFE_COMMIT.fullmatch(head):
        raise RuntimeError("The workspace HEAD is not a full Git commit.")
    return head


def workspace_status() -> dict[str, Any]:
    _git("fetch", "--quiet", "origin", "main", timeout=180)
    return {
        "branch": _git("branch", "--show-current"),
        "head": _head(),
        "originMain": _git("rev-parse", "origin/main"),
        "status": _git("status", "--short"),
        "commits": _git("log", "--oneline", "--decorate", "origin/main..HEAD"),
        "diffStat": _git("diff", "--stat", "origin/main..HEAD"),
        "changedPaths": [
            line
            for line in _git("diff", "--name-only", "origin/main..HEAD").splitlines()
            if line
        ],
    }


def _load_validations() -> dict[str, Any]:
    try:
        value = json.loads(VALIDATION_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _save_validations(value: dict[str, Any]) -> None:
    VALIDATION_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = VALIDATION_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(VALIDATION_FILE)


def _require_clean_candidate() -> str:
    if _git("branch", "--show-current") != EXPECTED_BRANCH:
        raise Refused(f"Repairs must be committed on {EXPECTED_BRANCH}.")
    if _git("status", "--porcelain"):
        raise Refused("Commit or discard workspace changes before validation or publication.")
    return _head()


def validate_workspace(mode: Any, test_paths: Any = None) -> dict[str, Any]:
    if mode not in {"targeted", "full", "security"}:
        raise Refused("mode must be targeted, full, or security.")
    head = _require_clean_candidate()
    if mode == "targeted":
        if not isinstance(test_paths, list) or not test_paths:
            raise Refused("targeted validation requires at least one regression test path.")
        if len(test_paths) > 10 or not all(
            isinstance(path, str) and TEST_PATH.fullmatch(path) for path in test_paths
        ):
            raise Refused("Every targeted test path must be a tests/test_*.py file.")
        missing = [path for path in test_paths if not (WORKSPACE / path).is_file()]
        if missing:
            raise Refused(f"Targeted tests do not exist: {', '.join(missing)}")
        output = _run(
            [TEST_PYTHON, "-m", "pytest", "-q", *test_paths],
            timeout=20 * 60,
        )
    elif mode == "full":
        output = _run(["make", f"PYTHON={TEST_PYTHON}", "check"], timeout=45 * 60)
    else:
        output = _run(["make", "security"], timeout=20 * 60)
    validations = _load_validations()
    record = validations.setdefault(head, {"modes": {}, "updatedAt": 0})
    record["modes"][mode] = {
        "at": int(time.time()),
        "testPaths": test_paths if mode == "targeted" else [],
    }
    record["updatedAt"] = int(time.time())
    _save_validations({head: record})
    return {"head": head, "mode": mode, "passed": True, "output": output}


def _require_publishable(head: str) -> list[str]:
    _git("fetch", "--quiet", "origin", "main", timeout=180)
    origin_main = _git("rev-parse", "origin/main")
    already_pushed = origin_main == head
    if not already_pushed and subprocess.run(
        ["git", "merge-base", "--is-ancestor", "origin/main", head],
        cwd=WORKSPACE,
        check=False,
    ).returncode != 0:
        raise Refused("origin/main advanced; rebase the repair and validate the new commit.")
    base = _git("rev-parse", f"{head}^") if already_pushed else origin_main
    changed = [
        path
        for path in _git("diff", "--name-only", f"{base}..{head}").splitlines()
        if path
    ]
    if not changed:
        raise Refused("There is no repair commit to publish.")
    if any(not path.startswith(("app/", "tests/", "docs/")) for path in changed):
        raise Refused("Automatic publication is limited to app/, tests/, and docs/ paths.")
    if not any(path.startswith("tests/test_") and path.endswith(".py") for path in changed):
        raise Refused("The repair must include a Python regression test.")
    record = _load_validations().get(head, {})
    modes = record.get("modes", {}) if isinstance(record, dict) else {}
    if not {"targeted", "full", "security"}.issubset(modes):
        raise Refused("Targeted, full, and security validation must pass on this exact commit.")
    newest_allowed = int(time.time()) - 4 * 60 * 60
    if any(int(modes[name].get("at", 0)) < newest_allowed for name in modes):
        raise Refused("Validation is older than four hours; run it again before publication.")
    return changed


def _deploy(commit: str) -> str:
    if not SAFE_COMMIT.fullmatch(commit):
        raise Refused("Deployment requires one exact full commit.")
    return _run(["sudo", "-n", DEPLOY_HELPER, commit], timeout=45 * 60)


def _git_patch(old_commit: str, failed_commit: str) -> str:
    """Return an inverse binary patch without stripping its required final newline."""
    return _run(
        ["git", "diff", "--binary", failed_commit, old_commit],
        timeout=180,
    )


def _revert_and_deploy(old_commit: str, failed_commit: str, reason: str) -> dict[str, Any]:
    inverse = _git_patch(old_commit, failed_commit)
    _run(["git", "apply", "--index"], input_text=inverse, timeout=180)
    _run(
        ["git", "commit", "-m", "revert: restore parser after failed verification"],
        timeout=180,
    )
    revert_commit = _head()
    _run(["git", "push", "origin", "HEAD:main"], timeout=300)
    deploy_output = _deploy(revert_commit)
    return {
        "reverted": True,
        "failedCommit": failed_commit,
        "revertCommit": revert_commit,
        "reason": reason,
        "deployOutput": deploy_output,
    }


def publish_and_verify(source_ids: Any, summary: Any) -> dict[str, Any]:
    ids = _source_ids(source_ids)
    if not isinstance(summary, str) or not 5 <= len(summary) <= 300:
        raise Refused("summary must contain between 5 and 300 characters.")
    with MUTATION_LOCK:
        head = _require_clean_candidate()
        changed = _require_publishable(head)
        origin_main = _git("rev-parse", "origin/main")
        already_pushed = origin_main == head
        old_commit = _git("rev-parse", f"{head}^") if already_pushed else origin_main
        pushed = already_pushed
        try:
            if not already_pushed:
                _run(["git", "push", "origin", "HEAD:main"], timeout=300)
                pushed = True
            deploy_output = _deploy(head)
            refresh = retry_sources(ids, f"Post-deploy verification: {summary}")
            results = refresh.get("results")
            outcomes = {
                result.get("sourceId"): result.get("outcome")
                for result in results
                if isinstance(result, dict)
            } if isinstance(results, list) else {}
            bad = [source_id for source_id in ids if outcomes.get(source_id) != "fresh_published"]
            if bad:
                raise RuntimeError(
                    "Post-deploy verification was not fresh_published for: " + ", ".join(bad)
                )
            health = audit_all_sources()
            if health["health"].get("hard_failed_sources"):
                raise RuntimeError("Post-deploy health contains hard-failed sources.")
            return {
                "published": True,
                "commit": head,
                "changedPaths": changed,
                "deployOutput": deploy_output,
                "verification": refresh,
                "health": health["health"],
            }
        except Exception as error:
            if not pushed:
                raise
            rollback = _revert_and_deploy(old_commit, head, _redact(str(error)))
            raise RuntimeError(json.dumps(rollback, ensure_ascii=False)) from error


def dispatch(tool: str, arguments: Any) -> dict[str, Any]:
    args = arguments if isinstance(arguments, dict) else {}
    if tool == "audit_all_sources":
        return audit_all_sources()
    if tool == "diagnose_source":
        return diagnose_source(args.get("sourceId"))
    if tool == "retry_sources":
        with MUTATION_LOCK:
            return retry_sources(args.get("sourceIds"), args.get("reason"))
    if tool == "codegraph_explore":
        return codegraph_explore(args.get("question"))
    if tool == "workspace_status":
        return workspace_status()
    if tool == "validate_workspace":
        return validate_workspace(args.get("mode"), args.get("testPaths"))
    if tool == "publish_and_verify":
        return publish_and_verify(args.get("sourceIds"), args.get("summary"))
    raise Refused("That tool is not offered by Parser Ops.")


def expected_token() -> str:
    boundary = os.environ.get("AGENT_TOOL_TOKEN", "").strip()
    if len(boundary) < 20:
        raise RuntimeError("AGENT_TOOL_TOKEN must be configured for Parser Ops.")
    return hashlib.sha256(f"openbot-parser-ops\0{boundary}".encode()).hexdigest()


class Handler(BaseHTTPRequestHandler):
    server_version = "ParserOps/1.0"

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {"status": "ok", "workspace": WORKSPACE.is_dir()})
            return
        self._json(404, {"error": "Not found."})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/call":
            self._json(404, {"error": "Not found."})
            return
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied, f"Bearer {SERVER_TOKEN}"):
            self._json(401, {"error": "Unauthorized."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64 * 1024:
                raise Refused("Request body must be between 1 byte and 64 KiB.")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict) or not isinstance(body.get("tool"), str):
                raise Refused("A tool name is required.")
            result = dispatch(body["tool"], body.get("arguments"))
            self._json(200, {"text": json.dumps(result, ensure_ascii=False, default=str)})
        except Refused as error:
            self._json(400, {"error": str(error)})
        except Exception as error:
            self._json(500, {"error": _redact(str(error))})

    def log_message(self, format: str, *args: Any) -> None:
        print(json.dumps({"type": "parser-ops-http", "message": format % args}))

    def _json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)


def main() -> None:
    global SERVER_TOKEN
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4031)
    options = parser.parse_args()
    SERVER_TOKEN = expected_token()
    # The unit's EnvironmentFile also configures OpenBot. Parser Ops needs one boundary secret and
    # its already-parsed paths; remove everything else before any child process or request runs.
    for key in list(os.environ):
        if key not in {"HOME", "LANG", "PATH"}:
            os.environ.pop(key, None)
    if not WORKSPACE.is_dir():
        raise RuntimeError(f"Parser workspace does not exist: {WORKSPACE}")
    ThreadingHTTPServer((options.bind, options.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
