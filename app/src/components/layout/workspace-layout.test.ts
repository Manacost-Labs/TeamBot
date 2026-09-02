import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_MAIN_CLASS,
  WORKSPACE_PROVIDER_CLASS,
} from "./workspace-layout";

describe("workspace layout", () => {
  test("keeps every full-screen route inside the viewport with a scrollable main column", () => {
    expect(WORKSPACE_PROVIDER_CLASS).toContain("h-svh");
    expect(WORKSPACE_PROVIDER_CLASS).toContain("overflow-hidden");
    expect(WORKSPACE_MAIN_CLASS).toContain("min-h-0");
    expect(WORKSPACE_MAIN_CLASS).toContain("overflow-y-auto");
    expect(WORKSPACE_MAIN_CLASS).not.toContain("overflow-hidden");
  });
});
