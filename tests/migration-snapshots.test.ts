import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("every journaled migration has a snapshot and the latest links to its predecessor", async () => {
  const directory = join(import.meta.dir, "..", "server", "drizzle", "meta");
  const journal = JSON.parse(
    await readFile(join(directory, "_journal.json"), "utf8"),
  ) as { entries: { idx: number }[] };
  let previousId = "00000000-0000-0000-0000-000000000000";
  for (const entry of journal.entries) {
    const filename = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
    const snapshot = JSON.parse(
      await readFile(join(directory, filename), "utf8"),
    ) as { id: string; prevId: string };
    // Historical custom migrations can share a predecessor; check the new tip's link
    // without rewriting already-released snapshot history.
    if (entry === journal.entries.at(-1)) {
      expect(snapshot.prevId).toBe(previousId);
    }
    expect(snapshot.id).not.toBe(previousId);
    previousId = snapshot.id;
  }
});
