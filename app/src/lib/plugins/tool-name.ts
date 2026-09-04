/**
 * A tool call, named the way the person watching would name it.
 *
 * The model is offered `mcp__notes__search_notes`, because a tool name has to be unique across every
 * server a Bot holds and has to survive two vendors both calling something `search`. None of that is
 * the reader's problem, and putting it on screen tells them how the thing is built rather than what
 * their Bot just did.
 *
 * Anything that is not a prefixed MCP name is left exactly as it is: a component the app registered
 * already has a name somebody chose.
 */
export type ToolName = {
  /** What was done, for the line itself. */
  label: string;
  /** Which server it was done against, muted beside the label. Absent for anything not MCP. */
  detail?: string;
};

export function readToolName(name: string): ToolName {
  const parts = name.split("__");
  if (parts.length < 3 || (parts[0] !== "mcp" && parts[0] !== "mcp_h")) {
    return { label: name };
  }
  const [, server, ...rest] = parts;
  const tool = rest.join("__");
  // Strip from the joined action: a base64url digest can itself contain `__` separators.
  const action =
    parts[0] === "mcp_h"
      ? tool.replace(/(?:^|__)h[a-zA-Z0-9_-]{16}$/, "")
      : tool;
  const label = humanise(action) || "Tool call";

  /*
   * The server is dropped when the action already says it. Vendors name a tool after the thing it
   * searches, so `mcp__notes__search_notes` would otherwise read "Search notes notes", which looks
   * like a bug rather than a label.
   */
  const named = label.toLowerCase().includes((server ?? "").toLowerCase());
  return named ? { label } : { label, detail: server };
}

/**
 * `search_notes` as "Search notes".
 *
 * Vendors write tool names in snake_case, camelCase or a mixture, and the only thing they agree on
 * is that the first word is a verb. Splitting on both and sentence-casing the result gets a phrase
 * that reads as an action without anybody maintaining a table of names.
 */
function humanise(tool: string): string {
  const words = tool
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  if (words.length === 0) return tool;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
