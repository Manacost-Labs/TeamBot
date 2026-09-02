import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("public ManacostTeam reverse proxy", () => {
  test("the certificate bootstrap exposes only ACME over HTTP", () => {
    const config = readFileSync(
      join(
        import.meta.dir,
        "..",
        "ops/nginx/work.kolodahearthstone.com.bootstrap-http.conf",
      ),
      "utf8",
    );

    expect(config).toContain("server_name work.kolodahearthstone.com;");
    expect(config).toContain("location /.well-known/acme-challenge/");
    expect(config).toContain("root /var/www/html;");
    expect(config).toContain("return 503;");
    expect(config).not.toContain("listen 151.80.21.140:443");
    expect(config).not.toContain("proxy_pass");
    expect(config).not.toContain("ssl_certificate");
  });

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
    expect(config).toContain('add_header Referrer-Policy "same-origin" always;');
    expect(config).not.toContain('add_header Referrer-Policy "no-referrer"');
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
