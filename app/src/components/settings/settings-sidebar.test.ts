import { describe, expect, test } from "bun:test";
import { SETTINGS_ITEMS } from "./settings-sidebar";

describe("ManacostTeam settings navigation", () => {
  test("keeps the user-facing sections in Russian and in product order", () => {
    expect(SETTINGS_ITEMS.map((item) => item.title)).toEqual([
      "Основные",
      "Интеграции",
      "Галерея компонентов",
    ]);
    expect(SETTINGS_ITEMS.map((item) => item.linkOptions.to)).toEqual([
      "/settings",
      "/settings/connected-accounts",
      "/settings/components-gallery",
    ]);
  });
});
