import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("public ManacostTeam reverse proxy", () => {
  test("keeps Telegram codes out of access logs and removes the legacy edge gate", () => {
    const config = readFileSync(
      join(
        import.meta.dir,
        "..",
        "ops/nginx/work.kolodahearthstone.com.conf",
      ),
      "utf8",
    );

    expect(config).toContain("server_name work.kolodahearthstone.com;");
    expect(config).toMatch(
      /location = \/api\/auth\/telegram\/callback\s*\{[\s\S]*?access_log off;/,
    );
    expect(config).toMatch(
      /location = \/api\/auth\/telegram\/callback\s*\{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:3021;/,
    );
    expect(config).not.toContain("auth_request");
    expect(config).not.toContain("3030");
  });
});
