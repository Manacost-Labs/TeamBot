import type { AgentProfile } from "./queries";

/** Keep roster grouping deterministic and independent of the page component. */
export function groupAgentsByFolder(agents: AgentProfile[]) {
  const groups = new Map<string, AgentProfile[]>();
  for (const agent of agents) {
    const folder = agent.folder?.trim() || "Без папки";
    const group = groups.get(folder);
    if (group) group.push(agent);
    else groups.set(folder, [agent]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === "Без папки") return 1;
      if (right === "Без папки") return -1;
      return left.localeCompare(right, "ru");
    })
    .map(([folder, folderAgents]) => ({ folder, agents: folderAgents }));
}
