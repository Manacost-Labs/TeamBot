.PHONY: verify check verify-static verify-tests verify-build

# Local entrypoint; CI uses the same phase targets in its independent jobs.
verify: verify-static verify-tests verify-build

check: verify

verify-static:
	bun run format:check
	bun run lint
	bun run typecheck

# Supply a migrated, disposable database explicitly. Never inherit a deployment DB by accident.
verify-tests:
	@test -n "$$TEST_DATABASE_URL" || { echo "Set TEST_DATABASE_URL to a migrated disposable test database" >&2; exit 1; }
	DATABASE_URL="$$TEST_DATABASE_URL" bun run test:ci

verify-build:
	bun run build
