import type { AgentProfile } from "@/lib/agents/queries";
import { AbstractAvatar } from "./abstract-avatar";

export function AgentCard({ agent }: { agent: AgentProfile }) {
  return (
    <div className="relative flex h-[196px] w-[144px] flex-col overflow-hidden rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent/40">
      <div
        className="flex flex-1 items-center justify-center"
        aria-hidden="true"
      >
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={112} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="line-clamp-1 text-sm font-medium">{agent.name}</span>
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {agent.roleDescription}
        </span>
      </div>
    </div>
  );
}
