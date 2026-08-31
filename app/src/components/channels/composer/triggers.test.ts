import { describe, expect, test } from "bun:test";
import { toAgentOptions } from "./triggers";

describe("agent mention routing", () => {
  test("shows the current Bot and coworkers granted for handoff", () => {
    const profiles = [
      { id: "analyst", name: "Главный Аналитик", title: "Исследование" },
      { id: "editor", name: "Главный редактор", title: "Редактура" },
      { id: "other", name: "Другой", title: "Не разрешён" },
    ];

    expect(
      toAgentOptions(profiles, ["analyst", "editor"]).map(({ id }) => id),
    ).toEqual(["analyst", "editor"]);
  });

  test("keeps ungranted coworkers out of the mention menu", () => {
    const profiles = [
      { id: "analyst", name: "Главный Аналитик" },
      { id: "editor", name: "Главный редактор" },
      { id: "other", name: "Другой" },
    ];

    expect(toAgentOptions(profiles, ["analyst", "editor"])).not.toContainEqual(
      expect.objectContaining({ id: "other" }),
    );
  });
});
