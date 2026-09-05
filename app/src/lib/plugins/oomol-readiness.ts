import type { AgentProfile } from "../agents/queries";
import type { PluginServer, PluginTool } from "./queries";

export type OomolAgent = Pick<AgentProfile, "id" | "hasCallbackToken">;

export type OomolReadinessState =
  | "not-configured"
  | "missing-key"
  | "unchecked"
  | "checking"
  | "failed"
  | "empty"
  | "roster-unavailable"
  | "needs-grants"
  | "callback-needed"
  | "callback-partial"
  | "catalogued";

/** Discovery is not execution: even a populated catalogue is not a successful provider action. */
export function oomolReadiness(
  server: PluginServer | undefined,
  {
    refreshing = false,
    error,
    agents,
    botsMayCallBack = false,
  }: {
    refreshing?: boolean;
    error?: unknown;
    agents?: readonly OomolAgent[];
    botsMayCallBack?: boolean;
  } = {},
): OomolReadinessState {
  if (!server) return "not-configured";
  if (!server.hasCredential) return "missing-key";
  if (refreshing) return "checking";
  // refreshTools records provider failures and returns HTTP 200 with the old tools still present.
  if (error || server.lastError) return "failed";
  if (
    !server.toolsRefreshedAt ||
    !Number.isFinite(Date.parse(server.toolsRefreshedAt))
  )
    return "unchecked";
  if (server.tools.length === 0) return "empty";
  if (!agents) return "roster-unavailable";
  const recordedIds = new Set(server.tools.flatMap((tool) => tool.grantedTo));
  const grantees = agents.filter((agent) => recordedIds.has(agent.id));
  if (grantees.length === 0) return "needs-grants";
  const configured = grantees.filter(
    (agent) => botsMayCallBack || agent.hasCallbackToken,
  ).length;
  if (configured === 0) return "callback-needed";
  if (configured < grantees.length) return "callback-partial";
  return "catalogued";
}

const SERVICE_TITLES = new Map([
  ["github", "GitHub"],
  ["googledocs", "Google Docs"],
  ["googlesheets", "Google Sheets"],
  ["googledrive", "Google Drive"],
  ["gmail", "Gmail"],
]);

/** Names are presentation hints from service.action IDs, never authority for permissions. */
export function groupOomolTools(
  tools: readonly PluginTool[],
  agents?: readonly OomolAgent[],
) {
  const visibleIds = new Set(agents?.map((agent) => agent.id));
  const groups = new Map<
    string,
    { title: string; toolCount: number; agents: Set<string> }
  >();
  for (const tool of tools) {
    const dot = tool.name.indexOf(".");
    const prefix =
      dot > 0 && dot < tool.name.length - 1 ? tool.name.slice(0, dot) : "";
    const id = /^[a-z][a-z0-9_-]{0,63}$/.test(prefix) ? prefix : "other";
    let group = groups.get(id);
    if (!group) {
      group = {
        title:
          id === "other" ? "Другие действия" : (SERVICE_TITLES.get(id) ?? id),
        toolCount: 0,
        agents: new Set(),
      };
      groups.set(id, group);
    }
    group.toolCount += 1;
    for (const agent of tool.grantedTo) group.agents.add(agent);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, group]) => {
      const grantedAgentCount = [...group.agents].filter((agent) =>
        visibleIds.has(agent),
      ).length;
      return {
        id,
        title: group.title,
        toolCount: group.toolCount,
        grantedAgentCount,
        unresolvedAgentCount: group.agents.size - grantedAgentCount,
      };
    });
}

/** Do not echo arbitrary vendor messages or credential material into this guidance surface. */
export function oomolRecoveryHint(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (/\b401\b/.test(message))
    return "OOMOL отклонил ключ. Проверьте API-ключ в OOMOL и при необходимости замените его здесь.";
  if (/\b403\b/.test(message))
    return "Проверьте доступ ключа к нужному аккаунту и команде в OOMOL, затем повторите проверку.";
  if (/\b429\b|rate.limit/i.test(message))
    return "OOMOL ограничил частоту запросов. Повторите проверку позже; менять ключ не нужно.";
  if (/time|reach|network|\b5\d\d\b/i.test(message))
    return "Не удалось получить список от OOMOL. Подождите и повторите проверку; менять ключ пока не нужно.";
  return "Не удалось обновить список действий. Проверьте подключённые аккаунты в OOMOL и повторите проверку.";
}
