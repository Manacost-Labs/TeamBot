import { describe, expect, test } from "bun:test";
import { emotionAppearance } from "./emotion-avatar";

describe("emotionAppearance", () => {
  test("keeps one employee visually stable between renders", () => {
    expect(emotionAppearance("data-control")).toEqual(
      emotionAppearance("data-control"),
    );
  });

  test("gives different employees deterministic appearances", () => {
    expect(emotionAppearance("data-control")).not.toEqual(
      emotionAppearance("researcher"),
    );
  });
});
