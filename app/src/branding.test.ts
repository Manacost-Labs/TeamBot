import { expect, test } from "bun:test";

const projectRoot = new URL("../../", import.meta.url);

test("the application document has the ManacostTeam title before JavaScript loads", async () => {
  const document = await Bun.file(
    new URL("app/index.html", projectRoot),
  ).text();

  expect(document).toContain("<title>ManacostTeam</title>");
  expect(document).not.toContain("<title>OpenBot</title>");
});
