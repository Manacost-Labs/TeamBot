import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EmotionAvatar, emotionAppearance } from "./emotion-avatar";

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

describe("EmotionAvatar", () => {
  test("renders inside the authenticated document without an iframe", () => {
    const html = renderToStaticMarkup(
      <EmotionAvatar name="Контроль данных" seed="data-control" size={32} />,
    );

    expect(html).toContain("<svg");
    expect(html).toContain("Контроль данных: готов к работе");
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("grok-emotion/embed.js");
  });
});
