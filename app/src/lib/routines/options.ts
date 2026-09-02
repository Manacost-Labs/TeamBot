export type RoutineSelectOption = { value: string; label: string };

/**
 * Ready-to-use cadences shown by the routine editor.
 *
 * The platform still enforces a 15-minute minimum interval server-side; the six-hour option is a
 * convenience for maintenance routines that should run on a predictable, low-noise cadence.
 */
export const routineSchedulePresets = [
  { id: "every-15-minutes", label: "Каждые 15 минут", cron: "*/15 * * * *" },
  { id: "every-6-hours", label: "Каждые 6 часов", cron: "0 */6 * * *" },
  { id: "hourly", label: "Каждый час", cron: "0 * * * *" },
  { id: "daily", label: "Каждый день в 09:00", cron: "0 9 * * *" },
  { id: "weekdays", label: "По будням в 09:00", cron: "0 9 * * 1-5" },
  { id: "weekly", label: "Каждый понедельник в 09:00", cron: "0 9 * * 1" },
  { id: "monthly", label: "Первого числа в 09:00", cron: "0 9 1 * *" },
] as const;

type AgentOptionSource = { id: string; name: string; title: string };
type ChannelOptionSource = {
  id: string;
  name: string;
  agentIds: string[];
  active: boolean;
};

/** Stable, human-first labels for the schedule editor's Employee field. */
export function routineAgentOptions(
  agents: AgentOptionSource[],
): RoutineSelectOption[] {
  return agents
    .map((agent) => ({
      value: agent.id,
      label: agent.title.trim() ? `${agent.name} — ${agent.title}` : agent.name,
    }))
    .sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" }),
    );
}

/**
 * Active channels that can actually run the selected employee.
 *
 * A duplicate human name gets the id as a disambiguator; ordinary names stay clean. The id is never
 * the only label, so the form remains usable without knowing internal identifiers.
 */
export function routineChannelOptions(
  channels: ChannelOptionSource[],
  agentId: string,
): RoutineSelectOption[] {
  const compatible = channels.filter(
    (channel) => channel.active && channel.agentIds.includes(agentId),
  );
  const counts = new Map<string, number>();
  for (const channel of compatible) {
    counts.set(channel.name, (counts.get(channel.name) ?? 0) + 1);
  }
  return compatible
    .map((channel) => ({
      value: channel.id,
      label:
        (counts.get(channel.name) ?? 0) > 1
          ? `${channel.name} · ${channel.id}`
          : channel.name,
    }))
    .sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" }),
    );
}
