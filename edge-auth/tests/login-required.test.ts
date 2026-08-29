import { describe, expect, test } from "bun:test";
import { loginRequiredPage } from "../src/login-required";

describe("login recovery page", () => {
  test("takes an expired embedded session back through ChatGPT login", () => {
    const page = loginRequiredPage("https://work.example.com");

    expect(page).toContain("Восстанавливаем вход");
    expect(page).toContain('target="_top"');
    expect(page).toContain(
      "https://work.example.com/signin-with-chatgpt?return_to=%2F",
    );
    expect(page).toContain("window.top.location.replace(loginUrl)");
  });

  test("escapes the URL before placing it in markup", () => {
    const page = loginRequiredPage('https://work.example.com/?next="<unsafe>');

    expect(page).toContain("&quot;&lt;unsafe&gt;/signin-with-chatgpt");
    expect(page).not.toContain("<unsafe>/signin-with-chatgpt");
  });
});
