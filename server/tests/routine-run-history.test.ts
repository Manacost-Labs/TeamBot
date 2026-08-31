import { describe, expect, test } from "bun:test";
import { safeRoutineRunError } from "../src/routines/store";

describe("member-facing routine failure summaries", () => {
  test("turns reconnect, timeout and overlap failures into actionable categories", () => {
    expect(
      safeRoutineRunError("Google OAuth invalid_grant for account 12"),
    ).toBe("Google authorization needs to be reconnected.");
    expect(safeRoutineRunError("gateway deadline exceeded")).toBe(
      "The run timed out.",
    );
    expect(safeRoutineRunError("another run was already running")).toBe(
      "Skipped because the previous run was still active.",
    );
  });

  test("never returns an unknown provider error or its credential-adjacent details", () => {
    const raw = "vendor rejected https://service.test?token=top-secret";
    const safe = safeRoutineRunError(raw);

    expect(safe).toBe("The run did not complete.");
    expect(safe).not.toContain("top-secret");
    expect(safe).not.toContain("service.test");
  });
});
