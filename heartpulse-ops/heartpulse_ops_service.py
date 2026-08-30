#!/usr/bin/env python3
"""Governed host boundary for OpenBot's Контроль HearthPulse agent.

The service owns the only operations that need host access: reading the local
HeartPulse/API endpoints, validating an isolated worktree and invoking the
configured deployment gate. The model receives bounded JSON evidence, never
credentials, runtime files or an unrestricted shell.
"""

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
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

WORKSPACE = Path(os.environ.get("HEARTPULSE_OPS_WORKSPACE", "/srv/projects/web/HeartPulse-worktrees/heartpulse-control"))
LOCAL_URL = os.environ.get(
    "HEARTPULSE_AUDIT_URL",
    "http://127.0.0.1:3107/api/tier-lists?list=strategies&source=hsreplay",
)
PUBLIC_URL = os.environ.get(
    "HEARTPULSE_PUBLIC_AUDIT_URL",
    "https://hearthpulse.net/api/bg/tier-lists?list=strategies&source=hsreplay",
)
PUBLIC_BASE_URL = os.environ.get(
    "HEARTHPULSE_PUBLIC_BASE_URL",
    "https://hearthpulse.net",
).rstrip("/")
VALIDATION_FILE = Path(os.environ.get("HEARTPULSE_OPS_VALIDATION_FILE", "/var/lib/openbot-heartpulse-ops/validation.json"))
DEPLOY_HELPER = os.environ.get("HEARTPULSE_DEPLOY_HELPER", "/usr/local/sbin/heartpulse-deploy")
EXPECTED_BRANCH = "agent/heartpulse-control"
SAFE_COMMIT = re.compile(r"^[a-f0-9]{40}$")
TEST_PATH = re.compile(r"^tests/[A-Za-z0-9_./-]+\.(?:ts|mjs)$")
MAX_OUTPUT = 45_000
MAX_PAGE_BYTES = 180_000
MUTATION_LOCK = threading.Lock()
SERVER_TOKEN = ""

# The route matrix intentionally follows the user-facing navigation rather than
# private/admin screens. API calls for subscription-gated sections are allowed to
# return 401/403: the page shell must still be healthy and the access state is
# reported explicitly to the agent.
SITE_SECTIONS: tuple[dict[str, Any], ...] = (
    {"id": "home", "title": "Главная", "path": "/", "apis": ("/api/home/summary",)},
    {"id": "articles", "title": "Статьи", "path": "/articles", "apis": ("/api/articles",)},
    {"id": "faq", "title": "FAQ", "path": "/faq", "apis": ()},
    {"id": "developer-api", "title": "API", "path": "/developers/api", "apis": ("/api/v1/openapi.json",)},
    {"id": "gallery", "title": "Галерея", "path": "/gallery", "apis": ("/api/gallery",)},
    {"id": "cosmetics", "title": "Косметика", "path": "/cosmetics", "apis": ("/api/cosmetics/heroes", "/api/cosmetics/coins", "/api/cosmetics/pets")},
    {"id": "guides-archive", "title": "Архив гайдов", "path": "/guides-archive", "apis": ("/api/guides-archive",)},
    {"id": "contests", "title": "Конкурсы", "path": "/contests", "apis": ("/api/contests",)},
    {"id": "standard-cards", "title": "Standard · Карты", "path": "/standard/cards", "apis": ("/api/constructed-cards?format=standard&limit=1",)},
    {"id": "standard-matchups", "title": "Standard · Матчапы", "path": "/standard/matchups", "apis": ("/api/standard/matchups?format=standard",)},
    {"id": "standard-meta", "title": "Standard · Мета", "path": "/standard/meta", "apis": ("/api/standard-meta/teaser",)},
    {"id": "standard-fun-decks", "title": "Standard · Фан-колоды", "path": "/standard/fun-decks", "apis": ("/api/fun-decks",)},
    {"id": "standard-archetypes", "title": "Standard · Архетипы", "path": "/standard/archetypes", "apis": ("/api/constructed-archetypes/teaser",)},
    {"id": "standard-vicious-gold", "title": "Standard · Vicious Gold", "path": "/standard/vicious-gold", "apis": ("/api/vicious-syndicate-gold", "/api/vicious-syndicate-gold/builds")},
    {"id": "arena-classes", "title": "Арена · Классы", "path": "/classes", "apis": ("/api/winrates?source=hsreplay",)},
    {"id": "arena-tierlist", "title": "Арена · Тир-лист", "path": "/tierlist", "apis": ("/api/tierlist?source=hsreplay",)},
    {"id": "arena-legendaries", "title": "Арена · Легендарки", "path": "/legendaries", "apis": ("/api/legendaries?source=hsreplay",)},
    {"id": "bg-heroes", "title": "Battlegrounds · Герои", "path": "/heroes", "apis": ("/api/bg/heroes?mode=solo&mmr=TOP_50_PERCENT", "/api/bg/library/extra/heroes?per_page=1")},
    {"id": "bg-library", "title": "Battlegrounds · Библиотека", "path": "/library", "apis": ("/api/bg/library/cards?card_type=minion&in_pool=1", "/api/bg/library/meta")},
    {"id": "bg-tier-list", "title": "Battlegrounds · Тир-лист", "path": "/battlegrounds/tier-list", "apis": ("/api/bg/tier-lists?list=minions", "/api/bg/tier-lists?list=spells", "/api/bg/tier-lists?list=trinkets")},
    {"id": "bg-strategies", "title": "Battlegrounds · Стратегии", "path": "/battlegrounds/strategies", "apis": ("/api/bg/tier-lists?list=strategies&source=hsreplay",)},
    {"id": "bg-tier-builder", "title": "Battlegrounds · Конструктор тир-листов", "path": "/battlegrounds/tier-builder", "apis": ()},
)


class Refused(RuntimeError):
    pass


def _redact(value: str) -> str:
    value = re.sub(r"(?i)(authorization|api[_-]?key|token|secret|password)(\s*[:=]\s*)\S+", r"\1\2[redacted]", value)
    return value if len(value) <= MAX_OUTPUT else f"{value[:MAX_OUTPUT]}\n[truncated]"


def _run(args: list[str], *, timeout: int = 600) -> str:
    env = {
        "HOME": "/home/debian",
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
    }
    completed = subprocess.run(args, cwd=WORKSPACE, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, check=False)
    output = _redact(completed.stdout)
    if completed.returncode:
        raise RuntimeError(f"Command {args[0]} failed with exit code {completed.returncode}.\n{output}")
    return output


def _git(*args: str, timeout: int = 120) -> str:
    return _run(["git", *args], timeout=timeout).strip()


def _request_json(url: str, *, timeout: int = 30) -> tuple[int, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "HeartPulse-Control/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None


def _request_page(url: str, *, timeout: int = 30) -> tuple[int, str, str]:
    request = urllib.request.Request(url, headers={"Accept": "text/html", "User-Agent": "HeartPulse-Control/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(MAX_PAGE_BYTES + 1)
            return response.status, response.headers.get_content_type(), body.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get_content_type(), ""


def _summarize_json(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        summary: dict[str, Any] = {"keys": sorted(str(key) for key in payload.keys())[:20]}
        for key in ("data", "items", "rows", "results", "entries", "cards", "heroes", "strategies"):
            value = payload.get(key)
            if isinstance(value, list):
                summary[f"{key}Count"] = len(value)
        tiers = payload.get("tiers")
        if isinstance(tiers, dict):
            summary["tierCounts"] = {
                str(tier): len(rows) if isinstance(rows, list) else 0
                for tier, rows in tiers.items()
                if str(tier) in {"S", "A", "B", "C", "D"}
            }
        return summary
    if isinstance(payload, list):
        return {"type": "array", "count": len(payload)}
    return {"type": type(payload).__name__}


def _audit_page(path: str) -> dict[str, Any]:
    try:
        status, content_type, body = _request_page(f"{PUBLIC_BASE_URL}{path}")
    except Exception as error:
        return {"path": path, "httpStatus": None, "contentType": None, "bytes": 0, "state": "unavailable", "issues": [f"request_failed:{type(error).__name__}"]}
    issues: list[str] = []
    if status in {401, 403}:
        state = "access_protected"
    elif status < 200 or status >= 400:
        state = "unavailable"
        issues.append(f"http_{status}")
    elif "html" not in content_type:
        state = "invalid"
        issues.append("not_html")
    elif 'id="root"' not in body and "id='root'" not in body:
        state = "invalid"
        issues.append("missing_app_root")
    elif len(body) > MAX_PAGE_BYTES:
        state = "invalid"
        issues.append("page_too_large")
    else:
        state = "healthy"
    return {"path": path, "httpStatus": status, "contentType": content_type, "bytes": len(body), "state": state, "issues": issues}


def _audit_section_api(path: str) -> dict[str, Any]:
    try:
        status, payload = _request_json(f"{PUBLIC_BASE_URL}{path}")
    except Exception as error:
        return {"path": path, "httpStatus": None, "state": "unavailable", "issues": [f"request_failed:{type(error).__name__}"]}
    if status in {401, 403}:
        return {"path": path, "httpStatus": status, "state": "access_protected", "issues": ["endpoint_requires_auth"]}
    if status < 200 or status >= 400:
        return {"path": path, "httpStatus": status, "state": "unavailable", "issues": [f"http_{status}"]}
    if payload is None:
        return {"path": path, "httpStatus": status, "state": "invalid", "issues": ["invalid_json"]}
    return {"path": path, "httpStatus": status, "state": "healthy", "summary": _summarize_json(payload), "issues": []}


def audit_site_sections() -> dict[str, Any]:
    """Audit every primary user-facing HeartPulse route and its data boundary."""
    sections: list[dict[str, Any]] = []
    for section in SITE_SECTIONS:
        page = _audit_page(str(section["path"]))
        apis = [_audit_section_api(str(path)) for path in section.get("apis", ())]
        issues = [f"page:{issue}" for issue in page["issues"]]
        issues.extend(f"api:{probe['path']}:{issue}" for probe in apis for issue in probe.get("issues", []))
        states = [page["state"], *(probe["state"] for probe in apis)]
        if any(state in {"unavailable", "invalid"} for state in states):
            state = "degraded"
        elif all(state == "access_protected" for state in states):
            state = "access_protected"
        else:
            state = "healthy"
        sections.append({"id": section["id"], "title": section["title"], "page": page, "apis": apis, "state": state, "issues": issues})
    degraded = [section["id"] for section in sections if section["state"] == "degraded"]
    protected = [section["id"] for section in sections if section["state"] == "access_protected"]
    protected_apis = [
        probe["path"]
        for section in sections
        for probe in section["apis"]
        if probe["state"] == "access_protected"
    ]
    degraded_apis = [
        probe["path"]
        for section in sections
        for probe in section["apis"]
        if probe["state"] in {"unavailable", "invalid"}
    ]
    return {
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "coverage": {
            "sections": len(sections),
            "healthy": sum(section["state"] == "healthy" for section in sections),
            "accessProtected": len(protected),
            "degraded": len(degraded),
            "apiBoundaries": sum(len(section["apis"]) for section in sections),
            "protectedApis": len(protected_apis),
            "degradedApis": len(degraded_apis),
        },
        "sections": sections,
        "issues": degraded,
        "accessProtected": protected,
        "accessProtectedApis": protected_apis,
        "degradedApis": degraded_apis,
    }


def _audit_payload(payload: Any) -> dict[str, Any]:
    root = payload if isinstance(payload, dict) else {}
    tiers = root.get("tiers") if isinstance(root.get("tiers"), dict) else {}
    rows: list[dict[str, Any]] = []
    tier_counts: dict[str, int] = {}
    for tier in ("S", "A", "B", "C", "D"):
        tier_rows = tiers.get(tier) if isinstance(tiers.get(tier), list) else []
        tier_counts[tier] = len(tier_rows)
        rows.extend(row for row in tier_rows if isinstance(row, dict))
    with_cards = sum(1 for row in rows if any(isinstance(row.get(key), list) and row.get(key) for key in ("cards", "coreCards", "additionalCards", "mainCards")))
    metric_fields = ("games", "avgPlacement", "averagePlacement", "popularity", "firstPlace", "winrate")
    with_metrics = sum(1 for row in rows if any(row.get(field) not in (None, "") for field in metric_fields))
    issues: list[str] = []
    if not isinstance(root.get("source"), str) or not root.get("source", "").strip(): issues.append("missing_source")
    if not root.get("fetchedAt") and not root.get("fetched_at"): issues.append("missing_fetched_at")
    if not rows: issues.append("empty_strategy_list")
    if isinstance(root.get("count"), int) and root["count"] != len(rows): issues.append(f"count_mismatch:{root['count']}:{len(rows)}")
    if len(rows) >= 3 and with_cards < max(3, (len(rows) + 1) // 2): issues.append(f"insufficient_card_coverage:{with_cards}/{len(rows)}")
    if root.get("source") == "hsreplay" and len(rows) >= 5 and tier_counts["D"] == len(rows) and with_metrics == 0: issues.append("hsreplay_collapsed_d_tiers_without_metrics")
    status = "invalid" if not rows or any(issue.startswith("count_mismatch") or issue == "hsreplay_collapsed_d_tiers_without_metrics" for issue in issues) else "degraded" if issues else "healthy"
    return {"ok": status == "healthy", "status": status, "source": root.get("source"), "fetchedAt": root.get("fetchedAt") or root.get("fetched_at"), "count": len(rows), "tierCounts": tier_counts, "strategiesWithCards": with_cards, "strategiesWithMetrics": with_metrics, "issues": issues}


def _audit_response(http_status: int, payload: Any) -> dict[str, Any]:
    """Keep an auth-protected public route distinct from a malformed data payload."""
    audit = _audit_payload(payload)
    if http_status in {401, 403}:
        audit.update({"ok": False, "status": "access_protected", "issues": ["endpoint_requires_auth"]})
    return {"httpStatus": http_status, **audit}


def audit_strategy_data() -> dict[str, Any]:
    local_status, local_payload = _request_json(LOCAL_URL)
    public_status, public_payload = _request_json(PUBLIC_URL)
    local = _audit_response(local_status, local_payload)
    public = _audit_response(public_status, public_payload)
    return {"checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "local": local, "public": public}


def diagnose_rendering() -> dict[str, Any]:
    audit = audit_strategy_data()
    local = audit["local"]
    public = audit["public"]
    if local["status"] == "invalid":
        disposition = "parser_or_api"
    elif public["status"] == "access_protected":
        disposition = "heartpulse_access_protected"
    elif public["status"] == "invalid":
        disposition = "heartpulse_api_or_cache"
    elif local["tierCounts"] != public["tierCounts"] or local["count"] != public["count"]:
        disposition = "heartpulse_transform_or_cache"
    else:
        disposition = "healthy"
    return {"disposition": disposition, "audit": audit}


def codegraph_explore(question: Any) -> dict[str, Any]:
    if not isinstance(question, str) or not 3 <= len(question) <= 1000: raise Refused("question must contain between 3 and 1000 characters.")
    return {"output": _run(["codegraph", "explore", question], timeout=180)}


def _head() -> str:
    head = _git("rev-parse", "HEAD")
    if not SAFE_COMMIT.fullmatch(head): raise RuntimeError("The workspace HEAD is not a full Git commit.")
    return head


def workspace_status() -> dict[str, Any]:
    return {"branch": _git("branch", "--show-current"), "head": _head(), "status": _git("status", "--short"), "commits": _git("log", "--oneline", "origin/main..HEAD"), "diffStat": _git("diff", "--stat", "origin/main..HEAD"), "changedPaths": [line for line in _git("diff", "--name-only", "origin/main..HEAD").splitlines() if line]}


def _load_validations() -> dict[str, Any]:
    try: value = json.loads(VALIDATION_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError): return {}
    return value if isinstance(value, dict) else {}


def validate_workspace(mode: Any, test_paths: Any = None) -> dict[str, Any]:
    if mode not in {"targeted", "full", "security"}: raise Refused("mode must be targeted, full, or security.")
    if _git("branch", "--show-current") != EXPECTED_BRANCH: raise Refused(f"Repairs must be committed on {EXPECTED_BRANCH}.")
    if _git("status", "--porcelain"): raise Refused("Commit or discard workspace changes before validation.")
    if mode == "targeted":
        if not isinstance(test_paths, list) or not test_paths or not all(isinstance(path, str) and TEST_PATH.fullmatch(path) for path in test_paths): raise Refused("targeted validation requires valid test paths.")
        output = _run(["npm", "run", "test:heartpulse-strategy-audit"], timeout=20 * 60)
    elif mode == "full":
        output = _run(["npm", "run", "verify:ci"], timeout=60 * 60)
    else:
        output = _run(["npm", "run", "security:semgrep:strict"], timeout=20 * 60) + _run(["npm", "run", "security:gitleaks"], timeout=20 * 60)
    head = _head()
    validations = _load_validations()
    record = validations.setdefault(head, {"modes": {}, "updatedAt": 0})
    record["modes"][mode] = {"at": int(time.time()), "testPaths": test_paths if mode == "targeted" else []}
    record["updatedAt"] = int(time.time())
    VALIDATION_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = VALIDATION_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(validations, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(VALIDATION_FILE)
    return {"head": head, "mode": mode, "passed": True, "output": output}


def _require_publishable() -> tuple[str, list[str]]:
    if _git("branch", "--show-current") != EXPECTED_BRANCH: raise Refused(f"Repairs must be committed on {EXPECTED_BRANCH}.")
    if _git("status", "--porcelain"): raise Refused("Commit or discard workspace changes before publication.")
    head = _head()
    changed = [line for line in _git("diff", "--name-only", "origin/main..HEAD").splitlines() if line]
    allowed = ("src/", "server/", "scripts/", "tests/", "docs/", "package.json", "package-lock.json", "CHANGELOG.md")
    if not changed or any(not path.startswith(allowed) for path in changed): raise Refused("Automatic publication is limited to HeartPulse source, tests, docs and lockfile paths.")
    if not any(path.startswith("tests/") for path in changed): raise Refused("The repair must include a regression test.")
    modes = _load_validations().get(head, {}).get("modes", {})
    if not {"targeted", "full", "security"}.issubset(modes): raise Refused("Targeted, full and security validation must pass on this exact commit.")
    if any(int(modes[name].get("at", 0)) < int(time.time()) - 4 * 60 * 60 for name in modes): raise Refused("Validation is older than four hours; run it again before publication.")
    return head, changed


def publish_and_verify(summary: Any) -> dict[str, Any]:
    if not isinstance(summary, str) or not 5 <= len(summary) <= 300: raise Refused("summary must contain between 5 and 300 characters.")
    with MUTATION_LOCK:
        head, changed = _require_publishable()
        if not Path(DEPLOY_HELPER).is_file(): raise Refused(f"Canonical HeartPulse deploy helper is unavailable: {DEPLOY_HELPER}")
        _run(["git", "push", "origin", "HEAD:main"], timeout=300)
        deploy_output = _run(["sudo", "-n", DEPLOY_HELPER, head], timeout=45 * 60)
        verification = diagnose_rendering()
        if verification["disposition"] != "healthy": raise RuntimeError(json.dumps({"published": False, "commit": head, "verification": verification}, ensure_ascii=False))
        return {"published": True, "commit": head, "changedPaths": changed, "deployOutput": deploy_output, "verification": verification}


def dispatch(tool: str, arguments: Any) -> dict[str, Any]:
    args = arguments if isinstance(arguments, dict) else {}
    if tool == "audit_site_sections": return audit_site_sections()
    if tool == "audit_strategy_data": return audit_strategy_data()
    if tool == "diagnose_rendering": return diagnose_rendering()
    if tool == "codegraph_explore": return codegraph_explore(args.get("question"))
    if tool == "workspace_status": return workspace_status()
    if tool == "validate_workspace": return validate_workspace(args.get("mode"), args.get("testPaths"))
    if tool == "publish_and_verify": return publish_and_verify(args.get("summary"))
    raise Refused(f"Unknown tool: {tool}")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/call": self._send(404, {"error": "Not found."}); return
        supplied = self.headers.get("authorization", "").removeprefix("Bearer ")
        if not SERVER_TOKEN or not hmac.compare_digest(supplied, SERVER_TOKEN): self._send(401, {"error": "Unauthorized."}); return
        try:
            length = int(self.headers.get("content-length", "0")); body = json.loads(self.rfile.read(length))
            result = dispatch(body.get("tool", ""), body.get("arguments", {}))
            self._send(200, {"text": json.dumps(result, ensure_ascii=False)})
        except Exception as error:
            self._send(400, {"error": _redact(str(error))})

    def _send(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(encoded))); self.end_headers(); self.wfile.write(encoded)

    def log_message(self, _format: str, *_args: Any) -> None: return


def main() -> None:
    global SERVER_TOKEN
    parser = argparse.ArgumentParser(); parser.add_argument("--bind", default="127.0.0.1"); parser.add_argument("--port", type=int, default=4032); args = parser.parse_args()
    secret = os.environ.get("AGENT_TOOL_TOKEN", "").strip()
    if len(secret) < 16: raise SystemExit("AGENT_TOOL_TOKEN is required")
    SERVER_TOKEN = hashlib.sha256(f"openbot-heartpulse-ops\0{secret}".encode()).hexdigest()
    ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()


if __name__ == "__main__": main()
