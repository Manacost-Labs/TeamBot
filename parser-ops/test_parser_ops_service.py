import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch

import parser_ops_service as service


class ParserOpsValidationTest(unittest.TestCase):
    def test_source_ids_rejects_more_than_five_before_any_operation(self) -> None:
        with self.assertRaises(service.Refused):
            service._source_ids([f"source_{index}" for index in range(6)])

    def test_source_ids_rejects_shell_shaped_input(self) -> None:
        with self.assertRaises(service.Refused):
            service._source_ids(["source;sudo"])

    def test_expected_token_is_derived_and_never_equal_to_boundary_secret(self) -> None:
        with patch.dict(os.environ, {"AGENT_TOOL_TOKEN": "a" * 32}):
            self.assertEqual(len(service.expected_token()), 64)
            self.assertNotEqual(service.expected_token(), "a" * 32)

    def test_validation_state_is_written_private(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "validation.json"
            with patch.object(service, "VALIDATION_FILE", target):
                service._save_validations({"commit": {"modes": {}}})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_audit_reports_all_ids_and_only_expands_problem_sources(self) -> None:
        health = {
            "data": {
                "ok": True,
                "stale_sources": ["broken"],
                "cached_after_failure_sources": [],
                "hard_failed_sources": [],
                "semantic_failed_sources": [],
                "publication_failed_sources": [],
                "operationally_disabled_sources": [],
            }
        }
        reliability = {"data": {"generated_at": "now", "windows": []}}
        catalogue = [
            {"id": "healthy", "site": "one"},
            {"id": "broken", "site": "two"},
        ]
        with (
            patch.object(service, "_request_json", side_effect=[health, reliability]),
            patch.object(service, "_sources_catalogue", return_value=catalogue),
        ):
            result = service.audit_all_sources()
        self.assertEqual(result["sourceCount"], 2)
        self.assertEqual(result["sourceIds"], ["healthy", "broken"])
        self.assertEqual([item["id"] for item in result["problemSources"]], ["broken"])

    def test_reliability_windows_keep_decision_metrics_without_large_details(self) -> None:
        result = service._compact_reliability_windows(
            [
                {
                    "window": "24h",
                    "full_fresh_rate_pct": 99.2,
                    "failure_reasons": {"timeout": 2, "transport": 0},
                    "scheduled_reliability": {
                        "parser_objective_status": "meeting",
                        "expected_slots": 700,
                    },
                    "verified_completeness": {
                        "sources_below_target": 2,
                        "states": {"complete": 500},
                    },
                    "ai_quality": {"large": "omitted"},
                }
            ]
        )
        self.assertEqual(result[0]["failureReasons"], {"timeout": 2})
        self.assertEqual(result[0]["scheduled"]["parser_objective_status"], "meeting")
        self.assertEqual(result[0]["completeness"]["sources_below_target"], 2)
        self.assertNotIn("ai_quality", result[0])

    def test_publish_does_not_attempt_rollback_when_push_fails(self) -> None:
        with (
            patch.object(service, "_source_ids", return_value=["source"]),
            patch.object(service, "_require_clean_candidate", return_value="a" * 40),
            patch.object(service, "_require_publishable", return_value=["app/source.py"]),
            patch.object(service, "_git", return_value="b" * 40),
            patch.object(service, "_run", side_effect=RuntimeError("push failed")),
            patch.object(service, "_revert_and_deploy") as rollback,
        ):
            with self.assertRaisesRegex(RuntimeError, "push failed"):
                service.publish_and_verify(["source"], "repair source")
        rollback.assert_not_called()

    def test_revert_applies_inverse_patch_then_publishes_exact_revert(self) -> None:
        inverse = "diff --git a/app/a.py b/app/a.py\n"
        with (
            patch.object(
                service,
                "_git",
                side_effect=[inverse, "c" * 40],
            ),
            patch.object(service, "_run", return_value="") as run,
            patch.object(service, "_deploy", return_value="deployed") as deploy,
        ):
            result = service._revert_and_deploy("a" * 40, "b" * 40, "bad result")
        self.assertTrue(result["reverted"])
        run.assert_has_calls(
            [
                call(["git", "apply", "--index"], input_text=inverse, timeout=180),
                call(
                    ["git", "commit", "-m", "revert: restore parser after failed verification"],
                    timeout=180,
                ),
                call(["git", "push", "origin", "HEAD:main"], timeout=300),
            ]
        )
        deploy.assert_called_once_with("c" * 40)


if __name__ == "__main__":
    unittest.main()
