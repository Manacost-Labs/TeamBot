type JsonObject = Record<string, unknown>;

function parseObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

function sourceIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Enforces the repair half of Контроль данных after deterministic local failures. */
export class DataControlWorkflow {
  private readonly unresolved = new Set<string>();

  recordToolResult(name: string, args: JsonObject, result: string): void {
    const parsed = parseObject(result);
    if (!parsed) return;

    const source = parsed.source as JsonObject | undefined;
    const triage = parsed.triage as JsonObject | undefined;
    if (
      name.endsWith("diagnose_source") ||
      (typeof source?.id === "string" &&
        typeof triage?.disposition === "string")
    ) {
      const sourceId = source?.id;
      if (
        typeof sourceId === "string" &&
        ["inspect_adapter", "investigate_implementation"].includes(
          String(triage?.disposition ?? ""),
        )
      ) {
        this.unresolved.add(sourceId);
      }
      return;
    }

    if (
      (name.endsWith("publish_and_verify") ||
        parsed.verification !== undefined) &&
      parsed.published === true
    ) {
      const verification = parsed.verification as JsonObject | undefined;
      const results = Array.isArray(verification?.results)
        ? verification.results
        : [];
      const fresh = new Set(
        results.flatMap((item) => {
          if (typeof item !== "object" || item === null || Array.isArray(item))
            return [];
          const row = item as JsonObject;
          return row.outcome === "fresh_published" &&
            typeof row.sourceId === "string"
            ? [row.sourceId]
            : [];
        }),
      );
      for (const sourceId of sourceIds(args.sourceIds)) {
        if (fresh.has(sourceId)) this.unresolved.delete(sourceId);
      }
    }
  }

  unresolvedSourceIds(): string[] {
    return [...this.unresolved].sort();
  }

  correctionMessage(): string | undefined {
    const unresolved = this.unresolvedSourceIds();
    if (unresolved.length === 0) return undefined;
    return [
      "The maintenance run is not complete yet.",
      `Binding workflow violation: ${unresolved.join(", ")} were classified as requiring implementation inspection but were not repaired and verified.`,
      "Continue the work now. Use codegraph_explore, inspect the implementation, make the minimal local repair with a regression test, commit it, run targeted/full/security validation, then call publish_and_verify and require fresh_published.",
      "Do not repeat the audit report and do not claim that a deterministic internal contract rejection is unconfirmed.",
    ].join(" ");
  }
}
