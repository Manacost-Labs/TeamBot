import importlib.util
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "heartpulse_ops_service",
    "/srv/projects/web/work.kolodahearthstone.com/heartpulse-ops/heartpulse_ops_service.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class HeartPulseAuditTests(unittest.TestCase):
    def test_page_requires_application_root(self):
        with patch.object(MODULE, "_request_page", return_value=(200, "text/html", "<html></html>")):
            result = MODULE._audit_page("/")
        self.assertEqual(result["state"], "invalid")
        self.assertIn("missing_app_root", result["issues"])

    def test_protected_api_is_reported_without_false_failure(self):
        with patch.object(MODULE, "_request_json", return_value=(401, None)):
            result = MODULE._audit_section_api("/api/standard-meta")
        self.assertEqual(result["state"], "access_protected")
        self.assertEqual(result["issues"], ["endpoint_requires_auth"])

    def test_route_matrix_covers_primary_sections(self):
        self.assertEqual(len(MODULE.SITE_SECTIONS), 22)
        self.assertEqual(len({section["id"] for section in MODULE.SITE_SECTIONS}), 22)

    def test_api_access_protection_is_listed_separately_from_page_health(self):
        with patch.object(MODULE, "_audit_page", return_value={"path": "/", "state": "healthy", "issues": []}), patch.object(
            MODULE,
            "_audit_section_api",
            return_value={"path": "/api/private", "state": "access_protected", "issues": ["endpoint_requires_auth"]},
        ):
            with patch.object(MODULE, "SITE_SECTIONS", ({"id": "home", "title": "Главная", "path": "/", "apis": ("/api/private",)},)):
                result = MODULE.audit_site_sections()
        self.assertEqual(result["coverage"]["sections"], 1)
        self.assertEqual(result["coverage"]["protectedApis"], 1)
        self.assertEqual(result["accessProtectedApis"], ["/api/private"])


if __name__ == "__main__":
    unittest.main()
