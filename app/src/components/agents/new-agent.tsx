import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AgentFields } from "@/components/agents/agent-fields";
import { agentInputFrom, emptyAgentForm } from "@/lib/agents/form";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";

export function NewAgent() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createAgent = useMutation(createAgentMutationOptions(queryClient));
  const currentUser = useQuery(currentUserQueryOptions());

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Новый сотрудник</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Эта роль будет действовать во всех диалогах сотрудника.
        </p>
      </header>

      <AgentFields
        allowCustomModel={currentUser.data?.role === "admin"}
        defaultValues={emptyAgentForm}
        error={createAgent.error}
        onSubmit={async (values) => {
          // The panel swaps from the form to the new coworker's profile, and the roster behind it
          // picks up the new card: the next thing to do is start a channel with it.
          const agent = await createAgent.mutateAsync(agentInputFrom(values));
          await navigate({ search: { agent: agent.id }, to: "/agents" });
        }}
        submitLabel="Создать сотрудника"
      />
    </div>
  );
}
