import { describe, expect, test } from "bun:test";
import { googleOAuthJavaScriptOrigin } from "./oauth-setup";

describe("Google OAuth setup values", () => {
  test("derives the browser origin from the server-owned callback", () => {
    expect(
      googleOAuthJavaScriptOrigin(
        "google-drive",
        "https://work.kolodahearthstone.com/api/plugins/oauth/callback",
      ),
    ).toBe("https://work.kolodahearthstone.com");
  });

  test("keeps localhost development but rejects unrelated and unsafe values", () => {
    expect(
      googleOAuthJavaScriptOrigin(
        "google-drive",
        "http://localhost:3001/api/plugins/oauth/callback",
      ),
    ).toBe("http://localhost:3001");
    expect(
      googleOAuthJavaScriptOrigin(
        "notion",
        "https://work.kolodahearthstone.com/api/plugins/oauth/callback",
      ),
    ).toBeNull();
    expect(
      googleOAuthJavaScriptOrigin(
        "google-drive",
        "http://work.kolodahearthstone.com/api/plugins/oauth/callback",
      ),
    ).toBeNull();
  });
});
